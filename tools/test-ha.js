#!/usr/bin/env gjs
// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 pvranik
/*
 * Test připojení k Home Assistant z terminálu:
 *   gjs tools/test-ha.js http://ha:8123 TOKEN
 */

imports.gi.versions.Soup = '3.0';

const {GLib, Soup} = imports.gi;
const System = imports.system;
const _decoder = new TextDecoder();

const url = (ARGV[0] || '').replace(/\/+$/, '');
const token = ARGV[1] || '';

if (!url || !token) {
    print('Použití: gjs tools/test-ha.js <url> <token>');
    System.exit(1);
}

const loop = GLib.MainLoop.new(null, false);
const session = new Soup.Session();
const msg = Soup.Message.new('GET', `${url}/api/states`);
msg.request_headers.append('Authorization', `Bearer ${token}`);

session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (sess, res) => {
    try {
        const bytes = sess.send_and_read_finish(res);
        const status = typeof msg.get_status === 'function' ? msg.get_status() : msg.status_code;
        const body = _decoder.decode(bytes instanceof Uint8Array ? bytes : bytes.get_data());
        if (status === 401 || status === 403) {
            print('CHYBA: přihlášení selhalo (401/403) - zkontrolujte token.');
            loop.quit();
            return;
        }
        if (status !== 200) {
            print(`CHYBA: server vrátil ${status}`);
            loop.quit();
            return;
        }
        const states = JSON.parse(body);
        print(`OK: nalezeno ${states.length} entit. Prvních 30:`);
        states.slice(0, 30).forEach(s => print(`  ${s.entity_id} = ${s.state}`));
    } catch (e) {
        print(`CHYBA: ${e.message}`);
    }
    loop.quit();
});

GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 15, () => {
    print('TIMEOUT');
    loop.quit();
    return GLib.SOURCE_REMOVE;
});

loop.run();
