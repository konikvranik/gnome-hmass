// MDI ikony z Home Assistant, součástí rozšíření je sada SVG (icons/mdi,
// vygenerovaná tools/fetch-mdi.py z @mdi/svg, Apache-2.0). SVG mají
// vypečenou bílou výplň - panel GNOME je tmavý a ne-symbolické ikony
// (Gio.FileIcon) obarvit nejde.
//
// Vstupní jméno je hodnota atributu entity "icon", např. "mdi:water-pump".

const Gio = imports.gi.Gio;

const _cache = new Map();
let _dir = null;
let _dirResolved = false;

function _iconDir() {
    if (!_dirResolved) {
        _dirResolved = true;
        try {
            const Me = imports.misc.extensionUtils.getCurrentExtension();
            _dir = Me.dir.get_child('icons').get_child('mdi');
        } catch (e) {
            // mimo GNOME Shell (testy) - sada ikon není dostupná
            _dir = null;
        }
    }
    return _dir;
}

/**
 * Vrátí gicon pro MDI jméno, nebo null (neznámá/chybějící ikona).
 * @param {string} mdiName např. "mdi:water-pump"
 */
function mdiIcon(mdiName) {
    if (!mdiName || mdiName.indexOf('mdi:') !== 0)
        return null;
    const name = mdiName.slice(4);
    if (_cache.has(name))
        return _cache.get(name);
    let gicon = null;
    const dir = _iconDir();
    if (dir) {
        const file = dir.get_child(name + '.svg');
        if (file.query_exists(null))
            gicon = new Gio.FileIcon({file});
    }
    _cache.set(name, gicon);
    return gicon;
}

/** Existuje ikona v bundled sadě? (diagnostika/testy) */
function hasMdi(mdiName) {
    return mdiIcon(mdiName) !== null;
}
