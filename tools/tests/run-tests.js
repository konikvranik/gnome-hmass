#!/usr/bin/env gjs
// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 pvranik
/*
 * E2E test knihoven rozšíření proti mock serverům:
 *   python3 tools/tests/mock_server.py ha 8721 /tmp/mock-ha.log &
 *   python3 tools/tests/mock_server.py ma 8722 /tmp/mock-ma.log &
 *   gjs tools/tests/run-tests.js
 */

imports.gi.versions.Soup = '3.0';

const {GLib, Gio} = imports.gi;
const System = imports.system;

const EXT_DIR = ARGV[0] || '.';
imports.searchPath.push(EXT_DIR);
imports.searchPath.push(EXT_DIR + '/tools/tests/harness');

const misc = imports.misc; // načte stub
const WsLib = imports.lib.ws;
const {HAClient} = imports.lib.ha;
const {MAClient, PlayerView} = imports.lib.ma;
const {MprisBridge} = imports.lib.mpris;
const {HaPlayerAdapter} = imports.lib.haPlayer;

const loop = GLib.MainLoop.new(null, false);

let failures = 0;
function check(name, cond, detail) {
    if (cond) {
        print(`PASS  ${name}`);
    } else {
        failures += 1;
        print(`FAIL  ${name}${detail ? ' — ' + detail : ''}`);
    }
}

// počítadlo logů pro testy "nic nepřehnaně loguje"
let logCalls = [];
globalThis.log = (...a) => {
    logCalls.push(a.map(String).join(' '));
};

function readLog(path) {
    try {
        const [, contents] = GLib.file_get_contents(path);
        const lines = new TextDecoder().decode(contents).trim().split('\n')
            .filter(l => l.length > 0).map(l => JSON.parse(l));
        return lines;
    } catch (e) {
        return [];
    }
}

function quitSoon() {
    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        loop.quit();
        return GLib.SOURCE_REMOVE;
    });
}

// ---------------- Home Assistant ----------------

function testHa() {
    const ha = new HAClient();
    let gotStates = null;
    let entityEvent = null;

    ha.onstates = states => {
        gotStates = states;
    };
    ha.onentity = (entityId, st) => {
        if (entityId === 'sensor.teplota_ob-yvak')
            entityEvent = st;
    };

    ha.configure('http://127.0.0.1:8721', 'test-token', false);
    ha.connect();

    GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
        check('HA: kompletní stavy načteny', gotStates !== null && Object.keys(gotStates).length === 5,
            `states=${gotStates && Object.keys(gotStates).length}`);
        check('HA: přihlášení proběhlo', ha.status === 'ok', `status=${ha.status}`);
        check('HA: push změna stavu dorazila', entityEvent !== null && entityEvent.state === '22.5',
            `state=${entityEvent && entityEvent.state}`);

        ha.callService('input_boolean', 'toggle', {entity_id: 'input_boolean.svetlo'});
        GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            const calls = readLog('/tmp/mock-ha.log').filter(l => l.kind === 'ha_call');
            check('HA: call_service odeslán', calls.length === 1 &&
                calls[0].data.domain === 'input_boolean' && calls[0].data.service === 'toggle',
                JSON.stringify(calls));
            ha.destroy();
            testMa();
            return GLib.SOURCE_REMOVE;
        });
        return GLib.SOURCE_REMOVE;
    });
}

// ---------------- Music Assistant ----------------

