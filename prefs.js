// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 pvranik
//
/*
 * Nastavení rozšíření (GTK4 + Libadwaita). GNOME 42+.
 */

imports.gi.versions.Gtk = '4.0';
imports.gi.versions.Soup = '3.0';

const {Adw, Gdk, Gio, GLib, GObject, Gtk, Soup} = imports.gi;
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const {MAClient} = Me.imports.lib.ma;

const _decoder = new TextDecoder();

// ---- čištění a normalizace URL ----

function _cleanHaUrl(url) {
    let s = (url || '').trim().replace(/\/+$/, '');
    if (s && !s.startsWith('http://') && !s.startsWith('https://'))
        s = 'http://' + s;
    if (s.endsWith('/api'))
        s = s.slice(0, -4);
    return s;
}

function _cleanMaUrl(url) {
    let s = (url || '').trim().replace(/\/+$/, '');
    if (s && !s.startsWith('http://') && !s.startsWith('https://') && !s.startsWith('ws://') && !s.startsWith('wss://'))
        s = 'http://' + s;
    return s;
}

// ---- pomocné funkce pro řádky Libadwaita ----

function _switchRow(title, subtitle, settings, key) {
    const row = new Adw.ActionRow({
        title: title,
        subtitle: subtitle || '',
    });
    const sw = new Gtk.Switch({
        valign: Gtk.Align.CENTER,
    });
    settings.bind(key, sw, 'active', Gio.SettingsBindFlags.DEFAULT);
    row.add_suffix(sw);
    row.activatable_widget = sw;
    return row;
}

function _entryRow(title, subtitle, settings, key, placeholder) {
    const row = new Adw.ActionRow({
        title: title,
        subtitle: subtitle || '',
    });
    const entry = new Gtk.Entry({
        valign: Gtk.Align.CENTER,
        hexpand: true,
        placeholder_text: placeholder || '',
    });
    settings.bind(key, entry, 'text', Gio.SettingsBindFlags.DEFAULT);
    row.add_suffix(entry);
    row.activatable_widget = entry;
    return {row, entry};
}

function _passwordRow(title, subtitle, settings, key) {
    const row = new Adw.ActionRow({
        title: title,
        subtitle: subtitle || '',
    });
    const entry = new Gtk.PasswordEntry({
        valign: Gtk.Align.CENTER,
        hexpand: true,
        show_peek_icon: true,
    });
    settings.bind(key, entry, 'text', Gio.SettingsBindFlags.DEFAULT);
    row.add_suffix(entry);
    row.activatable_widget = entry;
    return {row, entry};
}

/**
 * Řádek s rozbalovacím výběrem celočíselné hodnoty.
 * values: pole {value, label}; první položka s value === current je předvybraná.
 */
function _comboRow(title, subtitle, settings, key, values) {
    const row = new Adw.ActionRow({
        title: title,
        subtitle: subtitle || '',
    });
    const combo = new Gtk.ComboBoxText({
        valign: Gtk.Align.CENTER,
    });
    for (const v of values)
        combo.append_text(v.label);
    const applyCombo = () => {
        const current = settings.get_int(key);
        const idx = Math.max(0, values.findIndex(v => v.value === current));
        combo.set_active(idx);
    };
    applyCombo();
    combo.connect('changed', () => {
        const idx = combo.get_active();
        if (idx >= 0 && idx < values.length && values[idx].value !== settings.get_int(key))
            settings.set_int(key, values[idx].value);
    });
    const settingsHandler = settings.connect(`changed::${key}`, applyCombo);
    combo.connect('destroy', () => settings.disconnect(settingsHandler));
    row.add_suffix(combo);
    row.activatable_widget = combo;
    return row;
}

/** Jako _comboRow, ale pro textový klíč (např. entity-icon). */
function _comboRowStr(title, subtitle, settings, key, values) {
    const row = new Adw.ActionRow({
        title: title,
        subtitle: subtitle || '',
    });
    const combo = new Gtk.ComboBoxText({
        valign: Gtk.Align.CENTER,
    });
    for (const v of values)
        combo.append_text(v.label);
    const applyCombo = () => {
        const current = settings.get_string(key);
        const idx = Math.max(0, values.findIndex(v => v.value === current));
        combo.set_active(idx);
    };
    applyCombo();
    combo.connect('changed', () => {
        const idx = combo.get_active();
        if (idx >= 0 && idx < values.length && values[idx].value !== settings.get_string(key))
            settings.set_string(key, values[idx].value);
    });
    const settingsHandler = settings.connect(`changed::${key}`, applyCombo);
    combo.connect('destroy', () => settings.disconnect(settingsHandler));
    row.add_suffix(combo);
    row.activatable_widget = combo;
    return row;
}

