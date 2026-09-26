// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 pvranik
//
/*
 * Home Assistant & Music Assistant pro GNOME Shell 42.
 *
 * - HA: hodnoty entit v horní liště + ovládání v menu (switche, slidery,
 *   tlačítka, senzory, výběry, texty - automaticky podle domény)
 * - MA: ovládání přehrávání v menu + MPRIS most pro multimediální klávesy
 */

const {Clutter, Gio, GLib, GObject, Meta, Shell, St} = imports.gi;
const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const Util = imports.misc.util;
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const {HAClient} = Me.imports.lib.ha;
const {MAClient, PlayerView} = Me.imports.lib.ma;
const {MprisBridge} = Me.imports.lib.mpris;
const {HaPlayerAdapter} = Me.imports.lib.haPlayer;
const UI = Me.imports.lib.ui;

const CONNECTION_KEYS = new Set([
    'ha-url', 'ha-token', 'ma-url', 'ma-token', 'ma-enabled', 'ma-default-player',
    'allow-insecure-tls',
]);

const MPRIS_KEYS = new Set(['ma-mpris', 'mpris-players']);

const STATUS_DOT = {
    'ok': 'hmass-dot-ok',
    'connecting': 'hmass-dot-warn',
    'error': 'hmass-dot-err',
    'auth-error': 'hmass-dot-err',
    'disabled': 'hmass-dot-off',
    'disconnected': 'hmass-dot-off',
};

const STATUS_COLORS = {
    'ok': new Clutter.Color({ red: 51, green: 209, blue: 122, alpha: 255 }),
    'connecting': new Clutter.Color({ red: 246, green: 211, blue: 45, alpha: 255 }),
    'error': new Clutter.Color({ red: 224, green: 27, blue: 36, alpha: 255 }),
    'auth-error': new Clutter.Color({ red: 224, green: 27, blue: 36, alpha: 255 }),
};

