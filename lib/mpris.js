// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 pvranik
//
/*
 * MPRIS most: vystaví Music Assistant jako MPRIS přehrávač na D-Bus,
 * takže multimediální klávesy a nativní GNOME ovládání médií ovládají MA.
 *
 * Implementace používá ruční vtable přes Gio.DBusConnection.register_object,
 * protože GJS 1.72 (GNOME 42) umí z XML zaregistrovat jen jedno rozhraní
 * a dva wrappery na stejné cestě si kolidují v Properties dispatchi.
 */

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;

var BUS_NAME = 'org.mpris.MediaPlayer2.hmass';
var OBJECT_PATH = '/org/mpris/MediaPlayer2';
var ROOT_IFACE = 'org.mpris.MediaPlayer2';
var PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
var PROPS_IFACE = 'org.freedesktop.DBus.Properties';

const FULL_XML = `
<node>
  <interface name="org.mpris.MediaPlayer2">
    <method name="Raise"/>
    <method name="Quit"/>
    <property name="CanQuit" type="b" access="read"/>
    <property name="CanRaise" type="b" access="read"/>
    <property name="HasTrackList" type="b" access="read"/>
    <property name="Identity" type="s" access="read"/>
    <property name="DesktopEntry" type="s" access="read"/>
    <property name="SupportedUriSchemas" type="as" access="read"/>
    <property name="SupportedMimeTypes" type="as" access="read"/>
    <property name="CanSetFullscreen" type="b" access="read"/>
    <property name="Fullscreen" type="b" access="readwrite"/>
  </interface>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="Next"/>
    <method name="Previous"/>
    <method name="Pause"/>
    <method name="PlayPause"/>
    <method name="Stop"/>
    <method name="Play"/>
    <method name="Seek">
      <arg type="x" direction="in"/>
    </method>
    <method name="SetPosition">
      <arg type="o" direction="in"/>
      <arg type="x" direction="in"/>
    </method>
    <method name="OpenUri">
      <arg type="s" direction="in"/>
    </method>
    <signal name="Seeked">
      <arg type="x"/>
    </signal>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="LoopStatus" type="s" access="readwrite"/>
    <property name="Rate" type="d" access="readwrite"/>
    <property name="Shuffle" type="b" access="readwrite"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="Volume" type="d" access="readwrite"/>
    <property name="Position" type="x" access="read"/>
    <property name="MinimumRate" type="d" access="read"/>
    <property name="MaximumRate" type="d" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
    <property name="CanControl" type="b" access="read"/>
  </interface>
</node>`;

const PROPS_XML = `
<node>
  <interface name="org.freedesktop.DBus.Properties">
    <method name="Get">
      <arg type="s" name="interface_name" direction="in"/>
      <arg type="s" name="property_name" direction="in"/>
      <arg type="v" name="value" direction="out"/>
    </method>
    <method name="GetAll">
      <arg type="s" name="interface_name" direction="in"/>
      <arg type="a{sv}" name="properties" direction="out"/>
    </method>
    <method name="Set">
      <arg type="s" name="interface_name" direction="in"/>
      <arg type="s" name="property_name" direction="in"/>
      <arg type="v" name="value" direction="in"/>
    </method>
    <signal name="PropertiesChanged">
      <arg type="s" name="interface_name"/>
      <arg type="a{sv}" name="changed_properties"/>
      <arg type="as" name="invalidated_properties"/>
    </signal>
  </interface>
</node>`;

function _sanitizeSuffix(suffix) {
    return String(suffix || '').replace(/[^A-Za-z0-9_]/g, '_');
}

function _toObjectPath(basePath, id) {
    const cleaned = String(id || 'none').replace(/[^A-Za-z0-9]/g, '_');
    return `${basePath}/track/${cleaned}`;
}

function _repeatToLoop(mode) {
    if (mode === 'one')
        return 'Track';
    if (mode === 'all')
        return 'Playlist';
    return 'None';
}

function _loopToRepeat(loop) {
    if (loop === 'Track')
        return 'one';
    if (loop === 'Playlist')
        return 'all';
    return 'off';
}