// ---- individuální nastavení entit (klíč entity-configs) ----

/** Přečte přepis jedné entity z entity-configs (JSON), nebo null. */
function _entityOverrides(settings, entityId) {
    try {
        const dict = settings.get_value('entity-configs').deep_unpack();
        const raw = dict[entityId];
        return raw ? JSON.parse(raw) : null;
    } catch (e) {
        return null;
    }
}

/**
 * Uloží přepis entity (objekt) nebo ho smaže (null) v entity-configs.
 */
function _setEntityOverrides(settings, entityId, obj) {
    let dict = {};
    try {
        dict = settings.get_value('entity-configs').deep_unpack();
    } catch (e) {
    }
    if (obj)
        dict[entityId] = JSON.stringify(obj);
    else
        delete dict[entityId];
    settings.set_value('entity-configs', new GLib.Variant('a{ss}', dict));
}

/**
 * Dialog individuálního nastavení entity: vlastní název, ikona, režim
 * zobrazení v liště, desetinná místa a prahové hodnoty pro zvýraznění.
 */
function _entityConfigDialog(settings, entityId, root) {
    const ov = _entityOverrides(settings, entityId) || {};

    const dlg = new Gtk.Dialog({
        title: `Nastavení entity`,
        modal: true,
        use_header_bar: 1,
    });
    if (root)
        dlg.set_transient_for(root);
    dlg.add_button('Zrušit', Gtk.ResponseType.CANCEL);
    dlg.add_button('Vymazat', Gtk.ResponseType.REJECT);
    dlg.add_button('Uložit', Gtk.ResponseType.OK);
    dlg.set_default_response(Gtk.ResponseType.OK);

    const box = dlg.get_content_area();
    box.set({
        spacing: 10,
        margin_top: 14, margin_bottom: 14,
        margin_start: 16, margin_end: 16,
    });

    const idLabel = new Gtk.Label({
        label: `<b>${GLib.markup_escape_text(entityId, -1)}</b>`,
        use_markup: true,
        halign: Gtk.Align.START,
    });
    box.append(idLabel);

    const comboRow = (labelText, values, current) => {
        const hbox = new Gtk.Box({spacing: 10});
        const lbl = new Gtk.Label({label: labelText, hexpand: true, xalign: 0});
        const combo = new Gtk.ComboBoxText();
        for (const v of values)
            combo.append_text(v.label);
        const idx = Math.max(0, values.findIndex(v => v.value === current));
        combo.set_active(idx);
        hbox.append(lbl);
        hbox.append(combo);
        box.append(hbox);
        return combo;
    };

    const entryRow = (labelText, placeholder, initial) => {
        const hbox = new Gtk.Box({spacing: 10});
        const lbl = new Gtk.Label({label: labelText, hexpand: true, xalign: 0});
        const entry = new Gtk.Entry({
            placeholder_text: placeholder,
            hexpand: false, width_chars: 12,
            text: initial || '',
        });
        hbox.append(lbl);
        hbox.append(entry);
        box.append(hbox);
        return entry;
    };

    const nameEntry = entryRow('Vlastní název', 'dle Home Assistant', ov.name || '');
    const iconCombo = comboRow('Ikona', [
        {value: '', label: 'Globální nastavení'},
        {value: 'ha', label: 'Z Home Assistant (MDI)'},
        {value: 'type', label: 'Podle typu entity'},
        {value: 'text', label: 'Bez ikony'},
    ], ov.icon || '');
    const displayCombo = comboRow('Zobrazení v liště', [
        {value: '', label: 'Automaticky'},
        {value: 'icon', label: 'Jen ikona'},
        {value: 'icon-value', label: 'Ikona + hodnota'},
        {value: 'value', label: 'Jen hodnota / text'},
    ], ov.display || '');
    const decimalsCombo = comboRow('Desetinná místa', [
        {value: '', label: 'Globální nastavení'},
        {value: 0, label: '0 (celá čísla)'},
        {value: 1, label: '1'},
        {value: 2, label: '2'},
        {value: 3, label: '3'},
        {value: 4, label: '4'},
    ], Number.isInteger(ov.decimals) ? ov.decimals : '');
    const minEntry = entryRow('Práh minimum', 'neomezeno',
        typeof ov.min === 'number' ? String(ov.min) : '');
    const maxEntry = entryRow('Práh maximum', 'neomezeno',
        typeof ov.max === 'number' ? String(ov.max) : '');
    const hint = new Gtk.Label({
        label: 'Hodnota mimo prahy se zvýrazní červeně. Ikona, název,\n' +
               'desetinná místa a prahy platí pro lištu i menu; režim\n' +
               'zobrazení jen pro lištu (v menu u přepínače je hodnotou\n' +
               'sám přepínač).',
        halign: Gtk.Align.START,
        wrap: true,
    });
    hint.get_style_context().add_class('dim-label');
    box.append(hint);

    dlg.connect('response', (d, resp) => {
        if (resp === Gtk.ResponseType.REJECT) {
            _setEntityOverrides(settings, entityId, null);
        } else if (resp === Gtk.ResponseType.OK) {
            const out = {};
            const name = nameEntry.get_text().trim();
            if (name)
                out.name = name;
            const iconVal = iconCombo.get_active();
            if (iconVal > 0)
                out.icon = ['', 'ha', 'type', 'text'][iconVal];
            const dispVal = displayCombo.get_active();
            if (dispVal > 0)
                out.display = ['', 'icon', 'icon-value', 'value'][dispVal];
            const decIdx = decimalsCombo.get_active();
            if (decIdx > 0)
                out.decimals = decIdx - 1;
            const parseNum = txt => {
                const n = parseFloat((txt || '').trim().replace(',', '.'));
                return isFinite(n) ? n : null;
            };
            const mn = parseNum(minEntry.get_text());
            if (mn !== null)
                out.min = mn;
            const mx = parseNum(maxEntry.get_text());
            if (mx !== null)
                out.max = mx;
            _setEntityOverrides(settings, entityId,
                Object.keys(out).length > 0 ? out : null);
        }
        d.destroy();
    });

    dlg.present();
}

