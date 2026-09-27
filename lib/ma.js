// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 konikvranik
//
/*
 * Music Assistant WebSocket API client (MA 2.x, verified against 2.5 - 2.10).
 *
 * Protocol (https://github.com/music-assistant/server):
 *  - endpoint: ws(s)://host:8095/ws (older versions: /websocketapi - tried as fallback)
 *  - upon connect server sends server info (server_version, ...)
 *  - command: {"message_id": "<id>", "command": "...", "args": {...}}
 *  - response: {"message_id": "<id>", "result": ...} or {"message_id": "<id>", "error_code": ..., "details": ...}
 *  - event: {"event": "...", "object_id": "...", "data": ...}
 *  - authentication: command "auth" with args {token: "<API key>"}
 */

import GLib from 'gi://GLib';
import * as WsLib from './ws.js';
import {_} from './i18n.js';

/** Builds candidate WS URLs from http(s) MA base URL (new and legacy endpoints). */
export function maWsUrls(baseUrl) {
    return [
        WsLib.wsUrlFromHttp(baseUrl, '/ws'),
        WsLib.wsUrlFromHttp(baseUrl, '/websocketapi'),
    ];
}

/** Info about current track in given queue. */
export function queueTrackInfo(queue, httpBase) {
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

/** Current position in queue track (s), computed using local time. */
export function queueElapsed(queue) {
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

export class MAClient {
    constructor() {
        this.players = [];          // array of serialized Player objects
        this.queue = null;          // active queue (for menu)
        this.queues = {};           // queue_id -> queue (all known)
        this.playerQueues = {};     // player_id -> queue (for per-player MPRIS)
        this.activePlayerId = '';   // selected player (menu + default commands)
        this.serverInfo = null;
        this.authenticated = false;
        this.djHosts = [];          // AI Radio DJ hosts [{id, name, ...}]
        this.queueDjStatus = {};    // queue_id -> host_id of active DJ

        this.onstate = null;      // (statusText, detail) 'ok'|'connecting'|'error'|'auth-error'|'disabled'
        this.onplayers = null;    // () - player list changed
        this.onactive = null;     // () - active player changed
        this.onqueue = null;      // () - active queue changed (track, state, ...)
        this.onqueues = null;     // () - structural change of any queue (per-player MPRIS)
        this.onelapsed = null;    // () - elapsed time of active queue changed
        this.ondjinfo = null;     // () - DJ hosts or queue DJ status changed

        this._status = 'connecting';
        this._token = '';
        this._httpBase = '';
        this._defaultPlayerId = '';
        this._msgId = 0;
        this._pending = {};       // message_id -> {player_id} for get_active_queue
        this._requests = {};      // message_id -> {resolve, reject} one-shot requests
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
                this._failRequests(_('no connection'));
                this.authenticated = false;
                // auth-error remains visible until user changes API key
                if (this._status !== 'auth-error')
                    this._setStatus('error', detail || _('no connection'));
            }
        };
        this._ws.onmessage = msg => this._onMessage(msg);
    }

    _setStatus(status, detail) {
        this._status = status;
        if (this.onstate)
            this.onstate(status, detail);
    }

    /** Command error is logged at most once per minute. */
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
     * One-shot request with Promise response.
     * Fails when connection is not open or server returns error.
     */
    _request(command, args) {
        return new Promise((resolve, reject) => {
            const id = this._send(command, args);
            if (!id) {
                reject(new Error(_('no connection')));
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

    /** Fetches active queue for all known players. */
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
            const details = msg.details || `error ${msg.error_code}`;
            this._logLimited(`command failed: ${details}`);
            const failedReq = this._requests[msg.message_id];
            if (failedReq) {
                delete this._requests[msg.message_id];
                failedReq.reject(new Error(details));
            }
            if (/auth|token|permission/i.test(details) || msg.error_code === 401 || msg.error_code === 403)
                this._setStatus('auth-error', _('denied - check the API key'));
            else if (this._status !== 'ok')
                this._setStatus('error', details);
            return;
        }
        // successful response
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

        // players/all is identified by array of objects with player_id;
        // invalid items are filtered out
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
                // without context consider as active player queue
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

    // ---- public API ----

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

    /** Current position in active queue track (s). */
    currentElapsed() {
        return queueElapsed(this.queue);
    }

    get playing() {
        const q = this.queue;
        return !!q && q.state === 'playing';
    }

    // Info about current track
    trackInfo() {
        return queueTrackInfo(this.queue, this._httpBase);
    }

    // ---- commands (optional playerId; default = active player) ----

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

    /** position in seconds */
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
     * AI Radio DJ in MA = sticky DJ host on queue (ai_radio/queue_dj).
     * host_id = null turns off DJ on queue.
     * MA WebSocket commands: ai_radio/hosts/list, ai_radio/queue_dj/set|status
     * @param {string} queueId
     * @param {string|null} hostId
     */
    setDjHost(queueId, hostId) {
        return this._request('ai_radio/queue_dj/set', {
            queue_id: queueId,
            host_id: hostId === undefined ? null : hostId,
        }).then(status => {
            // response is complete queue_id -> host_id mapping after change
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

    /** Fetches DJ host list and DJ status on all queues. */
    refreshDjInfo() {
        Promise.all([this.getDjHosts(), this.getQueueDjStatus()])
            .then(([hosts, status]) => {
                this.djHosts = Array.isArray(hosts) ? hosts : [];
                this.queueDjStatus = status || {};
                if (this.ondjinfo)
                    this.ondjinfo();
            })
            .catch(e => this._logLimited(`AI Radio DJ info failed: ${e.message}`));
    }
};

/**
 * View of one specific player queue - surface for MprisBridge.
 * Used for per-player MPRIS: each selected player has its own
 * D-Bus name org.mpris.MediaPlayer2.hmass.<suffix>.
 */
export class PlayerView {
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
