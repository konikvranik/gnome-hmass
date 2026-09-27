#!/usr/bin/env gjs
// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 konikvranik
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
const REPO_DIR = ARGV[1] || EXT_DIR;
imports.searchPath.push(EXT_DIR);
imports.searchPath.push(REPO_DIR + '/tools/tests/harness');

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

// ---- i18n: vynucený jazyk rozhraní (JSON mapy ze skutečného adresáře) ----
{
    const Gio = imports.gi.Gio;
    const I18n = imports.lib.i18n;
    I18n.init(settings, Gio.File.new_for_path(EXT_DIR));
    I18n.apply('cs');
    check('i18n: vynucená čeština', I18n._('Settings') === 'Nastavení' &&
        I18n._('Reconnect') === 'Připojit znovu', I18n._('Settings'));
    check('i18n: cs hint asistenta', I18n._('Ask the Assistant...') === 'Požádej asistenta...',
        I18n._('Ask the Assistant...'));
    I18n.apply('nl');
    check('i18n: vynucená nizozemština', I18n._('Settings') === 'Instellingen' &&
        I18n._('on') === 'aan', I18n._('Settings'));
    I18n.apply('auto');
}

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
    checks.some(c => c.label.includes('Obývák') && c.label.includes('also found in HA')),
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
        l.includes('also found in HA')) &&
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
    labels[0].includes('No players'), labels.join(' | '));

settings.set_strv('mpris-players', []);

const testEntry = new Gtk.Entry({text: 'http://test.local'});
check('Gtk.Entry: entry.text property', testEntry.text === 'http://test.local', `entry.text is: "${testEntry.text}"`);
check('Gtk.Entry: entry.get_text() method', testEntry.get_text() === 'http://test.local', `get_text is: "${testEntry.get_text()}"`);

const page = Prefs.buildHaPage(settings);

// Výchozí přehrávač: combo se naplní načtenými hráči MA bez kliknutí na Test spojení
const maPage = Prefs.buildMaPage(settings);
const findCombo = w => {
    if (w instanceof Gtk.ComboBoxText)
        return w;
    for (let c = w.get_first_child(); c; c = c.get_next_sibling()) {
        const r = findCombo(c);
        if (r)
            return r;
    }
    return null;
};
const playerCombo = findCombo(maPage);
check('Prefs: _syncPlayerCombo nastaví buildMaPage',
    typeof Prefs._syncPlayerCombo === 'function');
check('Prefs: combo výchozího přehrávače je na MA stránce', !!playerCombo);
Prefs._maPlayers = [
    {player_id: 'p1', name: 'Obývák'},
    {player_id: 'p2', name: 'Kuchyň'},
];
Prefs._syncPlayerCombo();
check('Prefs: výchozí přehrávač nabízí auto + hráče MA',
    playerCombo.model.iter_n_children(null) === 3 && playerCombo.active_id === 'auto',
    `položek: ${playerCombo.model.iter_n_children(null)}, aktivní: ${playerCombo.active_id}`);
playerCombo.active_id = 'p2';
check('Prefs: výběr výchozího přehrávače se uloží',
    settings.get_string('ma-default-player') === 'p2');
settings.set_string('ma-default-player', 'neexistujici');
Prefs._syncPlayerCombo();
check('Prefs: neznámý přehrávač spadne na auto',
    playerCombo.active_id === 'auto' && settings.get_string('ma-default-player') === '');
settings.set_string('ma-default-player', '');

const origToken = settings.get_string('ha-token');

// --- našeptávač entit: logika porovnávání ---
check('Match: doména.předpona', Prefs._entityMatch('sensor.pro',
    'sensor.prostor_v_zumpe_cm', 'Prostor v zumpě', ''));
check('Match: doménový dotaz netrefuje jinou doménu', !Prefs._entityMatch('sensor.pro',
    'switch.kotel', 'Kotel', ''));
check('Match: podle názvu bez diakritiky', Prefs._entityMatch('zumpe',
    'sensor.prostor_v_zumpe_cm', 'Prostor v zumpě', ''));
