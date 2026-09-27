// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 konikvranik
//
/*
 * Nastavení rozšíření (GTK4 + Libadwaita). GNOME 42+.
 */

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';
import Soup from 'gi://Soup';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {MAClient} from './lib/ma.js';
import * as I18n from './lib/i18n.js';

const _ = I18n._;
// %s/%d nahrazování - String.format z GNOME Shell prostředí tady
// není (čistý gjs / prefs proces)
const _f = (str, ...args) => str.replace(/%[sd]/g, () => args.shift());

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

/**
 * Řádek s polem přes celou šířku: název a popis nad sebou, pole pod nimi.
 * (Adw.ActionRow by pole stiskl na šířku popisku — suffix-box se neroztahuje.)
 */
function _fieldRow(title, subtitle, entry) {
    const row = new Adw.PreferencesRow({activatable: false});
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 3,
        valign: Gtk.Align.CENTER,
    });
    // class 'header' = stejné okraje (12px) a min-výška jako u ActionRow
    box.add_css_class('header');
    if (title) {
        const titleLabel = new Gtk.Label({
            label: title, xalign: 0, wrap: true, wrap_mode: Pango.WrapMode.WORD_CHAR,
        });
        box.append(titleLabel);
    }
    if (subtitle) {
        const subLabel = new Gtk.Label({
            label: subtitle, xalign: 0, wrap: true, wrap_mode: Pango.WrapMode.WORD_CHAR,
        });
        // class 'subtitle' = stejný styl popisku jako u ActionRow (menší, tlumený)
        subLabel.add_css_class('subtitle');
        box.append(subLabel);
    }
    entry.hexpand = true;
    entry.margin_top = 3;
    box.append(entry);
    row.set_child(box);
    return row;
}

function _entryRow(title, subtitle, settings, key, placeholder) {
    const entry = new Gtk.Entry({
        valign: Gtk.Align.CENTER,
        placeholder_text: placeholder || '',
    });
    settings.bind(key, entry, 'text', Gio.SettingsBindFlags.DEFAULT);
    return {row: _fieldRow(title, subtitle, entry), entry};
}

function _passwordRow(title, subtitle, settings, key) {
    const entry = new Gtk.PasswordEntry({
        valign: Gtk.Align.CENTER,
        show_peek_icon: true,
    });
    settings.bind(key, entry, 'text', Gio.SettingsBindFlags.DEFAULT);
    return {row: _fieldRow(title, subtitle, entry), entry};
}

/**
 * Adw.ActionRow roztahuje interní blok titulku (hexpand=True z template),
 * takže pole v prefixes nezabere volné místo až k suffixům. Titulkový blok
 * tady sbalíme, aby se roztáhlo pole s hexpand=true (např. entry entity).
 */
function _collapseTitleBox(row) {
    let header = row.get_first_child();
    for (let c = header && header.get_first_child(); c; c = c.get_next_sibling()) {
        if (c instanceof Gtk.Box && c.hexpand) {
            c.hexpand = false;
            return true;
        }
    }
    return false;
}

/**
 * Porovnání pro našeptávač entit. key je zadaný text (lowercase).
 *  - dotaz s tečkou („sensor.pro“) → filtr na začátek entity_id,
 *  - jinak podřetězec v entity_id, názvu entity (bez diakritiky)
 *    nebo názvu zařízení.
 */
function _entityMatch(key, id, name, device) {
    const k = String(key || '').toLowerCase();
    if (!k)
        return false;
    return _entityMatchItem(k, _normName(k), _makeEntityItem(id, name, device));
}

/** Položka našeptávače s předpočítanými poli pro rychlé filtrování. */
function _makeEntityItem(id, name, device) {
    return {
        id,
        name,
        device,
        lcId: id.toLowerCase(),
        nName: _normName(name),
        nDev: _normName(device),
    };
}

/** Rychlé porovnání s předpočítanými poli (stejná sémantika jako _entityMatch). */
function _entityMatchItem(k, kn, it) {
    if (k.includes('.'))
        return it.lcId.startsWith(k);
    if (it.lcId.includes(k))
        return true;
    return !!(kn && ((it.nName && it.nName.includes(kn)) ||
                     (it.nDev && it.nDev.includes(kn))));
}

/** Markup řádku našeptávače: název + zařízení + entity_id. */
function _entityDisplayMarkup(it) {
    const esc = s => GLib.markup_escape_text(String(s || ''), -1);
    if (it.name && it.name !== it.id && it.device)
        return `<b>${esc(it.name)}</b>  <small>${esc(it.device)} · ${esc(it.id)}</small>`;
    if (it.name && it.name !== it.id)
        return `<b>${esc(it.name)}</b>  <small>${esc(it.id)}</small>`;
    if (it.device)
        return `<b>${esc(it.id)}</b>  <small>${esc(it.device)}</small>`;
    return `<b>${esc(it.id)}</b>`;
}

