// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 pvranik
//
/*
 * Widgety menu: sekce Music Assistant, řádky entit Home Assistant, stavový řádek.
 * GNOME Shell 42.
 */

const {Clutter, GLib, GObject, Pango, St} = imports.gi;
const PopupMenu = imports.ui.popupMenu;
const Slider = imports.ui.slider;
const BarLevel = imports.ui.barLevel;

const Me = imports.misc.extensionUtils.getCurrentExtension();
const MdiIcons = Me.imports.lib.icons;

// ---- ikony podle domény HA ----

const DOMAIN_ICONS = {
    sensor: 'utilities-system-monitor-symbolic',
    binary_sensor: 'dialog-information-symbolic',
    weather: 'weather-clear-symbolic',
    light: 'weather-clear-night-symbolic',
    switch: 'system-shutdown-symbolic',
    input_boolean: 'object-select-symbolic',
    input_number: 'preferences-system-symbolic',
    number: 'preferences-system-symbolic',
    input_select: 'open-menu-symbolic',
    select: 'open-menu-symbolic',
    input_text: 'text-x-generic-symbolic',
    input_button: 'media-playback-start-symbolic',
    button: 'media-playback-start-symbolic',
    script: 'media-playback-start-symbolic',
    scene: 'media-playback-start-symbolic',
    automation: 'preferences-system-symbolic',
    media_player: 'audio-x-generic-symbolic',
    fan: 'weather-windy-symbolic',
    cover: 'go-up-symbolic',
    vacuum: 'preferences-system-symbolic',
};

const TOGGLE_DOMAINS = new Set([
    'input_boolean', 'switch', 'light', 'fan', 'automation', 'cover', 'humidifier', 'siren',
]);

const RUN_SERVICES = {
    script: 'turn_on',
    scene: 'turn_on',
    button: 'press',
    input_button: 'press',
};

const SLIDER_DOMAINS = new Set(['input_number', 'number']);

const SELECT_DOMAINS = new Set(['input_select', 'select']);

// Výchozí MDI ikony domén HA (režim ikon "ha" bez vlastní ikony entity).
// Kompatibilní se sadou v icons/mdi (viz tools/fetch-mdi.py).
const MDI_DOMAIN_ICONS = {
    light: 'lightbulb',
    switch: 'light-switch',
    fan: 'fan',
    cover: 'window-shutter',
    climate: 'thermostat',
    humidifier: 'air-humidifier',
    siren: 'bullhorn',
    lock: 'lock',
    vacuum: 'robot-vacuum',
    media_player: 'speaker',
    sensor: 'eye',
    binary_sensor: 'checkbox-marked-circle',
    weather: 'weather-cloudy',
    scene: 'palette',
    script: 'script-text',
    automation: 'robot',
    button: 'gesture-tap-button',
    input_boolean: 'toggle-switch-variant',
    input_number: 'ray-vertex',
    input_select: 'format-list-bulleted',
    input_text: 'form-textbox',
    input_button: 'gesture-tap-button',
    number: 'ray-vertex',
    select: 'format-list-bulleted',
    text: 'form-textbox',
    camera: 'cctv',
    update: 'cloud-download',
    person: 'account',
    device_tracker: 'map-marker-radius',
    sun: 'weather-sunny',
    timer: 'timer-outline',
    counter: 'counter',
    calendar: 'calendar',
    water_heater: 'water-boiler',
    alarm_control_panel: 'shield-home',
};

/**
 * Sloučí globální nastavení entit s přepisem jedné entity (klíč
 * entity-configs). Přepis obsahuje jen přepsané položky.
 * @param overrides {object|null} přepis entity (JSON)
 * @param globalDecimals {number} globální value-decimals
 * @param globalIcon {string} globální entity-icon
 */
function mergeEntityConfig(overrides, globalDecimals, globalIcon) {
    const cfg = {
        decimals: typeof globalDecimals === 'number' ? globalDecimals : -1,
        icon: globalIcon === 'type' || globalIcon === 'text' ? globalIcon : 'ha',
        display: 'auto',
        name: '',
        min: null,
        max: null,
    };
    if (overrides) {
        if (Number.isInteger(overrides.decimals) &&
                overrides.decimals >= 0 && overrides.decimals <= 4)
            cfg.decimals = overrides.decimals;
        if (overrides.icon === 'ha' || overrides.icon === 'type' ||
                overrides.icon === 'text')
            cfg.icon = overrides.icon;
        if (overrides.display === 'auto' || overrides.display === 'icon' ||
                overrides.display === 'icon-value' || overrides.display === 'value')
            cfg.display = overrides.display;
        if (typeof overrides.name === 'string' && overrides.name.trim())
            cfg.name = overrides.name.trim();
        if (typeof overrides.min === 'number' && isFinite(overrides.min))
            cfg.min = overrides.min;
        if (typeof overrides.max === 'number' && isFinite(overrides.max))
            cfg.max = overrides.max;
    }
    return cfg;
}

/** Zobrazované jméno: vlastní název > friendly_name > entity_id. */
function displayName(entityId, stateObj, cfg) {
    if (cfg && cfg.name)
        return cfg.name;
    return (stateObj && stateObj.attributes && stateObj.attributes.friendly_name) || entityId;
}

/** Je hodnota mimo nastavené prahy? (barevné zvýraznění) */
function thresholdAlert(num, cfg) {
    if (!cfg || isNaN(num) || !isFinite(num))
        return false;
    if (cfg.min !== null && num < cfg.min)
        return true;
    if (cfg.max !== null && num > cfg.max)
        return true;
    return false;
}

/** HSV (h 0-360, s/v 0-1) -> [r,g,b] 0-255. */
function _hsvToRgb(h, s, v) {
    const f = n => {
        const k = (n + h / 60) % 6;
        return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    };
    const c = x => Math.round(Math.min(255, Math.max(0, x)));
    return [c(f(5) * 255), c(f(3) * 255), c(f(1) * 255)];
}

/** Barevná teplota (Kelvin) -> [r,g,b] (aproximace Tanner Helland). */
function _kelvinToRgb(k) {
    k = Math.min(40000, Math.max(1000, k)) / 100;
    let r, g, b;
    if (k <= 66) {
        r = 255;
        g = 99.4708025861 * Math.log(k) - 161.1195681661;
        b = k <= 19 ? 0 : 138.5177312231 * Math.log(k - 10) - 305.0447927307;
    } else {
        r = 329.698727446 * Math.pow(k - 60, -0.1332047592);
        g = 288.1221695283 * Math.pow(k - 60, -0.0755148492);
        b = 255;
    }
    const c = x => Math.round(Math.min(255, Math.max(0, x)));
    return [c(r), c(g), c(b)];
}