function testMa() {
    const ma = new MAClient();
    let gotPlayers = false;
    let gotQueue = false;
    let gotElapsed = null;
    let gotPause = null;
    let volumeEvent = null;

    ma.onplayers = () => {
        gotPlayers = true;
    };
    ma.onqueue = () => {
        gotQueue = true;
        if (ma.queue && ma.queue.state === 'paused')
            gotPause = ma.queue.state;
    };
    ma.onelapsed = () => {
        gotElapsed = ma.queue ? ma.queue.elapsed_time : null;
    };
    ma.onactive = () => {
        const p = ma.activePlayer;
        if (p && p.volume_level === 55)
            volumeEvent = p.volume_level;
    };

    ma.configure('http://127.0.0.1:8722', 'test-key', false, '');
    ma.connect();

    GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
        check('MA: přehrávače načteny', gotPlayers && ma.players.length === 2,
            `players=${ma.players.length}`);
        check('MA: aktivní přehrávač vybrán', ma.activePlayerId === 'p1',
            `active=${ma.activePlayerId}`);
        check('MA: fronta načtena', gotQueue && !!ma.queue && ma.queue.queue_id === 'p1');
        const info = ma.trackInfo();
        check('MA: info o skladbě', info.title === 'Song A' && info.artist === 'Artist' &&
            info.album === 'Album X' && info.duration === 200,
            JSON.stringify(info));
        check('MA: elapsed event', gotElapsed !== null && gotElapsed === 11.0, `elapsed=${gotElapsed}`);
        check('MA: queue_updated (pauza)', gotPause === 'paused', `state=${gotPause}`);
        check('MA: player_updated (hlasitost)', volumeEvent === 55, `vol=${volumeEvent}`);
        check('MA: pozice se dopočítává', ma.currentElapsed() >= 10,
            `elapsed=${ma.currentElapsed()}`);

        ma.playPause();
        ma.setVolume(77);
        ma.setRepeat('all');
        GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            const cmds = readLog('/tmp/mock-ma.log').filter(l => l.kind === 'ma_cmd')
                .map(l => l.data);
            check('MA: play_pause odesláno', cmds.some(c => c.command === 'players/cmd/play_pause' &&
                c.args.player_id === 'p1'), JSON.stringify(cmds));
            check('MA: volume_set odesláno', cmds.some(c => c.command === 'players/cmd/volume_set' &&
                c.args.volume_level === 77), JSON.stringify(cmds));
            check('MA: repeat odesláno', cmds.some(c => c.command === 'players/cmd/repeat' &&
                c.args.repeat_mode === 'all'), JSON.stringify(cmds));

            ma.destroy();
            testMpris();
            return GLib.SOURCE_REMOVE;
        });
        return GLib.SOURCE_REMOVE;
    });
}

// ---------------- MPRIS most ----------------

// vlastní testovací jméno, aby testy nekolidovaly s případně běžícím rozšířením
const TEST_SUFFIX = 'test1';
const TEST_DEST = 'org.mpris.MediaPlayer2.hmass.' + TEST_SUFFIX;
const TEST_PATH = '/org/mpris/MediaPlayer2/hmass/' + TEST_SUFFIX;

