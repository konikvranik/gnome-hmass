#!/usr/bin/env gjs
// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 pvranik
/*
 * UI testy rozšíření mimo GNOME Shell: logika panelu, menu, HA řádků,
 * SliderRow, MPRIS manageru v Indicatoru a logika prefs (checklist).
 *
 * Spuštění (env nastaví Makefile cíl check-ui):
 *   gjs tools/tests/run-ui-tests.js "$PWD"
 */

imports.gi.versions.Soup = '3.0';
imports.gi.versions.Clutter = '10';

const {GLib, GObject, Gio, Clutter} = imports.gi;
const System = imports.system;

const EXT_DIR = ARGV[0] || '.';
imports.searchPath.push(EXT_DIR);
imports.searchPath.push(EXT_DIR + '/tools/tests/harness');

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

// ---- St fakes: nahradí widgetové třídy v načteném namespace St ----
const St = imports.gi.St;

function fakeSignalMixin() {
    return {
        connect(sig, cb) {
            this._handlers[sig] = this._handlers[sig] || [];
            this._handlers[sig].push(cb);
            return 1;
        },
        emit(sig, ...args) {
            for (const cb of this._handlers[sig] || [])
                cb(this, ...args);
        },
    };
}

class FakeClutterText {
    constructor() {
        this.ellipsize = 0;
        this.has_key_focus = false;
        this._handlers = {};
        Object.assign(this, fakeSignalMixin());
    }
}

class FakeLabel {
    constructor(params) {
        params = params || {};
        this.text = params.text || '';
        this.style_class = params.style_class || '';
        this.x_expand = params.x_expand || false;
        this.y_align = params.y_align || null;
        this.clutter_text = new FakeClutterText();
        this._handlers = {};
        Object.assign(this, fakeSignalMixin());
        this.destroyed = false;
    }
    destroy() {
        this.destroyed = true;
    }
}

class FakeBoxLayout {
    constructor(params) {
        params = params || {};
        this.vertical = !!params.vertical;
        this.reactive = !!params.reactive;
        this.style_class = params.style_class || '';
        this.x_align = params.x_align || null;
        this.x_expand = params.x_expand || false;
        this.children = [];
        this._handlers = {};
        Object.assign(this, fakeSignalMixin());
        this.destroyed = false;
    }
    add_child(c) {
        this.children.push(c);
    }
    add_actor(c) {
        this.children.push(c);
    }
    insert_child_above(c, sibling) {
        const idx = this.children.indexOf(sibling);
        this.children.splice(idx < 0 ? 0 : idx, 0, c);
    }
    destroy_all_children() {
        this.children = [];
    }
    get_n_children() {
        return this.children.length;
    }
    destroy() {
        this.destroyed = true;
    }
}

class FakeBin {
    constructor(params) {
        params = params || {};
        this.style_class = params.style_class || '';
        this.y_align = params.y_align || null;
        this.destroyed = false;
    }
    destroy() {
        this.destroyed = true;
    }
}

class FakeIcon {
    constructor(params) {
        params = params || {};
        this.icon_name = params.icon_name || '';
        this.icon_size = params.icon_size || 16;
        this.style_class = params.style_class || '';
        this.destroyed = false;
    }
    destroy() {
        this.destroyed = true;
    }
}

class FakeButton {
    constructor(params) {
        params = params || {};
        this.can_focus = !!params.can_focus;
        this.style_class = params.style_class || '';
        this.child = null;
        this._handlers = {};
        Object.assign(this, fakeSignalMixin());
        this.destroyed = false;
    }
    set_child(c) {
        this.child = c;
    }
    click() {
        this.emit('clicked');
    }
    destroy() {
        this.destroyed = true;
    }
}

class FakeEntry {
    constructor(params) {
        params = params || {};
        this.text = params.text || '';
        this.hint_text = params.hint_text || '';
        this.can_focus = !!params.can_focus;
        this.track_hover = !!params.track_hover;
        this.style_class = params.style_class || '';
        this.clutter_text = new FakeClutterText();
        this._handlers = {};
        Object.assign(this, fakeSignalMixin());
        this.destroyed = false;
    }
    destroy() {
        this.destroyed = true;
    }
}

