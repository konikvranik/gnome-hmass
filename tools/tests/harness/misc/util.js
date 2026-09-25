/*
 * Stub imports.misc.util - zaznamenává spuštěné příkazy (Util.spawn).
 */

var spawned = [];

function spawn(argv) {
    spawned.push(argv);
}

function reset() {
    spawned = [];
}