// limit počtu nabízených položek a výška řádku (pro scroll a fixní šířku)
const ENTITY_MAX_MATCHES = 30;
const ENTITY_ROW_HEIGHT = 34;
const ENTITY_MIN_CHARS = 3;        // napovídat od 3 znaků (dotaz bez domény)
const ENTITY_MIN_CHARS_DOT = 2;    // dotaz s doménou („li“) od 2 znaků
const ENTITY_DEBOUNCE_MS = 300;    // prodleva po stisku klávesy
const ENTITY_CACHE_SIZE = 32;      // zapamatované dotazy → shody

/**
 * Vlastní našeptávač entit — VLOŽENÝ SEZNAM pod polem (Gtk.Revealer,
 * vzor Adw.EntryRow). Gtk.EntryCompletion ani popup (Gtk.Popover) se s
 * desítkami tisíc položek na GTK 4.6 chovají nestabilně: popup mění
 * nativní okna a bere klávesový grab, takže psaní zasekává a přeblikává.
 * Tady seznam žije přímo v řádku: žádný grab (psaní běží dál), žádné
 * přesouvání oken, obsah se přepoužívá z cache dotazů.
 * Vrací holder (Gtk.Box k vložení do řádku) a API pro testy.
 */
function _attachEntityCompletion(entry, getItems) {
    const holder = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 4,
    });
    holder.append(entry);
    const scroller = new Gtk.ScrolledWindow({
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
    });
    scroller.add_css_class('card');
    const listBox = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.SINGLE});
    scroller.set_child(listBox);
    const revealer = new Gtk.Revealer({
        transition_type: Gtk.RevealerTransitionType.SLIDE_DOWN,
        transition_duration: 120,
        reveal_child: false,
    });
    revealer.set_child(scroller);
    holder.append(revealer);

    const state = {matches: [], idx: -1, timer: 0, accepting: false,
        lastQuery: null, rendered: null};
    const queryCache = new Map();

    const collapse = () => {
        revealer.reveal_child = false;
    };

    const pick = it => {
        state.accepting = true;
        state.lastQuery = null;
        entry.set_text(it.id);
        entry.set_position(-1);
        collapse();
    };

    const rebuildRows = () => {
        if (state.rendered === state.matches)
            return;
        state.rendered = state.matches;
        for (let c = listBox.get_first_child(); c; ) {
            const next = c.get_next_sibling();
            listBox.remove(c);
            c = next;
        }
        for (const it of state.matches) {
            const row = new Gtk.ListBoxRow({focusable: false});
            const lbl = new Gtk.Label({
                label: _entityDisplayMarkup(it),
                use_markup: true,
                xalign: 0,
                ellipsize: Pango.EllipsizeMode.END,
                margin_top: 6,
                margin_bottom: 6,
                margin_start: 10,
                margin_end: 10,
            });
            row.set_child(lbl);
            // tooltip při hoveru: celý název, zařízení i přesné entity_id
            // (label je ořezávaný, takže tooltip i plný text)
            const tip = [];
            if (it.name)
                tip.push(`<b>${GLib.markup_escape_text(it.name, -1)}</b>`);
            if (it.device)
                tip.push(GLib.markup_escape_text(it.device, -1));
            tip.push(GLib.markup_escape_text(it.id, -1));
            row.tooltip_markup = tip.join('\n');
            const gesture = new Gtk.GestureClick();
            gesture.set_button(1);
            gesture.connect('released', () => pick(it));
            row.add_controller(gesture);
            listBox.append(row);
        }
        if (state.idx >= 0 && listBox.get_row_at_index(state.idx))
            listBox.select_row(listBox.get_row_at_index(state.idx));
    };

    const computeMatches = text => {
        const k = String(text || '').toLowerCase();
        if (!k)
            return [];
        const kn = _normName(k);
        const out = [];
        for (const it of getItems()) {
            if (_entityMatchItem(k, kn, it)) {
                out.push(it);
                if (out.length >= ENTITY_MAX_MATCHES)
                    break;
            }
        }
        return out;
    };

    const runFilter = () => {
        const text = String(entry.get_text() || '');
        const minLen = text.includes('.') ? ENTITY_MIN_CHARS_DOT : ENTITY_MIN_CHARS;
        if (text.length < minLen) {
            // bez brány fokusu — vlastnost has_focus je v GTK 4.6 nespolehlivá
            // (hlásila false i při psaní); seznam se otevírá jen na změnu
            // textu a pick() si to potlačí přes accepting
            state.lastQuery = null;
            state.matches = [];
            state.idx = -1;
            collapse();
            return;
        }
        if (state.lastQuery === text)
            return;             // stejné zadání — nic nepřekreslovat
        let matches = queryCache.get(text);
        if (!matches) {
            matches = computeMatches(text);
            if (queryCache.size >= ENTITY_CACHE_SIZE) {
                const oldest = queryCache.keys().next().value;
                queryCache.delete(oldest);
            }
            queryCache.set(text, matches);
        }
        state.lastQuery = text;
        state.matches = matches;
        state.idx = state.matches.length ? 0 : -1;
        if (state.matches.length === 0) {
            collapse();
            return;
        }
        rebuildRows();
        // Gtk.ScrolledWindow bez min-content má přirozený rozměr 0 — seznam
        // by se odhalil nulové šířky/výšky (neviditelný)
        scroller.min_content_width =
            Math.max(entry.get_allocated_width() || 300, 240);
        scroller.min_content_height =
            Math.min(state.matches.length, 8) * ENTITY_ROW_HEIGHT + 8;
        revealer.reveal_child = true;
    };

    entry.connect('changed', () => {
        if (state.accepting) {
            state.accepting = false;
            return;
        }
        if (state.timer)
            GLib.source_remove(state.timer);
        state.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            ENTITY_DEBOUNCE_MS, () => {
                state.timer = 0;
                runFilter();
                return GLib.SOURCE_REMOVE;
            });
    });

    const keyCtl = new Gtk.EventControllerKey();
    // CAPTURE: jinak vnitřní Gtk.Text Enter sám zkousne (aktivace entry)
    // a náš bubble-phase controller se na něj nedostane (šipky ano — ty
    // Gtk.Text nehandluje, proto pohyb v seznamu fungoval)
    keyCtl.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
    entry.add_controller(keyCtl);
    keyCtl.connect('key-pressed', (c, keyval) => {
        if (!revealer.reveal_child)
            return Gdk.EVENT_PROPAGATE;
        const step = keyval === Gdk.KEY_Down || keyval === Gdk.KEY_KP_Down ? 1 :
            keyval === Gdk.KEY_Up || keyval === Gdk.KEY_KP_Up ? -1 : 0;
        if (step !== 0) {
            if (state.matches.length) {
                state.idx = Math.max(0, Math.min(state.idx + step, state.matches.length - 1));
                const row = listBox.get_row_at_index(state.idx);
                if (row)
                    listBox.select_row(row);
                const adj = scroller.get_vadjustment();
                const y = state.idx * ENTITY_ROW_HEIGHT;
                if (y < adj.value)
                    adj.value = y;
                else if (y + ENTITY_ROW_HEIGHT > adj.value + adj.page_size)
                    adj.value = y + ENTITY_ROW_HEIGHT - adj.page_size;
            }
            return Gdk.EVENT_STOP;
        }
        if (keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter) {
            const it = state.matches[state.idx];
            if (it)
                pick(it);
            return Gdk.EVENT_STOP;
        }
        if (keyval === Gdk.KEY_Escape) {
            collapse();
            return Gdk.EVENT_STOP;
        }
        return Gdk.EVENT_PROPAGATE;
    });

    const focusCtl = new Gtk.EventControllerFocus();
    entry.add_controller(focusCtl);
    focusCtl.connect('leave', () => {
        state.lastQuery = null;
        collapse();
    });

    return {holder, computeMatches, pick,
        reset() {
            queryCache.clear();
            state.lastQuery = null;
            state.matches = [];
            state.idx = -1;
            state.rendered = null;
            collapse();
        },
        /** Stav pro testy: revealed + počet řádků + tooltip prvního řádku. */
        _debug() {
            let rowCount = 0;
            let firstTooltip = '';
            for (let c = listBox.get_first_child(); c; c = c.get_next_sibling()) {
                if (rowCount === 0)
                    firstTooltip = c.tooltip_markup || '';
                rowCount += 1;
            }
            return {revealed: revealer.reveal_child, rows: rowCount,
                matches: state.matches.length, firstTooltip};
        }};
}