/**
 * Řádek pro zachycení globální klávesové zkratky: klikni na tlačítko
 * a stiskni kombinaci kláves (Esc/Backspace zkratku smaže).
 */
function _keybindingRow(title, subtitle, settings, key) {
    const row = new Adw.ActionRow({
        title: title,
        subtitle: subtitle || '',
    });
    const btn = new Gtk.Button({valign: Gtk.Align.CENTER});
    btn.add_css_class('flat');

    const render = () => {
        const accels = settings.get_strv(key);
        if (accels.length === 0) {
            btn.label = 'Není nastavena';
            return;
        }
        const [ok, keyval, mods] = Gtk.accelerator_parse(accels[0]);
        btn.label = ok && keyval ? Gtk.accelerator_get_label(keyval, mods) : accels[0];
    };
    render();

    const ctrl = new Gtk.EventControllerKey();
    btn.add_controller(ctrl);
    ctrl.connect('key-pressed', (c, keyval, keycode, state) => {
        const mods = state & Gtk.accelerator_get_default_mod_mask();
        if (keyval === Gdk.KEY_Escape || keyval === Gdk.KEY_BackSpace) {
            settings.set_strv(key, []);
            return Gdk.EVENT_STOP;
        }
        // samotné klávesy bez modifikátoru (a ne F1-F12) nejsou platná zkratka
        const isFn = keyval >= Gdk.KEY_F1 && keyval <= Gdk.KEY_F12;
        if (mods === 0 && !isFn)
            return Gdk.EVENT_STOP;
        settings.set_strv(key, [Gtk.accelerator_name(keyval, mods)]);
        return Gdk.EVENT_STOP;
    });
    ctrl.connect('key-released', () => render());
    const settingsHandler = settings.connect(`changed::${key}`, render);
    btn.connect('destroy', () => settings.disconnect(settingsHandler));

    btn.connect('clicked', () => btn.grab_focus());
    row.add_suffix(btn);
    row.activatable_widget = btn;
    return row;
}

/**
 * Editor seznamu entity_id: čisté řádky v Adw.PreferencesGroup.
 */
