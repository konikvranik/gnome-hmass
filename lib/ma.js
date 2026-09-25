// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 pvranik
//
/*
 * Klient WebSocket API Music Assistant (MA 2.x, ověřeno proti 2.5 - 2.10).
 *
 * Protokol (https://github.com/music-assistant/server):
 *  - endpoint: ws(s)://host:8095/ws (starší verze: /websocketapi - zkouší se jako fallback)
 *  - po připojení server pošle info o serveru (server_version, ...)
 *  - příkaz: {"message_id": "<id>", "command": "...", "args": {...}}
 *  - odpověď: {"message_id": "<id>", "result": ...} nebo {"message_id": "<id>", "error_code": ..., "details": ...}
 *  - event: {"event": "...", "object_id": "...", "data": ...}
 *  - autentizace: command "auth" s args {token: "<API klíč>"}
 */

const GLib = imports.gi.GLib;
const Me = imports.misc.extensionUtils.getCurrentExtension();
const WsLib = Me.imports.lib.ws;

/** Z běžné http(s) adresy MA udělá kandidáty WS URL (nový i starý endpoint). */
function maWsUrls(baseUrl) {
    return [
        WsLib.wsUrlFromHttp(baseUrl, '/ws'),
        WsLib.wsUrlFromHttp(baseUrl, '/websocketapi'),
    ];
}

/** Info o aktuální skladbě dané fronty. */
function queueTrackInfo(queue, httpBase) {
    const item = queue && queue.current_item;
    if (!item)
        return {title: '', artist: '', album: '', duration: 0, artUrl: ''};
    const media = item.media_item || {};

    let artist = '';
    if (Array.isArray(media.artists) && media.artists.length > 0)
        artist = media.artists.map(a => (a && a.name) || '').filter(Boolean).join(', ');
    else if (Array.isArray(item.artists) && item.artists.length > 0)
        artist = item.artists.join(', ');
    else if (Array.isArray(media.authors) && media.authors.length > 0)
        artist = media.authors.map(a => (a && a.name) || '').filter(Boolean).join(', ');
    else if (Array.isArray(item.authors) && item.authors.length > 0)
        artist = item.authors.join(', ');
    else if (Array.isArray(media.narrators) && media.narrators.length > 0)
        artist = media.narrators.map(a => (a && a.name) || '').filter(Boolean).join(', ');

    let album = (media.album && media.album.name) || item.album || '';
    if (!album && media.metadata && media.metadata.series)
        album = media.metadata.series;
    else if (!album && media.publisher)
        album = media.publisher;

    let artUrl = '';
    const img = item.image || media.image || null;
    if (img) {
        const p = img.path || img.url || '';
        if (p) {
            if (p.startsWith('http://') || p.startsWith('https://'))
                artUrl = p;
            else if (httpBase)
                artUrl = httpBase.replace(/\/+$/, '') + (p.startsWith('/') ? p : '/' + p);
            else
                artUrl = p;
        }
    } else if (Array.isArray(media.images) && media.images.length > 0) {
        const first = media.images[0];
        const p = (first && (first.path || first.url)) || '';
        if (p) {
            if (p.startsWith('http://') || p.startsWith('https://'))
                artUrl = p;
            else if (httpBase)
                artUrl = httpBase.replace(/\/+$/, '') + (p.startsWith('/') ? p : '/' + p);
            else
                artUrl = p;
        }
    }

    return {
        title: media.name || item.name || '',
        artist,
        album,
        duration: typeof item.duration === 'number' ? item.duration : 0,
        artUrl,
    };
}

/** Aktuální pozice ve skladbě fronty (s), dopočtená lokálním časem. */
function queueElapsed(queue) {
    if (!queue || !queue.current_item || queue.state === 'idle' || queue.state === 'stopped')
        return 0;
    const elapsed = typeof queue.elapsed_time === 'number' ? queue.elapsed_time : 0;
    if (queue.state !== 'playing')
        return elapsed;
    const updated = typeof queue.elapsed_time_last_updated === 'number'
        ? queue.elapsed_time_last_updated : Date.now() / 1000;
    const delta = Math.max(0, Date.now() / 1000 - updated);
    const speed = typeof queue.playback_speed === 'number' ? queue.playback_speed : 1.0;
    return Math.max(0, elapsed + delta * speed);
}

