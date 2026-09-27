UUID = hmass@konikvranik
EXTDIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

SHELL_MAJOR := $(shell gnome-shell --version 2>/dev/null | sed -E 's/[^0-9]*([0-9]+).*/\1/')
IS_V45_PLUS := $(shell test "$$(echo $(SHELL_MAJOR) | cut -d. -f1)" -ge 45 2>/dev/null && echo 1 || echo 0)

FILES = metadata.json extension.js prefs.js stylesheet.css LICENSE lib schemas icons locale README.md
ZIPFILES = metadata.json extension.js prefs.js stylesheet.css LICENSE lib schemas icons locale po

.PHONY: all build-legacy check test install install-46 install-42 zip clean uninstall update-po

LANGUAGES = cs nl
MOFILES = $(LANGUAGES:%=locale/%/LC_MESSAGES/hmass.mo)
L10NFILES = $(LANGUAGES:%=locale/l10n/%.json)

all: schemas/gschemas.compiled $(MOFILES) $(L10NFILES)

schemas/gschemas.compiled: schemas/org.gnome.shell.extensions.hmass.gschema.xml
	glib-compile-schemas schemas/

# translations: msgids in code are English, po/*.po files contain localizations
locale/%/LC_MESSAGES/hmass.mo: po/%.po
	mkdir -p $(dir $@)
	msgfmt $< -o $@

# JSON maps for forced interface language (interface-language != auto)
locale/l10n/%.json: po/%.po tools/gen-l10n.py
	mkdir -p $(dir $@)
	python3 tools/gen-l10n.py $< $@

po/hmass.pot: po/POTFILES.in extension.js prefs.js lib/*.js
	xgettext --from-code=UTF-8 -L JavaScript --keyword=_ -kformat \
		--package-version=$(shell grep -oP '"version": "\K[^"]*' metadata.json 2>/dev/null || echo 1.0) \
		--msgid-bugs-address=https://github.com/konikvranik/gnome-hmass/issues \
		-F -o $@ $$(cat po/POTFILES.in)

# update po files after msgid changes (preserves existing translations)
update-po: po/hmass.pot
	@for po in $(LANGUAGES:%=po/%.po); do \
		msgmerge -U --backup=none $$po po/hmass.pot; \
	done

build-legacy: all
	python3 tools/build-legacy.py --src . --out build/v42
	glib-compile-schemas build/v42/schemas/

check: all build-legacy
	@echo "=== Checking ESM syntax (GNOME 45+) ==="
	for f in extension.js prefs.js lib/*.js tools/*.js; do node --check $$f && echo "OK $$f"; done
	@echo "=== Checking CJS syntax (GNOME 42-44) ==="
	for f in build/v42/extension.js build/v42/prefs.js build/v42/lib/*.js; do node --check $$f && echo "OK $$f"; done

test: all build-legacy
	bash tools/tests/run-all.sh

# Automatic atomic installation based on detected GNOME Shell version
install: all
ifeq ($(IS_V45_PLUS),1)
	@echo "Detected GNOME Shell $(SHELL_MAJOR) (>= 45) -> installing native ESM version"
	$(MAKE) install-46
else
	@echo "Detected GNOME Shell $(SHELL_MAJOR) (< 45) -> generating and installing GNOME 42 version"
	$(MAKE) install-42
endif

install-46: all
	rm -rf $(EXTDIR).staging $(EXTDIR).old
	mkdir -p $(EXTDIR).staging
	cp -r $(FILES) $(EXTDIR).staging/
	if [ -d $(EXTDIR) ]; then mv $(EXTDIR) $(EXTDIR).old; fi
	mv $(EXTDIR).staging $(EXTDIR)
	rm -rf $(EXTDIR).old
	@echo "Installed ESM version (GNOME 45+) to $(EXTDIR) (atomically)"
	@echo "Restart GNOME Shell (log out on Wayland; Alt+F2 -> r on X11)"

install-42: build-legacy
	rm -rf $(EXTDIR).staging $(EXTDIR).old
	mkdir -p $(EXTDIR).staging
	cp -r build/v42/* $(EXTDIR).staging/
	cp README.md $(EXTDIR).staging/ 2>/dev/null || true
	if [ -d $(EXTDIR) ]; then mv $(EXTDIR) $(EXTDIR).old; fi
	mv $(EXTDIR).staging $(EXTDIR)
	rm -rf $(EXTDIR).old
	@echo "Installed CJS version (GNOME 42-44) to $(EXTDIR) (atomically)"
	@echo "Restart GNOME Shell (Alt+F2 -> r on X11; kill -QUIT on Ubuntu 22.04)"

# Packages for EGO (extensions.gnome.org): versions for 45+ and 42-44
zip: all build-legacy
	rm -f $(UUID)-v46.zip $(UUID)-v42.zip $(UUID).zip
	zip -r $(UUID)-v46.zip $(ZIPFILES) -x 'schemas/gschemas.compiled'
	cd build/v42 && zip -r ../../$(UUID)-v42.zip $(ZIPFILES) -x 'schemas/gschemas.compiled'
	cp $(UUID)-v46.zip $(UUID).zip
	@echo "Created $(UUID)-v46.zip (for GNOME 45-48)"
	@echo "Created $(UUID)-v42.zip (for GNOME 42-44)"

clean:
	rm -rf build $(UUID)*.zip schemas/gschemas.compiled /tmp/mock-*.log

uninstall:
	rm -rf $(EXTDIR)
	gnome-extensions disable $(UUID) 2>/dev/null || true
	@echo "Uninstalled."