var MprisBridge = class MprisBridge {
    /**
     * @param client objekt s povrchem přehrávače (queue, activePlayer,
     *                trackInfo(), currentElapsed(), příkazy *) - MAClient,
     *                MAClient.PlayerView nebo HaPlayerAdapter
     * @param suffix přípona D-Bus jména pro druhý a další přehrávač
     *               (org.mpris.MediaPlayer2.hmass.<suffix>); null = základní jméno
     * @param identityPrefix název zdroje v Identity ("Music Assistant"/"Home Assistant")
     */
    constructor(client, suffix, identityPrefix) {
        this._client = client;
        this._identityPrefix = identityPrefix || 'Music Assistant';
        this._suffix = suffix || null;
        if (suffix) {
            const s = _sanitizeSuffix(suffix);
            this._busName = `${BUS_NAME}.${s}`;
        } else {
            this._busName = BUS_NAME;
        }
        this._path = OBJECT_PATH;
        this._connection = null;
        this._started = false;
        this._nameId = 0;
        this._regIds = [];
        this._lastTrackKey = null;
        this._lastPropValues = new Map();
    }

    // ---- hodnoty vlastností ----

    _identity() {
        const p = this._client.activePlayer;
        const name = (p && p.name) ||
                     (typeof this._client.playerName === 'string' ? this._client.playerName : '') ||
                     (this._suffix ? this._suffix.replace(/^(ma_|ha_)/, '') : '');
        return name ? `${name} (${this._identityPrefix})` : this._identityPrefix;
    }

    _playbackStatus() {
        const q = this._client.queue;
        if (!q)
            return 'Stopped';
        if (q.state === 'playing')
            return 'Playing';
        if (q.state === 'paused')
            return 'Paused';
        return 'Stopped';
    }

    _metadata() {
        const info = this._client.trackInfo();
        const status = this._playbackStatus();
        if (!info || !info.title || status === 'Stopped') {
            const p = this._client.activePlayer;
            const pName = p && p.name ? p.name : '';
            return new GLib.Variant('a{sv}', {
                'mpris:trackid': new GLib.Variant('o', '/org/mpris/MediaPlayer2/TrackList/NoTrack'),
                'xesam:title': new GLib.Variant('s', pName || 'Nic se nepřehrává'),
                'xesam:artist': new GLib.Variant('as', []),
                'xesam:album': new GLib.Variant('s', ''),
            });
        }
        const meta = {
            'mpris:trackid': new GLib.Variant('o', _toObjectPath(this._path, info.title)),
            'mpris:length': new GLib.Variant('x', Math.round((info.duration || 0) * 1000000)),
            'xesam:title': new GLib.Variant('s', info.title),
            'xesam:artist': new GLib.Variant('as', info.artist ? [info.artist] : []),
            'xesam:album': new GLib.Variant('s', info.album || ''),
        };
        if (info.artUrl)
            meta['mpris:artUrl'] = new GLib.Variant('s', info.artUrl);
        return new GLib.Variant('a{sv}', meta);
    }

    _volume() {
        const p = this._client.activePlayer;
        if (!p || p.volume_muted)
            return 0.0;
        const lvl = typeof p.volume_level === 'number' ? p.volume_level :
                    (typeof p.group_volume === 'number' ? p.group_volume : 0);
        return Math.min(1, Math.max(0, lvl / 100));
    }

    _canSeek() {
        if (this._playbackStatus() === 'Stopped')
            return false;
        const info = this._client.trackInfo();
        return info.duration > 0;
    }

    /** interface -> {jméno: [signatura, () => hodnota]} */
    _propDefs() {
        const c = this._client;
        return {
            [ROOT_IFACE]: {
                'CanQuit': ['b', () => false],
                'CanRaise': ['b', () => false],
                'HasTrackList': ['b', () => false],
                'Identity': ['s', () => this._identity()],
                'DesktopEntry': ['s', () => ''],
                'SupportedUriSchemas': ['as', () => []],
                'SupportedMimeTypes': ['as', () => []],
                'CanSetFullscreen': ['b', () => false],
                'Fullscreen': ['b', () => false],
            },
            [PLAYER_IFACE]: {
                'PlaybackStatus': ['s', () => this._playbackStatus()],
                'LoopStatus': ['s', () => _repeatToLoop(c.queue ? c.queue.repeat_mode : 'off')],
                'Rate': ['d', () => 1.0],
                'Shuffle': ['b', () => !!(c.queue && c.queue.shuffle_enabled)],
                'Metadata': ['a{sv}', () => this._metadata()],
                'Volume': ['d', () => this._volume()],
                'Position': ['x', () => {
                    if (this._playbackStatus() === 'Stopped')
                        return 0;
                    return Math.round(c.currentElapsed() * 1000000);
                }],
                'MinimumRate': ['d', () => 1.0],
                'MaximumRate': ['d', () => 1.0],
                'CanGoNext': ['b', () => {
                    const q = c.queue;
                    return !!q && q.state !== 'idle' && (q.items > 1 || q.current_item !== null);
                }],
                'CanGoPrevious': ['b', () => {
                    const q = c.queue;
                    return !!q && q.state !== 'idle' && (q.items > 1 || q.current_item !== null);
                }],
                'CanPlay': ['b', () => {
                    const p = c.activePlayer;
                    return !!p && p.available !== false;
                }],
                'CanPause': ['b', () => {
                    return this._playbackStatus() === 'Playing';
                }],
                'CanSeek': ['b', () => this._canSeek()],
                'CanControl': ['b', () => {
                    const p = c.activePlayer;
                    return !!p && p.available !== false;
                }],
            },
        };
    }

    _setProp(iface, name, value) {
        const c = this._client;
        if (iface === ROOT_IFACE && name === 'Fullscreen')
            return;
        if (iface !== PLAYER_IFACE)
            return;
        if (name === 'LoopStatus')
            c.setRepeat(_loopToRepeat(value));
        else if (name === 'Shuffle')
            c.setShuffle(value);
        else if (name === 'Volume')
            c.setVolume(Math.round(Math.min(1, Math.max(0, value)) * 100));
        else if (name === 'Rate')
            return;
    }

    // ---- D-Bus obsluha ----

    _onMethodCall(conn, sender, path, iface, method, params, invocation) {
        try {
            if (iface === PROPS_IFACE) {
                const args = params.deepUnpack();
                if (method === 'Get') {
                    const [propIface, prop] = args;
                    const v = this._propVariant(propIface, prop);
                    if (v === null) {
                        invocation.return_dbus_error(
                            'org.freedesktop.DBus.Error.InvalidArgs',
                            `Neznámá vlastnost ${prop} na ${propIface}`);
                    } else {
                        invocation.return_value(new GLib.Variant('(v)', [v]));
                    }
                } else if (method === 'GetAll') {
                    const [propIface] = args;
                    const dict = {};
                    const defs = this._propDefs()[propIface] || {};
                    for (const [name, [sig, get]] of Object.entries(defs))
                        dict[name] = new GLib.Variant(sig, get());
                    invocation.return_value(new GLib.Variant('(a{sv})', [dict]));
                } else if (method === 'Set') {
                    const [propIface, prop, variant] = args;
                    this._setProp(propIface, prop, variant.deepUnpack());
                    invocation.return_value(null);
                }
                return;
            }

            const c = this._client;
            switch (method) {
                case 'Raise':
                case 'Quit':
                case 'OpenUri':
                    invocation.return_value(null);
                    break;
                case 'Next':
                    c.next();
                    invocation.return_value(null);
                    break;
                case 'Previous':
                    c.previous();
                    invocation.return_value(null);
                    break;
                case 'Pause':
                    c.pause();
                    invocation.return_value(null);
                    break;
                case 'PlayPause':
                    c.playPause();
                    invocation.return_value(null);
                    break;
                case 'Stop':
                    c.stop();
                    invocation.return_value(null);
                    break;
                case 'Play':
                    c.play();
                    invocation.return_value(null);
                    break;
                case 'Seek':
                    c.seek(c.currentElapsed() + args(params)[0] / 1000000);
                    invocation.return_value(null);
                    break;
                case 'SetPosition':
                    c.seek(args(params)[1] / 1000000);
                    invocation.return_value(null);
                    break;
                default:
                    invocation.return_dbus_error(
                        'org.freedesktop.DBus.Error.UnknownMethod',
                        `Neznámá metoda ${method}`);
            }
        } catch (e) {
            invocation.return_dbus_error('org.freedesktop.DBus.Error.Failed', String(e));
        }

        function args(p) {
            return p.deepUnpack();
        }
    }

    // ---- správa životního cyklu ----

    start() {
        if (this._started)
            return;
        this._started = true;

        if (!this._connection) {
            try {
                const address = Gio.dbus_address_get_for_bus_sync(Gio.BusType.SESSION, null);
                this._connection = Gio.DBusConnection.new_for_address_sync(
                    address,
                    Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT |
                    Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
                    null,
                    null
                );
            } catch (e) {
                log(`[hmass] Soukromé D-Bus spojení selhalo: ${e.message}, použije se sdílené`);
                this._connection = Gio.DBus.session;
            }
        }

        const node = Gio.DBusNodeInfo.new_for_xml(FULL_XML);
        // GDBus směruje org.freedesktop.DBus.Properties.Get/Set/GetAll do
        // get_property/set_property členů vtable (ne do method_call) a sám
        // je dispatchuje podle interface_name. Reference drží instance,
        // aby je nesebral GC.
        this._onCall = this._onMethodCall.bind(this);
        this._onGet = (conn, sender, path, iface, prop) => {
            // nikdy NULL: neznámá/chybná vlastnost dostane neutrální výchozí
            // hodnotu správného typu, aby odpověď vždy byla platná
            const v = this._propVariant(iface, prop);
            if (v !== null)
                return v;
            const defs = this._propDefs()[iface];
            const sig = defs && defs[prop] ? defs[prop][0] : 's';
            return this._defaultVariant(sig);
        };
        this._onSet = (conn, sender, path, iface, prop, value) => {
            this._setProp(iface, prop, value.deepUnpack());
            return true;
        };
        for (const info of node.interfaces) {
            const id = this._connection.register_object(
                this._path, info, this._onCall, this._onGet, this._onSet);
            this._regIds.push(id);
        }
        this._nameId = Gio.bus_own_name_on_connection(
            this._connection, this._busName, Gio.BusNameOwnerFlags.NONE, null, null);
    }

    _syncBusName() {
        // Mosty zůstávají na D-Bus trvale registrované
    }

    get started() {
        return this._started;
    }

    stop() {
        if (!this._started)
            return;
        this._started = false;
        if (this._nameId) {
            Gio.bus_unown_name(this._nameId);
            this._nameId = 0;
        }
        for (const id of this._regIds) {
            if (id > 0 && this._connection)
                this._connection.unregister_object(id);
        }
        this._regIds = [];
        this._lastPropValues.clear();
        this._onCall = null;
        this._onGet = null;
        this._onSet = null;
        if (this._connection && this._connection !== Gio.DBus.session) {
            try {
                this._connection.close_sync(null);
            } catch (e) {
            }
            this._connection = null;
        }
    }

    // ---- hlášení změn ----

    _propVariant(ifaceName, name) {
        const defs = this._propDefs()[ifaceName];
        if (!defs || !defs[name])
            return null;
        const [sig, get] = defs[name];
        try {
            const value = get();
            // složené typy (a{sv}) už getter vrací jako hotový Variant
            if (value instanceof GLib.Variant)
                return value;
            return new GLib.Variant(sig, value);
        } catch (e) {
            log(`[hmass] vlastnost ${name} selhala: ${e.message}`);
            return null;
        }
    }

    /**
     * Neutrální výchozí hodnota podle signatury. get_property vtable nesmí
     * nikdy vrátit NULL bez nastavené chyby - GDBus to považuje za
     * programátorskou chybu a může shodit proces (tj. celý GNOME Shell).
     */
    _defaultVariant(sig) {
        switch (sig) {
            case 'b':
                return GLib.Variant.new_boolean(false);
            case 'd':
                return GLib.Variant.new_double(0.0);
            case 'x':
                return GLib.Variant.new_int64(0);
            case 'as':
                return GLib.Variant.new_strv([]);
            case 'a{sv}':
                return new GLib.Variant('a{sv}', {});
            case 's':
            default:
                return GLib.Variant.new_string('');
        }
    }

    /**
     * Plná synchronizace po změně na serveru: aktualizuje vlastnosti a při
     * změně skladby vyšle Seeked. Volá rozšíření při událostech klientů.
     */
    sync() {
        if (!this._started)
            return;
        this._syncBusName();
        const info = this._client.trackInfo();
        const key = `${info.title}|${this._busName}`;
        if (this._lastTrackKey !== null && key !== this._lastTrackKey)
            this.seeked();
        this._lastTrackKey = key;
        this.update([
            'PlaybackStatus', 'Metadata', 'CanSeek', 'Shuffle', 'LoopStatus',
            'Volume', 'CanPlay', 'CanPause', 'CanControl', 'Identity',
        ]);
    }

    /**
     * Rozešle PropertiesChanged pro dané vlastnosti Player rozhraní.
     * @param names pole názvů vlastností
     */
    update(names) {
        if (!this._started)
            return;
        const changed = {};
        for (const name of names) {
            const v = this._propVariant(PLAYER_IFACE, name);
            if (v !== null) {
                const s = v.print(false);
                if (this._lastPropValues.get(name) !== s) {
                    this._lastPropValues.set(name, s);
                    changed[name] = v;
                }
            }
        }
        if (Object.keys(changed).length === 0)
            return;
        try {
            const conn = this._connection || Gio.DBus.session;
            conn.emit_signal(
                null, this._path, PROPS_IFACE, 'PropertiesChanged',
                new GLib.Variant('(sa{sv}as)', [PLAYER_IFACE, changed, []]));
        } catch (e) {
            log(`[hmass] PropertiesChanged selhal: ${e.message}`);
        }
    }

    /** Signál Seeked (např. po přeskočení skladby). */
    seeked() {
        if (!this._started)
            return;
        try {
            const conn = this._connection || Gio.DBus.session;
            conn.emit_signal(
                null, this._path, PLAYER_IFACE, 'Seeked',
                new GLib.Variant('(x)', [this._propVariant(PLAYER_IFACE, 'Position').deepUnpack()]));
        } catch (e) {
        }
    }
};
