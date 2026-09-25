UUID = hmass@pvranik
EXTDIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

FILES = metadata.json extension.js prefs.js stylesheet.css LICENSE lib schemas icons README.md
# zip funguje jak pro EGO upload, tak pro lokální `gnome-extensions install`
# (ten nekompiluje schémata, proto přibalujeme i gschemas.compiled)
ZIPFILES = metadata.json extension.js prefs.js stylesheet.css LICENSE lib schemas icons

.PHONY: all install uninstall check test zip

all: schemas/gschemas.compiled

schemas/gschemas.compiled: schemas/org.gnome.shell.extensions.hmass.gschema.xml
	glib-compile-schemas schemas/

check: all
	for f in extension.js prefs.js lib/*.js tools/*.js; do node --check $$f && echo "OK $$f"; done

test: all
	bash tools/tests/run-all.sh

install: all
	mkdir -p $(EXTDIR)
	cp -r $(FILES) $(EXTDIR)/
	@echo "Nainstalováno do $(EXTDIR)"
	@echo "Restartujte GNOME Shell (Alt+F2 -> r na X11; odhlášení na Wayland) a poté:"
	@echo "  gnome-extensions enable $(UUID)"

# balíček pro https://extensions.gnome.org/upload/ (bez zkompilovaných schémat,
# README a vývojových nástrojů - ty EGO nevyžaduje)
zip: all
	rm -f $(UUID).zip
	zip -r $(UUID).zip $(ZIPFILES)
	@echo "Vytvořen $(UUID).zip - nahrajte na https://extensions.gnome.org/upload/"

uninstall:
	rm -rf $(EXTDIR)
	gnome-extensions disable $(UUID) 2>/dev/null || true
	@echo "Odinstalováno."