var MAClient = class MAClient {
    constructor() {
        this.players = [];          // pole serializovaných objektů Player
        this.queue = null;          // aktivní fronta (pro menu)
        this.queues = {};           // queue_id -> fronta (všechny známé)
        this.playerQueues = {};     // player_id -> fronta (pro per-player MPRIS)
        this.activePlayerId = '';   // vybraný přehrávač (menu + výchozí příkazy)
        this.serverInfo = null;
        this.authenticated = false;
        this.djHosts = [];          // AI Radio DJ hosté [{id, name, ...}]
        this.queueDjStatus = {};    // queue_id -> host_id aktivního DJ

        this.onstate = null;      // (statusText, detail) 'ok'|'connecting'|'error'|'auth-error'|'disabled'
        this.onplayers = null;    // () - seznam přehrávačů se změnil
        this.onactive = null;     // () - změna aktivního přehrávače
        this.onqueue = null;      // () - změna aktivní fronty (skladba, stav, ...)
        this.onqueues = null;     // () - strukturální změna libovolné fronty (per-player MPRIS)
        this.onelapsed = null;    // () - změna uplynulého času aktivní fronty
        this.ondjinfo = null;     // () - změnil se seznam DJ hostů nebo stav DJ na frontách

        this._status = 'connecting';
        this._token = '';
        this._httpBase = '';
        this._defaultPlayerId = '';
        this._msgId = 0;
        this._pending = {};       // message_id -> {player_id} pro get_active_queue
        this._requests = {};      // message_id -> {resolve, reject} jednorázové požadavky
        this._djInfoLoaded = false;
        this._lastErrLogTs = -Infinity;
        this._ws = new WsLib.WsClient('musicassistant');

        this._ws.onopen = () => this._onOpen();
        this._ws.onstate = (st, detail) => {
            if (st === WsLib.State.CONNECTING) {
                this._setStatus('connecting', detail);
            } else if (st === WsLib.State.DISCONNECTED) {
                this.queues = {};
                this.playerQueues = {};
                this._pending = {};
                this._failRequests('bez spojení');
                this.authenticated = false;
                // auth-error zůstává vidět, dokud uživatel nezmění API klíč
                if (this._status !== 'auth-error')
                    this._setStatus('error', detail || 'bez spojení');
            }
        };
        this._ws.onmessage = msg => this._onMessage(msg);
    }

    _setStatus(status, detail) {
        this._status = status;
        if (this.onstate)
            this.onstate(status, detail);
    }

    /** Chyba příkazu se loguje maximálně jednou za minutu. */
    _logLimited(msg) {
        const now = GLib.get_monotonic_time();
        if (now - this._lastErrLogTs < 60 * 1000 * 1000)
            return;
        this._lastErrLogTs = now;
        log(`[musicassistant] ${msg}`);
    }

    get status() {
        return this._status;
    }

    configure(url, token, allowInsecure, defaultPlayerId) {
        this._token = token || '';
        this._httpBase = (url || '').trim();
        this._defaultPlayerId = defaultPlayerId || '';
        this._ws.setTarget(maWsUrls(this._httpBase), this._token, allowInsecure);
    }

    connect() {
        if (!this._httpBase) {
            this._setStatus('disabled', '');
            return;
        }
        this._ws.open();
        this._setStatus('connecting', '');
    }

    disconnect() {
        this._ws.close();
        this.players = [];
        this.queue = null;
        this.queues = {};
        this.playerQueues = {};
        this._pending = {};
        this.authenticated = false;
        this._setStatus('disabled', '');
    }

    reconnect() {
        if (!this._httpBase) {
            this._setStatus('disabled', '');
            return;
        }
        this._ws.reconnect();
        this._setStatus('connecting', '');
    }

    destroy() {
        this._ws.destroy();
    }

    _send(command, args) {
        this._msgId += 1;
        const id = `hmass-${this._msgId}`;
        const ok = this._ws.send({message_id: id, command, args: args || {}});
        return ok ? id : null;
    }

    /**
     * Jednorázový požadavek s odpovědí přes Promise.
     * Selže, když spojení není otevřené nebo server vrátí chybu.
     */
    _request(command, args) {
        return new Promise((resolve, reject) => {
            const id = this._send(command, args);
            if (!id) {
                reject(new Error('není navázáno spojení'));
                return;
            }
            this._requests[id] = {resolve, reject};
        });
    }

    _failRequests(detail) {
        for (const id of Object.keys(this._requests)) {
            this._requests[id].reject(new Error(detail));
            delete this._requests[id];
        }
    }

    _onOpen() {
        this.authenticated = false;
        this._djInfoLoaded = false;
        if (this._token)
            this._send('auth', {token: this._token});
        this._refreshPlayers();
    }

    _refreshPlayers() {
        this._send('players/all');
    }

    /** Načte aktivní frontu pro všechny známé přehrávače. */
    _refreshAllQueues() {
        for (const p of this.players) {
            const mid = this._send('player_queues/get_active_queue', {player_id: p.player_id});
            if (mid)
                this._pending[mid] = {player_id: p.player_id};
        }
    }

    _onMessage(msg) {
        if (!msg || typeof msg !== 'object')
            return;
        if (msg.event) {
            this._onEvent(msg);
            return;
        }
        if (msg.server_version !== undefined) {
            this.serverInfo = msg;
            if (this._token)
                this._send('auth', {token: this._token});
            this._refreshPlayers();
            return;
        }
        if (msg.message_id === undefined)
            return;
        if (msg.error_code !== undefined) {
            const details = msg.details || `chyba ${msg.error_code}`;
            this._logLimited(`příkaz selhal: ${details}`);
            const failedReq = this._requests[msg.message_id];
            if (failedReq) {
                delete this._requests[msg.message_id];
                failedReq.reject(new Error(details));
            }
            if (/auth|token|permission/i.test(details) || msg.error_code === 401 || msg.error_code === 403)
                this._setStatus('auth-error', 'odmítnuto - zkontroluj API klíč');
            else if (this._status !== 'ok')
                this._setStatus('error', details);
            return;
        }
        // úspěšná odpověď
        if (!this.authenticated && this._token)
            this.authenticated = true;
        if (this._status !== 'ok')
            this._setStatus('ok', this.serverInfo ? `MA ${this.serverInfo.server_version || ''}`.trim() : '');

        const req = this._requests[msg.message_id];
        if (req) {
            delete this._requests[msg.message_id];
            req.resolve(msg.result);
            return;
        }

        // players/all se pozná podle pole objektů s player_id;
        // nevalidní prvky (null apod.) vynecháme
        if (Array.isArray(msg.result) && msg.result.length > 0 &&
                msg.result[0] && msg.result[0].player_id !== undefined) {
            this.players = msg.result.filter(p => p && p.player_id !== undefined);
            this._pickActivePlayer();
            if (this.onplayers)
                this.onplayers();
            this._refreshAllQueues();
            if (!this._djInfoLoaded) {
                this._djInfoLoaded = true;
                this.refreshDjInfo();
            }
            return;
        }
        if (msg.result && msg.result.queue_id !== undefined) {
            const queue = msg.result;
            const pending = this._pending[msg.message_id];
            delete this._pending[msg.message_id];
            this.queues[queue.queue_id] = queue;
            if (pending && pending.player_id) {
                this.playerQueues[pending.player_id] = queue;
                if (this.onqueues)
                    this.onqueues();
                if (pending.player_id === this.activePlayerId) {
                    this.queue = queue;
                    if (this.onqueue)
                        this.onqueue();
                }
            } else {
                // bez kontextu bereme jako frontu aktivního přehrávače
                this.queue = queue;
                if (this.onqueue)
                    this.onqueue();
            }
            return;
        }
        if (msg.result && msg.result.server_version !== undefined) {
            this.serverInfo = msg.result;
        }
    }

    _pickActivePlayer() {
        const configured = this._defaultPlayerId;
        if (configured && this.players.some(p => p.player_id === configured)) {
            this.setActivePlayer(configured, true);
            return;
        }
        const playing = this.players.find(p => p.playback_state === 'playing');
        const next = playing || this.players[0];
        if (next && next.player_id !== this.activePlayerId)
            this.setActivePlayer(next.player_id, true);
        else if (!next)
            this.activePlayerId = '';
    }

    _onEvent(ev) {
        switch (ev.event) {
            case 'player_updated': {
                const player = ev.data;
                if (!player || !player.player_id)
                    return;
                const idx = this.players.findIndex(p => p.player_id === player.player_id);
                const isNew = idx < 0;
                if (idx >= 0)
                    this.players[idx] = player;
                else
                    this.players.push(player);
                if (this.onplayers)
                    this.onplayers();
                if (player.player_id === this.activePlayerId && this.onactive)
                    this.onactive();
                if (isNew) {
                    const mid = this._send('player_queues/get_active_queue',
                        {player_id: player.player_id});
                    if (mid)
                        this._pending[mid] = {player_id: player.player_id};
                }
                break;
            }
            case 'player_removed':
                this.players = this.players.filter(p => p.player_id !== ev.object_id);
                delete this.playerQueues[ev.object_id];
                if (ev.object_id === this.activePlayerId)
                    this._pickActivePlayer();
                if (this.onplayers)
                    this.onplayers();
                break;
            case 'queue_added':
                this._refreshAllQueues();
                break;
            case 'queue_updated': {
                const queue = ev.data;
                if (!queue || !queue.queue_id)
                    return;
                this.queues[queue.queue_id] = queue;
                for (const playerId of Object.keys(this.playerQueues)) {
                    const q = this.playerQueues[playerId];
                    if (q && q.queue_id === queue.queue_id)
                        this.playerQueues[playerId] = queue;
                }
                if (this.queue && this.queue.queue_id === queue.queue_id) {
                    this.queue = queue;
                    if (this.onqueue)
                        this.onqueue();
                }
                if (this.onqueues)
                    this.onqueues();
                break;
            }
            case 'queue_time_updated': {
                const elapsed = typeof ev.data === 'number' ? ev.data : 0;
                const q = this.queues[ev.object_id];
                if (q) {
                    q.elapsed_time = elapsed;
                    q.elapsed_time_last_updated = Date.now() / 1000;
                }
                if (this.queue && ev.object_id === this.queue.queue_id && this.onelapsed)
                    this.onelapsed();
                break;
            }
            default:
                break;
        }
    }

    // ---- veřejné API ----

    get activePlayer() {
        return this.players.find(p => p.player_id === this.activePlayerId) || null;
    }

    setActivePlayer(playerId, silent) {
        if (this.activePlayerId === playerId)
            return;
        this.activePlayerId = playerId;
        this.queue = this.playerQueues[playerId] || null;
        if (!silent && this.onactive)
            this.onactive();
        if (!this.queue) {
            const mid = this._send('player_queues/get_active_queue', {player_id: playerId});
            if (mid)
                this._pending[mid] = {player_id: playerId};
        }
        if (this.onplayers)
            this.onplayers();
    }

    /** Aktuální pozice ve skladbě aktivní fronty (s). */
    currentElapsed() {
        return queueElapsed(this.queue);
    }

    get playing() {
        const q = this.queue;
        return !!q && q.state === 'playing';
    }

    // Info o aktuální skladbě
    trackInfo() {
        return queueTrackInfo(this.queue, this._httpBase);
    }

    // ---- příkazy (volitelný playerId; výchozí = aktivní přehrávač) ----

    _pid(playerId) {
        return playerId || this.activePlayerId;
    }

    play(playerId) {
        this._send('players/cmd/play', {player_id: this._pid(playerId)});
    }

    pause(playerId) {
        this._send('players/cmd/pause', {player_id: this._pid(playerId)});
    }

    playPause(playerId) {
        this._send('players/cmd/play_pause', {player_id: this._pid(playerId)});
    }

    stop(playerId) {
        this._send('players/cmd/stop', {player_id: this._pid(playerId)});
    }

    next(playerId) {
        this._send('players/cmd/next', {player_id: this._pid(playerId)});
    }

    previous(playerId) {
        this._send('players/cmd/previous', {player_id: this._pid(playerId)});
    }

    /** position v sekundách */
    seek(position, playerId) {
        this._send('players/cmd/seek', {
            player_id: this._pid(playerId),
            position: Math.round(position),
        });
    }

    /** volume 0..100 */
    setVolume(volumeLevel, playerId) {
        const pid = this._pid(playerId);
        const player = this.players.find(p => p.player_id === pid);
        const isGroup = player && (player.type === 'sync_group' || player.type === 'group' || player.group_childs !== undefined);
        const cmd = (isGroup && player.volume_level === null) ? 'players/cmd/group_volume' : 'players/cmd/volume_set';
        this._send(cmd, {
            player_id: pid,
            volume_level: Math.round(volumeLevel),
        });
    }

    setMuted(muted, playerId) {
        this._send('players/cmd/volume_mute', {
            player_id: this._pid(playerId),
            muted: !!muted,
        });
    }

    setShuffle(enabled, playerId) {
        this._send('players/cmd/shuffle', {
            player_id: this._pid(playerId),
            shuffle_enabled: !!enabled,
        });
    }

    /** mode: 'off' | 'one' | 'all' */
    setRepeat(mode, playerId) {
        this._send('players/cmd/repeat', {
            player_id: this._pid(playerId),
            repeat_mode: mode,
        });
    }

    /**
     * AI Radio DJ v MA = sticky DJ host na frontě (ai_radio/queue_dj).
     * host_id = null DJ na frontě vypne.
     * MA WebSocket příkazy: ai_radio/hosts/list, ai_radio/queue_dj/set|status
     * @param {string} queueId
     * @param {string|null} hostId
     */
    setDjHost(queueId, hostId) {
        return this._request('ai_radio/queue_dj/set', {
            queue_id: queueId,
            host_id: hostId === undefined ? null : hostId,
        }).then(status => {
            // odpověď je kompletní mapování queue_id -> host_id po změně
            this.queueDjStatus = status || {};
            if (this.ondjinfo)
                this.ondjinfo();
            return status;
        });
    }

    getDjHosts() {
        return this._request('ai_radio/hosts/list', {});
    }

    getQueueDjStatus() {
        return this._request('ai_radio/queue_dj/status', {});
    }

    /** Načte seznam DJ hostů a stav DJ na všech frontách. */
    refreshDjInfo() {
        Promise.all([this.getDjHosts(), this.getQueueDjStatus()])
            .then(([hosts, status]) => {
                this.djHosts = Array.isArray(hosts) ? hosts : [];
                this.queueDjStatus = status || {};
                if (this.ondjinfo)
                    this.ondjinfo();
            })
            .catch(e => this._logLimited(`AI Radio DJ info selhalo: ${e.message}`));
    }
};

