// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 konikvranik
/*
 * Stub for imports.misc.util - records spawned commands (Util.spawn).
 */

var spawned = [];

function spawn(argv) {
    spawned.push(argv);
}

function reset() {
    spawned = [];
}