/**
 * Barva ikony světla podle stavu: zapnuto -> aktuální barva světla
 * (rgb_color/hs_color/color_temp), vypnuto/neznámě -> null (bílá).
 */
function lightIconColor(st) {
    if (!st || st.state !== 'on')
        return null;
    const a = st.attributes || {};
    const toHex = rgb => '#' + rgb.map(x => x.toString(16).padStart(2, '0')).join('');
    if (Array.isArray(a.rgb_color) && a.rgb_color.length >= 3) {
        const rgb = a.rgb_color.slice(0, 3).map(Number);
        if (rgb.every(x => isFinite(x)))
            return toHex(rgb);
    }
    if (Array.isArray(a.hs_color) && a.hs_color.length >= 2) {
        const [h, s] = a.hs_color.map(Number);
        if (isFinite(h) && isFinite(s))
            return toHex(_hsvToRgb(h, Math.min(100, Math.max(0, s)) / 100, 1));
    }
    let kelvin = null;
    if (typeof a.color_temp_kelvin === 'number')
        kelvin = a.color_temp_kelvin;
    else if (typeof a.color_temp === 'number' && a.color_temp > 0)
        kelvin = 1e6 / a.color_temp; // mired
    if (kelvin !== null && isFinite(kelvin))
        return toHex(_kelvinToRgb(kelvin));
    return null;
}

/**
 * Definice ikony entity podle režimu.
 * @returns {object|null} {gicon} pro MDI ze sady rozšíření, {iconName} pro
 *   symbolic ikonu theme, null pro režim "text".
 */
function entityIconDef(domain, stateObj, iconMode) {
    if (iconMode === 'text')
        return null;
    if (iconMode === 'ha') {
        const attrIcon = stateObj && stateObj.attributes && stateObj.attributes.icon;
        // světlo obarvené podle stavu (zapnuto = barva světla)
        const fill = domain === 'light' ? lightIconColor(stateObj) : null;
        let gicon = MdiIcons.mdiIcon(attrIcon, fill);
        if (!gicon && MDI_DOMAIN_ICONS[domain])
            gicon = MdiIcons.mdiIcon('mdi:' + MDI_DOMAIN_ICONS[domain], fill);
        if (gicon)
            return {gicon};
    }
    return {iconName: DOMAIN_ICONS[domain] || 'text-x-generic-symbolic'};
}

/**
 * St.Icon entity se sledováním změn (atribut icon se může změnit).
 * Velikost 18: MDI glyf zabírá ~83 % výšky SVG, takže vizuálně ~15 px
 * = výška textu v panelu. Bez y_align - ikona se řadí shora stejně
 * jako text (y_align CENTER ji naopak posouvá pod textovou linku).
 * POZOR: gicon/icon_name se musí přiřadit PO konstrukci - v params
 * konstruktoru St.Icon je GJS 1.72 tiše zahodí (ikon pak má 0x0).
 */
function makeEntityIcon(domain, stateObj, iconMode, size) {
    const first = entityIconDef(domain, stateObj, iconMode);
    const icon = new St.Icon({icon_size: size});
    if (first && first.gicon)
        icon.gicon = first.gicon;
    else if (first && first.iconName)
        icon.icon_name = first.iconName;
    let lastDef = first;
    const sync = st => {
        const def = entityIconDef(domain, st, iconMode);
        // mdiIcon cachuje gicony - shoda instancí znamená beze změny
        // (nastavovat gicon dodatečně jen když se ikona opravdu mění)
        if (def === lastDef ||
                (def && lastDef && def.gicon === lastDef.gicon &&
                 def.iconName === lastDef.iconName))
            return;
        lastDef = def;
        if (def && def.gicon) {
            icon.gicon = def.gicon;
            icon.icon_name = null;
        } else if (def) {
            icon.gicon = null;
            icon.icon_name = def.iconName;
        } else {
            icon.gicon = null;
            icon.icon_name = null;
        }
    };
    sync(stateObj);
    return {icon, sync};
}

const STATE_CS = {
    on: 'zapnuto',
    off: 'vypnuto',
    unavailable: 'nedostupné',
    unknown: 'neznámé',
    idle: 'nečinné',
    playing: 'hraje',
    paused: 'pozastaveno',
    standby: 'pohotovost',
    open: 'otevřeno',
    opening: 'otevírá se',
    closed: 'zavřeno',
    closing: 'zavírá se',
    home: 'doma',
    'not_home': 'pryč',
};

function humanState(state) {
    if (state === null || state === undefined)
        return 'nedostupné';
    return STATE_CS[state] || state;
}