St.Label = FakeLabel;
St.BoxLayout = FakeBoxLayout;
St.Bin = FakeBin;
St.Icon = FakeIcon;
St.Button = FakeButton;
St.Entry = FakeEntry;

// ---- import testovaných modulů (až po nahrazení St) ----
const UI = imports.lib.ui;
const WsLib = imports.lib.ws;
const {HAClient} = imports.lib.ha;
const {MAClient} = imports.lib.ma;
const Main = imports.ui.main;
const Util = imports.misc.util;

// ---- jednotkové testy čisté logiky ----

function testUnits() {
    check('UI: formatTime', UI.formatTime(0) === '0:00' && UI.formatTime(65) === '1:05' &&
        UI.formatTime(3671) === '1:01:11');
    check('UI: humanState', UI.humanState('on') === 'zapnuto' &&
        UI.humanState('off') === 'vypnuto' && UI.humanState('unavailable') === 'nedostupné' &&
        UI.humanState('21.4') === '21.4' && UI.humanState(null) === 'nedostupné');
    check('UI: panelValueText', UI.panelValueText({
        state: '21.4', attributes: {unit_of_measurement: '°C'},
    }) === '21.4 °C' && UI.panelValueText({state: 'off', attributes: {}}) === 'off' &&
        UI.panelValueText(null) === '—');
    check('UI: panelValueText auto zaokrouhlení',
        UI.panelValueText({state: '65.6158981323242', attributes: {unit_of_measurement: 'cm'}}) === '65.62 cm' &&
        UI.panelValueText({state: '42', attributes: {}}) === '42' &&
        UI.panelValueText({state: '21.4', attributes: {}}) === '21.4' &&
        UI.panelValueText({state: '21.4321', attributes: {}}, 3) === '21.432' &&
        UI.panelValueText({state: '21.432', attributes: {suggested_display_precision: 1}}, -1) === '21.4');
    check('ws: wsUrlFromHttp', WsLib.wsUrlFromHttp('http://ha:8123', '/api/websocket') === 'ws://ha:8123/api/websocket' &&
        WsLib.wsUrlFromHttp('https://ha', '/api/websocket') === 'wss://ha/api/websocket' &&
        WsLib.wsUrlFromHttp('ws://x:1/', '/ws') === 'ws://x:1/ws');
}

// ---- createHaRows: automatické ovládací prvky podle domény ----

function recorderHa() {
    return {
        states: {},
        calls: [],
        callService(domain, service, data) {
            this.calls.push({domain, service, data});
        },
    };
}

