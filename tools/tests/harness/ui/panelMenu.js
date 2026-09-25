/*
 * Stub imports.ui.panelMenu - Button s fake menu.
 */

const {GObject} = imports.gi;
const PopupMenu = imports.ui.popupMenu;

var Button = GObject.registerClass({
}, class Button extends GObject.Object {
    _init(menuAlignment, nameText, dontCreateMenu) {
        super._init();
        this.menuAlignment = menuAlignment;
        this.nameText = nameText;
        this.menu = new PopupMenu.FakeMenu();
        this.children = [];
        this.destroyed = false;
        this.style_class = 'panel-button';
    }
    add_child(child) {
        this.children.push(child);
    }
    destroy() {
        if (this.destroyed)
            return;
        this.destroyed = true;
        this.menu.removeAll();
        for (const c of this.children) {
            if (c.destroy)
                c.destroy();
        }
    }
});

var ButtonBox = Button;
