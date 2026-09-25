// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 pvranik
/*
 * Stub imports.ui.popupMenu pro testy mimo GNOME Shell.
 * Itemy jsou skutečné GObject třídy (kvůli registerClass a signálům).
 */

const {GObject} = imports.gi;

var Ornament = {
    NONE: 0,
    DOT: 1,
    CHECK: 2,
};

var FakeMenu = class FakeMenu {
    constructor() {
        this.items = [];
        this._handlers = {};
    }
    addMenuItem(item) {
        this.items.push(item);
    }
    removeAll() {
        for (const it of this.items) {
            if (it.destroy)
                it.destroy();
        }
        this.items = [];
    }
    _getMenuItems() {
        return this.items;
    }
    connect(sig, cb) {
        this._handlers[sig] = this._handlers[sig] || [];
        this._handlers[sig].push(cb);
        return 1;
    }
    emit(sig, ...args) {
        for (const cb of this._handlers[sig] || [])
            cb(this, ...args);
    }
};

var PopupBaseMenuItem = GObject.registerClass({
    Signals: {
        'activate': {param_types: []},
        'destroy': {param_types: []},
    },
}, class PopupBaseMenuItem extends GObject.Object {
    _init(params) {
        super._init();
        params = params || {};
        this.reactive = params.reactive !== false;
        this.activate = params.activate !== false;
        this.hover = params.hover !== false;
        this.can_focus = params.can_focus !== false;
        this.style_class = params.style_class || '';
        this.children = [];
        this.destroyed = false;
        this._handlers = {};
    }
    add_child(child) {
        this.children.push(child);
    }
    add_actor(child) {
        this.children.push(child);
    }
    setOrnament(ornament) {
        this._ornament = ornament;
    }
    insert_child_above(child, sibling) {
        const idx = this.children.indexOf(sibling);
        this.children.splice(idx < 0 ? 0 : idx, 0, child);
    }
    insert_child_at_index(child, idx) {
        this.children.splice(idx, 0, child);
    }
    destroy() {
        if (this.destroyed)
            return;
        this.destroyed = true;
        for (const c of this.children) {
            if (c.destroy)
                c.destroy();
        }
        this.emit('destroy');
    }
});

var PopupMenuItem = GObject.registerClass({
}, class PopupMenuItem extends PopupBaseMenuItem {
    _init(text, params) {
        super._init(params);
        this.label = {text: text || ''};
    }
    activateItem() {
        this.emit('activate');
    }
});

var PopupSwitchMenuItem = GObject.registerClass({
    Signals: {
        'toggled': {param_types: [GObject.TYPE_BOOLEAN]},
    },
}, class PopupSwitchMenuItem extends PopupBaseMenuItem {
    _init(text, active, params) {
        super._init(params);
        this.label = {text: text || ''};
        this._state = !!active;
    }
    get state() {
        return this._state;
    }
    setToggleState(state) {
        this._state = !!state;
    }
    activateItem() {
        this._state = !this._state;
        this.emit('toggled', this._state);
    }
});

var PopupSubMenuMenuItem = GObject.registerClass({
}, class PopupSubMenuMenuItem extends PopupBaseMenuItem {
    _init(text, wantIcon) {
        super._init({});
        this.label = {text: text || ''};
        this.menu = new FakeMenu();
    }
});

var PopupSeparatorMenuItem = GObject.registerClass({
}, class PopupSeparatorMenuItem extends PopupBaseMenuItem {
    _init(text) {
        super._init({reactive: false, can_focus: false});
        this.label = {text: text || ''};
    }
});

var PopupMenuSection = GObject.registerClass({
}, class PopupMenuSection extends PopupBaseMenuItem {
    _init() {
        super._init({});
        this.menu = new FakeMenu();
    }
});
