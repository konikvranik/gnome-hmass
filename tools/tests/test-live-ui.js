#!/usr/bin/env gjs
// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 pvranik
/*
 * Test kompletního UI Indicatoru (panel + menu + přehrávače)
 * běžícího pod Libsoup 2.4 s reálnými daty.
 */

imports.gi.versions.Soup = '2.4';
const {GLib, Gio, Soup} = imports.gi;
const System = imports.system;

const EXT_DIR = ARGV[0] || '.';
imports.searchPath.push(EXT_DIR);
imports.searchPath.push(EXT_DIR + '/tools/tests/harness');

const Extension = imports.extension;
const ExtensionUtils = imports.misc.extensionUtils;

const loop = GLib.MainLoop.new(null, false);

print('1. Spouštím Extension.enable() se skutečným nastavením...');
let indicator = null;
try {
    Extension.enable();
    indicator = Extension._indicator;
    print('   Indicator vytvořen a zaregistrován: OK');
} catch (e) {
    print('CHYBA při Extension.enable():', e.message);
    System.exit(1);
}

// Počkáme 3 sekundy na navázání spojení a sestavení UI menu
GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
    print('\n2. Kontrola stavu klientů po připojení:');
    print('   HA status:', indicator._ha.status);
    print('   MA status:', indicator._ma.status);
    print('   MA počet přehrávačů v klientovi:', indicator._ma.players.length);

    print('\n3. Kontrola UI panelu:');
    print('   Počet widgetů v panelBox:', indicator._panelBox ? indicator._panelBox.get_children().length : 0);

    print('\n4. Kontrola sekce Music Assistant v menu:');
    if (indicator._maSection) {
        print('   MA sekce existuje: ANO');
        print('   Aktivní přehrávač v sekci:', indicator._maSection._activeId || 'žádný');
    } else {
        print('   MA sekce: NENÍ (ma-enabled může být false)');
    }

    print('\n5. Úklid a disable():');
    try {
        Extension.disable();
        print('   Extension.disable(): OK');
    } catch (e) {
        print('CHYBA při Extension.disable():', e.message);
        System.exit(1);
    }
    loop.quit();
    return GLib.SOURCE_REMOVE;
});

loop.run();
print('\nVŠECHNO PROBĚHLO V POŘÁDKU A BEZ CHYB.');
System.exit(0);