check('Match: podle zařízení', Prefs._entityMatch('kotelna',
    'sensor.teplota', 'Teplota', 'Kotelna'));
check('Match: podle entity_id (podřetězec)', Prefs._entityMatch('zump',
    'sensor.prostor_v_zumpe_cm', '', ''));
check('Match: prázdný dotaz nikdy', !Prefs._entityMatch('', 'sensor.x', 'X', ''));
check('Match: nesouvislé řetězce si nesednou', !Prefs._entityMatch('loznice',
    'sensor.kotel', 'Kotel', 'Kotelna'));

// --- našeptávač: filtr přes API, výběr vkládá entity_id ---
const testGroup = Prefs._createEntityGroup(settings, 'ha-panel-entities',
    'test', 'test', '');
const pumpIdle = () => {
    const ctx = GLib.main_context_default();
    for (let i = 0; i < 100 && ctx.iteration(false); i++);
};
testGroup.setCompletion([
    {id: 'sensor.prostor_v_zumpe_cm', name: 'Prostor v zumpě', device: 'Vytápění'},
    {id: 'switch.kotel', name: 'Kotel', device: 'Kotelna'},
    'light.plain_only',
]);
pumpIdle();
const api = testGroup.completionApi;
check('Completion: API je k dispozici', !!api);
check('Completion: hledá podle názvu bez diakritiky',
    JSON.stringify(api.computeMatches('zumpe').map(x => x.id)) ===
    JSON.stringify(['sensor.prostor_v_zumpe_cm']),
    JSON.stringify(api.computeMatches('zumpe').map(x => x.id)));
check('Completion: doménový dotaz',
    JSON.stringify(api.computeMatches('switch.ko').map(x => x.id)) ===
    JSON.stringify(['switch.kotel']),
    JSON.stringify(api.computeMatches('switch.ko').map(x => x.id)));
check('Completion: hledá podle zařízení',
    api.computeMatches('kotelna').length === 1 &&
    api.computeMatches('kotelna')[0].id === 'switch.kotel');
check('Completion: podřetězec v entity_id',
    api.computeMatches('zump').length === 1);
check('Completion: neexistující dotaz = nic', api.computeMatches('nejde-nikdy').length === 0);
check('Completion: prázdný dotaz = nic', api.computeMatches('').length === 0);
// limit počtu nabízených položek (stabilita popupu)
const many = [];
for (let i = 0; i < 40; i++)
    many.push({id: `switch.x${i}`, name: '', device: ''});
testGroup.setCompletion(many);
pumpIdle();
check('Completion: limit 30 položek', api.computeMatches('switch.x').length === 30,
    `vrátilo ${api.computeMatches('switch.x').length}`);
// výběr z popupu vloží entity_id do pole
const findEntry = w => {
    if (w instanceof Gtk.Entry)
        return w;
    for (let c = w.get_first_child(); c; c = c.get_next_sibling()) {
        const r = findEntry(c);
        if (r)
            return r;
    }
    return null;
};
const testEntry2 = findEntry(testGroup.group);
api.pick({id: 'switch.x5'});
check('Completion: výběr vloží entity_id', testEntry2.get_text() === 'switch.x5',
    `v poli: "${testEntry2.get_text()}"`);

// --- našeptávač: celý řetěz set_text → debounce → odhalení seznamu ---
const chainGroup = Prefs._createEntityGroup(settings, 'ha-panel-entities',
    'test', 'test', '');
chainGroup.setCompletion([...many, {id: 's.test', name: '', device: ''}]);
pumpIdle();
const chainApi = chainGroup.completionApi;
const chainEntry = findEntry(chainGroup.group);
// pustit hlavní smyčku na zadanou dobu (debounce 300 ms + rezerva)
const runMs = ms => {
    const loop = new GLib.MainLoop(null, false);
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        loop.quit();
        return GLib.SOURCE_REMOVE;
    });
    loop.run();
};
chainEntry.set_text('switch.x');
runMs(450);
let st = chainApi._debug();
check('Completion: řetěz set_text → debounce → seznam', st.revealed === true &&
    st.rows === 30 && st.matches === 30, JSON.stringify(st));