function testHaRows() {
    const ha = recorderHa();

    // přepínač
    let r = UI.createHaRows('switch.kotel', {
        entity_id: 'switch.kotel', state: 'off', attributes: {friendly_name: 'Kotel'},
    }, ha);
    check('Rows: switch = přepínač', r.rows.length === 1 &&
        r.rows[0] instanceof imports.ui.popupMenu.PopupSwitchMenuItem &&
        r.rows[0].label.text === 'Kotel' && r.rows[0].state === false);
    r.rows[0].activateItem();
    check('Rows: switch toggle → callService', ha.calls.length === 1 &&
        ha.calls[0].domain === 'switch' && ha.calls[0].service === 'toggle' &&
        ha.calls[0].data.entity_id === 'switch.kotel');
    r.update({entity_id: 'switch.kotel', state: 'on', attributes: {friendly_name: 'Kotel'}});
    check('Rows: switch update zapnuto', r.rows[0].state === true);
    r.update(null);
    check('Rows: switch update nedostupné', r.rows[0].state === false);

    // světlo s jasem = přepínač + posuvník
    r = UI.createHaRows('light.pokoj', {
        entity_id: 'light.pokoj', state: 'on',
        attributes: {friendly_name: 'Světlo', brightness: 128},
    }, ha);
    check('Rows: light = přepínač + jas', r.rows.length === 2 &&
        r.rows[0].state === true);
    r.rows[1].slider.value = 0.5;
    r.rows[1].emit('changed', 0.5);
    const bright = ha.calls.find(c => c.service === 'turn_on');
    check('Rows: jas → brightness 128', bright && bright.data.brightness === 128 &&
        bright.data.entity_id === 'light.pokoj');
    r.update({entity_id: 'light.pokoj', state: 'on',
        attributes: {friendly_name: 'Světlo', brightness: 64}});
    check('Rows: jas update', Math.abs(r.rows[1].slider.value - 64 / 255) < 0.01);

    // input_number
    r = UI.createHaRows('input_number.jas', {
        entity_id: 'input_number.jas', state: '42',
        attributes: {friendly_name: 'Jas', min: 0, max: 100, step: 1},
    }, ha);
    check('Rows: input_number = posuvník', r.rows.length === 1 &&
        Math.abs(r.rows[0].slider.value - 0.42) < 0.01);
    r.rows[0].emit('changed', 0.5);
    const setVal = ha.calls.find(c => c.service === 'set_value');
    check('Rows: set_value 50', setVal && setVal.data.value === 50);

    // input_select
    r = UI.createHaRows('input_select.mod', {
        entity_id: 'input_select.mod', state: 'auto',
        attributes: {friendly_name: 'Mód', options: ['auto', 'eco', 'boost']},
    }, ha);
    check('Rows: select = submenu', r.rows.length === 1 &&
        r.rows[0].menu.items.length === 3);
    r.rows[0].menu.items[2].activateItem();
    const sel = ha.calls.find(c => c.service === 'select_option');
    check('Rows: select_option boost', sel && sel.data.option === 'boost');
    r.update({entity_id: 'input_select.mod', state: 'eco',
        attributes: {friendly_name: 'Mód', options: ['auto', 'eco', 'boost']}});
    check('Rows: select ornament po update', r.rows[0].menu.items.length === 3);

    // script = položka spuštění
    r = UI.createHaRows('script.good_night', {
        entity_id: 'script.good_night', state: 'off', attributes: {friendly_name: 'Dobrou noc'},
    }, ha);
    check('Rows: script = položka', r.rows.length === 1 && r.rows[0].label.text === 'Dobrou noc');
    r.rows[0].activateItem();
    const scr = ha.calls.find(c => c.domain === 'script');
    check('Rows: script turn_on', scr && scr.service === 'turn_on');

    // sensor = jen zobrazení
    r = UI.createHaRows('sensor.teplota', {
        entity_id: 'sensor.teplota', state: '21.4',
        attributes: {friendly_name: 'Teplota', unit_of_measurement: '°C'},
    }, ha);
    const valueLbl = r.rows[0].children.find(c => c.style_class === 'hmass-ha-value');
    check('Rows: sensor = hodnota', r.rows.length === 1 && valueLbl && valueLbl.text === '21.4 °C');

    // input_text = textové pole
    r = UI.createHaRows('input_text.poznamka', {
        entity_id: 'input_text.poznamka', state: 'ahoj',
        attributes: {friendly_name: 'Poznámka'},
    }, ha);
    const entryRow = r.rows[0];
    const entry = entryRow.children.find(c => c.clutter_text && 'hint_text' in c);
    check('Rows: input_text = entry', !!entry && entry.text === 'ahoj');
    entry.text = 'nazdar';
    entry.clutter_text.emit('activate');
    const txt = ha.calls.find(c => c.service === 'set_value' &&
        c.domain === 'input_text');
    check('Rows: set_value text', txt && txt.data.value === 'nazdar');
    r.update({entity_id: 'input_text.poznamka', state: 'nova',
        attributes: {friendly_name: 'Poznámka'}});
    check('Rows: entry update zvenku', entry.text === 'nova');

    // media_player s hlasitostí
    r = UI.createHaRows('media_player.obb', {
        entity_id: 'media_player.obb', state: 'playing',
        attributes: {friendly_name: 'OBB', volume_level: 0.3},
    }, ha);
    const volRow = r.rows.find(row => row.slider);
    check('Rows: media_player hlasitost', !!volRow &&
        Math.abs(volRow.slider.value - 0.3) < 0.01);
    volRow.emit('changed', 1.0);
    const vol = ha.calls.find(c => c.service === 'volume_set');
    check('Rows: volume_set 1.0', vol && vol.data.volume_level === 1);

    // cover s pozicí = přepínač + posuvník
    r = UI.createHaRows('cover.roleta', {
        entity_id: 'cover.roleta', state: 'open',
        attributes: {friendly_name: 'Roleta', current_position: 80},
    }, ha);
    check('Rows: cover = přepínač + pozice', r.rows.length === 2 &&
        r.rows[1].slider !== undefined);
    r.rows[1].emit('changed', 0.5);
    const pos = ha.calls.find(c => c.service === 'set_cover_position');
    check('Rows: pozice 50', pos && pos.data.position === 50);
}