function formatTime(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds));
    const sec = s % 60;
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0)
        return `${h}:${String(m % 60).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    return `${m}:${String(sec).padStart(2, '0')}`;
}

// ---- pomocné widgety ----

function iconButton(icon, onClick, extraStyle) {
    const btn = new St.Button({
        can_focus: true,
        style_class: `hmass-ctrl-btn ${extraStyle || ''}`,
    });
    const iconParams = {icon_size: 16};
    if (typeof icon === 'string')
        iconParams.icon_name = icon;
    else if (icon)
        iconParams.gicon = icon;
    btn.child = new St.Icon(iconParams);
    btn.connect('clicked', onClick);
    return btn;
}

function sectionHeader(title, onLaunch, icon, tooltip) {
    const item = new PopupMenu.PopupBaseMenuItem({
        reactive: false,
        activate: false,
        hover: false,
        can_focus: false,
        style_class: 'hmass-section-header',
    });
    const label = new St.Label({
        text: title,
        style_class: 'popup-subtitle-menu-item',
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
    item.add_child(label);

    if (typeof onLaunch === 'function') {
        const btn = iconButton(icon, onLaunch, 'hmass-launch-btn');
        if (tooltip && typeof btn.set_tooltip_text === 'function')
            btn.set_tooltip_text(tooltip);
        item.add_child(btn);
    }
    return item;
}

function _ellipsize(label) {
    if (label.clutter_text)
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
}

function _nonReactiveRow(styleClass) {
    return new PopupMenu.PopupBaseMenuItem({
        reactive: false,
        activate: false,
        hover: false,
        can_focus: false,
        style_class: styleClass || 'hmass-ha-row',
    });
}

/**
 * Řádek se sliderem: popisek | slider | hodnota.
 * Signál 'changed(value0..1)' se emituje po dokončení tažení / scrollu.
 */
var SliderRow = GObject.registerClass({
    Signals: {'changed': {param_types: [GObject.TYPE_DOUBLE]}},
}, class SliderRow extends PopupMenu.PopupBaseMenuItem {
    _init(labelText, value, params) {
        super._init(Object.assign({
            reactive: true,
            activate: false,
            hover: true,
            can_focus: true,
            style_class: 'hmass-slider-row',
        }, params || {}));
        this._dragging = false;
        this._updating = false;
        this._commitId = 0;

        this.label = new St.Label({text: labelText || ''});
        this.label.x_expand = false;
        this.label.y_align = Clutter.ActorAlign.CENTER;
        if (!labelText)
            this.label.visible = false;
        _ellipsize(this.label);

        this.slider = new Slider.Slider(value === undefined ? 0 : value);
        this.slider.x_expand = true;
        this.valueLabel = new St.Label({
            text: '',
            style_class: 'hmass-slider-value',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this.add_child(this.label);
        this.add_child(this.slider);
        this.add_child(this.valueLabel);

        this.slider.connect('drag-begin', () => {
            this._dragging = true;
        });
        this.slider.connect('drag-end', () => {
            this._dragging = false;
            this._commit();
        });
        this.slider.connect('notify::value', () => {
            // programatické nastavení (ze serveru) nesmí vyvolat odeslání příkazu
            if (this._dragging || this._updating)
                return;
            this._commitSoon();
        });

        this.connect('scroll-event', (actor, event) => {
            const direction = event.get_scroll_direction();
            let delta = 0;
            if (direction === Clutter.ScrollDirection.UP)
                delta = 0.05;
            else if (direction === Clutter.ScrollDirection.DOWN)
                delta = -0.05;
            else if (direction === Clutter.ScrollDirection.SMOOTH) {
                const [, dy] = event.get_scroll_delta();
                delta = -dy * 0.05;
            }
            if (delta !== 0) {
                const nv = Math.min(1, Math.max(0, this.slider.value + delta));
                this.setValue(nv);
                this._commitSoon();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _commit() {
        this.emit('changed', this.slider.value);
    }

    /** Scroll na slideru nespouští drag-end, proto krátký debounce. */
    _commitSoon() {
        if (this._commitId)
            GLib.source_remove(this._commitId);
        this._commitId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            this._commitId = 0;
            if (!this._dragging)
                this._commit();
            return GLib.SOURCE_REMOVE;
        });
    }

    setValue(v) {
        if (this._dragging)
            return;
        this._updating = true;
        try {
            this.slider.value = Math.min(1, Math.max(0, v));
        } finally {
            this._updating = false;
        }
    }

    get dragging() {
        return this._dragging;
    }

    destroy() {
        if (this._commitId) {
            GLib.source_remove(this._commitId);
            this._commitId = 0;
        }
        this._dragging = false;
        super.destroy();
    }

    setDisplay(text) {
        this.valueLabel.text = text;
    }

    setLabel(text) {
        this.label.text = text;
    }
});

/**
 * Odlehčený pouze pro čtení (readonly) řádek s průběhem přehrávání:
 * tenký ukazatel pozice + textový čas (uplynulý / celkový).
 */
var ProgressRow = GObject.registerClass(
class ProgressRow extends PopupMenu.PopupBaseMenuItem {
    _init(params) {
        super._init(Object.assign({
            reactive: false,
            activate: false,
            hover: false,
            can_focus: false,
            style_class: 'hmass-progress-row',
        }, params || {}));

        this.bar = new BarLevel.BarLevel({
            style_class: 'hmass-progress-bar',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this.valueLabel = new St.Label({
            text: '',
            style_class: 'hmass-time-label',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this.add_child(this.bar);
        this.add_child(this.valueLabel);
    }

    setValue(v) {
        this.bar.value = Math.min(1, Math.max(0, v));
    }

    setDisplay(text) {
        this.valueLabel.text = text;
    }
});

// ---- řádky Home Assistant ----

function _displayRow(entityId, stateObj, cfg) {
    if (!cfg)
        cfg = mergeEntityConfig(null, -1, 'ha');
    const domain = entityId.split('.')[0];
    const row = _nonReactiveRow();
    const ic = makeEntityIcon(domain, stateObj, cfg.icon, 16);
    const name = new St.Label({text: ''});
    name.x_expand = true;
    name.y_align = Clutter.ActorAlign.CENTER;
    _ellipsize(name);
    const value = new St.Label({
        style_class: 'hmass-ha-value',
        y_align: Clutter.ActorAlign.CENTER,
    });
    row.add_child(ic.icon);
    row.add_child(name);
    row.add_child(value);

    const update = st => {
        ic.sync(st);
        if (!st) {
            name.text = displayName(entityId, null, cfg);
            value.text = 'nedostupné';
            value.style_class = 'hmass-ha-value';
            return;
        }
        name.text = displayName(entityId, st, cfg);
        const unit = st.attributes && st.attributes.unit_of_measurement;
        const num = parseFloat(st.state);
        if (!isNaN(num) && isFinite(num)) {
            const txt = formatNumericState(st, cfg.decimals);
            value.text = unit ? `${txt} ${unit}` : txt;
            value.style_class = thresholdAlert(num, cfg)
                ? 'hmass-ha-value hmass-value-alert' : 'hmass-ha-value';
        } else {
            value.text = unit ? `${st.state} ${unit}` : humanState(st.state);
            value.style_class = 'hmass-ha-value';
        }
    };
    update(stateObj);
    return {row, update};
}

/**
 * Vytvoří řádky pro entitu HA. Vrací {rows, update(stateObj|null)}.
 * Ovládací prvek se volí automaticky podle domény entity.
 */
function createHaRows(entityId, stateObj, ha, cfg) {
    if (!cfg)
        cfg = mergeEntityConfig(null, -1, 'ha');
    const domain = entityId.split('.')[0];
    const rows = [];
    const updaters = [];
    const name = st => displayName(entityId, st, cfg);

    // ikona entity pred nadpis radku (preskočí se v režimu "text");
    // vrací sync pro aktualizaci v updateru
    const prependEntityIcon = item => {
        if (entityIconDef(domain, stateObj, cfg.icon) === null)
            return null;
        const ic = makeEntityIcon(domain, stateObj, cfg.icon, 16);
        item.insert_child_at_index(ic.icon, 0);
        return ic.sync;
    };

    // 1) hlavní ovládací prvek podle domény
    if (TOGGLE_DOMAINS.has(domain)) {
        const sw = new PopupMenu.PopupSwitchMenuItem(name(stateObj), !!stateObj && stateObj.state === 'on');
        sw.connect('toggled', () => ha.callService(domain, 'toggle', {entity_id: entityId}));
        const iconSync = prependEntityIcon(sw);
        rows.push(sw);
        updaters.push(st => {
            sw.label.text = name(st);
            sw.setToggleState(!!st && st.state === 'on');
            if (iconSync)
                iconSync(st);
        });
    } else if (RUN_SERVICES[domain]) {
        const item = new PopupMenu.PopupMenuItem(name(stateObj));
        item.connect('activate', () => ha.callService(domain, RUN_SERVICES[domain], {entity_id: entityId}));
        const iconSync = prependEntityIcon(item);
        rows.push(item);
        updaters.push(st => {
            item.label.text = name(st);
            if (iconSync)
                iconSync(st);
        });
    } else if (SLIDER_DOMAINS.has(domain)) {
        const attrs = (stateObj && stateObj.attributes) || {};
        const min = typeof attrs.min === 'number' ? attrs.min : 0;
        const max = typeof attrs.max === 'number' ? attrs.max : 100;
        const step = typeof attrs.step === 'number' && attrs.step > 0 ? attrs.step : 1;
        const range = Math.max(0.000001, max - min);
        const value = parseFloat(stateObj ? stateObj.state : NaN);
        const norm = v => (v - min) / range;
        const real = v => min + v * range;
        const dec = Math.max(0, Math.min(3, -Math.floor(Math.log10(step) + 1e-9)));
        const fmt = v => Number(v).toFixed(dec);
        const sl = new SliderRow(name(stateObj), norm(isNaN(value) ? min : value));
        const iconSync = prependEntityIcon(sl);
        sl.connect('changed', (row, v) => {
            ha.callService(domain, 'set_value', {
                entity_id: entityId,
                value: Number(real(v).toFixed(3)),
            });
        });
        rows.push(sl);
        updaters.push(st => {
            sl.setLabel(name(st));
            if (iconSync)
                iconSync(st);
            const val = parseFloat(st ? st.state : NaN);
            if (!isNaN(val)) {
                sl.setValue(norm(val));
                const unit = st.attributes && st.attributes.unit_of_measurement;
                sl.setDisplay(fmt(val) + (unit ? ` ${unit}` : ''));
            } else {
                sl.setDisplay(humanState(st ? st.state : null));
            }
        });
    } else if (SELECT_DOMAINS.has(domain)) {
        const sub = new PopupMenu.PopupSubMenuMenuItem(name(stateObj));
        const iconSync = prependEntityIcon(sub);
        const syncOptions = st => {
            const options = (st && st.attributes && st.attributes.options) || [];
            const current = st ? String(st.state) : null;
            sub.menu.removeAll();
            options.forEach(opt => {
                const it = new PopupMenu.PopupMenuItem(String(opt));
                it.connect('activate', () => {
                    ha.callService(domain, 'select_option', {
                        entity_id: entityId,
                        option: opt,
                    });
                });
                if (current !== null && String(opt) === current)
                    it.setOrnament(PopupMenu.Ornament.DOT);
                sub.menu.addMenuItem(it);
            });
        };
        syncOptions(stateObj);
        rows.push(sub);
        updaters.push(st => {
            sub.label.text = name(st);
            if (iconSync)
                iconSync(st);
            syncOptions(st);
        });
    } else if (domain === 'input_text') {
        const row = _nonReactiveRow();
        const lbl = new St.Label({text: name(stateObj)});
        lbl.x_expand = true;
        lbl.y_align = Clutter.ActorAlign.CENTER;
        _ellipsize(lbl);
        const iconSync = prependEntityIcon(row);
        const entry = new St.Entry({
            hint_text: 'text…',
            can_focus: true,
            track_hover: true,
            style_class: 'hmass-entry',
            y_align: Clutter.ActorAlign.CENTER,
        });
        if (stateObj && stateObj.state)
            entry.text = stateObj.state;
        entry.clutter_text.connect('activate', () => {
            ha.callService('input_text', 'set_value', {entity_id: entityId, value: entry.text});
        });
        row.add_child(lbl);
        row.add_child(entry);
        rows.push(row);
        updaters.push(st => {
            lbl.text = name(st);
            if (iconSync)
                iconSync(st);
            if (st && st.state && entry.text !== st.state && !entry.clutter_text.has_key_focus)
                entry.text = st.state;
        });
    } else {
        const d = _displayRow(entityId, stateObj, cfg);
        rows.push(d.row);
        updaters.push(d.update);
    }

    // 2) doplňkové posuvníky (nezávisle na přepínači výše)
    const attrs = (stateObj && stateObj.attributes) || {};
    if (domain === 'light' && typeof attrs.brightness === 'number') {
        const sl = new SliderRow('Jas', attrs.brightness / 255);
        sl.setDisplay(`${Math.round(attrs.brightness / 255 * 100)} %`);
        sl.connect('changed', (row, v) => {
            ha.callService('light', 'turn_on', {
                entity_id: entityId,
                brightness: Math.round(v * 255),
            });
        });
        rows.push(sl);
        updaters.push(st => {
            if (st && typeof st.attributes.brightness === 'number') {
                sl.setValue(st.attributes.brightness / 255);
                sl.setDisplay(`${Math.round(st.attributes.brightness / 255 * 100)} %`);
            }
        });
    } else if (domain === 'media_player' && typeof attrs.volume_level === 'number') {
        const sl = new SliderRow('Hlasitost', attrs.volume_level);
        sl.setDisplay(`${Math.round(attrs.volume_level * 100)} %`);
        sl.connect('changed', (row, v) => {
            ha.callService('media_player', 'volume_set', {
                entity_id: entityId,
                volume_level: Math.round(v * 100) / 100,
            });
        });
        rows.push(sl);
        updaters.push(st => {
            if (st && typeof st.attributes.volume_level === 'number') {
                sl.setValue(st.attributes.volume_level);
                sl.setDisplay(`${Math.round(st.attributes.volume_level * 100)} %`);
            }
        });
    } else if (domain === 'cover' && typeof attrs.current_position === 'number') {
        const sl = new SliderRow('Pozice', attrs.current_position / 100);
        sl.setDisplay(`${Math.round(attrs.current_position)} %`);
        sl.connect('changed', (row, v) => {
            ha.callService('cover', 'set_cover_position', {
                entity_id: entityId,
                position: Math.round(v * 100),
            });
        });
        rows.push(sl);
        updaters.push(st => {
            if (st && typeof st.attributes.current_position === 'number') {
                sl.setValue(st.attributes.current_position / 100);
                sl.setDisplay(`${Math.round(st.attributes.current_position)} %`);
            }
        });
    }

    if (rows.length === 0) {
        const d = _displayRow(entityId, stateObj, cfg);
        rows.push(d.row);
        updaters.push(d.update);
    }

    return {
        rows,
        update(st) {
            for (const u of updaters)
                u(st);
        },
    };
}

/**
 * Formát číselného stavu entity s počtem desetinných míst.
 * @param decimals -1 = automaticky (atribut suggested_display_precision,
 *   bez něj max 2 desetinná místa s ořezem koncových nul),
 *   jinak 0-4 = pevný počet desetinných míst.
 */
function formatNumericState(stateObj, decimals) {
    const raw = stateObj.state;
    const num = parseFloat(raw);
    if (isNaN(num) || !isFinite(num))
        return String(raw);
    if (typeof decimals === 'number' && decimals >= 0)
        return num.toFixed(Math.min(4, Math.floor(decimals)));
    const sugg = stateObj.attributes && stateObj.attributes.suggested_display_precision;
    if (Number.isInteger(sugg) && sugg >= 0 && sugg <= 4)
        return num.toFixed(sugg);
    // auto bez doporučení entity: nejvýše 2 desetinná místa, bez koncových nul
    let txt = num.toFixed(2);
    if (txt.indexOf('.') >= 0)
        txt = txt.replace(/0+$/, '').replace(/\.$/, '');
    return txt;
}

/** Kompaktní text hodnoty entity pro horní lištu. */
function panelValueText(stateObj, decimals) {
    if (!stateObj)
        return '—';
    const unit = stateObj.attributes && stateObj.attributes.unit_of_measurement;
    const value = formatNumericState(stateObj, decimals);
    return unit ? `${value} ${unit}` : value;
}

// ---- entity v horní liště: interaktivní widgety + tooltip ----

const TIP_DELAY_MS = 350;
let _tipLabel = null;
let _tipOwner = null;
let _tipShowId = 0;

function _hidePanelTooltip() {
    if (_tipShowId) {
        GLib.source_remove(_tipShowId);
        _tipShowId = 0;
    }
    if (_tipLabel)
        _tipLabel.hide();
    _tipOwner = null;
}

function _showPanelTooltip(actor, text) {
    if (!text)
        return;
    let monitor = null;
    let uiGroup = null;
    try {
        const Main = imports.ui.main;
        uiGroup = Main.layoutManager && Main.layoutManager.uiGroup;
        if (uiGroup && Main.layoutManager.findMonitorForActor)
            monitor = Main.layoutManager.findMonitorForActor(actor);
    } catch (e) {
        return;
    }
    if (!uiGroup)
        return;
    if (!_tipLabel) {
        _tipLabel = new St.Label({style_class: 'hmass-tooltip'});
        _tipLabel.hide();
    }
    _tipLabel.text = text;
    if (!_tipLabel.get_parent())
        uiGroup.add_child(_tipLabel);
    _tipLabel.show();
    _tipOwner = actor;

    // pozice: nad widget, pokud by pod ním nebylo místo (panel dole),
    // jinak pod widgetem (panel nahoře); horizontálně centrované
    const [ax, ay] = actor.get_transformed_position();
    const aw = actor.width || 0;
    const ah = actor.height || 0;
    const [, natW] = _tipLabel.get_preferred_width(-1);
    const [, natH] = _tipLabel.get_preferred_height(-1);
    let ty = Math.round(ay + ah + 8);
    if (monitor && ty + natH > monitor.y + monitor.height)
        ty = Math.round(ay - natH - 8);
    const tx = Math.max(4, Math.round(ax + aw / 2 - natW / 2));
    _tipLabel.set_position(tx, ty);
}

/**
 * Název (a stav) entity při najetí myší v liště.
 * Používá track_hover + notify::hover - stejné rozhraní, kterým GNOME Shell
 * řeší tooltipy ikon aplikací (enter-event uvnitř panelového tlačítka
 * se k potomkům nedostává spolehlivě).
 */
function attachPanelTooltip(actor, getText) {
    actor.reactive = true;
    actor.track_hover = true;
    actor.connect('notify::hover', () => {
        if (actor.hover) {
            _hidePanelTooltip();
            _tipShowId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TIP_DELAY_MS, () => {
                _tipShowId = 0;
                let txt = '';
                try {
                    txt = getText() || '';
                } catch (e) {
                    txt = '';
                }
                _showPanelTooltip(actor, txt);
                return GLib.SOURCE_REMOVE;
            });
        } else {
            _hidePanelTooltip();
        }
    });
    actor.connect('destroy', () => {
        if (_tipOwner === actor)
            _hidePanelTooltip();
    });
}

/** Skryje zobrazený panelový tooltip (např. při vypnutí rozšíření). */
function hidePanelTooltip() {
    _hidePanelTooltip();
}

/**
 * Widget entity přímo v horní liště. Podle domény vrací ovladatelný prvek
 * (přepínač, tlačítko, číslo měněné kolečkem, výběr, textové pole),
 * jinde jen hodnotu. Vrací {actor, update(stateObj|null)}.
 */
function createPanelEntity(entityId, stateObj, ha, cfg) {
    if (!cfg)
        cfg = mergeEntityConfig(null, -1, 'ha');
    const domain = entityId.split('.')[0];
    const name = st => displayName(entityId, st, cfg);
    let last = stateObj || null;

    // Ikona pro panel: posun 5 px nahoru - ikona se v řádku centruje na
    // střed linky, ale číslice (bez descenderů) mají vizuální střed výš;
    // bez posunu působí ikona, jako by visela pod textem
    const mkPanelIcon = () => {
        const ic = makeEntityIcon(domain, stateObj, cfg.icon, 18);
        ic.icon.translation_y = -5;
        return ic;
    };

    // styl hodnoty podle prahů (společné pro všechny větve s hodnotou)
    const valueClass = st => {
        const num = st ? parseFloat(st.state) : NaN;
        return thresholdAlert(num, cfg)
            ? 'hmass-panel-value hmass-value-alert' : 'hmass-panel-value';
    };

    let actor;
    let update;

    if (TOGGLE_DOMAINS.has(domain)) {
        const btn = new St.Button({can_focus: false, style_class: 'hmass-panel-btn'});
        const ic = mkPanelIcon();
        const stateLabel = new St.Label({style_class: 'hmass-panel-value'});
        if (cfg.display === 'value') {
            // textový přepínač: krátký text stavu místo ikony
            btn.set_child(stateLabel);
        } else {
            // ikona přes BoxLayout: gicon FileIcon jako přímý potomek
            // St.Button se na shellu 42 nevykreslí
            const box = new St.BoxLayout({style_class: 'hmass-panel-select'});
            box.add_child(ic.icon);
            if (cfg.display === 'icon-value')
                box.add_child(stateLabel);
            btn.set_child(box);
        }
        btn.connect('clicked', () =>
            ha.callService(domain, 'toggle', {entity_id: entityId}));
        actor = btn;
        update = st => {
            last = st || null;
            const dead = !st || st.state === 'unavailable' || st.state === 'unknown';
            ic.sync(st);
            // zapnuto plná barva/opacity, vypnuto zřetelně tlumené,
            // nedostupné téměř neviditelné
            ic.icon.opacity = dead ? 60 : (st.state === 'on' ? 255 : 115);
            if (cfg.display === 'value' || cfg.display === 'icon-value') {
                stateLabel.text = dead ? '—' : humanState(st.state);
                stateLabel.opacity = dead ? 40 : 255;
            }
        };
        attachPanelTooltip(btn, () =>
            `${name(last)} — ${humanState(last ? last.state : null)} (klik přepne)`);
    } else if (RUN_SERVICES[domain]) {
        const btn = new St.Button({can_focus: false, style_class: 'hmass-panel-btn'});
        const ic = mkPanelIcon();
        const runBox = new St.BoxLayout({style_class: 'hmass-panel-select'});
        runBox.add_child(ic.icon);
        btn.set_child(runBox);
        btn.connect('clicked', () =>
            ha.callService(domain, RUN_SERVICES[domain], {entity_id: entityId}));
        actor = btn;
        update = st => {
            last = st || null;
            ic.sync(st);
        };
        attachPanelTooltip(btn, () => `${name(last)} (klik spustí)`);
    } else if (SLIDER_DOMAINS.has(domain)) {
        const attrs0 = (stateObj && stateObj.attributes) || {};
        const min = typeof attrs0.min === 'number' ? attrs0.min : 0;
        const max = typeof attrs0.max === 'number' ? attrs0.max : 100;
        const step = typeof attrs0.step === 'number' && attrs0.step > 0 ? attrs0.step : 1;
        const dec = Math.max(0, Math.min(3, -Math.floor(Math.log10(step) + 1e-9)));
        const box = new St.BoxLayout({reactive: true, style_class: 'hmass-panel-slider'});
        const ic = mkPanelIcon();
        const label = new St.Label({style_class: 'hmass-panel-value'});
        if (cfg.display !== 'value') {
            box.add_child(ic.icon);
            ic.icon.opacity = 200;
        }
        box.add_child(label);
        let current = parseFloat(stateObj ? stateObj.state : NaN);
        box.connect('scroll-event', (w, event) => {
            const dir = event.get_scroll_direction();
            let delta = 0;
            if (dir === Clutter.ScrollDirection.UP)
                delta = 1;
            else if (dir === Clutter.ScrollDirection.DOWN)
                delta = -1;
            else if (dir === Clutter.ScrollDirection.SMOOTH)
                delta = event.get_scroll_delta()[1] < 0 ? 1 : -1;
            if (delta !== 0 && !isNaN(current)) {
                current = Math.min(max, Math.max(min, current + delta * step));
                ha.callService(domain, 'set_value', {
                    entity_id: entityId,
                    value: Number(current.toFixed(dec)),
                });
            }
            return Clutter.EVENT_STOP;
        });
        actor = box;
        update = st => {
            last = st || null;
            const v = parseFloat(st ? st.state : NaN);
            if (!isNaN(v))
                current = v;
            ic.sync(st);
            label.text = panelValueText(st, cfg.decimals);
            label.style_class = valueClass(st);
        };
        attachPanelTooltip(box, () =>
            `${name(last)} — ${panelValueText(last, cfg.decimals)} (kolečko mění hodnotu)`);
    } else if (SELECT_DOMAINS.has(domain)) {
        const btn = new St.Button({can_focus: false, style_class: 'hmass-panel-btn'});
        const box = new St.BoxLayout({style_class: 'hmass-panel-select'});
        const ic = mkPanelIcon();
        const label = new St.Label({style_class: 'hmass-panel-value'});
        if (cfg.display !== 'icon')
            box.add_child(label);
        if (cfg.display !== 'value')
            box.add_child(ic.icon);
        btn.set_child(box);
        btn.connect('clicked', () => {
            const options = (last && last.attributes && last.attributes.options) || [];
            if (options.length === 0 || !last)
                return;
            const idx = options.findIndex(o => String(o) === String(last.state));
            const next = options[(idx + 1 + options.length) % options.length];
            ha.callService(domain, 'select_option', {entity_id: entityId, option: next});
        });
        actor = btn;
        update = st => {
            last = st || null;
            ic.sync(st);
            label.text = st ? String(st.state) : '—';
        };
        attachPanelTooltip(btn, () =>
            `${name(last)} — ${last ? last.state : '—'} (klik přepne volbu)`);
    } else if (domain === 'input_text') {
        const entry = new St.Entry({
            can_focus: true,
            hint_text: 'text…',
            style_class: 'hmass-panel-entry',
        });
        if (stateObj && stateObj.state)
            entry.text = stateObj.state;
        entry.clutter_text.connect('activate', () =>
            ha.callService('input_text', 'set_value', {entity_id: entityId, value: entry.text}));
        actor = entry;
        update = st => {
            last = st || null;
            if (st && st.state && entry.text !== st.state && !entry.clutter_text.has_key_focus)
                entry.text = st.state;
        };
        attachPanelTooltip(entry, () => name(last));
    } else {
        // senzory a ostatní: text hodnoty, volitelně s ikonou entity
        const label = new St.Label({text: '—', style_class: 'hmass-panel-value'});
        if (cfg.display === 'icon') {
            const ic = mkPanelIcon();
            ic.icon.opacity = 220;
            actor = ic.icon;
            update = st => {
                last = st || null;
                ic.sync(st);
            };
            attachPanelTooltip(actor, () =>
                `${name(last)} — ${panelValueText(last, cfg.decimals)}`);
        } else if (cfg.display === 'icon-value') {
            const box = new St.BoxLayout({style_class: 'hmass-panel-select'});
            const ic = mkPanelIcon();
            box.add_child(ic.icon);
            box.add_child(label);
            actor = box;
            update = st => {
                last = st || null;
                ic.sync(st);
                label.text = panelValueText(st, cfg.decimals);
                label.style_class = valueClass(st);
            };
            attachPanelTooltip(box, () => name(last));
        } else {
            actor = label;
            update = st => {
                last = st || null;
                label.text = panelValueText(st, cfg.decimals);
                label.style_class = valueClass(st);
            };
            attachPanelTooltip(label, () => name(last));
        }
    }

    update(stateObj);
    return {actor, update};
}

// ---- sekce Music Assistant ----

var MaSection = class MaSection {
    /**
     * @param client MAClient
     * @param settings Gio.Settings
     */
    constructor(client, settings) {
        this.client = client;
        this.settings = settings;
        this.onPlayerPicked = null; // (playerId) => void

        this.items = [];
        this.playerSelector = null;
        this.titleLabel = null;
        this.subLabel = null;
        this.playBtn = null;
        this.shuffleBtn = null;
        this.repeatBtn = null;
        this.seekRow = null;
        this.volumeRow = null;
        this.muteBtn = null;
        this._lastPlayersSig = '';
        this._lastDjSig = '';

        this._build();
    }

    _build() {
        if (this.settings.get_boolean('ma-show-player-selector')) {
            this.playerSelector = new PopupMenu.PopupSubMenuMenuItem('Přehrávač');
            this.items.push(this.playerSelector);
        }

        if (this.settings.get_boolean('ma-show-dj-selector')) {
            this.djSelector = new PopupMenu.PopupSubMenuMenuItem('AI Radio DJ');
            this.items.push(this.djSelector);
        }

        const titleRow = _nonReactiveRow('hmass-track-row');
        const box = new St.BoxLayout({vertical: true, x_expand: true});
        this.titleLabel = new St.Label({style_class: 'hmass-track-title'});
        this.titleLabel.x_expand = true;
        _ellipsize(this.titleLabel);
        this.subLabel = new St.Label({style_class: 'hmass-track-sub'});
        this.subLabel.x_expand = true;
        _ellipsize(this.subLabel);
        box.add_child(this.titleLabel);
        box.add_child(this.subLabel);
        titleRow.add_child(box);
        this.items.push(titleRow);

        const showTransport = this.settings.get_boolean('ma-show-transport');
        const showSeek = this.settings.get_boolean('ma-show-seek');

        if (showTransport && showSeek) {
            // tlačítka přehrávání a průběh na jednom řádku
            this.seekRow = new ProgressRow({style_class: 'hmass-progress-row hmass-progress-combined'});
            this.seekRow.insert_child_at_index(this._buildTransportButtons(), 0);
            this.items.push(this.seekRow);
        } else if (showTransport) {
            const tRow = _nonReactiveRow('hmass-track-row');
            const tBox = this._buildTransportButtons();
            tBox.x_align = Clutter.ActorAlign.CENTER;
            tBox.x_expand = true;
            tRow.add_child(tBox);
            this.items.push(tRow);
        } else if (showSeek) {
            this.seekRow = new ProgressRow();
            this.items.push(this.seekRow);
        }

        if (this.settings.get_boolean('ma-show-volume')) {
            this.volumeRow = new SliderRow('', 0);
            this.volumeRow.connect('changed', (row, v) => {
                this.client.setVolume(v * 100);
            });
            this.muteBtn = iconButton('audio-volume-high-symbolic', () => {
                const p = this.client.activePlayer;
                this.client.setMuted(!(p && p.volume_muted));
            });
            this.volumeRow.insert_child_at_index(this.muteBtn, 0);
            this.items.push(this.volumeRow);
        }
    }

    /** Box s tlačítky přehrávání (shuffle, prev, play, next, stop, repeat). */
    _buildTransportButtons() {
        const tBox = new St.BoxLayout({style_class: 'hmass-ctrl-box'});
        const advanced = this.settings.get_boolean('ma-show-shuffle-repeat');
        if (advanced) {
            this.shuffleBtn = iconButton('media-playlist-shuffle-symbolic', () => {
                const q = this.client.queue;
                this.client.setShuffle(!(q && q.shuffle_enabled));
            });
            tBox.add_child(this.shuffleBtn);
        }
        tBox.add_child(iconButton('media-skip-backward-symbolic', () => this.client.previous()));
        this.playBtn = iconButton('media-playback-start-symbolic',
            () => this.client.playPause(), 'hmass-ctrl-btn-play');
        tBox.add_child(this.playBtn);
        tBox.add_child(iconButton('media-skip-forward-symbolic', () => this.client.next()));
        tBox.add_child(iconButton('media-playback-stop-symbolic', () => this.client.stop()));
        if (advanced) {
            this.repeatBtn = iconButton('media-playlist-repeat-symbolic', () => {
                const mode = this.client.queue ? this.client.queue.repeat_mode : 'off';
                const nextMode = mode === 'off' ? 'all' : (mode === 'all' ? 'one' : 'off');
                this.client.setRepeat(nextMode);
            });
            tBox.add_child(this.repeatBtn);
        }
        return tBox;
    }

    /** Aktualizace podle stavu klienta. */
    update() {
        const c = this.client;
        const player = c.activePlayer;
        const q = c.queue;

        if (this.playerSelector) {
            this.playerSelector.label.text = player ? player.name : 'Žádný přehrávač';
            // podmenu se přestavuje jen při změně seznamu, aby se nezavíralo
            // pod rukama (update() běží i každý sekundový tick pozice)
            const sig = `${c.activePlayerId}#${c.players.map(p => `${p.player_id}:${p.name}`).join('|')}`;
            if (sig !== this._lastPlayersSig) {
                this._lastPlayersSig = sig;
                const menu = this.playerSelector.menu;
                menu.removeAll();
                for (const p of c.players) {
                    const it = new PopupMenu.PopupMenuItem(p.name || p.player_id);
                    it.connect('activate', () => {
                        c.setActivePlayer(p.player_id);
                        if (this.onPlayerPicked)
                            this.onPlayerPicked(p.player_id);
                    });
                    if (p.player_id === c.activePlayerId)
                        it.setOrnament(PopupMenu.Ornament.DOT);
                    menu.addMenuItem(it);
                }
            }
        }

        if (this.djSelector) {
            const hosts = c.djHosts || [];
            const queueId = q ? q.queue_id : '';
            const activeHostId = queueId && c.queueDjStatus ? c.queueDjStatus[queueId] : null;
            const activeName = activeHostId
                ? ((hosts.find(h => h.id === activeHostId) || {}).name || activeHostId)
                : null;
            this.djSelector.label.text = activeName ? `AI Radio DJ: ${activeName}` : 'AI Radio DJ';
            // podmenu se přestavuje jen při změně (update() běží i každý sekundový tick)
            const sig = `${queueId}#${hosts.map(h => `${h.id}:${h.name}`).join('|')}#${activeHostId}`;
            if (sig !== this._lastDjSig) {
                this._lastDjSig = sig;
                const menu = this.djSelector.menu;
                menu.removeAll();
                if (queueId) {
                    const offItem = new PopupMenu.PopupMenuItem('Vypnout');
                    offItem.connect('activate', () => c.setDjHost(queueId, null));
                    if (!activeHostId)
                        offItem.setOrnament(PopupMenu.Ornament.DOT);
                    menu.addMenuItem(offItem);
                    if (hosts.length > 0)
                        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                    for (const h of hosts) {
                        const it = new PopupMenu.PopupMenuItem(h.name || h.id);
                        it.connect('activate', () => c.setDjHost(queueId, h.id));
                        if (h.id === activeHostId)
                            it.setOrnament(PopupMenu.Ornament.DOT);
                        menu.addMenuItem(it);
                    }
                }
            }
        }

        const info = c.trackInfo();
        this.titleLabel.text = info.title || 'Nic se nepřehrává';
        this.subLabel.text = [info.artist, info.album].filter(Boolean).join(' – ');

        if (this.playBtn) {
            const playing = !!q && q.state === 'playing';
            this.playBtn.child.icon_name = playing
                ? 'media-playback-pause-symbolic'
                : 'media-playback-start-symbolic';
        }
        if (this.shuffleBtn) {
            const on = !!(q && q.shuffle_enabled);
            this.shuffleBtn.child.icon_name = 'media-playlist-shuffle-symbolic';
            this.shuffleBtn.style_class = `hmass-ctrl-btn ${on ? '' : 'hmass-ctrl-btn-inactive'}`;
        }
        if (this.repeatBtn) {
            const mode = q ? q.repeat_mode : 'off';
            this.repeatBtn.child.icon_name = mode === 'one'
                ? 'media-playlist-repeat-song-symbolic'
                : 'media-playlist-repeat-symbolic';
            this.repeatBtn.style_class = `hmass-ctrl-btn ${mode === 'off' ? 'hmass-ctrl-btn-inactive' : ''}`;
        }

        if (this.seekRow) {
            const elapsed = c.currentElapsed();
            const duration = info.duration || 0;
            this.seekRow.setValue(duration > 0 ? Math.min(1, elapsed / duration) : 0);
            this.seekRow.setDisplay(duration > 0
                ? `${formatTime(elapsed)} / ${formatTime(duration)}`
                : formatTime(elapsed));
        }

        if (this.volumeRow) {
            const raw = player ? (typeof player.volume_level === 'number' ? player.volume_level :
                        (typeof player.group_volume === 'number' ? player.group_volume : 0)) : 0;
            const lvl = Math.min(1, Math.max(0, raw / 100));
            this.volumeRow.setValue(lvl);
            this.volumeRow.setDisplay(`${Math.round(lvl * 100)} %`);
        }
        if (this.muteBtn && player) {
            const raw = typeof player.volume_level === 'number' ? player.volume_level :
                        (typeof player.group_volume === 'number' ? player.group_volume : 0);
            this.muteBtn.child.icon_name = player.volume_muted
                ? 'audio-volume-muted-symbolic'
                : (raw > 60 ? 'audio-volume-high-symbolic' : 'audio-volume-medium-symbolic');
        }
    }

    destroy() {
        for (const it of this.items)
            it.destroy();
        this.items = [];
    }
};

