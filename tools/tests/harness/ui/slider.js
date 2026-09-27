// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 konikvranik
/*
 * Stub for imports.ui.slider - GObject with 'value' property and drag-begin/drag-end
 * signals (real notify::value mechanics work).
 */

const {GObject} = imports.gi;

var Slider = GObject.registerClass({
    Properties: {
        'value': GObject.ParamSpec.double(
            'value', 'value', 'value',
            GObject.ParamFlags.READWRITE,
            0, 1, 0),
    },
    Signals: {
        'drag-begin': {},
        'drag-end': {},
    },
}, class Slider extends GObject.Object {
    _init(value) {
        super._init({value: Math.min(1, Math.max(0, value || 0))});
        this.x_expand = false;
    }
});
