#!/usr/bin/env gjs
/*
 * Testy logiky prefs (checklist přehrávačů s deduplikací, preferencí MA).
 * Samostatný proces - UI harness načítá přes St Gtk 3.0, zde potřebujeme 4.0.
 *
 *   gjs tools/tests/run-prefs-tests.js "$PWD"
 */

imports.gi.versions.Gtk = '4.0';
imports.gi.versions.Soup = '3.0';

const {GLib, Gtk} = imports.gi;
const System = imports.system;

const EXT_DIR = ARGV[0] || '.';
imports.searchPath.push(EXT_DIR);
imports.searchPath.push(EXT_DIR + '/tools/tests/harness');

let failures = 0;
function check(name, cond, detail) {
    if (cond) {
        print(`PASS  ${name}`);
    } else {
        failures += 1;
        print(`FAIL  ${name}${detail ? ' — ' + detail : ''}`);
    }
}

Gtk.init(null);

const Prefs = imports.prefs;
const settings = imports.misc.extensionUtils.getSettings();

// simulovat načtené přehrávače: Obývák je v MA i HA (duplicita → MA), Ložnice jen v HA
Prefs._maPlayers = [
    {player_id: 'p1', name: 'Obývák'},
    {player_id: 'p2', name: 'Kuchyň'},
];
Prefs._haPlayers = [
    {id: 'media_player.obyvak', name: 'Obývák'},
    {id: 'media_player.loznice', name: 'Ložnice'},
];
Prefs._playersBox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
settings.set_strv('mpris-players', ['ma:p1', 'ha:media_player.loznice']);
Prefs._refreshPlayerList(settings);

const checks = [];
let child = Prefs._playersBox.get_first_child();
while (child) {
    checks.push(child);
    child = child.get_next_sibling();
}
check('Prefs: dedup - 3 řádky (Obývák jen MA)', checks.length === 3,
    checks.map(c => c.label).join(' | '));
check('Prefs: Obývák s poznámkou (nalezen i v HA)',
    checks.some(c => c.label.includes('Obývák') && c.label.includes('nalezen i v HA')),
    checks.map(c => c.label).join(' | '));
check('Prefs: HA Ložnice bez dvojníka',
    checks.some(c => c.label.includes('Ložnice') && c.label.includes('Home Assistant')),
    checks.map(c => c.label).join(' | '));
check('Prefs: zaškrtnutí z nastavení',
    checks.some(c => c._playerRef === 'ma:p1' && c.active) &&
    checks.some(c => c._playerRef === 'ha:media_player.loznice' && c.active));

// odškrtnutí MA p1 a persist
for (const c of checks) {
    if (c._playerRef === 'ma:p1')
        c.active = false;
    c.emit('toggled');
}
const sel = settings.get_strv('mpris-players');
check('Prefs: persist po odškrtnutí', sel.length === 1 &&
    sel[0] === 'ha:media_player.loznice', JSON.stringify(sel));

// po výměně MA seznamu: Ložnice nyní v MA (preferováno), Obývák už jen v HA
Prefs._maPlayers = [{player_id: 'p9', name: 'Loznice'}];
Prefs._refreshPlayerList(settings);
const labels = [];
child = Prefs._playersBox.get_first_child();
while (child) {
    labels.push(child.label || '');
    child = child.get_next_sibling();
}
check('Prefs: přeřazení zdrojů + dedup bez diakritiky', labels.length === 2 &&
    labels.some(l => l.includes('Loznice') && l.includes('Music Assistant') &&
        l.includes('nalezen i v HA')) &&
    labels.some(l => l.includes('Obývák') && l.includes('Home Assistant')),
    labels.join(' | '));

// úplně prázdné seznamy = nápověda
Prefs._maPlayers = [];
Prefs._haPlayers = [];
Prefs._refreshPlayerList(settings);
labels.length = 0;
child = Prefs._playersBox.get_first_child();
while (child) {
    labels.push(child.label || '');
    child = child.get_next_sibling();
}
check('Prefs: prázdný seznam = nápověda', labels.length === 1 &&
    labels[0].includes('Žádní přehrávači'), labels.join(' | '));

settings.set_strv('mpris-players', []);

const testEntry = new Gtk.Entry({text: 'http://test.local'});
check('Gtk.Entry: entry.text property', testEntry.text === 'http://test.local', `entry.text is: "${testEntry.text}"`);
check('Gtk.Entry: entry.get_text() method', testEntry.get_text() === 'http://test.local', `get_text is: "${testEntry.get_text()}"`);

const page = Prefs.buildHaPage(settings);
const origToken = settings.get_string('ha-token');
const passEntry = new Gtk.PasswordEntry();
settings.bind('ha-token', passEntry, 'text', imports.gi.Gio.SettingsBindFlags.DEFAULT);
check('Gtk.PasswordEntry: get_text() from settings.bind', typeof passEntry.get_text() === 'string');
passEntry.set_text('test-token-roundtrip');
check('Settings: ha-token updated from passEntry', settings.get_string('ha-token') === 'test-token-roundtrip');
settings.set_string('ha-token', origToken);



print('');
if (failures === 0)
    print('VŠECHNY PREFS TESTY PROŠLY');
else
    print(`SELHALO PREFS TESTŮ: ${failures}`);
System.exit(failures === 0 ? 0 : 1);