// ---- createPanelEntity: interaktivní widgety v liště ----

function testPanelEntities() {
    const ha = recorderHa();

    // sensor = jen hodnota s desetinnými místy
    let p = UI.createPanelEntity('sensor.teplota', {
        entity_id: 'sensor.teplota', state: '21.432',
        attributes: {friendly_name: 'Teplota', unit_of_measurement: '°C'},
    }, ha, UI.mergeEntityConfig({decimals: 1}, -1, 'ha'));
    check('Panel: sensor text 1 desetinné', p.actor.text === '21.4 °C', p.actor.text);
    p.update({entity_id: 'sensor.teplota', state: '21.436',
        attributes: {friendly_name: 'Teplota', unit_of_measurement: '°C'}});
    check('Panel: sensor update', p.actor.text === '21.4 °C', p.actor.text);
    p.update(null);
    check('Panel: sensor nedostupné', p.actor.text === '—', p.actor.text);

    // auto podle suggested_display_precision
    p = UI.createPanelEntity('sensor.vlhkost', {
        entity_id: 'sensor.vlhkost', state: '52.3456',
        attributes: {friendly_name: 'Vlhkost', suggested_display_precision: 2},
    }, ha);
    check('Panel: auto suggested_display_precision', p.actor.text === '52.35', p.actor.text);

    // switch = tlačítko přepínající entitu
    p = UI.createPanelEntity('switch.kotel', {
        entity_id: 'switch.kotel', state: 'off', attributes: {friendly_name: 'Kotel'},
    }, ha);
    check('Panel: switch je tlačítko', p.actor.constructor === St.Button);
    check('Panel: switch vypnuto = ztlumená ikona', p.actor.child.opacity === 110,
        String(p.actor.child.opacity));
    p.actor.click();
    check('Panel: klik přepne switch',
        ha.calls.length === 1 && ha.calls[0].service === 'toggle' &&
        ha.calls[0].data.entity_id === 'switch.kotel');
    p.update({entity_id: 'switch.kotel', state: 'on', attributes: {friendly_name: 'Kotel'}});
    check('Panel: switch zapnuto = plná ikona', p.actor.child.opacity === 255,
        String(p.actor.child.opacity));

    // script = tlačítko spuštění
    p = UI.createPanelEntity('script.dobre_rano', {
        entity_id: 'script.dobre_rano', state: 'off', attributes: {friendly_name: 'Dobré ráno'},
    }, ha);
    p.actor.click();
    const run = ha.calls.find(c => c.service === 'turn_on' && c.domain === 'script');
    check('Panel: klik spustí script', !!run);

    // input_number = hodnota měněná kolečkem
    p = UI.createPanelEntity('input_number.jas', {
        entity_id: 'input_number.jas', state: '42',
        attributes: {friendly_name: 'Jas', min: 0, max: 100, step: 1},
    }, ha);
    p.actor.emit('scroll-event', {get_scroll_direction: () => Clutter.ScrollDirection.UP});
    let sv = ha.calls.find(c => c.service === 'set_value');
    check('Panel: scroll nahoru +1', sv && sv.data.value === 43, JSON.stringify(sv && sv.data));
    p.actor.emit('scroll-event', {get_scroll_direction: () => Clutter.ScrollDirection.DOWN});
    p.actor.emit('scroll-event', {get_scroll_direction: () => Clutter.ScrollDirection.DOWN});
    sv = ha.calls.filter(c => c.service === 'set_value').pop();
    check('Panel: scroll dolů -2', sv && sv.data.value === 41, JSON.stringify(sv && sv.data));
    p.update({entity_id: 'input_number.jas', state: '100',
        attributes: {friendly_name: 'Jas', min: 0, max: 100, step: 1}});
    p.actor.emit('scroll-event', {get_scroll_direction: () => Clutter.ScrollDirection.UP});
    sv = ha.calls.filter(c => c.service === 'set_value').pop();
    check('Panel: scroll respektuje max', sv && sv.data.value === 100, JSON.stringify(sv && sv.data));

    // input_select = klik přepíná volby cyklicky
    p = UI.createPanelEntity('input_select.mod', {
        entity_id: 'input_select.mod', state: 'auto',
        attributes: {friendly_name: 'Mód', options: ['auto', 'eco', 'boost']},
    }, ha);
    check('Panel: select ukazuje volbu', p.actor.child.children[0].text === 'auto');
    p.actor.click();
    let so = ha.calls.find(c => c.service === 'select_option');
    check('Panel: klik přepne na eco', so && so.data.option === 'eco');
    p.update({entity_id: 'input_select.mod', state: 'boost',
        attributes: {friendly_name: 'Mód', options: ['auto', 'eco', 'boost']}});
    p.actor.click();
    so = ha.calls.filter(c => c.service === 'select_option').pop();
    check('Panel: přepnutí z poslední zalamuje na začátek', so && so.data.option === 'auto',
        JSON.stringify(so && so.data));

    // input_text = vstup přímo v liště
    p = UI.createPanelEntity('input_text.poznamka', {
        entity_id: 'input_text.poznamka', state: 'ahoj',
        attributes: {friendly_name: 'Poznámka'},
    }, ha);
    check('Panel: input_text předvyplněný', p.actor.text === 'ahoj');
    p.actor.text = 'nazdar';
    p.actor.clutter_text.emit('activate');
    const it = ha.calls.find(c => c.service === 'set_value' && c.domain === 'input_text');
    check('Panel: enter odešle text', it && it.data.value === 'nazdar');

    // práh = zvýraznění hodnoty, vlastní název
    p = UI.createPanelEntity('sensor.tlak', {
        entity_id: 'sensor.tlak', state: '2.9',
        attributes: {friendly_name: 'Tlak', unit_of_measurement: 'bar'},
    }, ha, UI.mergeEntityConfig({min: 3, max: 4, name: 'Tlak vody'}, -1, 'ha'));
    check('Panel: práh pod minimum = zvýraznění',
        p.actor.style_class.indexOf('hmass-value-alert') >= 0, p.actor.style_class);
    p.update({entity_id: 'sensor.tlak', state: '3.5',
        attributes: {friendly_name: 'Tlak', unit_of_measurement: 'bar'}});
    check('Panel: v rozsahu bez zvýraznění',
        p.actor.style_class.indexOf('hmass-value-alert') < 0, p.actor.style_class);

    // přepínač v textovém režimu
    p = UI.createPanelEntity('switch.kotel2', {
        entity_id: 'switch.kotel2', state: 'off', attributes: {friendly_name: 'Kotel 2'},
    }, ha, UI.mergeEntityConfig({display: 'value'}, -1, 'ha'));
    check('Panel: toggle text režim = stav slovem',
        p.actor.child && p.actor.child.text === 'vypnuto',
        p.actor.child && String(p.actor.child.text));
}

