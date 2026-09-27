#!/usr/bin/env gjs
// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 konikvranik
/*
 * Probe Assist pipelines/agents on live HA:
 * 1) list pipelines (assist_pipeline/pipeline/list) + agents (conversation/agent/list)
 * 2) conversation/process "set relaxation" without agent_id vs. with agent_id from preferred pipeline
 * Note: working variant actually activates the scene (like user manual test).
 */

imports.gi.versions.Soup = '2.4';

const {GLib} = imports.gi;
const System = imports.system;

const EXT_DIR = ARGV[0] || '.';
imports.searchPath.push(EXT_DIR);
imports.searchPath.push(EXT_DIR + '/tools/tests/harness');

const ExtensionUtils = imports.misc.extensionUtils;
const settings = ExtensionUtils.getSettings();
const {HAClient} = imports.lib.ha;

const PHRASE = 'set relaxation';

const ha = new HAClient();
ha.configure(settings.get_string('ha-url'), settings.get_string('ha-token'), false);

const loop = GLib.MainLoop.new(null, false);
let statesArrived = false;

const results = {};
let got = 0;

const origOn = ha._onMessage.bind(ha);
ha._onMessage = msg => {
    origOn(msg);
    if (!msg || msg.event !== undefined || msg.success === undefined)
        return;
    if (msg.id === results._pipeId) {
        results.pipelines = msg.success ? msg.result : {ERROR: msg.error && msg.error.message};
        next();
    } else if (msg.id === results._agentId) {
        results.agents = msg.success ? msg.result : {ERROR: msg.error && msg.error.message};
        next();
    }
};

ha.onstates = () => {
    if (statesArrived)
        return;
    statesArrived = true;
    print('HA connected, probing pipelines and agents...');
    results._pipeId = ha._nextId();   // HA requires integer message IDs
    results._agentId = ha._nextId();
    ha._ws.send({id: results._pipeId, type: 'assist_pipeline/pipeline/list'});
    ha._ws.send({id: results._agentId, type: 'conversation/agent/list'});
};

function next() {
    got++;
    if (got < 2)
        return;
    print('\n=== PIPELINES ===');
    print(JSON.stringify(results.pipelines).slice(0, 2200));
    print('\n=== AGENTS ===');
    print(JSON.stringify(results.agents).slice(0, 1200));

    const p = results.pipelines;
    const list = Array.isArray(p) ? p : (p && p.pipelines);
    const preferred = Array.isArray(list)
        ? (list.find(x => x.id === (p.preferred_item || p.preferred)) || list[0])
        : null;

    print('\n=== TEST: "' + PHRASE + '" without agent_id ===');
    ha.processConversation(PHRASE).then(res => {
        print('speech:', JSON.stringify(res.speech), 'type:', res.responseType);
        return new Promise(r => GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => r()));
    }).then(() => {
        if (preferred) {
            print(`\n=== TEST: via pipeline "${preferred.name}" (agent_id=${preferred.conversation_engine}, lang=${preferred.conversation_language}) ===`);
            return ha.processConversation(PHRASE, null, preferred.conversation_language, preferred.conversation_engine)
                .then(res => {
                    print('speech:', JSON.stringify(res.speech), 'type:', res.responseType);
                });
        }
        print('No pipeline available - agent test skipped');
    }).then(done).catch(e => {
        print('Test ERROR:', e.message);
        done();
    });
}

function done() {
    try { ha._ws.destroy(); } catch (e) {}
    loop.quit();
}

GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
    print('TIMEOUT');
    loop.quit();
    return GLib.SOURCE_REMOVE;
});

ha.connect();
loop.run();
System.exit(0);
