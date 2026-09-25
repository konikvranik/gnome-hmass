// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 pvranik
//
/*
 * Jednoduchý JSON WebSocket klient nad libsoup 3 s automatickým
 * opakovaným připojením. GNOME Shell 42 (legacy imports API).
 *
 * Odolnost vůči nedostupnému serveru:
 *  - reconnect s exponenciálním backoffem (1 -> 60 s)
 *  - watchdog 20 s na visící connect (ruší ho přes GCancellable)
 *  - výjimky v callbackách klienta nezabrají smyčce zpráv
 *  - opakované chyby se logují maximálně jednou za minutu
 */

const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Soup = imports.gi.Soup;

const _decoder = new TextDecoder();

const LOG_INTERVAL_US = 60 * 1000 * 1000; // stejný klíč log max 1x za minutu
const CONNECT_TIMEOUT_S = 20;             // visící připojení přerušit

var State = {
    DISCONNECTED: 'disconnected',
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
};

/** Převod GBytes/Uint8Array z signálu 'message' na řetězec. */
function decodeBytes(data) {
    if (data instanceof Uint8Array)
        return _decoder.decode(data);
    if (data && typeof data.get_data === 'function')
        return _decoder.decode(data.get_data());
    return '';
}

/**
 * http(s) URL přeloží na ws(s) a přidá cestu.
 * wsUrlFromHttp('http://ha:8123', '/api/websocket') -> 'ws://ha:8123/api/websocket'
 */
function wsUrlFromHttp(base, path) {
    let s = (base || '').trim().replace(/\/+$/, '');
    if (!s)
        return '';
    if (s.endsWith('/api') && path.startsWith('/api/'))
        s = s.slice(0, -4);
    if (s.startsWith('ws://') || s.startsWith('wss://')) {
        // už je to websocket URL - cestu přidáme jen když tam není
        if (s.includes(path))
            return s;
        return s + path;
    }
    if (s.startsWith('http://'))
        s = 'ws://' + s.slice('http://'.length);
    else if (s.startsWith('https://'))
        s = 'wss://' + s.slice('https://'.length);
    else
        s = 'ws://' + s;
    return s + path;
}

function _createSoupMessage(method, url) {
    if (typeof Soup.Message.new === 'function') {
        try {
            const msg = Soup.Message.new(method, url);
            if (msg)
                return msg;
        } catch (e) {
        }
    }
    if (typeof Soup.URI !== 'undefined' && typeof Soup.URI.new === 'function') {
        try {
            const soupUri = Soup.URI.new(url);
            if (soupUri) {
                const msg = Soup.Message.new_from_uri(method, soupUri);
                if (msg)
                    return msg;
            }
        } catch (e) {
        }
    }
    if (typeof GLib.Uri !== 'undefined' && typeof GLib.Uri.parse === 'function') {
        try {
            const uri = GLib.Uri.parse(url, GLib.UriFlags.NONE);
            if (uri) {
                const msg = Soup.Message.new_from_uri(method, uri);
                if (msg)
                    return msg;
            }
        } catch (e) {
        }
    }
    try {
        let httpUrl = url;
        if (httpUrl.startsWith('ws://'))
            httpUrl = 'http://' + httpUrl.slice(5);
        else if (httpUrl.startsWith('wss://'))
            httpUrl = 'https://' + httpUrl.slice(6);
        return Soup.Message.new(method, httpUrl);
    } catch (e) {
    }
    return null;
}