// ---- MaSection: kombinovaný řádek tlačítek + průběhu ----

function testMaSection() {
    const ExtensionUtils = imports.misc.extensionUtils;
    const settings = ExtensionUtils.getSettings();
    settings.set_boolean('ma-show-player-selector', false);
    settings.set_boolean('ma-show-dj-selector', false);
    settings.set_boolean('ma-show-transport', true);
    settings.set_boolean('ma-show-seek', true);
    settings.set_boolean('ma-show-shuffle-repeat', true);
    settings.set_boolean('ma-show-volume', false);

    const fakeClient = {
        players: [], queue: null, queues: {}, playerQueues: {},
        activePlayerId: '', djHosts: [], queueDjStatus: {},
        trackInfo: () => ({title: '', artist: '', album: '', duration: 0, artUrl: ''}),
        currentElapsed: () => 0,
    };
    const section = new UI.MaSection(fakeClient, settings);
    check('Ma: transport + průběh na jednom řádku',
        !!section.seekRow && section.seekRow.children.length === 3 &&
        section.seekRow.children[0].children.length === 6,
        JSON.stringify(section.seekRow && section.seekRow.children.length));
    check('Ma: play tlačítko v kombinovaném řádku', !!section.playBtn);
    section.seekRow.setValue(0.5);
    section.seekRow.setDisplay('1:00 / 2:00');
    check('Ma: setValue/setDisplay funguje', section.seekRow.bar.value === 0.5 &&
        section.seekRow.valueLabel.text === '1:00 / 2:00');
    section.destroy();

    // samostatné řádky, když je seek vypnutý
    settings.set_boolean('ma-show-seek', false);
    const section2 = new UI.MaSection(fakeClient, settings);
    check('Ma: bez seeku jen transport', !section2.seekRow && !!section2.playBtn);
    section2.destroy();
}

