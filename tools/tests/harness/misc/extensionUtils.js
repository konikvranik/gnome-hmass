// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 konikvranik
/*
 * Stub imports.misc.extensionUtils pro běh knihoven mimo GNOME Shell.
 * Knihovny v lib/ používají Me.imports.lib.xxx - tenhle stub je namapuje
 * na skutečný imports.lib (adresář rozšíření je na imports.searchPath).
 */

const Gio = imports.gi.Gio;

let _testSettings = null;

function getCurrentExtension() {
    // metadata + dir nutné pro import extension.js (gettext doména) i ikony
    if (!_ext) {
        _ext = {
            uuid: 'hmass@konikvranik',
            dir: Gio.File.new_for_path('/home/pvranik/priv/git/gnome-hmass'),
            metadata: {name: 'hmass', 'gettext-domain': 'hmass',
                'settings-schema': 'org.gnome.shell.extensions.hmass'},
            imports: {lib: imports.lib},
        };
    }
    return _ext;
}
let _ext = null;

function getSettings() {
    if (!_testSettings) {
        try {
            const backend = Gio.MemorySettingsBackend.new();
            _testSettings = Gio.Settings.new_with_backend('org.gnome.shell.extensions.hmass', backend);
        } catch (e) {
            _testSettings = new Gio.Settings({schema_id: 'org.gnome.shell.extensions.hmass'});
        }
    }
    return _testSettings;
}