/**
 * Přesune řádek seznamu entit před/za cílový (drag&drop). rows a entries
 * jsou paralelní pole — přeskupí oba a přemístí widget v listu.
 * Vrací cílovou pozici v polích, nebo -1 když přesun nemá smysl.
 */
function _reorderEntities(list, rows, entries, srcRow, dstRow, after) {
    const srcIdx = rows.indexOf(srcRow);
    const dstIdx = rows.indexOf(dstRow);
    if (srcIdx < 0 || dstIdx < 0 || srcIdx === dstIdx)
        return -1;
    const movedRow = rows.splice(srcIdx, 1)[0];
    const movedEntry = entries.splice(srcIdx, 1)[0];
    const target = rows.indexOf(dstRow) + (after ? 1 : 0);
    rows.splice(target, 0, movedRow);
    entries.splice(target, 0, movedEntry);
    // widget: index cíle v listu se po odstranění zdroje sám posune
    const insertIdx = dstRow.get_index() + (after ? 1 : 0);
    list.remove(srcRow);
    list.insert(srcRow, insertIdx);
    return target;
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
        title: _('Entity settings'),
        modal: true,
        use_header_bar: 1,
    });
    if (root)
        dlg.set_transient_for(root);
    dlg.add_button(_('Cancel'), Gtk.ResponseType.CANCEL);
    dlg.add_button(_('Clear'), Gtk.ResponseType.REJECT);
    dlg.add_button(_('Save'), Gtk.ResponseType.OK);
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

    const nameEntry = entryRow(_('Custom name'), _('from Home Assistant'), ov.name || '');
    const iconCombo = comboRow(_('Icon'), [
        {value: '', label: _('Global setting')},
        {value: 'ha', label: _('From Home Assistant (MDI)')},
        {value: 'type', label: _('By entity type')},
        {value: 'text', label: _('No icon')},
    ], ov.icon || '');
    const displayCombo = comboRow(_('Panel display'), [
        {value: '', label: _('Automatic')},
        {value: 'icon', label: _('Icon only')},
        {value: 'icon-value', label: _('Icon + value')},
        {value: 'value', label: _('Value / text only')},
    ], ov.display || '');
    const decimalsCombo = comboRow(_('Decimal places'), [
        {value: '', label: _('Global setting')},
        {value: 0, label: _('0 (integers)')},
        {value: 1, label: '1'},
        {value: 2, label: '2'},
        {value: 3, label: '3'},
        {value: 4, label: '4'},
    ], Number.isInteger(ov.decimals) ? ov.decimals : '');
    const minEntry = entryRow(_('Minimum threshold'), _('unlimited'),
        typeof ov.min === 'number' ? String(ov.min) : '');
    const maxEntry = entryRow(_('Maximum threshold'), _('unlimited'),
        typeof ov.max === 'number' ? String(ov.max) : '');
    const hint = new Gtk.Label({
        label: _('Values outside thresholds are highlighted red. Icon, name,\n' +
               'decimal places and thresholds apply to both the panel and the\n' +
               'menu; the display mode applies to the panel only (in the menu\n' +
               'the toggle is the value itself).'),
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
            btn.label = _('Not set');
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
    const completions = [];
    let persistId = 0;
    let rowSeq = 0;
    let sharedItems = [];   // položky našeptávače {id, name, device, lcId, nName, nDev}

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
        title: _('Add entity…'),
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
            placeholder_text: placeholder || _('e.g. sensor.temperature_livingroom'),
            text: initialText || '',
        });
        const completion = _attachEntityCompletion(entry, () => sharedItems);
        completions.push(completion);

        entry.connect('changed', persist);
        entries.push(entry);

        const cfgBtn = new Gtk.Button({
            icon_name: 'document-edit-symbolic',
            valign: Gtk.Align.START,
            has_frame: false,
            tooltip_text: _('Per-entity settings (icon, decimal places, thresholds…)'),
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
            valign: Gtk.Align.START,
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

        // přetahování za úchyt změní pořadí entit
        const uid = `row${++rowSeq}`;
        row._hmassUid = uid;
        const handle = new Gtk.Image({
            icon_name: 'list-drag-handle-symbolic',
            valign: Gtk.Align.START,
            margin_top: 9,          // střed 16px ikony proti ~34px poli
            tooltip_text: _('Drag to reorder'),
        });
        handle.add_css_class('dim-label');
        const dragSource = new Gtk.DragSource({actions: Gdk.DragAction.MOVE});
        dragSource.connect('prepare', () => {
            const v = new GObject.Value();
            v.init(GObject.TYPE_STRING);
            v.set_string(uid);
            return Gdk.ContentProvider.new_for_value(v);
        });
        dragSource.connect('drag-begin', src => {
            row.opacity = 0.35;
            const paintable = handle.get_paintable();
            if (paintable)
                src.set_icon(paintable, 8, 8);
        });
        dragSource.connect('drag-end', () => {
            row.opacity = 1.0;
        });
        handle.add_controller(dragSource);

        const dropTarget = Gtk.DropTarget.new(GObject.TYPE_STRING, Gdk.DragAction.MOVE);
        dropTarget.connect('drop', (t, value, x, y) => {
            const srcRow = rows.find(r => r._hmassUid === value);
            if (!srcRow)
                return false;
            if (srcRow === row)
                return true;
            const list = row.get_parent();
            if (!list)
                return false;
            _reorderEntities(list, rows, entries, srcRow, row, y > row.get_height() / 2);
            persist();
            return true;
        });
        row.add_controller(dropTarget);

        row.add_prefix(handle);
        row.add_prefix(completion.holder);
        row.add_suffix(cfgBtn);
        row.add_suffix(removeBtn);
        _collapseTitleBox(row);
        rows.push(row);

        // vložit těsně před addBtnRow — na její přesnou pozici, i když
        // jsou ve skupině za ní další řádky (globální nastavení na HA stránce)
        const list = addBtnRow.get_parent();
        const idx = addBtnRow.get_index();
        if (list && idx >= 0) {
            group.remove(addBtnRow);
            group.add(row);
            group.remove(row);
            list.insert(row, idx);
            list.insert(addBtnRow, idx + 1);
        } else {
            group.add(row);
        }
    };

    addBtnRow.connect('activated', () => {
        addRow('');
        // nové pole hned pro psaní — fokusem a kurzorem na začátek
        const last = entries[entries.length - 1];
        if (last) {
            last.grab_focus();
            last.set_position(0);
        }
    });
    group.add(addBtnRow);

    const stored = settings.get_strv(key);
    for (const id of stored)
        addRow(id);
    if (stored.length === 0)
        addRow('');

    return {
        group,
        // API našeptávače posledního řádku (pro testy)
        get completionApi() {
            return completions[completions.length - 1] || null;
        },
        /**
         * Našeptávač entit. items: pole entity_id (string) nebo objekty
         * {id, name, device}. Popup ukazuje název + zařízení + entity_id,
         * výběr vloží do pole entity_id. Převod na položky probíhá po
         * dávkách v idle (desítky tisíc entit nezamrznou UI).
         */
        setCompletion(items) {
            const list = [];
            for (const raw of (items || [])) {
                const it = typeof raw === 'string' ? {id: raw, name: '', device: ''} : raw;
                const id = String((it && it.id) || '');
                if (!id)
                    continue;
                list.push(_makeEntityItem(id, String(it.name || ''), String(it.device || '')));
            }
            sharedItems = [];
            // staré cacheované shody ukazují na předchozí položky
            for (const c of completions)
                c.reset();
            let pos = 0;
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                const end = Math.min(pos + 5000, list.length);
                for (; pos < end; pos++)
                    sharedItems.push(list[pos]);
                return pos < list.length;
            });
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
        callback(false, _('Authentication failed (401/403) — check the long-lived token.'));
        return;
    }
    if (status === 404) {
        callback(false, _('Server returned 404 Not Found — verify the URL.'));
        return;
    }
    if (status !== 200) {
        callback(false, _f(_('Server returned code %s.'), status));
        return;
    }
    let states;
    try {
        states = JSON.parse(body);
    } catch (e) {
        callback(false, _f(_('Invalid JSON response: %s'), e.message));
        return;
    }
    if (!Array.isArray(states)) {
        callback(false, _('Server returned no entities.'));
        return;
    }
    const ids = states.map(s => s.entity_id).filter(id => !!id).sort();
    const mediaPlayers = states
        .filter(s => s.entity_id && s.entity_id.startsWith('media_player.'))
        .map(s => ({
            id: s.entity_id,
            name: (s.attributes && s.attributes.friendly_name) || s.entity_id,
        }));
    const entities = states
        .filter(s => s.entity_id)
        .map(s => ({
            id: s.entity_id,
            name: (s.attributes && s.attributes.friendly_name) || '',
            device: '',
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
    callback(true, _f(_('Connected — %d entities found.'), ids.length), ids, mediaPlayers, entities);
    return entities;
}

/** HTTP request přes Soup 2.4/3.0; payload = objekt pro POST JSON. Při chybě cb(null). */
function _soupRequest(session, method, url, token, payload, cb) {
    const msg = _createSoupMessage(method, url);
    if (!msg) {
        cb(null);
        return;
    }
    if (token)
        msg.request_headers.append('Authorization', `Bearer ${token}`);
    if (payload) {
        const body = JSON.stringify(payload);
        if (typeof msg.set_request_body_from_bytes === 'function')
            msg.set_request_body_from_bytes('application/json', new GLib.Bytes(body));
        else
            msg.request_body.append(Soup.MemoryUse.COPY, body);
    }
    const parse = (status, body) => {
        if (status !== 200 || !body) {
            cb(null);
            return;
        }
        try {
            cb(JSON.parse(body));
        } catch (e) {
            cb(null);
        }
    };
    if (typeof session.queue_message === 'function') {
        session.queue_message(msg, (sess, message) => {
            parse(message.status_code, message.response_body && message.response_body.data);
        });
    } else {
        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (sess, res) => {
            try {
                const status = typeof msg.get_status === 'function' ? msg.get_status() : msg.status_code;
                parse(status, _decodeBytes(sess.send_and_read_finish(res)));
            } catch (e) {
                cb(null);
            }
        });
    }
}

// počet entit na jeden template požadavek (výstup šablony má limit 256 kB)
const HA_DEVICE_CHUNK = 2500;
const HA_DEVICE_PARALLEL = 4;   // souběžné dávky (19+ požadavků × sekvenčně = dlouho)

/**
 * Doplní k entitám název zařízení přes POST /api/template po dávkách
 * (registry endpointy mívá reverzní proxy zakázané; /api/states zařízení
 * neobsahuje). Když se dávkám nedaří, zařízení zůstane ''.
 */
function _haEnrichDevices(session, base, token, entities, done) {
    const tmplChunk = (a, b) =>
        '[{% set all = states | list %}{% for s in all[' + a + ':' + b + '] %}' +
        '{"i":{{ s.entity_id|to_json }},"d":{{ (device_attr(s.entity_id, "name_by_user") ' +
        'or device_attr(s.entity_id, "name") or "")|to_json }} }' +
        '{{ "," if not loop.last else "" }}{% endfor %}]';
    const byId = {};
    let next = 0;
    let failures = 0;
    let finished = 0;
    const total = Math.ceil(entities.length / HA_DEVICE_CHUNK);
    const finishOne = res => {
        if (Array.isArray(res)) {
            for (const r of res)
                if (r && r.i)
                    byId[r.i] = r;
        } else {
            failures += 1;
        }
        finished += 1;
        if (finished < total && failures < 3)
            launch();
        if (finished >= total || failures >= 3) {
            for (const e of entities) {
                const r = byId[e.id];
                if (r)
                    e.device = r.d || '';
            }
            done(entities);
        }
    };
    const launch = () => {
        if (next >= entities.length)
            return;
        const a = next;
        const b = Math.min(next + HA_DEVICE_CHUNK, entities.length);
        next = b;
        _soupRequest(session, 'POST', `${base}/api/template`, token,
            {template: tmplChunk(a, b)}, finishOne);
    };
    for (let i = 0; i < HA_DEVICE_PARALLEL; i++)
        launch();
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

    // zpracování odpovědi: callback hned, pak doplnění zařízení do našeptávače
    const onStates = (status, body) => {
        const entities = _handleHaStatesResponse(status, body, callback);
        if (entities && entities.length > 0)
            _haEnrichDevices(session, base, cleanToken, entities, enriched => {
                if (_applyHaCompletion)
                    _applyHaCompletion(enriched);
            });
    };

    if (typeof session.queue_message === 'function') {
        session.queue_message(msg, (sess, message) => {
            try {
                onStates(message.status_code,
                    (message.response_body && message.response_body.data) ? message.response_body.data : '');
            } catch (e) {
                callback(false, _f(_('Connection error: %s'), e.message));
            }
        });
    } else {
        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (sess, res) => {
            try {
                const bytes = sess.send_and_read_finish(res);
                const status = typeof msg.get_status === 'function' ? msg.get_status() : msg.status_code;
                onStates(status, _decodeBytes(bytes));
            } catch (e) {
                callback(false, _f(_('Connection error: %s'), e.message));
            }
        });
    }
}