// ---- SliderRow: guard proti zpětné vazbě + debounce ----

function testSliderRow() {
    const localLoop = GLib.MainLoop.new(null, false);
    const row = new UI.SliderRow('Jas', 0.2);
    let changed = [];
    row.connect('changed', (src, v) => changed.push(v));

    row.setValue(0.7);
    check('Slider: programatické setValue neemituje changed', changed.length === 0,
        JSON.stringify(changed));

    row.slider.emit('drag-begin');
    row.slider.value = 0.9;
    row.slider.emit('drag-end');
    check('Slider: tažení emituje changed jednou', changed.length === 1 &&
        Math.abs(changed[0] - 0.9) < 0.001, JSON.stringify(changed));

    // scroll: notify::value bez dragu → debounce 400 ms
    changed = [];
    row.slider.value = 0.3;
    check('Slider: hned po scrollu nic', changed.length === 0);
    let debounced = false;
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => {
        debounced = changed.length === 1;
        localLoop.quit();
        return GLib.SOURCE_REMOVE;
    });
    localLoop.run();
    check('Slider: scroll debounce odešle po 400 ms', debounced, JSON.stringify(changed));
}

// ---- Indicator: integrace s mock servery ----

function nameOwned(name) {
    try {
        const res = Gio.DBus.session.call_sync(
            'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
            'NameHasOwner', new GLib.Variant('(s)', [name]), new GLib.VariantType('(b)'),
            Gio.DBusCallFlags.NONE, 2000, null);
        return res.deepUnpack()[0];
    } catch (e) {
        return false;
    }
}