function _createEntityGroup(settings, key, title, description, placeholder) {
    const group = new Adw.PreferencesGroup({
        title: title,
        description: description,
    });

    const entries = [];
    const rows = [];
    let persistId = 0;
    let sharedCompletion = null;

    const persist = () => {
        if (persistId)
            GLib.source_remove(persistId);
        persistId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            persistId = 0;
            const values = entries
                .map(e => (e.get_text() || '').trim())
                .filter(v => v.length > 0);
            settings.set_strv(key, values);
            return GLib.SOURCE_REMOVE;
        });
    };

    const addBtnRow = new Adw.ActionRow({
        title: 'Přidat entitu…',
        activatable: true,
    });
    const addIcon = new Gtk.Image({
        icon_name: 'list-add-symbolic',
        valign: Gtk.Align.CENTER,
    });
    addBtnRow.add_prefix(addIcon);

    const addRow = (initialText) => {
        const row = new Adw.ActionRow();
        const entry = new Gtk.Entry({
            hexpand: true,
            valign: Gtk.Align.CENTER,
            placeholder_text: placeholder || 'např. sensor.teplota_obyvak',
            text: initialText || '',
        });
        if (sharedCompletion)
            entry.set_completion(sharedCompletion);

        entry.connect('changed', persist);
        entries.push(entry);

        const cfgBtn = new Gtk.Button({
            icon_name: 'document-edit-symbolic',
            valign: Gtk.Align.CENTER,
            has_frame: false,
            tooltip_text: 'Individuální nastavení entity (ikona, desetinná místa, prahy…)',
        });
        cfgBtn.add_css_class('flat');
        cfgBtn.connect('clicked', () => {
            const id = (entry.get_text() || '').trim();
            if (!id.includes('.'))
                return;
            let root = null;
            try {
                root = entry.get_root();
            } catch (e) {
            }
            _entityConfigDialog(settings, id, root);
        });

        const removeBtn = new Gtk.Button({
            icon_name: 'user-trash-symbolic',
            valign: Gtk.Align.CENTER,
            has_frame: false,
            tooltip_text: 'Odebrat entitu',
        });
        removeBtn.add_css_class('flat');

        removeBtn.connect('clicked', () => {
            const eIdx = entries.indexOf(entry);
            if (eIdx >= 0)
                entries.splice(eIdx, 1);
            const rIdx = rows.indexOf(row);
            if (rIdx >= 0)
                rows.splice(rIdx, 1);
            group.remove(row);
            persist();
        });

        row.add_prefix(entry);
        row.add_suffix(cfgBtn);
        row.add_suffix(removeBtn);
        rows.push(row);

        // vložit před addBtnRow
        group.remove(addBtnRow);
        group.add(row);
        group.add(addBtnRow);
    };

    addBtnRow.connect('activated', () => addRow(''));
    group.add(addBtnRow);

    const stored = settings.get_strv(key);
    for (const id of stored)
        addRow(id);
    if (stored.length === 0)
        addRow('');

    return {
        group,
        setCompletion(ids) {
            const store = new Gtk.ListStore();
            store.set_column_types([GObject.TYPE_STRING]);
            const limit = Math.min((ids || []).length, 500);
            for (let i = 0; i < limit; i++) {
                const iter = store.append();
                store.set(iter, [0], [ids[i]]);
            }
            sharedCompletion = new Gtk.EntryCompletion();
            sharedCompletion.set_model(store);
            sharedCompletion.set_text_column(0);
            sharedCompletion.set_minimum_key_length(1);
            for (const e of entries)
                e.set_completion(sharedCompletion);
        },
    };
}

// ---- test spojení ----