// ---- sekce Home Assistant Assist Chat ----

var HaAssistChat = class HaAssistChat {
    /**
     * @param ha HAClient
     */
    constructor(ha) {
        this.ha = ha;
        this.items = [];
        this._conversationId = null;
        this._busy = false;

        this._build();
    }

    _build() {
        this.row = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            activate: false,
            hover: false,
            can_focus: false,
            style_class: 'hmass-assist-row',
        });

        const box = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'hmass-assist-box',
        });

        // Chat display area (shows question and answer)
        this.historyBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'hmass-assist-history',
        });
        this.historyBox.hide();

        this.userMsgLabel = new St.Label({
            text: '',
            style_class: 'hmass-assist-msg-user',
            x_expand: true,
        });
        if (this.userMsgLabel.clutter_text)
            this.userMsgLabel.clutter_text.line_wrap = true;

        this.replyMsgLabel = new St.Label({
            text: '',
            style_class: 'hmass-assist-msg-reply',
            x_expand: true,
        });
        if (this.replyMsgLabel.clutter_text)
            this.replyMsgLabel.clutter_text.line_wrap = true;

        this.historyBox.add_child(this.userMsgLabel);
        this.historyBox.add_child(this.replyMsgLabel);
        box.add_child(this.historyBox);

        // Input row: entry + send button + clear button
        const inputRow = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            style_class: 'hmass-assist-input-row',
        });

        this.entry = new St.Entry({
            hint_text: 'Zeptejte se Assistenta...',
            can_focus: true,
            x_expand: true,
            style_class: 'hmass-entry hmass-assist-entry',
        });

        this.entry.clutter_text.connect('key-press-event', (actor, event) => {
            const sym = event.get_key_symbol();
            if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) {
                this._send();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this.sendBtn = iconButton('mail-send-symbolic', () => this._send(), 'hmass-assist-send-btn');
        this.clearBtn = iconButton('edit-clear-symbolic', () => this._clear(), 'hmass-assist-clear-btn');
        this.clearBtn.hide();

        inputRow.add_child(this.entry);
        inputRow.add_child(this.sendBtn);
        inputRow.add_child(this.clearBtn);
        box.add_child(inputRow);

        this.row.add_child(box);
        this.items.push(this.row);
    }

    async _send() {
        if (this._busy)
            return;
        const text = (this.entry.text || '').trim();
        if (!text)
            return;

        this._busy = true;
        this.entry.text = '';
        this.sendBtn.reactive = false;

        this.userMsgLabel.text = `Vy: ${text}`;
        this.replyMsgLabel.text = 'Assist: Přemýšlím...';
        this.replyMsgLabel.style_class = 'hmass-assist-msg-reply hmass-assist-thinking';
        this.historyBox.show();
        this.clearBtn.show();

        try {
            const res = await this.ha.processConversation(text, this._conversationId);
            if (res && res.conversationId)
                this._conversationId = res.conversationId;
            const reply = (res && res.speech) || (res && res.responseType ? `[${res.responseType}]` : 'Hotovo.');
            this.replyMsgLabel.text = `Assist: ${reply}`;
            this.replyMsgLabel.style_class = 'hmass-assist-msg-reply';
        } catch (e) {
            this.replyMsgLabel.text = `Chyba: ${e.message || e}`;
            this.replyMsgLabel.style_class = 'hmass-assist-msg-reply hmass-assist-error';
        } finally {
            this._busy = false;
            this.sendBtn.reactive = true;
        }
    }

    _clear() {
        this._conversationId = null;
        this.userMsgLabel.text = '';
        this.replyMsgLabel.text = '';
        this.historyBox.hide();
        this.clearBtn.hide();
        this.entry.text = '';
    }

    destroy() {
        for (const item of this.items)
            item.destroy();
        this.items = [];
    }
};

// ---- stavový řádek (tečka + text + volitelné tlačítko pro otevření) ----

function statusRow(labelText, onLaunch, icon, tooltip) {
    const row = _nonReactiveRow('hmass-status-row');
    const dot = new St.Bin({style_class: 'hmass-dot hmass-dot-off', y_align: Clutter.ActorAlign.CENTER});
    const label = new St.Label({
        text: labelText || '',
        style_class: 'hmass-status-text',
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
    row.add_child(dot);
    row.add_child(label);

    let launchBtn = null;
    if (typeof onLaunch === 'function') {
        launchBtn = iconButton(icon, onLaunch, 'hmass-launch-btn');
        if (tooltip && typeof launchBtn.set_tooltip_text === 'function')
            launchBtn.set_tooltip_text(tooltip);
        row.add_child(launchBtn);
    }

    return {
        row,
        launchBtn,
        set(stateCls, text) {
            dot.style_class = `hmass-dot ${stateCls}`;
            label.text = text;
        },
    };
}