function testMa(url, token, allowInsecure, callback) {
    const base = _cleanMaUrl(url);
    if (!base) {
        callback(false, _('Enter the Music Assistant URL.'));
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
        finish(false, _('Connection timed out (10 s).'));
        return GLib.SOURCE_REMOVE;
    });

    const client = new MAClient();
    client.configure(base, (token || '').trim(), allowInsecure, '');
    client.onplayers = () => {
        const names = client.players.map(p => p.name || p.player_id);
        finish(true, _f(_('Connected — %d players: %s'), client.players.length, names.join(', ')), client.players);
    };
    client.onstate = (status, detail) => {
        if (finished)
            return;
        if (status === 'auth-error') {
            finish(false, _('Access denied — check the API key.'));
        }
    };
    client.connect();
}

// ---- seznam přehrávačů pro MPRIS (MA + HA, při duplicitě preferovat MA) ----

var _maPlayers = [];   // [{player_id, name}]
var _haPlayers = [];   // [{id, name}] (pouze media_player.*)
var _playersBox = null;
var _syncPlayerCombo = null;  // doplní combo „Výchozí přehrávač" (MA stránka)
var _applyHaCompletion = null; // napojí našeptávač na načtené entity (HA stránka)

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
            label: `${p.name || p.player_id} — Music Assistant${twin ? ' (' + _('also found in HA') + ')' : ''}`,
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
            label: _('No players — they load after testing the connection above.'),
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
            (ok, msg, ids, mediaPlayers, entities) => {
                // napovědět hned z /api/states (názvy); zařízení doplní enrich
                if (ok && entities && entities.length > 0 && _applyHaCompletion)
                    _applyHaCompletion(entities);
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
                if (_syncPlayerCombo)
                    _syncPlayerCombo();
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
        title: _('Connection'),
        description: _('Home Assistant server connection settings'),
    });

    const urlField = _entryRow(_('Server URL'), _('e.g. http://homeassistant.local:8123'), settings, 'ha-url', 'http://homeassistant.local:8123');
    connGroup.add(urlField.row);

    const tokenField = _passwordRow(_('Access token'),
        _('Long-lived token from your Home Assistant user profile'),
        settings, 'ha-token');
    connGroup.add(tokenField.row);

    const tlsRow = _switchRow(
        'Allow unverified TLS certificates',
        _('For servers with custom or self-signed certificates (libsoup 3.2+)'),
        settings, 'allow-insecure-tls');
    connGroup.add(tlsRow);

    // Test spojení
    const testRow = new Adw.ActionRow({
        title: _('Test connection'),
        subtitle: _('Checks the server and loads the entity list'),
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
        _('Panel entities'),
        _('Entity values (e.g. a temperature sensor) shown directly in the GNOME ' +
        'top bar. Switches, buttons and other controls can be operated right in ' +
        'the bar; the entity name appears on hover.'),
        _('e.g. sensor.temperature_livingroom')
    );
    panelEditor.group.add(_comboRow(
        _('Decimal places for numeric values'),
        _('Automatic per entity, or a fixed number of decimal places'),
        settings,
        'value-decimals',
        [
            {value: -1, label: _('Automatic')},
            {value: 0, label: _('0 (integers)')},
            {value: 1, label: '1'},
            {value: 2, label: '2'},
            {value: 3, label: '3'},
            {value: 4, label: '4'},
        ]
    ));
    panelEditor.group.add(_comboRowStr(
        _('Entity icons'),
        _('Icon source for the panel and menu. "From Home Assistant (MDI)" uses ' +
        'the entity\'s own icon (mdi:…) from the MDI set bundled with the ' +
        'extension'),
        settings,
        'entity-icon',
        [
            {value: 'ha', label: _('From Home Assistant (MDI)')},
            {value: 'type', label: _('By entity type')},
            {value: 'text', label: _('No icons')},
        ]
    ));
    page.add(panelEditor.group);

    // Zkratky
    const keysGroup = new Adw.PreferencesGroup({
        title: _('Shortcuts'),
        description: _('Extension global keyboard shortcuts'),
    });
    keysGroup.add(_keybindingRow(
        _('Open menu and assistant chat'),
        _('Opens the extension menu and focuses the conversation entry'),
        settings,
        'hotkey-open-menu'
    ));
    page.add(keysGroup);

    // Entity v menu
    const menuEditor = _createEntityGroup(
        settings,
        'ha-menu-entities',
        _('Menu entities'),
        _('Controls in the popup menu. The control type adapts automatically by ' +
        'domain: switch (switch, light, fan), slider (light brightness, volume, ' +
        'covers), button (script, scene), dropdown (input_select), text or ' +
        'sensor.'),
        _('e.g. light.livingroom or switch.coffee')
    );
    page.add(menuEditor.group);

    // společné napojení našeptávače obou skupin entit na načtené entity
    _applyHaCompletion = entities => {
        panelEditor.setCompletion(entities);
        menuEditor.setCompletion(entities);
    };

    testBtn.connect('clicked', () => {
        testBtn.sensitive = false;
        testRow.subtitle = _('Testing connection…');
        const url = urlField.entry.get_text().trim() || settings.get_string('ha-url').trim();
        const token = tokenField.entry.get_text().trim() || settings.get_string('ha-token').trim();
        const allowInsecure = settings.get_boolean('allow-insecure-tls');

        // Okamžitě explicitně uložit do GSettings
        if (url)
            settings.set_string('ha-url', url);
        if (token)
            settings.set_string('ha-token', token);

        testHa(url, token, allowInsecure, (ok, msg, ids, mediaPlayers, entities) => {
            testBtn.sensitive = true;
            testRow.subtitle = msg;
            if (ok && entities && entities.length > 0)
                _applyHaCompletion(entities);
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
        title: _('Connection'),
        description: _('Music Assistant server connection settings'),
    });

    const enableRow = _switchRow(
        'Zapnout integraci Music Assistant',
        _('Shows the player section in the menu and enables MPRIS control'),
        settings, 'ma-enabled');
    connGroup.add(enableRow);

    const urlField = _entryRow(_('Server URL'), _('e.g. http://music-assistant:8095'), settings, 'ma-url', 'http://music-assistant:8095');
    connGroup.add(urlField.row);

    const tokenField = _passwordRow(_('API key'),
        _('Optional — only if MA requires authentication'),
        settings, 'ma-token');
    connGroup.add(tokenField.row);

    // Test spojení
    const testRow = new Adw.ActionRow({
        title: _('Test connection'),
        subtitle: _('Checks the server and loads the players'),
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
        title: _('Default player'),
        description: _('Which player gets selected in the menu at startup'),
    });
    const playerRow = new Adw.ActionRow({
        title: _('Default player'),
        subtitle: _('Player shown in the menu when opened'),
    });
    const playerCombo = new Gtk.ComboBoxText({valign: Gtk.Align.CENTER});
    const fillPlayerCombo = () => {
        playerCombo.remove_all();
        playerCombo.append('auto', _('Automatic (first playing)'));
        for (const p of _maPlayers)
            playerCombo.append(p.player_id, p.name || p.player_id);
        const current = settings.get_string('ma-default-player') || 'auto';
        playerCombo.active_id = current === 'auto' ||
            _maPlayers.some(p => p.player_id === current) ? current : 'auto';
    };
    fillPlayerCombo();
    playerCombo.connect('changed', () => {
        const id = playerCombo.active_id || 'auto';
        settings.set_string('ma-default-player', id === 'auto' ? '' : id);
    });
    playerRow.add_suffix(playerCombo);
    playerGroup.add(playerRow);
    _syncPlayerCombo = fillPlayerCombo;
    page.add(playerGroup);

    testBtn.connect('clicked', () => {
        testBtn.sensitive = false;
        testRow.subtitle = _('Testing connection…');

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
                    _maPlayers = players.map(p => ({player_id: p.player_id, name: p.name || p.player_id}));
                    fillPlayerCombo();
                    _refreshPlayerList(settings);
                }
            });
    });

    // MPRIS
    const mprisGroup = new Adw.PreferencesGroup({
        title: _('MPRIS and media keys'),
        description: _('Integration with the GNOME system media controls'),
    });
    mprisGroup.add(_switchRow(
        _('MPRIS bridge (media keys)'),
        _('Lets you control players with hardware keys and the GNOME media controls'),
        settings, 'ma-mpris'));
    page.add(mprisGroup);

    // Přehrávače pro MPRIS
    const playersGroup = new Adw.PreferencesGroup({
        title: _('Players in MPRIS'),
        description: _('Check the players from Music Assistant and Home Assistant. On name clash Music Assistant wins.'),
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
        title: _('Menu controls'),
        description: _('Choose the player widgets shown in the popup menu'),
    });
    menuGroup.add(_switchRow(_('Player selector in menu'), null, settings, 'ma-show-player-selector'));
    menuGroup.add(_switchRow(_('Playback buttons'), _('Play/Pause, previous, next'), settings, 'ma-show-transport'));
    menuGroup.add(_switchRow(_('Track position slider'), null, settings, 'ma-show-seek'));
    menuGroup.add(_switchRow(_('Volume slider'), null, settings, 'ma-show-volume'));
    menuGroup.add(_switchRow(_('Shuffle and repeat'), null, settings, 'ma-show-shuffle-repeat'));
    page.add(menuGroup);

    return page;
}

