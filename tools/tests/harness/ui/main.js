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