/**
 * Pohled na jednu konkrétní frontu přehrávače - povrch pro MprisBridge.
 * Používá se pro per-player MPRIS: každý vybraný přehrávač má vlastní
 * D-Bus jméno org.mpris.MediaPlayer2.hmass.<suffix>.
 */
var PlayerView = class PlayerView {
    constructor(client, playerId) {
        this._c = client;
        this.playerId = playerId;
    }

    get activePlayer() {
        return this._c.players.find(p => p.player_id === this.playerId) || null;
    }

    get playerName() {
        const p = this.activePlayer;
        return (p && p.name) || this.playerId;
    }

    get queue() {
        return this._c.playerQueues[this.playerId] || null;
    }

    trackInfo() {
        return queueTrackInfo(this.queue, this._c._httpBase);
    }

    currentElapsed() {
        return queueElapsed(this.queue);
    }

    play() {
        this._c.play(this.playerId);
    }

    pause() {
        this._c.pause(this.playerId);
    }

    playPause() {
        this._c.playPause(this.playerId);
    }

    stop() {
        this._c.stop(this.playerId);
    }

    next() {
        this._c.next(this.playerId);
    }

    previous() {
        this._c.previous(this.playerId);
    }

    seek(position) {
        this._c.seek(position, this.playerId);
    }

    setVolume(volumeLevel) {
        this._c.setVolume(volumeLevel, this.playerId);
    }

    setMuted(muted) {
        this._c.setMuted(muted, this.playerId);
    }

    setShuffle(enabled) {
        this._c.setShuffle(enabled, this.playerId);
    }

    setRepeat(mode) {
        this._c.setRepeat(mode, this.playerId);
    }

    setDjHost(hostId) {
        const q = this.queue;
        return this._c.setDjHost((q && q.queue_id) || this.playerId, hostId);
    }
};
