UUID = hmass@pvranik
EXTDIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

SHELL_MAJOR := $(shell gnome-shell --version 2>/dev/null | sed -E 's/[^0-9]*([0-9]+).*/\1/')
IS_V45_PLUS := $(shell test "$$(echo $(SHELL_MAJOR) | cut -d. -f1)" -ge 45 2>/dev/null && echo 1 || echo 0)

FILES = metadata.json extension.js prefs.js stylesheet.css LICENSE lib schemas icons locale README.md
ZIPFILES = metadata.json extension.js prefs.js stylesheet.css LICENSE lib schemas icons locale

.PHONY: all build-legacy check test install install-46 install-42 zip clean uninstall update-po

all: schemas/gschemas.compiled locale/cs/LC_MESSAGES/hmass.mo

schemas/gschemas.compiled: schemas/org.gnome.shell.extensions.hmass.gschema.xml
	glib-compile-schemas schemas/

# překlady: msgid v kódu jsou anglicky, cs.po nese českou lokalizaci
locale/cs/LC_MESSAGES/hmass.mo: po/cs.po
	mkdir -p locale/cs/LC_MESSAGES
	msgfmt po/cs.po -o $@

po/hmass.pot: po/POTFILES.in extension.js prefs.js lib/*.js
	xgettext --from-code=UTF-8 -L JavaScript --keyword=_ -kformat \
		--package-version=$(shell grep -oP '"version": "\K[^"]*' metadata.json 2>/dev/null || echo 1.0) \
		--msgid-bugs-address=https://github.com/konikvranik/gnome-hmass/issues \
		-F -o $@ $$(cat po/POTFILES.in)

# aktualizace cs.po po změně msgid (uchová přeložené)
update-po: po/hmass.pot
	msgmerge -U --backup=none po/cs.po po/hmass.pot

build-legacy: all
	python3 tools/build-legacy.py --src . --out build/v42
	glib-compile-schemas build/v42/schemas/

check: all build-legacy
	@echo "=== Kontrola ESM syntaxe (GNOME 45+) ==="
	for f in extension.js prefs.js lib/*.js tools/*.js; do node --check $$f && echo "OK $$f"; done
	@echo "=== Kontrola CJS syntaxe (GNOME 42-44) ==="
	for f in build/v42/extension.js build/v42/prefs.js build/v42/lib/*.js; do node --check $$f && echo "OK $$f"; done

test: all build-legacy
	bash tools/tests/run-all.sh

# Automatická atomická instalace podle zjištěné verze GNOME Shellu
install: all
ifeq ($(IS_V45_PLUS),1)
	@echo "Detekován GNOME Shell $(SHELL_MAJOR) (>= 45) -> instaluji nativní ESM verzi"
	$(MAKE) install-46
else
	@echo "Detekován GNOME Shell $(SHELL_MAJOR) (< 45) -> generuji a instaluji GNOME 42 verzi"
	$(MAKE) install-42
endif

install-46: all
	rm -rf $(EXTDIR).staging $(EXTDIR).old
	mkdir -p $(EXTDIR).staging
	cp -r $(FILES) $(EXTDIR).staging/
	if [ -d $(EXTDIR) ]; then mv $(EXTDIR) $(EXTDIR).old; fi
	mv $(EXTDIR).staging $(EXTDIR)
	rm -rf $(EXTDIR).old
	@echo "Nainstalována ESM verze (GNOME 45+) do $(EXTDIR) (atomicky)"
	@echo "Restartujte GNOME Shell (odhlášení na Wayland; Alt+F2 -> r na X11)"

install-42: build-legacy
	rm -rf $(EXTDIR).staging $(EXTDIR).old
	mkdir -p $(EXTDIR).staging
	cp -r build/v42/* $(EXTDIR).staging/
	cp README.md $(EXTDIR).staging/ 2>/dev/null || true
	if [ -d $(EXTDIR) ]; then mv $(EXTDIR) $(EXTDIR).old; fi
	mv $(EXTDIR).staging $(EXTDIR)
	rm -rf $(EXTDIR).old
	@echo "Nainstalována CJS verze (GNOME 42-44) do $(EXTDIR) (atomicky)"
	@echo "Restartujte GNOME Shell (Alt+F2 -> r na X11; kill -QUIT na Ubuntu 22.04)"

# Balíčky pro EGO (extensions.gnome.org): verze pro 45+ i pro 42-44
zip: all build-legacy
	rm -f $(UUID)-v46.zip $(UUID)-v42.zip $(UUID).zip
	zip -r $(UUID)-v46.zip $(ZIPFILES)
	cd build/v42 && zip -r ../../$(UUID)-v42.zip $(ZIPFILES)
	cp $(UUID)-v46.zip $(UUID).zip
	@echo "Vytvořen $(UUID)-v46.zip (pro GNOME 45-48)"
	@echo "Vytvořen $(UUID)-v42.zip (pro GNOME 42-44)"

clean:
	rm -rf build $(UUID)*.zip schemas/gschemas.compiled /tmp/mock-*.log

uninstall:
	rm -rf $(EXTDIR)
	gnome-extensions disable $(UUID) 2>/dev/null || true
	@echo "Odinstalováno."