check('Completion: tooltip řádku obsahuje entity_id',
    (st.firstTooltip || '').includes('switch.x0'), st.firstTooltip);
chainEntry.set_text('sw');   // 2 znaky bez tečky → pod minimem, skryté
runMs(450);
st = chainApi._debug();
check('Completion: 2 znaky bez domény nenapovídají', st.revealed === false,
    JSON.stringify(st));
chainEntry.set_text('s.');   // 2 znaky s tečkou (doménový dotaz) → napoví
runMs(450);
st = chainApi._debug();
check('Completion: doménový dotaz od 2 znaků', st.revealed === true &&
    st.matches === 1, JSON.stringify(st));
chainEntry.set_text('');     // smazání seznam skryje
runMs(450);
st = chainApi._debug();
check('Completion: smazání textu seznam skryje', st.revealed === false,
    JSON.stringify(st));

// --- drag&drop: přesun řádků v paralelních polích ---
const mkRow = idx => ({get_index: () => idx});
const fakeList = {
    removed: [],
    insertOrder: [],
    remove(w) {
        this.removed.push(w);
    },
    insert(w, pos) {
        this.insertOrder.push([w, pos]);
    },
};
const dRows = [mkRow(0), mkRow(1), mkRow(2), mkRow(3)];
const dEntries = ['a', 'b', 'c', 'd'];
const moved = Prefs._reorderEntities(fakeList, dRows, dEntries, dRows[0], dRows[3], true);
check('Reorder: A za D → a,b,c,d pořadí b,c,d,a',
    JSON.stringify(dEntries) === JSON.stringify(['b', 'c', 'd', 'a']) && moved === 3,
    JSON.stringify(dEntries));
const dRows2 = [mkRow(0), mkRow(1), mkRow(2), mkRow(3)];
const dEntries2 = ['a', 'b', 'c', 'd'];
Prefs._reorderEntities(fakeList, dRows2, dEntries2, dRows2[3], dRows2[0], false);
check('Reorder: D před A → d,a,b,c',
    JSON.stringify(dEntries2) === JSON.stringify(['d', 'a', 'b', 'c']),
    JSON.stringify(dEntries2));
const dRows3 = [mkRow(0), mkRow(1)];
const dEntries3 = ['a', 'b'];
check('Reorder: stejný řádek se odmítne',
    Prefs._reorderEntities(fakeList, dRows3, dEntries3, dRows3[0], dRows3[0], true) === -1);
check('Reorder: paralelní pole zůstávají synchronní',
    dRows.length === dEntries.length);

const passEntry = new Gtk.PasswordEntry();

// --- velikost okna nastavení: clamp ---
check('Velikost: běžné hodnoty zůstávají',
    JSON.stringify(Prefs._clampWindowSize(900, 600)) === '[900,600]');
check('Velikost: příliš malé se zvednou na minimum',
    JSON.stringify(Prefs._clampWindowSize(10, 5)) === `[${Prefs.PREFS_MIN_W},${Prefs.PREFS_MIN_H}]`);
check('Velikost: obří se seříznou na maximum',
    JSON.stringify(Prefs._clampWindowSize(99999, 99999)) === `[${Prefs.PREFS_MAX_W},${Prefs.PREFS_MAX_H}]`);
check('Velikost: nečíselné spadnou na minimum',
    JSON.stringify(Prefs._clampWindowSize(NaN, NaN)) === `[${Prefs.PREFS_MIN_W},${Prefs.PREFS_MIN_H}]`);
check('Schema: klíče prefs-width/height existují',
    settings.get_int('prefs-width') === 680 && settings.get_int('prefs-height') === 750);

const passEntry2 = new Gtk.PasswordEntry();
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
