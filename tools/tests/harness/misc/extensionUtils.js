/*
 * Stub imports.misc.extensionUtils pro běh knihoven mimo GNOME Shell.
 * Knihovny v lib/ používají Me.imports.lib.xxx - tenhle stub je namapuje
 * na skutečný imports.lib (adresář rozšíření je na imports.searchPath).
 */

const Gio = imports.gi.Gio;

let _testSettings = null;

function getCurrentExtension() {
    return {imports: {lib: imports.lib}};
}

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