function _createSoupMessage(method, url) {
    let httpUrl = url;
    if (httpUrl.startsWith('ws://'))
        httpUrl = 'http://' + httpUrl.slice(5);
    else if (httpUrl.startsWith('wss://'))
        httpUrl = 'https://' + httpUrl.slice(6);

    if (typeof Soup.Message.new === 'function') {
        try {
            const msg = Soup.Message.new(method, url);
            if (msg)
                return msg;
        } catch (e) {
        }
        try {
            const msg = Soup.Message.new(method, httpUrl);
            if (msg)
                return msg;
        } catch (e) {
        }
    }
    if (typeof Soup.URI !== 'undefined' && typeof Soup.URI.new === 'function') {
        try {
            const soupUri = Soup.URI.new(httpUrl);
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
    return null;
}

function _decodeBytes(bytes) {
    if (!bytes)
        return '';
    const data = bytes instanceof Uint8Array ? bytes : (typeof bytes.get_data === 'function' ? bytes.get_data() : bytes);
    return _decoder.decode(data);
}

function _handleHaStatesResponse(status, body, callback) {
    if (status === 401 || status === 403) {
        callback(false, 'Přihlášení selhalo (401/403) — zkontrolujte dlouhodobý token.');
        return;
    }
    if (status === 404) {
        callback(false, 'Server vrátil 404 Not Found — ověřte zadanou URL.');
        return;
    }
    if (status !== 200) {
        callback(false, `Server vrátil kód ${status}.`);
        return;
    }
    let states;
    try {
        states = JSON.parse(body);
    } catch (e) {
        callback(false, `Neplatná JSON odpověď serveru: ${e.message}`);
        return;
    }
    if (!Array.isArray(states)) {
        callback(false, 'Server nevrátil pole entit.');
        return;
    }
    const ids = states.map(s => s.entity_id).filter(id => !!id).sort();
    const mediaPlayers = states
        .filter(s => s.entity_id && s.entity_id.startsWith('media_player.'))
        .map(s => ({
            id: s.entity_id,
            name: (s.attributes && s.attributes.friendly_name) || s.entity_id,
        }));
    callback(true, `Připojeno — nalezeno ${ids.length} entit.`, ids, mediaPlayers);
}

function testHa(url, token, allowInsecure, callback) {
    const base = _cleanHaUrl(url);
    if (!base) {
        callback(false, 'Zadejte URL Home Assistant.');
        return;
    }
    const session = new Soup.Session();
    try {
        session.timeout = 25;
    } catch (e) {
    }
    if (allowInsecure) {
        try {
            session.ssl_strict = false;
        } catch (e) {
        }
        try {
            session.connect('accept-certificate', () => true);
        } catch (e) {
        }
    }
    const targetUrl = `${base}/api/states`;
    const msg = _createSoupMessage('GET', targetUrl);
    if (!msg) {
        callback(false, 'Neplatná URL (např. http://192.168.1.10:8123).');
        return;
    }
    const cleanToken = (token || '').trim();
    if (cleanToken)
        msg.request_headers.append('Authorization', `Bearer ${cleanToken}`);

    if (typeof session.queue_message === 'function') {
        session.queue_message(msg, (sess, message) => {
            try {
                const status = message.status_code;
                const body = (message.response_body && message.response_body.data) ? message.response_body.data : '';
                _handleHaStatesResponse(status, body, callback);
            } catch (e) {
                callback(false, `Chyba spojení: ${e.message}`);
            }
        });
    } else {
        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (sess, res) => {
            try {
                const bytes = sess.send_and_read_finish(res);
                const status = typeof msg.get_status === 'function' ? msg.get_status() : msg.status_code;
                const body = _decodeBytes(bytes);
                _handleHaStatesResponse(status, body, callback);
            } catch (e) {
                callback(false, `Chyba spojení: ${e.message}`);
            }
        });
    }
}

function testMa(url, token, allowInsecure, callback) {
    const base = _cleanMaUrl(url);
    if (!base) {
        callback(false, 'Zadejte URL Music Assistant serveru.');
        return;
    }
    let finished = false;
    let timeoutId = 0;
    const finish = (ok, msg, players) => {
        if (finished)
            return;
        finished = true;
        if (timeoutId) {
            GLib.source_remove(timeoutId);
            timeoutId = 0;
        }
        callback(ok, msg, players || []);
        client.disconnect();
        client.destroy();
    };
    timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 10, () => {
        timeoutId = 0;
        finish(false, 'Vypršel časový limit spojení (10 s).');
        return GLib.SOURCE_REMOVE;
    });

    const client = new MAClient();
    client.configure(base, (token || '').trim(), allowInsecure, '');
    client.onplayers = () => {
        const names = client.players.map(p => p.name || p.player_id);
        finish(true, `Připojeno — ${client.players.length} přehrávačů: ${names.join(', ')}`, client.players);
    };
    client.onstate = (status, detail) => {
        if (finished)
            return;
        if (status === 'auth-error') {
            finish(false, 'Přístup odepřen — zkontrolujte API klíč.');
        }
    };
    client.connect();
}

// ---- seznam přehrávačů pro MPRIS (MA + HA, při duplicitě preferovat MA) ----

var _maPlayers = [];   // [{player_id, name}]
var _haPlayers = [];   // [{id, name}] (pouze media_player.*)
var _playersBox = null;

function _normName(name) {
    return String(name || '')
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}

function _persistMprisSelection(settings) {
    const selected = [];
    let child = _playersBox ? _playersBox.get_first_child() : null;
    while (child) {
        if (child instanceof Gtk.CheckButton && child.active && child._playerRef)
            selected.push(child._playerRef);
        child = child.get_next_sibling();
    }
    settings.set_strv('mpris-players', selected);
}

function _refreshPlayerList(settings) {
    if (!_playersBox)
        return;
    let child = _playersBox.get_first_child();
    while (child) {
        const next = child.get_next_sibling();
        _playersBox.remove(child);
        child = next;
    }

    const selected = new Set(settings.get_strv('mpris-players'));
    const maNames = new Set(_maPlayers.map(p => _normName(p.name)));

    const rows = [];
    for (const p of _maPlayers) {
        const twin = maNames.has(_normName(p.name)) &&
            _haPlayers.some(h => _normName(h.name) === _normName(p.name));
        rows.push({
            ref: `ma:${p.player_id}`,
            label: `${p.name || p.player_id} — Music Assistant${twin ? ' (nalezen i v HA)' : ''}`,
        });
    }
    for (const h of _haPlayers) {
        // stejný přehrávač v MA i HA: preferujeme MA
        if (maNames.has(_normName(h.name)))
            continue;
        rows.push({ref: `ha:${h.id}`, label: `${h.name || h.id} — Home Assistant`});
    }

    if (rows.length === 0) {
        const emptyLbl = new Gtk.Label({
            label: 'Žádní přehrávači — načtou se po otestování spojení výše.',
            halign: Gtk.Align.START,
            wrap: true,
            margin_top: 8,
            margin_bottom: 8,
            margin_start: 12,
            margin_end: 12,
        });
        emptyLbl.add_css_class('dim-label');
        _playersBox.append(emptyLbl);
        return;
    }

    for (const row of rows) {
        const cb = new Gtk.CheckButton({
            label: row.label,
            active: selected.has(row.ref),
            halign: Gtk.Align.START,
            margin_top: 4,
            margin_bottom: 4,
            margin_start: 12,
            margin_end: 12,
        });
        cb._playerRef = row.ref;
        cb.connect('toggled', () => _persistMprisSelection(settings));
        _playersBox.append(cb);
    }
}

