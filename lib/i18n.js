// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 konikvranik
//
/*
 * Centralized translation point for the extension: gettext + optional FORCED language
 * (interface-language setting). Switching language for only one extension is not
 * supported by gettext (setlocale/LANGUAGE is process-wide - in shell that would
 * change the language of the entire GNOME session), therefore mode != auto maps msgid -> msgstr
 * from JSON files generated from .po (tools/gen-l10n.py).
 *
 * Usage in modules (takes a reference once on import, dispatcher is thus a stable
 * function and mode is evaluated on every call):
 *
 *   const I18n = Me.imports.lib.i18n;   // OR imports.lib.i18n in tests
 *   const _ = I18n._;
 *
 * Initialization: I18n.init(settings, extDir) - from extension.js/prefs.js.
 * Without init (tests) runs auto mode = pure gettext.
 */

const Gettext = imports.gettext.domain('hmass');

var _mode = 'auto';
var _map = null;
var _dir = null;
var _settings = null;

/**
 * Connects dispatcher to settings. extDir = extension directory (Gio.File),
 * from which locale/l10n/<lang>.json is read.
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

/** Switches translation mode ('auto' or language code 'en'/'cs'/'nl'). */
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
        // missing/corrupt map: fallback to gettext (system language)
        _map = null;
    }
}

/** Stable dispatching function - see module description. */
export function _(msgid) {
    if (_map) {
        const t = _map[msgid];
        if (typeof t === 'string')
            return t;
    }
    return Gettext.gettext(msgid);
}
