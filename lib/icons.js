// MDI ikony z Home Assistant, součástí rozšíření je kompletní sada SVG
// (icons/mdi, vygenerovaná tools/fetch-mdi.py z @mdi/svg, Apache-2.0).
// SVG mají vypečenou bílou výplň - panel GNOME je tmavý a ne-symbolické
// ikony (Gio.FileIcon) obarvit nejde.
//
// Barevné varianty (stav světla) se pečou za běhu: fill se přepíše
// a SVG se zapíše do cache adresáře (~/.cache/hmass-mdi).
//
// Vstupní jméno je hodnota atributu entity "icon", např. "mdi:water-pump".

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;

const _cache = new Map();
let _dir = null;
let _dirResolved = false;
let _cacheDir = null;

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

function _cacheDirFile() {
    if (_cacheDir === null) {
        _cacheDir = false;
        try {
            const d = Gio.file_new_for_path(GLib.get_user_cache_dir())
                .get_child('hmass-mdi');
            if (!d.query_exists(null))
                d.make_directory_with_parents(null);
            _cacheDir = d;
        } catch (e) {
            // cache nejde zapsat - barevné varianty se vrátí bílé
        }
    }
    return _cacheDir || null;
}

/**
 * Vrátí gicon pro MDI jméno, nebo null (neznámá/chybějící ikona).
 * @param {string} mdiName např. "mdi:water-pump"
 * @param {string|null} fillHex např. "#FF8800" pro obarvenou variantu
 *   (null = bílá základní verze ze sady rozšíření)
 */
function mdiIcon(mdiName, fillHex) {
    if (!mdiName || mdiName.indexOf('mdi:') !== 0)
        return null;
    const name = mdiName.slice(4);
    const key = fillHex ? name + fillHex : name;
    if (_cache.has(key))
        return _cache.get(key);
    let gicon = null;
    const dir = _iconDir();
    if (dir) {
        if (fillHex && /^[0-9a-fA-F]{6}$/.test(fillHex.slice(1))) {
            try {
                const src = dir.get_child(name + '.svg');
                const [ok, bytes] = src.load_contents(null);
                if (ok) {
                    const svg = new TextDecoder().decode(bytes)
                        .replace('fill="#FFFFFF"', `fill="#${fillHex.slice(1)}"`);
                    const cd = _cacheDirFile();
                    if (svg.indexOf(fillHex) >= 0 && cd) {
                        const dst = cd.get_child(`${name}-${fillHex.slice(1)}.svg`);
                        dst.replace_contents(svg, null, false,
                            Gio.FileCreateFlags.REPLACE_DESTINATION, null);
                        gicon = Gio.FileIcon.new(dst);
                    }
                }
            } catch (e) {
                // obarvení selhalo - použije se bílá základní verze
                gicon = null;
            }
        }
        if (!gicon) {
            const file = dir.get_child(name + '.svg');
            if (file.query_exists(null)) {
                gicon = Gio.FileIcon.new(file);
            } else {
                log(`hmass: mdi ikona nenalezena v sadě: ${name}`);
            }
        }
    }
    _cache.set(key, gicon);
    return gicon;
}

/** Existuje ikona v bundled sadě? (diagnostika/testy) */
function hasMdi(mdiName) {
    return mdiIcon(mdiName) !== null;
}