function _collectHaPlayers(mediaPlayers) {
    _haPlayers = mediaPlayers || [];
}

function _autoLoadPlayers(settings) {
    if (settings.get_string('ha-url') && settings.get_string('ha-token')) {
        testHa(settings.get_string('ha-url'), settings.get_string('ha-token'),
            settings.get_boolean('allow-insecure-tls'),
            (ok, msg, ids, mediaPlayers) => {
                if (ok && mediaPlayers)
                    _collectHaPlayers(mediaPlayers);
                _refreshPlayerList(settings);
            });
    }
    if (settings.get_string('ma-url')) {
        testMa(settings.get_string('ma-url'), settings.get_string('ma-token'),
            settings.get_boolean('allow-insecure-tls'),
            (ok, msg, players) => {
                if (ok)
                    _maPlayers = players.map(p => ({player_id: p.player_id, name: p.name || p.player_id}));
                _refreshPlayerList(settings);
            });
    }
}

// ---- stránky nastavení ----

function buildHaPage(settings) {
    const page = new Adw.PreferencesPage({
        title: 'Home Assistant',
        icon_name: 'user-home-symbolic',
    });

    // Skupina připojení
    const connGroup = new Adw.PreferencesGroup({
        title: 'Připojení',
        description: 'Nastavení spojení k serveru Home Assistant',
    });

    const urlField = _entryRow('URL serveru', 'Např. http://homeassistant.local:8123', settings, 'ha-url', 'http://homeassistant.local:8123');
    connGroup.add(urlField.row);

    const tokenField = _passwordRow('Přístupový token',
        'Dlouhodobý přístupový token z profilu uživatele v Home Assistant',
        settings, 'ha-token');
    connGroup.add(tokenField.row);

    const tlsRow = _switchRow(
        'Povolit neověřené TLS certifikáty',
        'Pro servery s vlastním nebo self-signed certifikátem (libsoup 3.2+)',
        settings, 'allow-insecure-tls');
    connGroup.add(tlsRow);

    // Test spojení
    const testRow = new Adw.ActionRow({
        title: 'Test spojení',
        subtitle: 'Ověří dostupnost serveru a načte seznam entit',
    });
    const testBtn = new Gtk.Button({
        label: 'Otestovat',
        icon_name: 'network-transmit-receive-symbolic',
        valign: Gtk.Align.CENTER,
    });
    testRow.add_suffix(testBtn);
    connGroup.add(testRow);

    page.add(connGroup);

    // Entity v horní liště
    const panelEditor = _createEntityGroup(
        settings,
        'ha-panel-entities',
        'Entity v horní liště',
        'Hodnoty entit (např. senzor teploty) zobrazené přímo v horním panelu GNOME. ' +
        'Přepínače, tlačítka a ostatní ovládací prvky lze ovládat přímo v liště; ' +
        'název entity se zobrazí při najetí myší.',
        'např. sensor.teplota_obyvak'
    );
    panelEditor.group.add(_comboRow(
        'Desetinná místa číselných hodnot',
        'Automaticky podle entity, nebo pevný počet desetinných míst',
        settings,
        'value-decimals',
        [
            {value: -1, label: 'Automaticky'},
            {value: 0, label: '0 (celá čísla)'},
            {value: 1, label: '1'},
            {value: 2, label: '2'},
            {value: 3, label: '3'},
            {value: 4, label: '4'},
        ]
    ));
    panelEditor.group.add(_comboRowStr(
        'Ikony entit',
        'Zdroj ikon v liště i menu. "Z Home Assistant" používá ikonu entity ' +
        '(mdi:…), které rozšíření obsahuje jako součástí dodávanou sadu MDI',
        settings,
        'entity-icon',
        [
            {value: 'ha', label: 'Z Home Assistant (MDI)'},
            {value: 'type', label: 'Podle typu entity'},
            {value: 'text', label: 'Bez ikon'},
        ]
    ));
    page.add(panelEditor.group);

    // Zkratky
    const keysGroup = new Adw.PreferencesGroup({
        title: 'Zkratky',
        description: 'Globální klávesové zkratky rozšíření',
    });
    keysGroup.add(_keybindingRow(
        'Otevřít menu a chat s asistentem',
        'Otevře menu rozšíření a nastaví kurzor do pole konverzace',
        settings,
        'hotkey-open-menu'
    ));
    page.add(keysGroup);

    // Entity v menu
    const menuEditor = _createEntityGroup(
        settings,
        'ha-menu-entities',
        'Entity v menu rozšíření',
        'Ovládací prvky v rozbalovacím menu. Typ prvku se přizpůsobí automaticky podle domény: ' +
        'přepínač (switch, light, fan), posuvník (jas světel, hlasitost, žaluzie), ' +
        'tlačítko (skript, scéna), rozbalovací výběr (input_select), text nebo senzor.',
        'např. light.obyvak nebo switch.kavovar'
    );
    page.add(menuEditor.group);

    testBtn.connect('clicked', () => {
        testBtn.sensitive = false;
        testRow.subtitle = 'Testuji spojení…';
        const url = urlField.entry.get_text().trim() || settings.get_string('ha-url').trim();
        const token = tokenField.entry.get_text().trim() || settings.get_string('ha-token').trim();
        const allowInsecure = settings.get_boolean('allow-insecure-tls');

        // Okamžitě explicitně uložit do GSettings
        if (url)
            settings.set_string('ha-url', url);
        if (token)
            settings.set_string('ha-token', token);

        testHa(url, token, allowInsecure, (ok, msg, ids, mediaPlayers) => {
            testBtn.sensitive = true;
            testRow.subtitle = msg;
            if (ok && ids && ids.length > 0) {
                panelEditor.setCompletion(ids);
                menuEditor.setCompletion(ids);
            }
            if (ok && mediaPlayers) {
                _collectHaPlayers(mediaPlayers);
                _refreshPlayerList(settings);
            }
        });
    });

    return page;
}