async function testIndicator() {
    const ExtensionUtils = imports.misc.extensionUtils;
    const settings = ExtensionUtils.getSettings();
    settings.set_string('ha-url', 'http://127.0.0.1:8721');
    settings.set_string('ha-token', 'test-token');
    settings.set_string('ma-url', 'http://127.0.0.1:8722');
    settings.set_string('ma-token', 'test-key');
    settings.set_boolean('ma-enabled', true);
    settings.set_strv('ha-panel-entities', ['sensor.teplota_ob-yvak']);
    settings.set_strv('ha-menu-entities', [
        'input_boolean.svetlo', 'sensor.teplota_ob-yvak',
    ]);
    settings.set_strv('mpris-players', ['ma:p2', 'ha:media_player.obyvak']);

    Main.reset();
    Util.reset();
    const Ext = imports.extension;
    Ext.enable();

    await new Promise(r => GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 4, () => {
        r();
        return GLib.SOURCE_REMOVE;
    }));

    check('Ind: pověšeno do panelu', Main.addedToPanel.length === 1 &&
        Main.addedToPanel[0].role === 'hmass');

    const ind = Main.addedToPanel[0].indicator;
    const panelEntities = ind._panelEntities;
    check('Ind: panel widget s hodnotou', panelEntities.has('sensor.teplota_ob-yvak') &&
        /22\.5 °C|21\.4 °C/.test(panelEntities.get('sensor.teplota_ob-yvak').actor.text),
        panelEntities.get('sensor.teplota_ob-yvak') &&
        panelEntities.get('sensor.teplota_ob-yvak').actor.text);

    check('Ind: MPRIS mosty podle výběru',
        nameOwned('org.mpris.MediaPlayer2.hmass.ma_p2') &&
        nameOwned('org.mpris.MediaPlayer2.hmass.ha_media_player_obyvak'),
        '');

    // menu: HA řádky
    const menuItems = ind.menu.items;
    check('Ind: menu má položky', menuItems.length > 3, String(menuItems.length));
    const sw = menuItems.find(it => it instanceof imports.ui.popupMenu.PopupSwitchMenuItem &&
        it.label && it.label.text === 'Světlo');
    check('Ind: řádek input_boolean v menu', !!sw);

    // MA sekce
    const maSection = ind._maSection;
    check('Ind: MA sekce existuje', !!maSection && maSection.titleLabel.text === 'Song A',
        maSection && maSection.titleLabel.text);

    // volání prefs z menu
    const prefsItem = menuItems.find(it => it.label && it.label.text === 'Nastavení');
    check('Ind: položka Nastavení', !!prefsItem);
    prefsItem.activateItem();
    check('Ind: Nastavení spustí prefs', Util.spawned.length === 1 &&
        Util.spawned[0][0] === 'gnome-extensions' && Util.spawned[0][1] === 'prefs',
        JSON.stringify(Util.spawned));

    // otevření menu (ticker)
    ind.menu.emit('open-state-changed', true);
    ind.menu.emit('open-state-changed', false);

    Ext.disable();
    await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
        r();
        return GLib.SOURCE_REMOVE;
    }));
    check('Ind: disable uvolní MPRIS jména',
        !nameOwned('org.mpris.MediaPlayer2.hmass.ma_p2') &&
        !nameOwned('org.mpris.MediaPlayer2.hmass.ha_media_player_obyvak'), '');

    // vrátit nastavení do neutrálního stavu
    settings.set_strv('mpris-players', []);
    settings.set_strv('ha-panel-entities', []);
    settings.set_strv('ha-menu-entities', []);
    settings.set_string('ha-url', '');
    settings.set_string('ma-url', '');
}

// ---- Indicator s nedostupnými servery ----

async function testIndicatorOffline() {
    const ExtensionUtils = imports.misc.extensionUtils;
    const settings = ExtensionUtils.getSettings();
    settings.set_string('ha-url', 'http://127.0.0.1:8799');
    settings.set_string('ha-token', 'x');
    settings.set_string('ma-url', 'http://127.0.0.1:8799');
    settings.set_boolean('ma-enabled', true);
    settings.set_strv('ha-panel-entities', ['sensor.teplota_ob-yvak']);
    settings.set_strv('ha-menu-entities', []);
    settings.set_boolean('ma-mpris', false);

    let logs = 0;
    const origLog = globalThis.log;
    globalThis.log = () => {
        logs++;
    };

    Main.reset();
    Util.reset();
    const Ext = imports.extension;
    Ext.enable();

    await new Promise(r => GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 4, () => {
        r();
        return GLib.SOURCE_REMOVE;
    }));

    const ind = Main.addedToPanel[0].indicator;
    check('OfflineUI: ikona přepnuta na offline',
        ind._panelIcon && ind._panelIcon.icon_name === 'network-offline-symbolic',
        ind._panelIcon && ind._panelIcon.icon_name);
    check('OfflineUI: HA tečka chybová',
        ind._haDot && ind._haDot.style_class.includes('hmass-dot-err'),
        ind._haDot && ind._haDot.style_class);
    check('OfflineUI: MA tečka chybová',
        ind._maDot && ind._maDot.style_class.includes('hmass-dot-err'),
        ind._maDot && ind._maDot.style_class);
    check('OfflineUI: rozšíření žije, oba klienti v chybovém stavu',
        ind._ha.status === 'error' && ind._ma.status === 'error',
        `${ind._ha.status}/${ind._ma.status}`);
    check('OfflineUI: nepřehnané logování', logs <= 6, String(logs));

    globalThis.log = origLog;
    Ext.disable();
    await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
        r();
        return GLib.SOURCE_REMOVE;
    }));

    // vrátit nastavení do neutrálního stavu
    settings.set_string('ha-url', '');
    settings.set_string('ma-url', '');
    settings.set_strv('ha-panel-entities', []);
    settings.set_boolean('ma-mpris', true);
}

