// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 pvranik
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