function buildMaPage(settings) {
    const page = new Adw.PreferencesPage({
        title: 'Music Assistant',
        icon_name: 'audio-x-generic-symbolic',
    });

    // Skupina připojení
    const connGroup = new Adw.PreferencesGroup({
        title: 'Připojení',
        description: 'Nastavení spojení k serveru Music Assistant',
    });

    const enableRow = _switchRow(
        'Zapnout integraci Music Assistant',
        'Zobrazí sekci přehrávače v menu a umožní MPRIS ovládání',
        settings, 'ma-enabled');
    connGroup.add(enableRow);

    const urlField = _entryRow('URL serveru', 'Např. http://music-assistant:8095', settings, 'ma-url', 'http://music-assistant:8095');
    connGroup.add(urlField.row);

    const tokenField = _passwordRow('API klíč',
        'Volitelné — pouze pokud MA vyžaduje přihlášení',
        settings, 'ma-token');
    connGroup.add(tokenField.row);

    // Test spojení
    const testRow = new Adw.ActionRow({
        title: 'Test spojení',
        subtitle: 'Ověří dostupnost serveru a načte přehrávače',
    });
    const testBtn = new Gtk.Button({
        label: 'Otestovat',
        icon_name: 'network-transmit-receive-symbolic',
        valign: Gtk.Align.CENTER,
    });
    testRow.add_suffix(testBtn);
    connGroup.add(testRow);

    page.add(connGroup);

    // Výchozí přehrávač
    const playerGroup = new Adw.PreferencesGroup({
        title: 'Výchozí přehrávač',
        description: 'Který přehrávač se má v menu vybrat při startu',
    });
    const playerRow = new Adw.ActionRow({
        title: 'Výchozí přehrávač',
        subtitle: 'Přehrávač zobrazený v menu po otevření',
    });
    const playerCombo = new Gtk.ComboBoxText({valign: Gtk.Align.CENTER});
    playerCombo.append('auto', 'Automaticky (první hrající)');
    playerCombo.active_id = settings.get_string('ma-default-player') || 'auto';
    playerCombo.connect('changed', () => {
        const id = playerCombo.active_id || 'auto';
        settings.set_string('ma-default-player', id === 'auto' ? '' : id);
    });
    playerRow.add_suffix(playerCombo);
    playerGroup.add(playerRow);
    page.add(playerGroup);

    testBtn.connect('clicked', () => {
        testBtn.sensitive = false;
        testRow.subtitle = 'Testuji spojení…';
        playerCombo.remove_all();
        playerCombo.append('auto', 'Automaticky (první hrající)');
        playerCombo.active_id = 'auto';

        const url = urlField.entry.get_text().trim() || settings.get_string('ma-url').trim();
        const token = tokenField.entry.get_text().trim() || settings.get_string('ma-token').trim();
        const allowInsecure = settings.get_boolean('allow-insecure-tls');

        // Okamžitě explicitně uložit do GSettings
        if (url)
            settings.set_string('ma-url', url);
        if (token)
            settings.set_string('ma-token', token);

        testMa(
            url,
            token,
            allowInsecure,
            (ok, msg, players) => {
                testBtn.sensitive = true;
                testRow.subtitle = msg;
                if (ok && players.length > 0) {
                    const current = settings.get_string('ma-default-player') || 'auto';
                    for (const p of players)
                        playerCombo.append(p.player_id, p.name || p.player_id);
                    playerCombo.active_id = current;
                    _maPlayers = players.map(p => ({player_id: p.player_id, name: p.name || p.player_id}));
                    _refreshPlayerList(settings);
                }
            });
    });

    // MPRIS
    const mprisGroup = new Adw.PreferencesGroup({
        title: 'MPRIS a multimediální klávesy',
        description: 'Propojení se systémovým ovládáním médií v GNOME',
    });
    mprisGroup.add(_switchRow(
        'MPRIS most (multimediální klávesy)',
        'Umožní ovládat přehrávače hardwarovými klávesami a systémovým ovládáním médií v GNOME',
        settings, 'ma-mpris'));
    page.add(mprisGroup);

    // Přehrávače pro MPRIS
    const playersGroup = new Adw.PreferencesGroup({
        title: 'Přehrávače v MPRIS',
        description: 'Zaškrtněte přehrávače z Music Assistant i Home Assistant. Při shodě jmen má přednost Music Assistant.',
    });
    _playersBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 2,
        margin_top: 4,
        margin_bottom: 4,
    });
    playersGroup.add(_playersBox);
    _refreshPlayerList(settings);
    page.add(playersGroup);

    // Prvky přehrávače v menu
    const menuGroup = new Adw.PreferencesGroup({
        title: 'Ovládací prvky v menu',
        description: 'Zvolte prvky přehrávače zobrazované v rozbalovacím menu',
    });
    menuGroup.add(_switchRow('Výběr přehrávače v menu', null, settings, 'ma-show-player-selector'));
    menuGroup.add(_switchRow('Tlačítka přehrávání', 'Play/Pause, předchozí, další', settings, 'ma-show-transport'));
    menuGroup.add(_switchRow('Posuvník pozice skladby', null, settings, 'ma-show-seek'));
    menuGroup.add(_switchRow('Posuvník hlasitosti', null, settings, 'ma-show-volume'));
    menuGroup.add(_switchRow('Náhodné přehrávání a opakování (Shuffle a repeat)', null, settings, 'ma-show-shuffle-repeat'));
    page.add(menuGroup);

    return page;
}