var WsClient = class WsClient {
    constructor(name) {
        this.name = name;
        this.state = State.DISCONNECTED;
        this.detail = '';

        this.onstate = null;   // (state, detail)
        this.onopen = null;    // () - socket otevřen (handshake aplikace začíná)
        this.onmessage = null; // (obj) - parsované JSON zprávy
        this.onclosed = null;  // (detail) - socket zavřen (před plánovaným reconnektem)

        this._urls = [];
        this._token = '';
        this._allowInsecure = false;
        this._session = null;
        this._ws = null;
        this._urlIdx = 0;
        this._backoff = 1;
        this._reconnectId = 0;
        this._manualClose = false;
        this._destroyed = false;
        this._insecureHandler = 0;
        this._connectGen = 0;          // zneplatňuje odpovědi starých pokusů
        this._connectCancellable = null;
        this._watchdogId = 0;
        this._logTs = {};              // klíč -> čas posledního logu (µs)
    }

    /** Nastaví cíl. urls: pole WS URL (fallback pořadí). */
    setTarget(urls, token, allowInsecure) {
        this._urls = urls.filter(u => !!u);
        this._token = token || '';
        this._allowInsecure = !!allowInsecure;
    }

    get connected() {
        return this.state === State.CONNECTED && this._ws !== null;
    }

    /** Log s limitem: stejný klíč maximálně jednou za minutu. */
    _logLimited(key, msg) {
        const now = GLib.get_monotonic_time();
        if (now - (this._logTs[key] || -LOG_INTERVAL_US) < LOG_INTERVAL_US)
            return;
        this._logTs[key] = now;
        log(`[${this.name}] ${msg}`);
    }

    open() {
        this._manualClose = false;
        if (this._reconnectId) {
            GLib.source_remove(this._reconnectId);
            this._reconnectId = 0;
        }
        this._invalidateConnect();
        this._cleanupSocket();
        if (this._urls.length === 0) {
            this._setState(State.DISCONNECTED, '');
            return;
        }
        if (this._urlIdx >= this._urls.length)
            this._urlIdx = 0;

        if (!this._session) {
            this._session = new Soup.Session();
            try {
                this._session.timeout = 30;
            } catch (e) {
                // vlastnost není dostupná - watchdog to pokryje
            }
            if (this._allowInsecure) {
                // libsoup >= 3.2; na starší verzi signál chybí a prostě ignorujeme
                try {
                    this._insecureHandler = this._session.connect('accept-certificate',
                        (sess, msg, peerCert, errors) => true);
                } catch (e) {
                    this._insecureHandler = 0;
                }
            }
        }

        this._setState(State.CONNECTING, this._urls[this._urlIdx]);
        this._tryConnect();
    }

    /** Zruší probíhající pokus o připojení (watchdog i async callback). */
    _invalidateConnect() {
        this._connectGen++;
        if (this._watchdogId) {
            GLib.source_remove(this._watchdogId);
            this._watchdogId = 0;
        }
        if (this._connectCancellable) {
            try {
                this._connectCancellable.cancel();
            } catch (e) {
            }
            this._connectCancellable = null;
        }
    }

    _armWatchdog() {
        if (this._watchdogId)
            GLib.source_remove(this._watchdogId);
        this._watchdogId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            CONNECT_TIMEOUT_S, () => {
                this._watchdogId = 0;
                if (this._manualClose || this.state !== State.CONNECTING)
                    return GLib.SOURCE_REMOVE;
                // spojení se 20 s neotevřelo - zkusit další URL / reconnect
                this._advanceUrl(`připojení se nepovedlo do ${CONNECT_TIMEOUT_S} s`);
                return GLib.SOURCE_REMOVE;
            });
    }

    _tryConnect() {
        const url = this._urls[this._urlIdx];
        const message = _createSoupMessage('GET', url);
        if (!message) {
            this._advanceUrl(`neplatná URL (nelze vytvořit zprávu): ${url}`);
            return;
        }
        if (this._token)
            message.request_headers.append('Authorization', `Bearer ${this._token}`);

        const gen = ++this._connectGen;
        const cancellable = new Gio.Cancellable();
        this._connectCancellable = cancellable;
        this._armWatchdog();

        const callback = (sess, res) => {
            // po destroy() nebo překonaném pokusu výsledek ignorujeme
            if (!this._session || gen !== this._connectGen)
                return;
            let ws = null;
            try {
                ws = sess.websocket_connect_finish(res);
            } catch (e) {
                this._advanceUrl(`připojení selhalo: ${e.message}`);
                return;
            }
            this._onWsOpen(ws);
        };

        try {
            // Libsoup 2.4 bere 5 parametrů: (message, origin, protocols, cancellable, callback)
            // Libsoup 3.0 bere 6 parametrů: (message, origin, protocols, io_priority, cancellable, callback)
            try {
                this._session.websocket_connect_async(
                    message, null, null, cancellable, callback);
            } catch (argErr) {
                this._session.websocket_connect_async(
                    message, null, null, GLib.PRIORITY_DEFAULT, cancellable, callback);
            }
        } catch (e) {
            this._advanceUrl(`připojení selhalo: ${e.message}`);
        }
    }

    _advanceUrl(reason) {
        this._invalidateConnect();
        this._urlIdx++;
        if (this._urlIdx < this._urls.length) {
            this._logLimited('fallback', `${reason}, zkouším ${this._urls[this._urlIdx]}`);
            this._setState(State.CONNECTING, this._urls[this._urlIdx]);
            this._tryConnect();
            return;
        }
        this._urlIdx = 0;
        this._setState(State.DISCONNECTED, reason);
        this._scheduleReconnect();
    }

    _onWsOpen(ws) {
        this._invalidateConnect();
        this._ws = ws;
        this._backoff = 1;
        try {
            if (typeof ws.set_max_incoming_payload_size === 'function')
                ws.set_max_incoming_payload_size(0);
            ws.max_incoming_payload_size = 0;
        } catch (e) {
        }
        ws.connect('message', (self, type, data) => {
            if (this._ws !== ws)
                return;
            if (type !== Soup.WebsocketDataType.TEXT)
                return;
            let obj = null;
            try {
                obj = JSON.parse(decodeBytes(data));
            } catch (e) {
                this._logLimited('json', `neplatná JSON zpráva: ${e.message}`);
                return;
            }
            if (this.onmessage) {
                try {
                    this.onmessage(obj);
                } catch (e) {
                    this._logLimited('handler', `zpracování zprávy selhalo: ${e.message}`);
                }
            }
        });
        ws.connect('closed', () => {
            if (this._ws !== ws)
                return;
            this._cleanupSocket();
            if (this._destroyed || this._manualClose) {
                this._setState(State.DISCONNECTED, '');
                return;
            }
            this._logLimited('closed', 'spojení ukončeno serverem, obnovuji');
            this._setState(State.DISCONNECTED, 'spojení ukončeno');
            this._scheduleReconnect();
        });
        ws.connect('error', (self, error) => {
            if (this._ws !== ws)
                return;
            this._logLimited('wserr', `websocket chyba: ${error.message}`);
        });

        this._setState(State.CONNECTED, '');
        if (this.onopen) {
            try {
                this.onopen();
            } catch (e) {
                this._logLimited('handler', `inicializace po připojení selhala: ${e.message}`);
            }
        }
    }

    _setState(state, detail) {
        this.state = state;
        this.detail = detail;
        if (this.onstate) {
            try {
                this.onstate(state, detail);
            } catch (e) {
                this._logLimited('handler', `callback změny stavu selhal: ${e.message}`);
            }
        }
    }

    _scheduleReconnect() {
        if (this._manualClose || this._reconnectId)
            return;
        const delay = this._backoff;
        this._backoff = Math.min(this._backoff * 2, 60);
        this._reconnectId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
            this._reconnectId = 0;
            if (!this._manualClose)
                this.open();
            return GLib.SOURCE_REMOVE;
        });
    }

    send(obj) {
        if (!this._ws)
            return false;
        try {
            // send_text na zavřený socket nevyhodí výjimku, jen GLib
            // CRITICAL do journalu - stav zkontrolovat předem
            if (this._ws.state !== Soup.WebsocketState.OPEN)
                return false;
            this._ws.send_text(JSON.stringify(obj));
            return true;
        } catch (e) {
            this._logLimited('send', `odesílání selhalo: ${e.message}`);
            return false;
        }
    }

    /** Zavře spojení bez naplánovaného reconnektu. */
    close() {
        this._manualClose = true;
        if (this._reconnectId) {
            GLib.source_remove(this._reconnectId);
            this._reconnectId = 0;
        }
        this._invalidateConnect();
        this._cleanupSocket();
        this._setState(State.DISCONNECTED, '');
    }

    reconnect() {
        this._manualClose = true;
        this._cleanupSocket();
        this.open();
    }

    _cleanupSocket() {
        if (this._ws) {
            try {
                this._ws.close(Soup.WebsocketCloseCode.NORMAL, null);
            } catch (e) {
                // socket už je zavřený - nic se neděje
            }
            this._ws = null;
        }
    }

    destroy() {
        this._destroyed = true;
        this.close();
        if (this._session && this._insecureHandler)
            this._session.disconnect(this._insecureHandler);
        this._session = null;
        this.onstate = null;
        this.onmessage = null;
        this.onopen = null;
        this.onclosed = null;
    }
};
