// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 pvranik
//
/*
 * Adaptér entity Home Assistant media_player na povrch přehrávače pro
 * MprisBridge. HA volume_level je 0..1 (MA 0..100), pozice se dopočítává
 * z media_position + media_position_updated_at, seek v HA je relativní.
 */

const Me = imports.misc.extensionUtils.getCurrentExtension();

var HaPlayerAdapter = class HaPlayerAdapter {
    /**
     * @param ha HAClient
     * @param entityId entity_id přehrávače (media_player.neco)
     */
    constructor(ha, entityId) {
        this.ha = ha;
        this.entityId = entityId;
    }

    get _state() {
        return this.ha.states[this.entityId] || null;
    }

    get _attrs() {
        const st = this._state;
        return (st && st.attributes) || {};
    }

    get activePlayer() {
        const st = this._state;
        if (!st)
            return null;
        const a = st.attributes || {};
        const vol = typeof a.volume_level === 'number' ? a.volume_level : null;
        return {
            player_id: this.entityId,
            name: a.friendly_name || this.entityId,
            volume_level: vol === null ? null : Math.round(Math.min(1, Math.max(0, vol)) * 100),
            volume_muted: !!a.is_volume_muted,
        };
    }

    get playerName() {
        const a = this._attrs;
        return a.friendly_name || this.entityId;
    }

    get queue() {
        const st = this._state;
        if (!st)
            return null;
        const a = st.attributes || {};
        const playing = st.state === 'playing';
        const paused = st.state === 'paused';
        const elapsed = typeof a.media_position === 'number' ? a.media_position : 0;
        const updatedAt = a.media_position_updated_at
            ? Date.parse(a.media_position_updated_at) / 1000 : null;
        const item = a.media_title
            ? {
                name: a.media_title,
                duration: typeof a.media_duration === 'number' ? a.media_duration : 0,
                media_item: {
                    name: a.media_title,
                    artists: a.media_artist ? [{name: a.media_artist}] : [],
                    album: a.media_album_name ? {name: a.media_album_name} : null,
                },
            }
            : null;
        return {
            queue_id: this.entityId,
            state: playing ? 'playing' : (paused ? 'paused' : 'idle'),
            shuffle_enabled: !!a.shuffle,
            repeat_mode: (a.repeat === 'one' || a.repeat === 'all') ? a.repeat : 'off',
            elapsed_time: elapsed,
            elapsed_time_last_updated: updatedAt,
            current_item: item,
        };
    }

    trackInfo() {
        const q = this.queue;
        const item = q && q.current_item;
        if (!item)
            return {title: '', artist: '', album: '', duration: 0, artUrl: ''};
        let artUrl = this._attrs.entity_picture || '';
        if (artUrl && artUrl.startsWith('/') && this.ha && this.ha._url)
            artUrl = this.ha._url.replace(/\/+$/, '') + artUrl;
        return {
            title: media.name || item.name || '',
            artist: media.artists && media.artists.length > 0 ? media.artists[0].name : '',
            album: media.album ? media.album.name : '',
            duration: item.duration || 0,
            artUrl,
        };
    }

    currentElapsed() {
        const q = this.queue;
        if (!q)
            return 0;
        const elapsed = q.elapsed_time || 0;
        if (q.state !== 'playing' || !q.elapsed_time_last_updated)
            return elapsed;
        const delta = Math.max(0, Date.now() / 1000 - q.elapsed_time_last_updated);
        return elapsed + delta;
    }

    // ---- příkazy přes HA služby ----

    _call(service, data) {
        this.ha.callService('media_player', service, Object.assign(
            {entity_id: this.entityId}, data || {}));
    }

    play() {
        this._call('media_play');
    }

    pause() {
        this._call('media_pause');
    }

    playPause() {
        this._call('media_play_pause');
    }

    stop() {
        this._call('media_stop');
    }

    next() {
        this._call('media_next_track');
    }

    previous() {
        this._call('media_previous_track');
    }

    /** absolutní pozice v sekundách - HA seek je relativní */
    seek(position) {
        const target = Math.max(0, Math.round(position - this.currentElapsed()));
        if (target > 0)
            this._call('media_seek', {seek_position: target});
    }

    /** volume 0..100 (HA 0..1) */
    setVolume(volumeLevel) {
        this._call('volume_set', {
            volume_level: Math.round(Math.min(1, Math.max(0, volumeLevel / 100)) * 100) / 100,
        });
    }

    setMuted(muted) {
        this._call('volume_mute', {is_volume_muted: !!muted});
    }

    setShuffle(enabled) {
        this._call('shuffle_set', {shuffle: !!enabled});
    }

    setRepeat(mode) {
        this._call('repeat_set', {repeat: mode || 'off'});
    }
};
