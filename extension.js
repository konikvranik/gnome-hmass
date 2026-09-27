// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 konikvranik
//
/*
 * Home Assistant & Music Assistant for GNOME Shell 42.
 *
 * - HA: entity values in top panel + control in menu (switches, sliders,
 *   buttons, sensors, selects, text inputs - automatically by domain)
 * - MA: playback control in menu + MPRIS bridge for multimedia keys
 */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as I18n from './lib/i18n.js';
const _ = I18n._;

import {HAClient} from './lib/ha.js';
import {MAClient, PlayerView} from './lib/ma.js';
import {MprisBridge} from './lib/mpris.js';
import {HaPlayerAdapter} from './lib/haPlayer.js';
import * as UI from './lib/ui.js';
import * as MdiIcons from './lib/icons.js';

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
    _init(extension) {
        super._init(0.0, 'Home Assistant & Music Assistant');

        this._extension = extension;
        this._settings = (extension && typeof extension.getSettings === 'function')
            ? extension.getSettings()
            : (typeof ExtensionUtils !== 'undefined' ? ExtensionUtils.getSettings() : null);

        this._ha = new HAClient();
        this._ma = new MAClient();
        this._mprisBridges = [];   // Array of MprisBridge instances (per-player or one for active)

        this._panelBox = new St.BoxLayout({style_class: 'hmass-panel-box'});
        this.add_child(this._panelBox);

        this._panelEntities = new Map(); // entityId -> {actor, update}
        this._panelIcon = null;
        this._haStatusValue = 'disabled';
        this._maStatusValue = 'disabled';
        this._dotsArea = null;

        const extDir = extension && extension.dir;
        if (extDir) {
            const haIconFile = extDir.get_child('icons').get_child('home-assistant.svg');
            this._haFileIcon = Gio.FileIcon.new(haIconFile);
            const maIconFile = extDir.get_child('icons').get_child('music-assistant.svg');
            this._maFileIcon = Gio.FileIcon.new(maIconFile);
            MdiIcons.setIconDir(extDir.get_child('icons').get_child('mdi'));
        } else {
            this._haFileIcon = null;
            this._maFileIcon = null;
        }

        this._maSection = null;
        this._haSeparator = null;
        this._haAssist = null;
        this._haRows = new Map();      // entityId -> {update}
        this._haRowsHolder = null;     // Menu section containing HA rows
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

    /** Global shortcut: open menu and focus the Assist chat entry. */
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
            logError(e, 'hmass: hotkey registration failed');
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
        // Menu grabs focus upon opening - focus entry afterwards
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (this.menu.isOpen && this._haAssist && this._haAssist.entry)
                this._haAssist.entry.grab_key_focus();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---- clients ----

    _wireClients() {
        this._ha.onstate = (status, detail) => this._updateHaStatus(status, detail);
        this._ha.onstates = () => {
            // Rebuilding synchronously in websocket callback at session start
            // can cause destroyed item handlers to hit GC sweep phase
            // and get blocked by the shell (empty menu, unallocated indicator)
            if (this._rebuildIdle)
                GLib.source_remove(this._rebuildIdle);
            this._rebuildIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._rebuildIdle = 0;
                this._rebuildHaRows();
                this._updatePanelValues();
                return GLib.SOURCE_REMOVE;
            });
        };
        this._ha.onentity = (entityId, st) => {
            this._onHaEntity(entityId, st);
        };

        this._ma.onstate = (status, detail) => this._updateMaStatus(status, detail);
        this._ma.onplayers = () => {
            this._setupMpris();  // Rebuild bridges with readable player names
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
            this._updateHaStatus('disabled', _('not configured'));

        if (s.get_boolean('ma-enabled')) {
            const maUrl = s.get_string('ma-url');
            this._ma.configure(maUrl, s.get_string('ma-token'), insecure, s.get_string('ma-default-player'));
            if (maUrl)
                this._ma.connect();
            else
                this._updateMaStatus('disabled', _('not configured'));
        } else {
            this._ma.disconnect();
            this._updateMaStatus('disabled', _('disabled in settings'));
        }

        this._setupMpris();
    }

    // ---- MPRIS bridges (one per chosen player, or one for active) ----

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
                        // Derive suffix from player name – human-readable for MPRIS indicator.
                        // Key remains stable (player_id).
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

        // 1. Stop bridges outside target selection
        //    Bridges have _key stored on creation; fallback to _suffix or 'default_ma'.
        this._mprisBridges = this._mprisBridges.filter(b => {
            const key = b._key || b._suffix || 'default_ma';
            const target = targetFactories.get(key);
            if (!target) {
                b.stop();
                return false;
            }
            // If D-Bus name changed (player name now known), rebuild bridge.
            if (target.nameSuffix !== b._suffix) {
                b.stop();
                return false;
            }
            return true;
        });

        // 2. Add new / rebuilt bridges
        const existingKeys = new Set(this._mprisBridges.map(b => b._key || b._suffix || 'default_ma'));
        for (const [key, {factory}] of targetFactories) {
            if (!existingKeys.has(key)) {
                const b = factory();
                b._key = key;   // Stores stable key separately from D-Bus suffix
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
                style_class: 'system-status-icon hmass-panel-icon',
                icon_size: 16,
            });
        } else {
            this._panelIcon = null;
        }

        if (s.get_boolean('panel-show-status')) {
            this._dotsArea = new St.DrawingArea({
                style_class: 'hmass-dots-area',
                width: 6,
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

                // Top dot: Home Assistant
                if (haColor) {
                    Clutter.cairo_set_source_color(cr, haColor);
                    cr.arc(cx, yTop, r, 0, 2 * Math.PI);
                    cr.fill();
                }

                // Bottom dot: Music Assistant
                if (maColor) {
                    Clutter.cairo_set_source_color(cr, maColor);
                    cr.arc(cx, yBottom, r, 0, 2 * Math.PI);
                    cr.fill();
                }

                cr.$dispose();
            });
        } else {
            this._dotsArea = null;
        }

        // Icon and dots belong together - common box without theme gaps
        // so status dots sit tightly next to Home Assistant icon
        if (this._panelIcon && this._dotsArea) {
            const iconBox = new St.BoxLayout({style_class: 'hmass-icon-box'});
            iconBox.add_child(this._panelIcon);
            iconBox.add_child(this._dotsArea);
            this._panelBox.add_child(iconBox);
        } else {
            if (this._panelIcon)
                this._panelBox.add_child(this._panelIcon);
            if (this._dotsArea)
                this._panelBox.add_child(this._dotsArea);
        }

        for (const entityId of s.get_strv('ha-panel-entities')) {
            const built = UI.createPanelEntity(
                entityId, this._ha.states[entityId] || null, this._ha,
                this._entityConfig(entityId));
            this._panelEntities.set(entityId, built);
            this._panelBox.add_child(built.actor);
        }

        this._updatePanelValues();
        this._syncPanelIcon();
    }

    /**
     * Panel icon: when any configured server is unavailable,
     * switch to "offline" variant - the only visible intervention in the system.
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

        // Search ~/.local/share/applications/ (Chrome PWA) + /usr/share/applications/
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

                // URL/host match in Exec (for non-PWA apps)
                if (cleanUrl && cmdL.includes(cleanUrl)) {
                    foundExec = cmd;
                    break outer;
                }
                if (host && cmdL.includes(host.toLowerCase())) {
                    foundExec = cmd;
                    break outer;
                }

                // Keyword match with Name= in .desktop file (Chrome PWA)
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
                logError(e, 'hmass: PWA launch failed, opening URL');
            }
        }

        // Fallback: open URL in default browser
        try {
            Gio.AppInfo.launch_default_for_uri(url, null);
        } catch (e) {
            logError(e, `hmass: failed to open URL ${url}`);
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
        // First destroy assist chat - removeAll won't destroy it a second time (disposed objects)
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
            this.menu.addMenuItem(UI.sectionHeader('Music Assistant', () => this._launchMa(), this._maFileIcon, _('Open Music Assistant')));
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
            this.menu.addMenuItem(UI.sectionHeader('Home Assistant', () => this._launchHa(), this._haFileIcon, _('Open Home Assistant')));

            // Assist Chat
            this._haAssist = new UI.HaAssistChat(this._ha);
            for (const item of this._haAssist.items)
                this.menu.addMenuItem(item);

            this._haRowsHolder = this.menu;
            for (const entityId of menuEntities)
                this._appendHaRow(entityId);
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        // Connection status signaled by panel dots - no status rows in menu
        this._haStatus = null;
        this._maStatus = null;

        const reloadItem = new PopupMenu.PopupMenuItem(_('Reconnect'));
        reloadItem.add_style_class_name('hmass-menu-secondary');
        reloadItem.connect('activate', () => {
            this._ha.reconnect();
            this._ma.reconnect();
        });
        this.menu.addMenuItem(reloadItem);

        const prefsItem = new PopupMenu.PopupMenuItem(_('Settings'));
        prefsItem.add_style_class_name('hmass-menu-secondary');
        prefsItem.connect('activate', () => {
            try {
                if (this._extension && typeof this._extension.openPreferences === 'function') {
                    this._extension.openPreferences();
                    return;
                }
            } catch (e) {
            }
            try {
                if (typeof ExtensionUtils !== 'undefined' && typeof ExtensionUtils.openPrefs === 'function') {
                    ExtensionUtils.openPrefs();
                    return;
                }
            } catch (e) {
            }
            try {
                const uuid = (this._extension && this._extension.uuid) || 'hmass@konikvranik';
                Util.spawn(['gnome-extensions', 'prefs', uuid]);
            } catch (e) {
                logError(e, 'hmass: failed to launch gnome-extensions prefs');
            }
        });
        this.menu.addMenuItem(prefsItem);

        this._refreshMa(true);
    }

    _appendHaRow(entityId) {
        const built = UI.createHaRows(
            entityId, this._ha.states[entityId] || null, this._ha,
            this._entityConfig(entityId));
        this._haRows.set(entityId, built);
        for (const row of built.rows)
            this.menu.addMenuItem(row);
    }

    /**
     * Merged configuration for single entity: global settings + overrides
     * from entity-configs key (JSON). Invalid JSON is silently ignored.
     */
    _entityConfig(entityId) {
        let overrides = null;
        try {
            const dict = this._settings.get_value('entity-configs').deep_unpack();
            const raw = dict[entityId];
            if (raw)
                overrides = JSON.parse(raw);
        } catch (e) {
            overrides = null;
        }
        return UI.mergeEntityConfig(
            overrides,
            this._settings.get_int('value-decimals'),
            this._settings.get_string('entity-icon'));
    }

    _rebuildHaRows() {
        // Rebuild HA portion of menu (after full states loaded)
        this._rebuildMenu();
    }

    // ---- events ----

    _onHaEntity(entityId, st) {
        const panelEntity = this._panelEntities.get(entityId);
        if (panelEntity)
            panelEntity.update(st);
        const built = this._haRows.get(entityId);
        if (built)
            built.update(st);
        // MPRIS player (media_player.*) - update its bridge
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
                this._haStatus.set(STATUS_DOT[status], _('Home Assistant: connected') + (detail ? ` (${detail})` : ''));
                break;
            case 'connecting':
                this._haStatus.set(STATUS_DOT[status], _('Home Assistant: connecting…'));
                break;
            case 'auth-error':
                this._haStatus.set(STATUS_DOT[status], _('Home Assistant: invalid token'));
                break;
            case 'disabled':
                this._haStatus.set(STATUS_DOT[status], `Home Assistant: ${detail || _('not configured')}`);
                break;
            default:
                this._haStatus.set(STATUS_DOT[status] || 'hmass-dot-err',
                    `Home Assistant: ${detail || _('no connection')}`);
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
                this._maStatus.set(STATUS_DOT[status], _('Music Assistant: connected') + (detail ? ` (${detail})` : ''));
                break;
            case 'connecting':
                this._maStatus.set(STATUS_DOT[status], _('Music Assistant: connecting…'));
                break;
            case 'auth-error':
                this._maStatus.set(STATUS_DOT[status], _('Music Assistant: access denied (API key?)'));
                break;
            case 'disabled':
                this._maStatus.set(STATUS_DOT[status], `Music Assistant: ${detail || _('not configured')}`);
                break;
            default:
                this._maStatus.set(STATUS_DOT[status] || 'hmass-dot-err',
                    `Music Assistant: ${detail || _('no connection')}`);
        }
    }

    // ---- settings ----

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
        // Restore status texts after menu rebuild
        this._updateHaStatus(this._ha.status, '');
        this._updateMaStatus(this._ma.status, '');
    }

    destroy() {
        // First disconnect client handlers - after disable nothing
        // (e.g. from scheduled reconnect) should touch destroyed UI
        this._ha.onstate = null;
        this._ha.onstates = null;
        this._ha.onentity = null;
        this._ma.onstate = null;
        this._ma.onplayers = null;
        this._ma.onactive = null;
        this._ma.onqueue = null;
        this._ma.onqueues = null;
        this._ma.ondjinfo = null;
        this._ma.onelapsed = null;
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
        if (this._rebuildIdle) {
            GLib.source_remove(this._rebuildIdle);
            this._rebuildIdle = 0;
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

export default class HMassExtension extends Extension {
    enable() {
        I18n.init(this.getSettings(), this.dir);
        this._indicator = new HMassIndicator(this);
        Main.panel.addToStatusArea('hmass', this._indicator);
        this._indicator._connectClients();
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