function buildPanelPage(settings) {
    const page = new Adw.PreferencesPage({
        title: 'Horní lišta',
        icon_name: 'preferences-system-symbolic',
    });
    const group = new Adw.PreferencesGroup({
        title: 'Indikátor v panelu',
        description: 'Přizpůsobení ikony a stavu v horní liště GNOME',
    });
    group.add(_switchRow('Zobrazit ikonu', 'Ikona domečku / noty / stavu offline', settings, 'panel-show-icon'));
    group.add(_switchRow('Zobrazit stav spojení (tečky)', 'Barevná indikace stavu Home Assistant a Music Assistant', settings, 'panel-show-status'));
    page.add(group);
    return page;
}

function init() {
}

/**
 * Moderní vstupní bod pro GNOME 42+ (Libadwaita).
 */
function fillPreferencesWindow(window) {
    const settings = ExtensionUtils.getSettings();

    window.set_default_size(680, 750);
    window.set_search_enabled(true);

    window.add(buildHaPage(settings));
    window.add(buildMaPage(settings));
    window.add(buildPanelPage(settings));

    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        _autoLoadPlayers(settings);
        return GLib.SOURCE_REMOVE;
    });
}

/**
 * Zpětně kompatibilní fallback (GTK4 widget).
 */
function buildPrefsWidget() {
    const settings = ExtensionUtils.getSettings();

    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
        margin_top: 12,
        margin_bottom: 12,
        margin_start: 12,
        margin_end: 12,
    });

    const stack = new Gtk.Stack({
        transition_type: Gtk.StackTransitionType.SLIDE_LEFT_RIGHT,
    });
    const switcher = new Gtk.StackSwitcher({
        stack: stack,
        halign: Gtk.Align.CENTER,
        margin_bottom: 12,
    });

    box.append(switcher);
    box.append(stack);

    stack.add_titled(buildHaPage(settings), 'ha', 'Home Assistant');
    stack.add_titled(buildMaPage(settings), 'ma', 'Music Assistant');
    stack.add_titled(buildPanelPage(settings), 'panel', 'Horní lišta');

    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        _autoLoadPlayers(settings);
        return GLib.SOURCE_REMOVE;
    });

    return box;
}
