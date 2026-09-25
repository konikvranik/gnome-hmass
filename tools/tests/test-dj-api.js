#!/usr/bin/env gjs
// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 pvranik
/*
 * Read-only probe AI Radio DJ API (hosts/list, queue_dj/status).
 * Spouštět: GSETTINGS_SCHEMA_DIR=schemas DISPLAY=:1 gjs -I . tools/tests/test-dj-api.js
 */

imports.gi.versions.Soup = '2.4';

const {GLib, Soup} = imports.gi;
const System = imports.system;

const EXT_DIR = ARGV[0] || '.';
imports.searchPath.push(EXT_DIR);
imports.searchPath.push(EXT_DIR + '/tools/tests/harness');

const ExtensionUtils = imports.misc.extensionUtils;
const settings = ExtensionUtils.getSettings();

const {MAClient} = imports.lib.ma;

const ma = new MAClient();
ma.configure(settings.get_string('ma-url'), settings.get_string('ma-token'), false, '');

const loop = GLib.MainLoop.new(null, false);
let done = false;

const origOnMsg = ma._onMessage.bind(ma);
ma._onMessage = msg => {
    origOnMsg(msg);
    if (msg && msg.message_id === 'hmass-dj-hosts') {
        if (msg.error_code !== undefined) {
            print('hosts/list CHYBA:', JSON.stringify(msg).slice(0, 300));
        } else {
            print('hosts/list OK — počet hostů:', msg.result.length);
            for (const h of msg.result)
                print(`   host_id=${h.id}  name="${h.name}"`);
        }
        finishPart();
    }
    if (msg && msg.message_id === 'hmass-dj-status') {
        if (msg.error_code !== undefined) {
            print('queue_dj/status CHYBA:', JSON.stringify(msg).slice(0, 300));
        } else {
            print('queue_dj/status OK:', JSON.stringify(msg.result));
        }
        finishPart();
    }
};

let parts = 0;
function finishPart() {
    parts++;
    if (parts >= 2 && !done) {
        done = true;
        try { ma._ws.destroy(); } catch (e) {}
        loop.quit();
    }
}

ma.onplayers = () => {
    print('MA připojeno, hráčů:', ma.players.length);
    print('fronty (queue_id → display_name):');
    for (const q of Object.values(ma.queues))
        print(`   ${q.queue_id} → ${q.display_name} (active=${q.active})`);
    // ruční probe příkazy s pevnými message_id
    ma._ws.send({message_id: 'hmass-dj-hosts', command: 'ai_radio/hosts/list', args: {}});
    ma._ws.send({message_id: 'hmass-dj-status', command: 'ai_radio/queue_dj/status', args: {}});
};

GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 15, () => {
    print('TIMEOUT');
    loop.quit();
    return GLib.SOURCE_REMOVE;
});

ma.connect();
loop.run();
System.exit(0);
