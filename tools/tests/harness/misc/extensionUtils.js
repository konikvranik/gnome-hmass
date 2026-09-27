// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 konikvranik
/*
 * Stub for imports.misc.extensionUtils to run libraries outside GNOME Shell.
 * Libraries in lib/ use Me.imports.lib.xxx - this stub maps them to actual
 * imports.lib (extension directory is in imports.searchPath).
 */

const Gio = imports.gi.Gio;

let _testSettings = null;

function getCurrentExtension() {
    // metadata + dir necessary for extension.js import (gettext domain) and icons
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
        if (Gio.MemorySettingsBackend && typeof Gio.MemorySettingsBackend.new === 'function') {
            const backend = Gio.MemorySettingsBackend.new();
            _testSettings = Gio.Settings.new_with_backend('org.gnome.shell.extensions.hmass', backend);
        } else {
            _testSettings = new Gio.Settings({schema_id: 'org.gnome.shell.extensions.hmass'});
        }
    }
    return _testSettings;
}