// ---- mergeEntityConfig / thresholdAlert / entityIconDef ----

function testEntityConfig() {
    const c1 = UI.mergeEntityConfig(null, -1, 'ha');
    check('Cfg: defaulty', c1.decimals === -1 && c1.icon === 'ha' &&
        c1.display === 'auto' && c1.name === '' &&
        c1.min === null && c1.max === null);

    const c2 = UI.mergeEntityConfig({
        decimals: 2, icon: 'type', display: 'icon-value',
        name: ' Teplota ', min: 10, max: 30,
    }, -1, 'ha');
    check('Cfg: přepisy platí', c2.decimals === 2 && c2.icon === 'type' &&
        c2.display === 'icon-value' && c2.name === 'Teplota' &&
        c2.min === 10 && c2.max === 30);

    const c3 = UI.mergeEntityConfig({decimals: 9, icon: 'bflm', display: 'x'}, -1, 'ha');
    check('Cfg: neplatné hodnoty ignorovány',
        c3.decimals === -1 && c3.icon === 'ha' && c3.display === 'auto');

    check('Cfg: práh min', UI.thresholdAlert(9.9, c2) && !UI.thresholdAlert(15, c2));
    check('Cfg: práh max', UI.thresholdAlert(30.1, c2) && !UI.thresholdAlert(29.9, c2));
    check('Cfg: práhy jen pro čísla', !UI.thresholdAlert(NaN, c2));

    // icons.js mimo GNOME Shell nemá sadu MDI → entityIconDef spadne
    // na symbolic ikonu theme
    const Icons = imports.lib.icons;
    check('Cfg: mdi mimo shell = null', Icons.mdiIcon('mdi:lightbulb') === null);
    const def = UI.entityIconDef('light', {attributes: {icon: 'mdi:lightbulb'}}, 'ha');
    check('Cfg: fallback na doménovou symbolic', !!def && !!def.iconName,
        JSON.stringify(def));
    check('Cfg: text režim bez ikony',
        UI.entityIconDef('light', null, 'text') === null);
    const defType = UI.entityIconDef('fan', null, 'type');
    check('Cfg: type režim = symbolic domény',
        defType && defType.iconName === 'weather-windy-symbolic');

    // vlastní název se uplatní i v řádku menu
    const ha = recorderHa();
    const r = UI.createHaRows('sensor.teplota', {
        entity_id: 'sensor.teplota', state: '21.5',
        attributes: {friendly_name: 'Teplota', unit_of_measurement: '°C'},
    }, ha, UI.mergeEntityConfig({name: 'Teplota ložnice'}, -1, 'ha'));
    const nameLbl = r.rows[0].children.find(c => c.x_expand === true);
    check('Cfg: vlastní název v menu', nameLbl && nameLbl.text === 'Teplota ložnice',
        nameLbl && nameLbl.text);
}

// ---- běh ----

async function main() {
    testUnits();
    for (const [name, fn] of [['Rows', testHaRows], ['Panel', testPanelEntities],
        ['Ma', testMaSection], ['Slider', testSliderRow], ['Cfg', testEntityConfig]]) {
        try {
            fn();
        } catch (e) {
            check(`${name}: fáze selhala`, false, `${e}\n${e.stack}`);
        }
    }
    try {
        await testIndicator();
    } catch (e) {
        check('Ind: fáze selhala', false, `${e}\n${e.stack}`);
    }
    try {
        await testIndicatorOffline();
    } catch (e) {
        check('OfflineUI: fáze selhala', false, `${e}\n${e.stack}`);
    }

    print('');
    if (failures === 0)
        print('VŠECHNY UI TESTY PROŠLY');
    else
        print(`SELHALO UI TESTŮ: ${failures}`);
    System.exit(failures === 0 ? 0 : 1);
}

GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
    main().catch(e => {
        print('CHYBA SUITY: ' + e);
        System.exit(1);
    });
    return GLib.SOURCE_REMOVE;
});
loop.run();
