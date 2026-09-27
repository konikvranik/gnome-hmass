// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 konikvranik
/*
 * Stub for imports.ui.barLevel - GObject with 'value' property for tests.
 */

const {GObject} = imports.gi;

var BarLevel = GObject.registerClass({
    Properties: {
        'value': GObject.ParamSpec.double(
            'value', 'value', 'value',
            GObject.ParamFlags.READWRITE,
            0, 1, 0),
    },
}, class BarLevel extends GObject.Object {
    _init(params) {
        super._init();
        this.x_expand = false;
        this.value = (params && params.value) || 0;
    }
});
