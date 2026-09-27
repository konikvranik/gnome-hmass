// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 konikvranik
//
/*
 * Jednotné místo překladů rozšíření: gettext + volitelně VYNUCENÝ jazyk
 * (nastavení interface-language). Přepnout jazyk jen pro jedno rozšíření
 * přes gettext nejde (setlocale/LANGUAGE je procesové - v shellu by to
 * přeplo jazyk celému GNOME), proto režim != auto mapuje msgid -> msgstr
 * z JSON souborů generovaných z .po (tools/gen-l10n.py).
 *
 * Použití v modulech (referenci si vezmou jednou při importu, dispatcher
 * je proto stabilní funkce a režim se čte při každém volání):
 *
 *   const I18n = Me.imports.lib.i18n;   // NEBO imports.lib.i18n jen v testech
 *   const _ = I18n._;
 *
 * Inicializace: I18n.init(settings, extDir) - z extension.js/prefs.js.
 * Bez init (testy) běží auto režim = čistý gettext.
 */

const Gettext = imports.gettext.domain('hmass');

var _mode = 'auto';
var _map = null;
var _dir = null;
var _settings = null;

/**
 * Napojí dispatcher na nastavení. extDir = adresář rozšíření (Gio.File),
 * z něj se čtou locale/l10n/<jazyk>.json.
 */
export function init(settings, extDir) {
    _dir = extDir || null;
    _settings = settings || null;
    if (!_settings)
        return;
    apply(_settings.get_string('interface-language'));
    _settings.connect('changed::interface-language', (s, key) => {
        apply(s.get_string(key));
    });
}

/** Přepne režim překladu ('auto' nebo kód jazyka 'en'/'cs'/'nl'). */
export function apply(mode) {
    _mode = mode || 'auto';
    _map = null;
    if (_mode === 'auto' || !_dir)
        return;
    try {
        const file = _dir.get_child('locale').get_child('l10n')
            .get_child(_mode + '.json');
        const [ok, bytes] = file.load_contents(null);
        if (ok)
            _map = JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) {
        // chybějící/rozbitá mapa: zůstává gettext (jazyk systému)
        _map = null;
    }
}

/** Stabilní dispatchovací funkce - viz popis modulu. */
export function _(msgid) {
    if (_map) {
        const t = _map[msgid];
        if (typeof t === 'string')
            return t;
    }
    return Gettext.gettext(msgid);
}