function buildPanelPage(settings) {
    const page = new Adw.PreferencesPage({
        title: _('Top bar'),
        icon_name: 'preferences-system-symbolic',
    });
    const group = new Adw.PreferencesGroup({
        title: _('Panel indicator'),
        description: _('Icon and status customization in the GNOME top bar'),
    });
    group.add(_switchRow(_('Show icon'), _('House / note / offline status icon'), settings, 'panel-show-icon'));
    group.add(_switchRow(_('Show connection status (dots)'), _('Color indicator of Home Assistant and Music Assistant status'), settings, 'panel-show-status'));
    page.add(group);

    const langGroup = new Adw.PreferencesGroup({
        title: _('Interface'),
        description: _('Extension interface language'),
    });
    langGroup.add(_comboRowStr(_('Interface language'),
        _('Automatic follows the system language. The menu updates right ' +
          'away; reopen this window to translate it too.'),
        settings,
        'interface-language',
        [
            {value: 'auto', label: _('Automatic (follow system)')},
            {value: 'en', label: 'English'},
            {value: 'cs', label: 'Čeština'},
            {value: 'nl', label: 'Nederlands'},
        ]
    ));
    page.add(langGroup);
    return page;
}



/**
 * Uložení/obnova velikosti okna nastavení (GSettings prefs-width/height).
 * Hodnoty se clampují na rozumné minimum i maximum.
 */
