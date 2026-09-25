#!/usr/bin/env gjs
/*
 * Test připojení k Music Assistant z terminálu:
 *   gjs tools/test-ma.js http://mass:8095 [API_KLIC]
 */

imports.gi.versions.Soup = '3.0';

const {GLib, Soup} = imports.gi;
const System = imports.system;
const _decoder = new TextDecoder();

const url = ARGV[0];
const token = ARGV[1] || '';

if (!url) {
    print('Použití: gjs tools/test-ma.js <url> [api_klic]');
    System.exit(1);
}

function wsUrl() {
    let s = url.replace(/\/+$/, '');
    if (s.startsWith('https://'))
        s = 'wss://' + s.slice(8);
    else if (s.startsWith('http://'))
        s = 'ws://' + s.slice(7);
    else
        s = 'ws://' + s;
    return s;
}

const loop = GLib.MainLoop.new(null, false);
const session = new Soup.Session();
const msg = Soup.Message.new('GET', `${wsUrl()}/ws`);
if (token)
    msg.request_headers.append('Authorization', `Bearer ${token}`);

let msgId = 0;
let ws = null;
let queueAsked = false;

function send(command, args) {
    msgId += 1;
    ws.send_text(JSON.stringify({message_id: `t-${msgId}`, command, args: args || {}}));
}

const timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 15, () => {
    print('TIMEOUT: server neodpověděl do 15 s');
    loop.quit();
    return GLib.SOURCE_REMOVE;
});

session.websocket_connect_async(msg, null, null, GLib.PRIORITY_DEFAULT, null, (sess, res) => {
    try {
        ws = sess.websocket_connect_finish(res);
    } catch (e) {
        print(`SPOJENÍ SELHALO: ${e.message}`);
        print(`Zkouším starší endpoint /websocketapi …`);
        System.exit(2);
    }
    ws.connect('message', (self, type, data) => {
        let m;
        try {
            const raw = _decoder.decode(data instanceof Uint8Array ? data : data.get_data());
            m = JSON.parse(raw);
        } catch (e) {
            return;
        }
        if (m.event) {
            if (m.event === 'queue_updated' || m.event === 'queue_time_updated')
                return; // běžící eventy ignorujeme
            print(`event: ${m.event}`);
            return;
        }
        if (m.error_code !== undefined) {
            print(`CHYBA (${m.error_code}): ${m.details}`);
            loop.quit();
            return;
        }
        if (m.server_version) {
            print(`Server: MA ${m.server_version}`);
            if (token)
                send('auth', {token});
            send('players/all');
            return;
        }
        if (Array.isArray(m.result) && m.result.length > 0 && m.result[0].player_id !== undefined) {
            print(`Přehrávače (${m.result.length}):`);
            for (const p of m.result) {
                print(`  - ${p.player_id}  |  ${p.name}  |  ${p.playback_state}  |  vol ${p.volume_level}${p.volume_muted ? ' (mute)' : ''}`);
            }
            const first = m.result[0];
            send('player_queues/get_active_queue', {player_id: first.player_id});
            queueAsked = true;
            return;
        }
        if (queueAsked && m.result && m.result.queue_id !== undefined) {
            const q = m.result;
            const item = q.current_item || {};
            const media = item.media_item || {};
            print(`Fronta '${q.display_name}': stav=${q.state}, elapsed=${q.elapsed_time}s, položek=${q.items}`);
            print(`  skladba: ${media.name || item.name || '-'} | ${item.duration || '?'} s`);
            GLib.source_remove(timeoutId);
            loop.quit();
        }
    });
    ws.connect('closed', () => {
        print('Spojení zavřeno.');
        loop.quit();
    });
});

loop.run();
