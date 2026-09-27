#!/usr/bin/env gjs
// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 konikvranik
/*
 * Complete live integration test running under Libsoup 2.4 with real HA and MA servers.
 */

imports.gi.versions.Soup = '2.4';

const {GLib, Gio, Soup} = imports.gi;
const System = imports.system;

const EXT_DIR = ARGV[0] || '.';
imports.searchPath.push(EXT_DIR);
imports.searchPath.push(EXT_DIR + '/tools/tests/harness');

print('1. Soup version verification in process:');
print('   Soup.MAJOR_VERSION =', Soup.MAJOR_VERSION);
if (Soup.MAJOR_VERSION !== 2) {
    print('ERROR: Soup 2.4 is not loaded!');
    System.exit(1);
}

const ExtensionUtils = imports.misc.extensionUtils;
const settings = ExtensionUtils.getSettings();

const haUrl = settings.get_string('ha-url');
const haToken = settings.get_string('ha-token');
const maUrl = settings.get_string('ma-url');
const maToken = settings.get_string('ma-token');

print('2. User settings loaded:');
print('   HA URL:', haUrl);
print('   HA Token set:', haToken.length > 0 ? 'YES (length ' + haToken.length + ')' : 'NO');
print('   MA URL:', maUrl);
print('   MA Token set:', maToken.length > 0 ? 'YES (length ' + maToken.length + ')' : 'NO');

const {HAClient} = imports.lib.ha;
const {MAClient} = imports.lib.ma;

const loop = GLib.MainLoop.new(null, false);
let haOk = false;
let maOk = false;
let haEntitiesCount = 0;
let maPlayersList = [];

// Test HA
print('\n3. Test HAClient (WebSocket via Libsoup 2.4)...');
const ha = new HAClient();
ha.configure(haUrl, haToken, false);
ha.onstate = (status, detail) => {
    print('   HA status:', status, detail || '');
    if (status === 'error' || status === 'auth-error') {
        print('   HA ERROR:', detail);
    }
};
ha.onstates = async () => {
    haEntitiesCount = Object.keys(ha.states).length;
    print('   HA SUCCESS: Loaded ' + haEntitiesCount + ' entities.');
    try {
        print('   Testing Assist (processConversation)...');
        const assistRes = await ha.processConversation('what time is it');
        print('   Assist response:', JSON.stringify(assistRes));
    } catch (e) {
        print('   Assist test info:', e.message);
    }
    haOk = true;
    checkDone();
};
ha.connect();

// Test MA
print('\n4. Test MAClient (WebSocket via Libsoup 2.4)...');
const ma = new MAClient();
ma.configure(maUrl, maToken, false, '');
ma.onstate = (status, detail) => {
    print('   MA status:', status, detail || '');
    if (status === 'error' || status === 'auth-error') {
        print('   MA ERROR:', detail);
    }
};
ma.onplayers = () => {
    const sg = ma.players.find(p => p.player_id === 'syncgroup_wvfarr22');
    if (sg) {
        print(`SG: id=${sg.player_id} name=${sg.name} vol=${sg.volume_level} grp_vol=${sg.group_volume} childs=${JSON.stringify(sg.group_childs)}`);
    }
};
const MprisLib = imports.lib.mpris;

let maDone = false;
ma.onqueues = () => {
    if (maDone)
        return;
    maDone = true;
    print('\n=== AI RADIO DJ ===');
    const djTest = Promise.all([ma.getDjHosts(), ma.getQueueDjStatus()]).then(([hosts, status]) => {
        print('   DJ hosts:', hosts.map(h => `${h.name} (${h.id})`).join(', '));
        print('   DJ queue status:', JSON.stringify(status));
    }).catch(e => print('   DJ test ERROR:', e.message));
    const firstQ = Object.values(ma.queues)[0];
    if (firstQ) {
        print('   dont_stop_the_music (Smart Mix):', firstQ.dont_stop_the_music_enabled);
    }
    const track = ma.trackInfo();
    print('1. Parse active track:');
    print('   Title:', track.title);
    print('   Artist:', track.artist);
    print('   Album:', track.album);
    print('   Duration:', track.duration, 's');
    print('   ArtUrl:', track.artUrl.slice(0, 60) + '...');

    const sgBridge = new MprisLib.MprisBridge(new imports.lib.ma.PlayerView(ma, 'syncgroup_wvfarr22'), 'test_sg', 'Music Assistant');
    const sgProps = sgBridge._propDefs()[MprisLib.PLAYER_IFACE];
    print('\n2. MPRIS properties of active group:');
    print('   Identity:', sgBridge._identity());
    print('   PlaybackStatus:', sgProps.PlaybackStatus[1]());
    print('   Volume:', sgProps.Volume[1]());
    print('   Position (s):', sgProps.Position[1]() / 1000000);
    print('   CanPause:', sgProps.CanPause[1]());
    print('   CanSeek:', sgProps.CanSeek[1]());
    print('   Metadata:', sgProps.Metadata[1]().print(true));

    print('\n3. Test starting MprisBridge on D-Bus /org/mpris/MediaPlayer2...');
    sgBridge.start();
    print('   Bridge started:', sgBridge.started);
    print('   Bus name:', sgBridge._busName);
    print('   Object path:', sgBridge._path);
    if (sgBridge._path !== '/org/mpris/MediaPlayer2') {
        throw new Error(`Error: path is not /org/mpris/MediaPlayer2, but ${sgBridge._path}`);
    }
    sgBridge.stop();
    print('   Bridge stopped successfully.');

    const samBridge = new MprisLib.MprisBridge(new imports.lib.ma.PlayerView(ma, 'upsam'), 'test_sam', 'Music Assistant');
    const samProps = samBridge._propDefs()[MprisLib.PLAYER_IFACE];
    print('\n4. MPRIS properties of inactive player:');
    print('   PlaybackStatus:', samProps.PlaybackStatus[1]());
    print('   Position (s):', samProps.Position[1]() / 1000000);
    print('   CanPause:', samProps.CanPause[1]());
    print('   Metadata:', samProps.Metadata[1]().print(true));

    // Wait for DJ test (checkDone quits main loop, promise must finish)
    djTest.then(() => {
        maOk = true;
        checkDone();
    });
};
ma.connect();

function checkDone() {
    if (haOk && maOk) {
        print('\n5. Result: Both connections fully functional in Libsoup 2.4!');
        cleanup();
        loop.quit();
    }
}

function cleanup() {
    try { ha._ws.destroy(); } catch (e) {}
    try { ma._ws.destroy(); } catch (e) {}
}

const timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 15, () => {
    print('\nERROR: Timeout exceeded (15 s).');
    print('   HA finished:', haOk ? 'YES' : 'NO');
    print('   MA finished:', maOk ? 'YES' : 'NO');
    cleanup();
    loop.quit();
    return GLib.SOURCE_REMOVE;
});

loop.run();

if (!haOk || !maOk) {
    System.exit(1);
}
System.exit(0);
