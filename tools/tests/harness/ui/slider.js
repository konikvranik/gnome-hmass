/*
 * Stub imports.ui.slider - GObject s vlastností 'value' a signály
 * drag-begin/drag-end (skutečná mechanika notify::value funguje).
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