/** Async wrapper - call_sync ze stejného procesu by deadlockovalo main loop. */
function dbusCall(method, params, replyType) {
    return new Promise((resolve, reject) => {
        Gio.DBus.session.call(
            TEST_DEST, TEST_PATH,
            'org.freedesktop.DBus.Properties', method, params, replyType,
            Gio.DBusCallFlags.NONE, 5000, null,
            (conn, res) => {
                try {
                    resolve(conn.call_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

function playerCall(method, params) {
    return new Promise((resolve, reject) => {
        Gio.DBus.session.call(
            TEST_DEST, TEST_PATH,
            'org.mpris.MediaPlayer2.Player', method, params, null,
            Gio.DBusCallFlags.NONE, 5000, null,
            (conn, res) => {
                try {
                    resolve(conn.call_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

function getProp(name) {
    return dbusCall('Get', new GLib.Variant('(ss)', ['org.mpris.MediaPlayer2.Player', name]),
        new GLib.VariantType('(v)')).then(v => v.deepUnpack()[0].deepUnpack());
}

function sleepMs(ms) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

async function testMpris() {
    const commands = [];
    const fake = {
        players: [],
        activePlayerId: 'p1',
        activePlayer: {player_id: 'p1', name: 'Obývák', volume_level: 40, volume_muted: false},
        queue: {
            queue_id: 'p1', state: 'playing', shuffle_enabled: true, repeat_mode: 'one',
            elapsed_time: 12, elapsed_time_last_updated: Date.now() / 1000,
            current_item: {
                name: 'Artist - Song A', duration: 200,
                media_item: {name: 'Song A', artists: [{name: 'Artist'}], album: {name: 'Album X'}},
            },
        },
        trackInfo() {
            return {title: 'Song A', artist: 'Artist', album: 'Album X', duration: 200, artUrl: ''};
        },
        currentElapsed() {
            return 13;
        },
        playPause() {
            commands.push('play_pause');
        },
        next() {
            commands.push('next');
        },
        previous() {
        },
        pause() {
        },
        play() {
        },
        stop() {
        },
        seek(pos) {
            commands.push(`seek:${pos}`);
        },
        setVolume(v) {
            commands.push(`vol:${v}`);
        },
        setMuted(m) {
        },
        setShuffle(s) {
            commands.push(`shuffle:${s}`);
        },
        setRepeat(m) {
            commands.push(`repeat:${m}`);
        },
    };

    const bridge = new MprisBridge(fake, TEST_SUFFIX, 'Music Assistant');
    bridge.start();

    let propsChanged = null;
    const subId = Gio.DBus.session.signal_subscribe(null, 'org.freedesktop.DBus.Properties',
        'PropertiesChanged', null, null, Gio.DBusSignalFlags.NONE,
        (conn, sender, path, iface, signal, params) => {
            const [ifaceName, changed] = params.deepUnpack();
            if (ifaceName === 'org.mpris.MediaPlayer2.Player')
                propsChanged = Object.keys(changed);
        });

    try {
        await sleepMs(500);

        check('MPRIS: PlaybackStatus', await getProp('PlaybackStatus') === 'Playing');
        check('MPRIS: LoopStatus one->Track', await getProp('LoopStatus') === 'Track');
        const meta = await getProp('Metadata');
        check('MPRIS: Metadata', meta['xesam:title'].deepUnpack() === 'Song A' &&
            meta['xesam:artist'].deepUnpack()[0] === 'Artist' &&
            meta['mpris:length'].deepUnpack() === 200000000,
            JSON.stringify(Object.keys(meta)));
        check('MPRIS: Volume', Math.abs(await getProp('Volume') - 0.4) < 0.001);
        check('MPRIS: Position', await getProp('Position') === 13000000);

        // --- regresní testy pádu Shellu ---
        // GetAll na obou rozhraních (tak činí gnome-shell při objevení MPRIS)
        for (const iface of ['org.mpris.MediaPlayer2', 'org.mpris.MediaPlayer2.Player']) {
            const all = await dbusCall('GetAll', new GLib.Variant('(s)', [iface]),
                new GLib.VariantType('(a{sv})'));
            const dict = all.deepUnpack()[0];
            check(`MPRIS: GetAll ${iface.split('.').pop()} vrací slovník`,
                dict && Object.keys(dict).length > 0,
                JSON.stringify(dict && Object.keys(dict)));
        }
        // křížový dotaz na neexistující vlastnost - musí přijít buď hodnota,
        // nebo korektní D-Bus chyba (InvalidArgs), nikdy ne zhodit proces
        let bogusOk = false;
        try {
            await dbusCall('Get',
                new GLib.Variant('(ss)', ['org.mpris.MediaPlayer2.Player', 'TakovatoNeexistuje']),
                new GLib.VariantType('(v)'));
            bogusOk = true;
        } catch (e) {
            bogusOk = String(e).includes('InvalidArgs');
        }
        check('MPRIS: neznámá vlastnost nezhodí proces', bogusOk);
        // rychlá série dotazů (agresivní konzumenti typu mprisindicatorbutton)
        for (let i = 0; i < 20; i++)
            await getProp('Position');
        check('MPRIS: zátěž 20 dotazů přežito', true);

        await dbusCall('Set', new GLib.Variant('(ssv)',
            ['org.mpris.MediaPlayer2.Player', 'Shuffle', new GLib.Variant('b', false)]), null);
        await playerCall('PlayPause', null);
        await sleepMs(500);

        check('MPRIS: příkazy přeposlány',
            commands.includes('play_pause') && commands.includes('shuffle:false'),
            JSON.stringify(commands));

        bridge.update(['PlaybackStatus', 'Metadata']);
        await sleepMs(500);
        check('MPRIS: PropertiesChanged vysílán', propsChanged !== null &&
            propsChanged.includes('PlaybackStatus') && propsChanged.includes('Metadata'),
            JSON.stringify(propsChanged));
    } catch (e) {
        check('MPRIS: D-Bus volání', false, e.message);
    }

    Gio.DBus.session.signal_unsubscribe(subId);
    bridge.stop();
    testPlayersPhase();
}

// ---- per-player MPRIS: MA PlayerView + HA adaptér, dva mosty souběžně ----

function dbusCallOn(dest, path, iface, method, params, replyType) {
    return new Promise((resolve, reject) => {
        Gio.DBus.session.call(dest, path, iface, method, params, replyType,
            Gio.DBusCallFlags.NONE, 5000, null,
            (conn, res) => {
                try {
                    resolve(conn.call_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

async function _testPlayersPhaseInner() {
    const ha = new HAClient();
    const ma = new MAClient();

    await new Promise(resolve => {
        let haReady = false;
        let maReady = false;
        const maybe = () => {
            if (haReady && maReady)
                resolve();
        };
        ha.onstates = () => {
            haReady = true;
            maybe();
        };
        ma.onqueues = () => {
            if (Object.keys(ma.playerQueues).length >= 2) {
                maReady = true;
                maybe();
            }
        };
        ha.configure('http://127.0.0.1:8721', 'test-token', false);
        ha.connect();
        ma.configure('http://127.0.0.1:8722', 'test-key', false, '');
        ma.connect();
        GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });

    check('Multi: fronty všech přehrávačů načteny',
        !!ma.playerQueues['p1'] && !!ma.playerQueues['p2'],
        JSON.stringify(Object.keys(ma.playerQueues)));

    ma.setVolume(50, 'p2');
    await sleepMs(300);
    const volCmds = readLog('/tmp/mock-ma.log').filter(l => l.kind === 'ma_cmd' &&
        l.data.command === 'players/cmd/volume_set');
    check('Multi: volume_set pro konkrétního přehrávače',
        volCmds.some(c => c.data.args.player_id === 'p2' && c.data.args.volume_level === 50),
        JSON.stringify(volCmds.map(c => c.data.args)));

    // dva souběžné mosty: MA p2 (idle) a HA media_player.obyvak (playing)
    const viewP2 = new PlayerView(ma, 'p2');
    check('Multi: PlayerView p2 idle', viewP2.queue && viewP2.queue.state === 'idle');

    const bridgeMa = new MprisBridge(viewP2, 'ma_p2', 'Music Assistant');
    const adapterHa = new HaPlayerAdapter(ha, 'media_player.obyvak');
    const bridgeHa = new MprisBridge(adapterHa, 'ha_media_player_obyvak', 'Home Assistant');
    bridgeMa.start();
    bridgeHa.start();
    await sleepMs(400);

    const getP = (dest, prop) => dbusCallOn(dest,
        `/org/mpris/MediaPlayer2/hmass/${dest.split('.').pop()}`,
        'org.freedesktop.DBus.Properties', 'Get',
        new GLib.Variant('(ss)', ['org.mpris.MediaPlayer2.Player', prop]),
        new GLib.VariantType('(v)')).then(v => v.deepUnpack()[0].deepUnpack());

    try {
        const destMa = 'org.mpris.MediaPlayer2.hmass.ma_p2';
        const destHa = 'org.mpris.MediaPlayer2.hmass.ha_media_player_obyvak';

        check('Multi: MA p2 Stopped', await getP(destMa, 'PlaybackStatus') === 'Stopped');
        check('Multi: HA Playing', await getP(destHa, 'PlaybackStatus') === 'Playing');

        const metaHa = await getP(destHa, 'Metadata');
        check('Multi: HA Metadata', metaHa['xesam:title'].deepUnpack() === 'Rádio FM' &&
            metaHa['xesam:artist'].deepUnpack()[0] === 'Interpret' &&
            metaHa['mpris:length'].deepUnpack() === 600000000,
            JSON.stringify(Object.keys(metaHa)));

        check('Multi: HA Volume (0.4)', Math.abs(await getP(destHa, 'Volume') - 0.4) < 0.001);

        const posHa = await getP(destHa, 'Position');
        // pozice roste od 30 s od okamžiku načtení stavu z mocku
        check('Multi: HA Position ~30s+', posHa >= 30000000 && posHa < 50000000,
            String(posHa));

        // příkazy: hlasitost, přehrání, seek (relativní v HA)
        await dbusCallOn(destHa, `/org/mpris/MediaPlayer2/hmass/${destHa.split('.').pop()}`,
            'org.freedesktop.DBus.Properties', 'Set', new GLib.Variant('(ssv)',
                ['org.mpris.MediaPlayer2.Player', 'Volume', new GLib.Variant('d', 0.55)]), null);
        await dbusCallOn(destHa, `/org/mpris/MediaPlayer2/hmass/${destHa.split('.').pop()}`,
            'org.mpris.MediaPlayer2.Player', 'PlayPause', null, null);
        await dbusCallOn(destHa, `/org/mpris/MediaPlayer2/hmass/${destHa.split('.').pop()}`,
            'org.mpris.MediaPlayer2.Player', 'SetPosition',
            new GLib.Variant('(ox)', ['/x', 60000000]), null);
        await sleepMs(400);

        const haCalls = readLog('/tmp/mock-ha.log').filter(l => l.kind === 'ha_call');
        check('Multi: HA volume_set 0.55', haCalls.some(c =>
            c.data.domain === 'media_player' && c.data.service === 'volume_set' &&
            c.data.service_data.entity_id === 'media_player.obyvak' &&
            Math.abs(c.data.service_data.volume_level - 0.55) < 0.001),
            JSON.stringify(haCalls.map(c => c.data)));
        check('Multi: HA media_play_pause', haCalls.some(c =>
            c.data.service === 'media_play_pause'));
        const seeks = haCalls.filter(c => c.data.service === 'media_seek');
        // relativní seek = cíl (60 s) - aktuální pozice v okamžiku volání
        const expectedSeek = 60 - posHa / 1000000;
        check('Multi: HA seek relativní', seeks.length === 1 &&
            Math.abs(seeks[0].data.service_data.seek_position - expectedSeek) <= 3,
            JSON.stringify(seaks_fix(seeks, expectedSeek)));
        function seaks_fix(seeks2, exp) {
            return {seek: seeks2.map(c => c.data.service_data.seek_position), expected: exp};
        }
    } catch (e) {
        check('Multi: D-Bus volání', false, e.message);
    }

    bridgeMa.stop();
    bridgeHa.stop();
    ha.destroy();
    ma.destroy();
}

async function testPlayersPhase() {
    try {
        await _testPlayersPhaseInner();
    } catch (e) {
        check('Multi: fáze selhala', false, `${e}\n${e.stack}`);
    }
    testOfflinePhase();
}

// ---------------- Offline: nedostupné a zlobivé servery ----------------

async function _testOfflineInner() {
    // 1) mrtvý port: klient se nezhroutí, opakuje pokusy s backoffem
    logCalls = [];
    const haDead = new HAClient();
    let deadAttempts = 0;
    haDead.onstate = st => {
        if (st === 'connecting')
            deadAttempts++;
    };
    haDead.configure('http://127.0.0.1:8799', 'tk', false);
    haDead.connect();
    await sleepMs(3500);
    check('Offline: mrtvý port → chybový stav', haDead.status === 'error', haDead.status);
    check('Offline: pokusy se opakují', deadAttempts >= 3, String(deadAttempts));
    check('Offline: backoff roste a je omezen',
        haDead._ws._backoff >= 2 && haDead._ws._backoff <= 60,
        String(haDead._ws._backoff));
    check('Offline: mrtvý port téměř neloguje', logCalls.length <= 2,
        logCalls.join(' | '));
    haDead.destroy();
    await sleepMs(300);

    // 2) opakované logy se potlačují (rate limit)
    logCalls = [];
    const wl = new WsLib.WsClient('logtest');
    wl._logLimited('k', 'první');
    wl._logLimited('k', 'druhý se stejným klíčem');
    wl._logLimited('j', 'jiný klíč');
    check('Offline: opakované logy potlačeny', logCalls.length === 2,
        JSON.stringify(logCalls));

    // 3) zlobivý server: nevalidní rámce + abrupt close, dokola
    logCalls = [];
    const maEvil = new MAClient();
    let evilAttempts = 0;
    maEvil.onstate = st => {
        if (st === 'connecting')
            evilAttempts++;
    };
    maEvil.configure('http://127.0.0.1:8723', '', false, '');
    maEvil.connect();
    await sleepMs(6000);
    check('Offline: zlobivý server klienta nesrazil (pokusy pokračují)',
        evilAttempts >= 3, `attempts=${evilAttempts}`);
    check('Offline: zlobivý server nepřehnaně loguje', logCalls.length <= 8,
        `${logCalls.length}: ${logCalls.slice(0, 3).join(' | ')}`);
    maEvil.destroy();
    await sleepMs(300);

    // 4) HA odmítá token: auth-error bez reconnect smyčky
    logCalls = [];
    const haRej = new HAClient();
    let removedEvent = false;
    haRej.onentity = (id, st) => {
        if (id === 'sensor.x' && st === null)
            removedEvent = true;
    };
    haRej.configure('http://127.0.0.1:8724', 'spatny-token', false);
    haRej.connect();
    await sleepMs(2500);
    check('Offline: HA auth_invalid → auth-error', haRej.status === 'auth-error',
        haRej.status);
    check('Offline: špatný token dál nespamuje server',
        haRej._ws._reconnectId === 0, String(haRej._ws._reconnectId));
    check('Offline: smazání entity (new_state null) zpracováno', removedEvent);
    check('Offline: auth odmítnutí zalogováno jednou', logCalls.length === 1,
        logCalls.join(' | '));
    haRej.destroy();
    await sleepMs(300);

    // 5) server zemří uprostřed sezení
    const maDie = new MAClient();
    maDie.configure('http://127.0.0.1:8725', '', false, '');
    maDie.connect();
    await sleepMs(1500);
    const wasOk = maDie.status === 'ok' && maDie.players.length === 2;
    await sleepMs(3500);
    check('Offline: pád serveru za běhu detekován', wasOk && maDie.status === 'error',
        `wasOk=${wasOk} status=${maDie.status}`);
    maDie.destroy();
    await sleepMs(300);

    // 6) MPRIS most bez dat (všechno offline)
    const fakeOffline = {
        activePlayer: null,
        queue: null,
        trackInfo: () => ({title: '', artist: '', album: '', duration: 0, artUrl: ''}),
        currentElapsed: () => 0,
        play() {}, pause() {}, playPause() {}, stop() {},
        next() {}, previous() {}, seek() {},
        setVolume() {}, setMuted() {}, setShuffle() {}, setRepeat() {},
    };
    const bridge = new MprisBridge(fakeOffline, TEST_SUFFIX, 'Music Assistant');
    bridge.start();
    bridge.sync();
    await sleepMs(300);
    const status = (await dbusCall('Get',
        new GLib.Variant('(ss)', ['org.mpris.MediaPlayer2.Player', 'PlaybackStatus']),
        new GLib.VariantType('(v)'))).deepUnpack()[0].deepUnpack();
    check('Offline: MPRIS bez dat = Stopped', status === 'Stopped', status);
    const canPlay = (await dbusCall('Get',
        new GLib.Variant('(ss)', ['org.mpris.MediaPlayer2.Player', 'CanPlay']),
        new GLib.VariantType('(v)'))).deepUnpack()[0].deepUnpack();
    check('Offline: MPRIS CanPlay false', canPlay === false, String(canPlay));
    bridge.stop();
}

async function testOfflinePhase() {
    try {
        await _testOfflineInner();
    } catch (e) {
        check('Offline: fáze selhala', false, `${e}\n${e.stack}`);
    }
    finish();
}

function finish() {
    print('');
    if (failures === 0)
        print('VŠECHNY TESTY PROŠLY');
    else
        print(`SELHALO TESTŮ: ${failures}`);
    quitSoon();
}

testHa();
loop.run();
System.exit(failures === 0 ? 0 : 1);
