#!/usr/bin/env gjs
// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 pvranik
/*
 * Ověření kompatibility s Libsoup 2.4 (GNOME Shell 42 na Ubuntu 22.04).
 */

imports.gi.versions.Soup = '2.4';
imports.gi.versions.Gtk = '4.0';
const {Soup, GLib, Gio} = imports.gi;
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

check('Soup verze je 2.4', Soup.MAJOR_VERSION === 2);

const WsLib = imports.lib.ws;
const msgHttp = WsLib._createSoupMessage('GET', 'http://127.0.0.1:8721/api/states');
check('WsLib._createSoupMessage HTTP', msgHttp !== null);

const msgWs = WsLib._createSoupMessage('GET', 'ws://127.0.0.1:8721/api/websocket');
check('WsLib._createSoupMessage WS', msgWs !== null);

const Prefs = imports.prefs;
const msgPrefs = Prefs._createSoupMessage('GET', 'http://127.0.0.1:8721/api/states');
check('Prefs._createSoupMessage HTTP', msgPrefs !== null);

// Ověření 5-argumentového volání session.websocket_connect_async
const session = new Soup.Session();
const cancellable = new Gio.Cancellable();
let connectThrows = false;
try {
    session.websocket_connect_async(msgWs, null, null, cancellable, () => {});
} catch (e) {
    connectThrows = true;
}
check('websocket_connect_async přijímá 5 argumentů v Soup 2.4', !connectThrows);

if (failures > 0)
    System.exit(1);

print('VŠECHNY SOUP 2.4 TESTY PROŠLY');
System.exit(0);
