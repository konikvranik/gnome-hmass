#!/usr/bin/env gjs
// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 konikvranik
/*
 * Complete live Indicator UI test (panel + menu + players)
 * running under Libsoup 2.4 with real data.
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

print('1. Running Extension.enable() with real settings...');
let indicator = null;
try {
    Extension.enable();
    indicator = Extension._indicator;
    print('   Indicator created and registered: OK');
} catch (e) {
    print('ERROR during Extension.enable():', e.message);
    System.exit(1);
}

// Wait 3 seconds for connection setup and UI menu construction
GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
    print('\n2. Checking client statuses after connection:');
    print('   HA status:', indicator._ha.status);
    print('   MA status:', indicator._ma.status);
    print('   MA player count in client:', indicator._ma.players.length);

    print('\n3. Checking panel UI:');
    print('   Widget count in panelBox:', indicator._panelBox ? indicator._panelBox.get_children().length : 0);

    print('\n4. Checking Music Assistant section in menu:');
    if (indicator._maSection) {
        print('   MA section exists: YES');
        print('   Active player in section:', indicator._maSection._activeId || 'none');
    } else {
        print('   MA section: NONE (ma-enabled might be false)');
    }

    print('\n5. Cleanup and disable():');
    try {
        Extension.disable();
        print('   Extension.disable(): OK');
    } catch (e) {
        print('ERROR during Extension.disable():', e.message);
        System.exit(1);
    }
    loop.quit();
    return GLib.SOURCE_REMOVE;
});

loop.run();
print('\nALL COMPLETED SUCCESSFULLY WITHOUT ERRORS.');
System.exit(0);
