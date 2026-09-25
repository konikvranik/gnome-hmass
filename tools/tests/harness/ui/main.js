// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 pvranik
/*
 * Stub imports.ui.main - zaznamenává registraci indikátoru do panelu.
 */

var addedToPanel = [];

var panel = {
    addToStatusArea(role, indicator, position, box) {
        addedToPanel.push({role, indicator});
        return indicator;
    },
};

function reset() {
    addedToPanel = [];
}