var PREFS_MIN_W = 480;
var PREFS_MIN_H = 400;
var PREFS_MAX_W = 3840;
var PREFS_MAX_H = 2160;

function _clampWindowSize(w, h) {
    const clamp = (v, min, max) =>
        Math.max(min, Math.min(max, Math.round(v) || min));
    return [clamp(w, PREFS_MIN_W, PREFS_MAX_W), clamp(h, PREFS_MIN_H, PREFS_MAX_H)];
}

function _rememberWindowSize(settings, window) {
    window.connect('close-request', () => {
        const alloc = window.get_allocation();
        if (alloc && alloc.width > 1 && alloc.height > 1) {
            const [w, h] = _clampWindowSize(alloc.width, alloc.height);
            settings.set_int('prefs-width', w);
            settings.set_int('prefs-height', h);
        }
        return Gdk.EVENT_PROPAGATE;   // okno se zavře jako obvykle
    });
}

/**
 * Moderní vstupní bod pro GNOME 42+ (Libadwaita).
 */
export default class HMassPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        I18n.init(settings, this.dir);

        window.set_default_size(..._clampWindowSize(
            settings.get_int('prefs-width'), settings.get_int('prefs-height')));
        window.set_search_enabled(true);
        _rememberWindowSize(settings, window);

        window.add(buildHaPage(settings));
        window.add(buildMaPage(settings));
        window.add(buildPanelPage(settings));

        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            _autoLoadPlayers(settings);
            return GLib.SOURCE_REMOVE;
        });
    }
}