const HMassIndicator = GObject.registerClass({
}, class HMassIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'Home Assistant & Music Assistant');

        this._settings = ExtensionUtils.getSettings();

        this._ha = new HAClient();
        this._ma = new MAClient();
        this._mprisBridges = [];   // pole MprisBridge (per-player nebo jeden pro aktivní)

        this._panelBox = new St.BoxLayout({style_class: 'hmass-panel-box'});
        this.add_child(this._panelBox);

        this._panelEntities = new Map(); // entityId -> {actor, update}
        this._panelIcon = null;
        this._haStatusValue = 'disabled';
        this._maStatusValue = 'disabled';
        this._dotsArea = null;

        const haIconFile = Me.dir.get_child('icons').get_child('home-assistant.svg');
        this._haFileIcon = Gio.FileIcon.new(haIconFile);
        const maIconFile = Me.dir.get_child('icons').get_child('music-assistant.svg');
        this._maFileIcon = Gio.FileIcon.new(maIconFile);

        this._maSection = null;
        this._haSeparator = null;
        this._haAssist = null;
        this._haRows = new Map();      // entityId -> {update}
        this._haRowsHolder = null;     // sekce menu s HA řádky
        this._haStatus = null;
        this._maStatus = null;

        this._tickId = 0;
        this._reconnectId = 0;
        this._rebuildId = 0;
        this._mprisId = 0;

        this._wireClients();
        this._rebuildAll();

        this._settingsChangedId = this._settings.connect('changed', (s, key) => {
            this._onSettingsChanged(key);
        });

        this.menu.connect('open-state-changed', (menu, open) => {
            this._onMenuOpenChanged(open);
        });

        this._registerHotkey();
    }

    /** Globální zkratka: otevřít menu a foucnout do pole Assist chatu. */
    _registerHotkey() {
        if (!Main.wm || !Main.wm.addKeybinding || !Meta.KeyBindingFlags)
            return;
        try {
            Main.wm.addKeybinding('hotkey-open-menu',
                this._settings,
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                () => this._openMenuAndFocusAssist());
            this._hotkeyRegistered = true;
        } catch (e) {
            logError(e, 'hmass: registrace zkratky selhala');
        }
    }

    _unregisterHotkey() {
        if (this._hotkeyRegistered && Main.wm && Main.wm.removeKeybinding) {
            try {
                Main.wm.removeKeybinding('hotkey-open-menu');
            } catch (e) {
                // ignore
            }
        }
        this._hotkeyRegistered = false;
    }

    _openMenuAndFocusAssist() {
        this.menu.open();
        if (!this._haAssist)
            return;
        // menu si po otevření vezme grab - fokus vstupu až poté
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (this.menu.isOpen && this._haAssist && this._haAssist.entry)
                this._haAssist.entry.grab_key_focus();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---- klienti ----

    _wireClients() {
        this._ha.onstate = (status, detail) => this._updateHaStatus(status, detail);
        this._ha.onstates = () => {
            this._rebuildHaRows();
            this._updatePanelValues();
        };
        this._ha.onentity = (entityId, st) => {
            this._onHaEntity(entityId, st);
        };

        this._ma.onstate = (status, detail) => this._updateMaStatus(status, detail);
        this._ma.onplayers = () => {
            this._setupMpris();  // přebudovat mosty s čitelnými jmény hráčů
            this._refreshMa();
        };
        this._ma.onactive = () => this._refreshMa();
        this._ma.onqueue = () => this._refreshMa();
        this._ma.onqueues = () => this._syncMpris('ma');
        this._ma.ondjinfo = () => this._refreshMa();
        this._ma.onelapsed = () => {
            if (this._maSection)
                this._maSection.update();
        };
    }

    _connectClients() {
        const s = this._settings;
        const insecure = s.get_boolean('allow-insecure-tls');

        const haUrl = s.get_string('ha-url');
        this._ha.configure(haUrl, s.get_string('ha-token'), insecure);
        if (haUrl)
            this._ha.connect();
        else
            this._updateHaStatus('disabled', 'není nastaveno');

        if (s.get_boolean('ma-enabled')) {
            const maUrl = s.get_string('ma-url');
            this._ma.configure(maUrl, s.get_string('ma-token'), insecure, s.get_string('ma-default-player'));
            if (maUrl)
                this._ma.connect();
            else
                this._updateMaStatus('disabled', 'není nastaveno');
        } else {
            this._ma.disconnect();
            this._updateMaStatus('disabled', 'vypnuto v nastavení');
        }

        this._setupMpris();
    }

    // ---- MPRIS mosty (jeden na vybraný přehrávač, nebo jeden pro aktivní) ----

    _teardownMpris() {
        for (const b of this._mprisBridges)
            b.stop();
        this._mprisBridges = [];
    }

    _setupMpris() {
        const s = this._settings;
        if (!s.get_boolean('ma-mpris')) {
            this._teardownMpris();
            return;
        }

        const selection = s.get_strv('mpris-players');
        // targetFactories: key -> { nameSuffix, factory }
        const targetFactories = new Map();

        if (selection.length === 0) {
            if (s.get_boolean('ma-enabled') && s.get_string('ma-url')) {
                targetFactories.set('default_ma', {
                    nameSuffix: null,
                    factory: () => new MprisBridge(this._ma, null, 'Music Assistant'),
                });
            }
        } else {
            for (const entry of selection) {
                if (entry.startsWith('ma:')) {
                    const playerId = entry.slice(3);
                    if (playerId) {
                        // Suffix odvozujeme z jména přehrávače – čitelné pro MPRIS indikátor.
                        // Klíč zůstává stabilní (player_id).
                        const knownPlayer = this._ma.players.find(p => p.player_id === playerId);
                        const playerName = (knownPlayer && knownPlayer.name) || playerId;
                        const nameSuffix = `ma_${playerName}`;
                        const key = `ma_${playerId}`;
                        targetFactories.set(key, {
                            nameSuffix,
                            factory: () => new MprisBridge(
                                new PlayerView(this._ma, playerId), nameSuffix, 'Music Assistant'),
                        });
                    }
                } else if (entry.startsWith('ha:')) {
                    const entityId = entry.slice(3);
                    if (entityId) {
                        const suf = `ha_${entityId}`;
                        targetFactories.set(suf, {
                            nameSuffix: suf,
                            factory: () => new MprisBridge(
                                new HaPlayerAdapter(this._ha, entityId), suf, 'Home Assistant'),
                        });
                    }
                }
            }
        }

        // 1. Zastavit mosty mimo cílový výběr
        //    Mosty mají _key uložený při vytvoření; fallback na _suffix nebo 'default_ma'.
        this._mprisBridges = this._mprisBridges.filter(b => {
            const key = b._key || b._suffix || 'default_ma';
            const target = targetFactories.get(key);
            if (!target) {
                b.stop();
                return false;
            }
            // Pokud se D-Bus jméno změnilo (teď víme jméno hráče), přebuduj most.
            if (target.nameSuffix !== b._suffix) {
                b.stop();
                return false;
            }
            return true;
        });

        // 2. Přidat nové / přebudované mosty
        const existingKeys = new Set(this._mprisBridges.map(b => b._key || b._suffix || 'default_ma'));
        for (const [key, {factory}] of targetFactories) {
            if (!existingKeys.has(key)) {
                const b = factory();
                b._key = key;   // uloží stabilní klíč odděleně od D-Bus suffixu
                b.start();
                this._mprisBridges.push(b);
            }
        }
    }

    _syncMpris(source) {
        for (const b of this._mprisBridges) {
            const isHa = b._client instanceof HaPlayerAdapter;
            if (source === 'all' || (source === 'ma' && !isHa) || (source === 'ha' && isHa))
                b.sync();
        }
    }

    _disconnectClients() {
        this._ha.disconnect();
        this._ma.disconnect();
        this._teardownMpris();
    }

    // ---- panel ----

    _rebuildPanel() {
        this._panelBox.destroy_all_children();
        this._panelEntities.clear();

        const s = this._settings;

        if (s.get_boolean('panel-show-icon')) {
            this._panelIcon = new St.Icon({
                gicon: this._haFileIcon,
                style_class: 'system-status-icon',
                icon_size: 16,
            });
            this._panelBox.add_child(this._panelIcon);
        } else {
            this._panelIcon = null;
        }

        if (s.get_boolean('panel-show-status')) {
            this._dotsArea = new St.DrawingArea({
                style_class: 'hmass-dots-area',
                width: 8,
                height: 18,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._dotsArea.connect('repaint', (area) => {
                const cr = area.get_context();
                const [, h] = area.get_surface_size();
                const r = 2.5;
                const cx = r + 0.5;

                const hasMa = this._settings.get_boolean('ma-enabled');
                const haColor = STATUS_COLORS[this._haStatusValue] || null;
                const maColor = hasMa ? (STATUS_COLORS[this._maStatusValue] || null) : null;

                const yTop = hasMa ? Math.round(h * 0.3) : Math.round(h * 0.5);
                const yBottom = Math.round(h * 0.7);

                // Horní tečka: Home Assistant
                if (haColor) {
                    Clutter.cairo_set_source_color(cr, haColor);
                    cr.arc(cx, yTop, r, 0, 2 * Math.PI);
                    cr.fill();
                }

                // Dolní tečka: Music Assistant
                if (maColor) {
                    Clutter.cairo_set_source_color(cr, maColor);
                    cr.arc(cx, yBottom, r, 0, 2 * Math.PI);
                    cr.fill();
                }

                cr.$dispose();
            });
            this._panelBox.add_child(this._dotsArea);
        } else {
            this._dotsArea = null;
        }

        const decimals = s.get_int('value-decimals');
        for (const entityId of s.get_strv('ha-panel-entities')) {
            const built = UI.createPanelEntity(
                entityId, this._ha.states[entityId] || null, this._ha, decimals);
            this._panelEntities.set(entityId, built);
            this._panelBox.add_child(built.actor);
        }

        this._updatePanelValues();
        this._syncPanelIcon();
    }

    /**
     * Ikona v panelu: když je některý nastavený server nedostupný,
     * přepne se na "offline" variantu - jediný viditelný zásah do systému.
     */
    _panelOffline() {
        const bad = st => st === 'error' || st === 'auth-error';
        const s = this._settings;
        if (s.get_string('ha-url') && bad(this._ha.status))
            return true;
        if (s.get_boolean('ma-enabled') && s.get_string('ma-url') && bad(this._ma.status))
            return true;
        return false;
    }

    _syncPanelIcon() {
        if (!this._panelIcon)
            return;
        if (this._panelOffline()) {
            this._panelIcon.gicon = null;
            this._panelIcon.icon_name = 'network-offline-symbolic';
        } else {
            this._panelIcon.icon_name = null;
            this._panelIcon.gicon = this._haFileIcon;
        }
    }

    _launchApp(url, keywords) {
        if (!url)
            return;
        this.menu.close();

        let host = '';
        try {
            const uri = GLib.Uri.parse(url, GLib.UriFlags.NONE);
            host = uri ? uri.get_host() : '';
        } catch (_e) { /* ignore */ }
        const cleanUrl = url.replace(/\/+$/, '').toLowerCase();

        // Prohledáme ~/.local/share/applications/ (Chrome PWA) + /usr/share/applications/
        const searchDirs = [
            GLib.get_user_data_dir() + '/applications',
            '/usr/share/applications',
        ];

        let foundExec = null;

        outer: for (const dir of searchDirs) {
            const gdir = Gio.File.new_for_path(dir);
            let iter;
            try {
                iter = gdir.enumerate_children('standard::name,standard::type',
                    Gio.FileQueryInfoFlags.NONE, null);
            } catch (_e) {
                continue;
            }
            let finfo;
            while ((finfo = iter.next_file(null)) !== null) {
                const fname = finfo.get_name();
                if (!fname.endsWith('.desktop'))
                    continue;
                const fpath = `${dir}/${fname}`;
                let info;
                try {
                    info = Gio.DesktopAppInfo.new_from_filename(fpath);
                } catch (_e) {
                    continue;
                }
                if (!info)
                    continue;

                const name = (info.get_name() || '').toLowerCase();
                const cmd  = (info.get_commandline() || '');
                const cmdL = cmd.toLowerCase();

                // Shoda URL/host v Exec (pro non-PWA aplikace)
                if (cleanUrl && cmdL.includes(cleanUrl)) {
                    foundExec = cmd;
                    break outer;
                }
                if (host && cmdL.includes(host.toLowerCase())) {
                    foundExec = cmd;
                    break outer;
                }

                // Shoda klíčového slova s Name= v .desktop souboru (Chrome PWA)
                if (keywords && keywords.length > 0) {
                    for (const kw of keywords) {
                        if (name === kw.toLowerCase() || name.startsWith(kw.toLowerCase())) {
                            foundExec = cmd;
                            break outer;
                        }
                    }
                }
            }
        }

        if (foundExec) {
            try {
                GLib.spawn_command_line_async(foundExec);
                return;
            } catch (e) {
                logError(e, 'hmass: spuštění PWA selhalo, otvírám URL');
            }
        }

        // Fallback: otevřít URL v defaultním prohlížeči
        try {
            Gio.AppInfo.launch_default_for_uri(url, null);
        } catch (e) {
            logError(e, `hmass: nelze otevřít URL ${url}`);
        }
    }

    _launchHa() {
        const url = this._settings.get_string('ha-url');
        this._launchApp(url, ['home assistant', 'homeassistant']);
    }

    _launchMa() {
        const maUrl = this._settings.get_string('ma-url');
        this._launchApp(maUrl, ['music assistant', 'musicassistant']);
    }

    _updatePanelValues() {
        for (const [entityId, built] of this._panelEntities)
            built.update(this._ha.states[entityId] || null);
    }

    // ---- menu ----

    _rebuildMenu() {
        // nejdřív zrušit assist chat - jeho položky pak removeAll nebude
        // rušit podruhé (disposed objekty)
        if (this._haAssist) {
            this._haAssist.destroy();
            this._haAssist = null;
        }
        this.menu.removeAll();
        this._haRows.clear();
        this._maSection = null;

        const s = this._settings;

        let maShown = false;
        if (s.get_boolean('ma-enabled')) {
            this.menu.addMenuItem(UI.sectionHeader('Music Assistant', () => this._launchMa(), this._maFileIcon, 'Otevřít Music Assistant'));
            this._maSection = new UI.MaSection(this._ma, s);
            this._maSection.onPlayerPicked = playerId => {
                this._settings.set_string('ma-default-player', playerId);
            };
            for (const item of this._maSection.items)
                this.menu.addMenuItem(item);
            maShown = true;
        }

        const haUrl = s.get_string('ha-url');
        const menuEntities = s.get_strv('ha-menu-entities');
        if (haUrl || menuEntities.length > 0) {
            if (maShown)
                this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this.menu.addMenuItem(UI.sectionHeader('Home Assistant', () => this._launchHa(), this._haFileIcon, 'Otevřít Home Assistant'));

            // Assist Chat
            this._haAssist = new UI.HaAssistChat(this._ha);
            for (const item of this._haAssist.items)
                this.menu.addMenuItem(item);

            this._haRowsHolder = this.menu;
            for (const entityId of menuEntities)
                this._appendHaRow(entityId);
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        // stav připojení signalizují tečky v panelu - žádné stavové řádky v menu
        this._haStatus = null;
        this._maStatus = null;

        const reloadItem = new PopupMenu.PopupMenuItem('Připojit znovu');
        reloadItem.connect('activate', () => {
            this._ha.reconnect();
            this._ma.reconnect();
        });
        this.menu.addMenuItem(reloadItem);

        const prefsItem = new PopupMenu.PopupMenuItem('Nastavení');
        prefsItem.connect('activate', () => {
            try {
                if (typeof ExtensionUtils.openPrefs === 'function') {
                    ExtensionUtils.openPrefs();
                    return;
                }
            } catch (e) {
                logError(e, 'hmass: ExtensionUtils.openPrefs selhalo');
            }
            try {
                Util.spawn(['gnome-extensions', 'prefs', Me.uuid]);
            } catch (e) {
                logError(e, 'hmass: Nelze spustit gnome-extensions prefs');
            }
        });
        this.menu.addMenuItem(prefsItem);

        this._refreshMa(true);
    }

    _appendHaRow(entityId) {
        const decimals = this._settings.get_int('value-decimals');
        const built = UI.createHaRows(entityId, this._ha.states[entityId] || null, this._ha, decimals);
        this._haRows.set(entityId, built);
        for (const row of built.rows)
            this.menu.addMenuItem(row);
    }

    _rebuildHaRows() {
        // znovupostaví HA část menu (po načtení kompletních stavů)
        this._rebuildMenu();
    }

    // ---- události ----

    _onHaEntity(entityId, st) {
        const panelEntity = this._panelEntities.get(entityId);
        if (panelEntity)
            panelEntity.update(st);
        const built = this._haRows.get(entityId);
        if (built)
            built.update(st);
        // přehrávač v MPRIS (media_player.*) - aktualizovat jeho most
        if (entityId.startsWith('media_player.')) {
            for (const b of this._mprisBridges) {
                if (b._client instanceof HaPlayerAdapter && b._client.entityId === entityId)
                    b.sync();
            }
        }
    }

    _refreshMa(force) {
        if (this._maSection)
            this._maSection.update();
        this._syncMpris('ma');
        if (force)
            this._syncMpris('all');
    }

    _onMenuOpenChanged(open) {
        if (open) {
            this._refreshMa(true);
            if (!this._tickId) {
                this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                    if (this._maSection && this._ma.playing)
                        this._maSection.update();
                    return GLib.SOURCE_CONTINUE;
                });
            }
        } else if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
    }

    _updateHaStatus(status, detail) {
        this._haStatusValue = status;
        if (this._dotsArea)
            this._dotsArea.queue_repaint();
        this._syncPanelIcon();
        if (!this._haStatus)
            return;
        switch (status) {
            case 'ok':
                this._haStatus.set(STATUS_DOT[status], `Home Assistant: připojeno${detail ? ' (' + detail + ')' : ''}`);
                break;
            case 'connecting':
                this._haStatus.set(STATUS_DOT[status], 'Home Assistant: připojuji…');
                break;
            case 'auth-error':
                this._haStatus.set(STATUS_DOT[status], 'Home Assistant: neplatný token');
                break;
            case 'disabled':
                this._haStatus.set(STATUS_DOT[status], `Home Assistant: ${detail || 'není nastaveno'}`);
                break;
            default:
                this._haStatus.set(STATUS_DOT[status] || 'hmass-dot-err',
                    `Home Assistant: ${detail || 'bez spojení'}`);
        }
    }

    _updateMaStatus(status, detail) {
        this._maStatusValue = status;
        if (this._dotsArea)
            this._dotsArea.queue_repaint();
        this._syncPanelIcon();
        if (!this._maStatus)
            return;
        switch (status) {
            case 'ok':
                this._maStatus.set(STATUS_DOT[status], `Music Assistant: připojeno${detail ? ' (' + detail + ')' : ''}`);
                break;
            case 'connecting':
                this._maStatus.set(STATUS_DOT[status], 'Music Assistant: připojuji…');
                break;
            case 'auth-error':
                this._maStatus.set(STATUS_DOT[status], 'Music Assistant: přístup odepřen (API klíč?)');
                break;
            case 'disabled':
                this._maStatus.set(STATUS_DOT[status], `Music Assistant: ${detail || 'není nastaveno'}`);
                break;
            default:
                this._maStatus.set(STATUS_DOT[status] || 'hmass-dot-err',
                    `Music Assistant: ${detail || 'bez spojení'}`);
        }
    }

    // ---- nastavení ----

    _onSettingsChanged(key) {
        if (CONNECTION_KEYS.has(key)) {
            if (this._reconnectId)
                GLib.source_remove(this._reconnectId);
            this._reconnectId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
                this._reconnectId = 0;
                this._connectClients();
                return GLib.SOURCE_REMOVE;
            });
        } else if (MPRIS_KEYS.has(key)) {
            if (this._mprisId)
                GLib.source_remove(this._mprisId);
            this._mprisId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                this._mprisId = 0;
                this._setupMpris();
                return GLib.SOURCE_REMOVE;
            });
        } else {
            if (this._rebuildId)
                GLib.source_remove(this._rebuildId);
            this._rebuildId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                this._rebuildId = 0;
                this._rebuildAll();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _rebuildAll() {
        this._rebuildPanel();
        this._rebuildMenu();
        // obnovit stavové texty po přestavění menu
        this._updateHaStatus(this._ha.status, '');
        this._updateMaStatus(this._ma.status, '');
    }

    destroy() {
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
        if (this._reconnectId) {
            GLib.source_remove(this._reconnectId);
            this._reconnectId = 0;
        }
        if (this._rebuildId) {
            GLib.source_remove(this._rebuildId);
            this._rebuildId = 0;
        }
        if (this._mprisId) {
            GLib.source_remove(this._mprisId);
            this._mprisId = 0;
        }
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }
        this._unregisterHotkey();
        this._disconnectClients();
        UI.hidePanelTooltip();
        if (this._haAssist) {
            this._haAssist.destroy();
            this._haAssist = null;
        }
        this._ha.destroy();
        this._ma.destroy();
        super.destroy();
    }
});

let _indicator = null;

function init() {
}

function enable() {
    if (_indicator !== null)
        return;
    _indicator = new HMassIndicator();
    Main.panel.addToStatusArea('hmass', _indicator);
    _indicator._connectClients();
}

function disable() {
    if (_indicator === null)
        return;
    _indicator.destroy();
    _indicator = null;
}
