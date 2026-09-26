// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 pvranik
/*
 * Stub imports.ui.main - zaznamenává registraci indikátoru do panelu.
 */

var addedToPanel = [];

var keybindings = [];

var wm = {
    addKeybinding(name) {
        keybindings.push(name);
        return true;
    },
    removeKeybinding(name) {
        const idx = keybindings.indexOf(name);
        if (idx >= 0)
            keybindings.splice(idx, 1);
    },
};

var panel = {
    addToStatusArea(role, indicator, position, box) {
        addedToPanel.push({role, indicator});
        return indicator;
    },
};

function reset() {
    addedToPanel = [];
    keybindings = [];
}
