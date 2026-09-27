// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 konikvranik
//
/*
 * Simple JSON WebSocket client on top of libsoup with automatic
 * reconnection. GNOME Shell 42+ (legacy and ESM imports).
 *
 * Resilience against unreachable server:
 *  - reconnect with exponential backoff (1 -> 60 s)
 *  - 20 s watchdog on hanging connect (cancels via GCancellable)
 *  - client callback exceptions do not break the message loop
 *  - repeating errors are logged at most once per minute
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';
import {_} from './i18n.js';
// %s/%d substitution - String.format from GNOME Shell environment is not
// present here (pure gjs / prefs process)
const _f = (str, ...args) => str.replace(/%[sd]/g, () => args.shift());

const _decoder = new TextDecoder();

const LOG_INTERVAL_US = 60 * 1000 * 1000; // same log key max once per minute
const CONNECT_TIMEOUT_S = 20;             // abort hanging connection

export const State = {
    DISCONNECTED: 'disconnected',
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
};

/** Converts GBytes/Uint8Array from 'message' signal to string. */
export function decodeBytes(data) {
    if (data instanceof Uint8Array)
        return _decoder.decode(data);
    if (data && typeof data.get_data === 'function')
        return _decoder.decode(data.get_data());
    return '';
}

/**
 * Converts http(s) URL to ws(s) and appends path.
 * wsUrlFromHttp('http://ha:8123', '/api/websocket') -> 'ws://ha:8123/api/websocket'
 */
export function wsUrlFromHttp(base, path) {
    let s = (base || '').trim().replace(/\/+$/, '');
    if (!s)
        return '';
    if (s.endsWith('/api') && path.startsWith('/api/'))
        s = s.slice(0, -4);
    if (s.startsWith('ws://') || s.startsWith('wss://')) {
        // already a websocket URL - add path only if not present
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

export function _createSoupMessage(method, url) {
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

export class WsClient {
    constructor(name) {
        this.name = name;
        this.state = State.DISCONNECTED;
        this.detail = '';

        this.onstate = null;   // (state, detail)
        this.onopen = null;    // () - socket opened (application handshake begins)
        this.onmessage = null; // (obj) - parsed JSON messages
        this.onclosed = null;  // (detail) - socket closed (before scheduled reconnect)

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
        this._connectGen = 0;          // invalidates responses from obsolete attempts
        this._connectCancellable = null;
        this._watchdogId = 0;
        this._logTs = {};              // key -> timestamp of last log (µs)
    }

    /** Sets target. urls: array of WS URLs (fallback order). */
    setTarget(urls, token, allowInsecure) {
        this._urls = urls.filter(u => !!u);
        this._token = token || '';
        this._allowInsecure = !!allowInsecure;
    }

    get connected() {
        return this.state === State.CONNECTED && this._ws !== null;
    }

    /** Log with throttle: same key at most once per minute. */
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
                // property not available - covered by watchdog
            }
            if (this._allowInsecure) {
                // libsoup >= 3.2; signal missing on older version, simply ignored
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

    /** Cancels pending connection attempt (watchdog and async callback). */
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
                // connection did not open within timeout - try next URL / reconnect
                this._advanceUrl(_f(_('connection did not open within %s s'), CONNECT_TIMEOUT_S));
                return GLib.SOURCE_REMOVE;
            });
    }

    _tryConnect() {
        const url = this._urls[this._urlIdx];
        const message = _createSoupMessage('GET', url);
        if (!message) {
            this._advanceUrl(_f(_('invalid URL (cannot create message): %s'), url));
            return;
        }
        if (this._token)
            message.request_headers.append('Authorization', `Bearer ${this._token}`);

        const gen = ++this._connectGen;
        const cancellable = new Gio.Cancellable();
        this._connectCancellable = cancellable;
        this._armWatchdog();

        const callback = (sess, res) => {
            // ignore result after destroy() or superseded attempt
            if (!this._session || gen !== this._connectGen)
                return;
            let ws = null;
            try {
                ws = sess.websocket_connect_finish(res);
            } catch (e) {
                this._advanceUrl(_f(_('connection failed: %s'), e.message));
                return;
            }
            this._onWsOpen(ws);
        };

        try {
            // Libsoup 2.4 takes 5 arguments: (message, origin, protocols, cancellable, callback)
            // Libsoup 3.0 takes 6 arguments: (message, origin, protocols, io_priority, cancellable, callback)
            try {
                this._session.websocket_connect_async(
                    message, null, null, cancellable, callback);
            } catch (argErr) {
                this._session.websocket_connect_async(
                    message, null, null, GLib.PRIORITY_DEFAULT, cancellable, callback);
            }
        } catch (e) {
            this._advanceUrl(_f(_('connection failed: %s'), e.message));
        }
    }

    _advanceUrl(reason) {
        this._invalidateConnect();
        this._urlIdx++;
        if (this._urlIdx < this._urls.length) {
            this._logLimited('fallback', `${reason}, trying ${this._urls[this._urlIdx]}`);
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
                this._logLimited('json', `invalid JSON message: ${e.message}`);
                return;
            }
            if (this.onmessage) {
                try {
                    this.onmessage(obj);
                } catch (e) {
                    this._logLimited('handler', `message processing failed: ${e.message}`);
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
            this._logLimited('closed', 'connection closed by server, reconnecting');
            this._setState(State.DISCONNECTED, _('connection closed by server'));
            this._scheduleReconnect();
        });
        ws.connect('error', (self, error) => {
            if (this._ws !== ws)
                return;
            this._logLimited('wserr', `websocket error: ${error.message}`);
        });

        this._setState(State.CONNECTED, '');
        if (this.onopen) {
            try {
                this.onopen();
            } catch (e) {
                this._logLimited('handler', `post-connect initialization failed: ${e.message}`);
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
                this._logLimited('handler', `state change callback failed: ${e.message}`);
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
            // send_text on closed socket does not throw exception, only GLib
            // CRITICAL in journal - check socket state beforehand
            if (this._ws.state !== Soup.WebsocketState.OPEN)
                return false;
            this._ws.send_text(JSON.stringify(obj));
            return true;
        } catch (e) {
            this._logLimited('send', `send failed: ${e.message}`);
            return false;
        }
    }

    /** Closes connection without scheduling a reconnect. */
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
                // socket already closed - ignore
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
