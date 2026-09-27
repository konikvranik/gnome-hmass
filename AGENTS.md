# AGENTS.md — Guidelines for AI assistants and automated tools

This file is the **single source of truth** for working in this repository. Other
agent entry files (`CLAUDE.md`, `GEMINI.md`) only import it.
It applies to all tools: ZCode, Claude Code, Antigravity (`agy`),
Gemini CLI, opencode, Junie/IntelliJ AI Assistant, Codex, Cursor.

## Project in one paragraph

GNOME Shell extension (42–48, verified on 42.9/X11 and 46+) integrating Home
Assistant and Music Assistant: entity values and controls in the top bar,
menu with playback controls and Assist chat, MPRIS bridge for media keys.
Pure GJS (SpiderMonkey) — **no bundler, no npm, no external dependencies**;
everything via GObject introspection. License: GPL-2.0-or-later.

## Language conventions

- **All texts in code must be in English**: comments, commit messages, explanations,
  agent instructions, identifiers (classes, functions, variables), log messages,
  and API names.
- **UI texts**: English msgid via `_('…')` + gettext domain "hmass";
  translations in `po/cs.po`, `po/nl.po` (see README → Contributing translations).
- **Documentation**: English (`README.md`, `CONTRIBUTING.md`, `AGENTS.md`), localized
  alternative as `README.cs.md`. `CONTRIBUTING.md` is strictly English only.
  The only allowed exceptions to English are localizations (`po/`, `mo/`) and
  localized documentation (`README.cs.md`).
- Comments explain *why*, not *what* a line does.

## Commands

```bash
make check          # syntax check for both ESM and generated CJS (fast, mandatory after every change)
make test           # full test suite (E2E + UI + prefs + Soup compatibility)
make install        # atomic installation (auto-detects GNOME 45+ ESM vs GNOME 42-44 CJS)
make zip            # generates packages for EGO: hmass@konikvranik-v46.zip and hmass@konikvranik-v42.zip
```

Live tests against real HA/MA (reading credentials from user's GSettings;
run from repo root):

```bash
GSETTINGS_SCHEMA_DIR=schemas DISPLAY=:1 gjs -I . tools/tests/test-live-integration.js
GSETTINGS_SCHEMA_DIR=schemas DISPLAY=:1 gjs -I . tools/tests/test-live-ui.js
```

Reload extension without restarting GNOME Shell (safe — installation is atomic):

```bash
B=/org/gnome/Shell/Extensions
gdbus call --session --dest org.gnome.Shell.Extensions --object-path $B \
  --method org.gnome.Shell.Extensions.DisableExtension hmass@konikvranik
gdbus call --session --dest org.gnome.Shell.Extensions --object-path $B \
  --method org.gnome.Shell.Extensions.EnableExtension hmass@konikvranik
```

## Architecture

| File | Role |
|---|---|
| `extension.js` | `HMassIndicator` (PanelMenu.Button): panel, menu, lifecycle, MPRIS manager, keybinding |
| `lib/ws.js` | WebSocket client (reconnect, backoff, watchdog) — **version-agnostic to Soup** |
| `lib/ha.js` | HA client (auth, get_states, subscribe_events, conversation/process with agent from preferred Assist pipeline) |
| `lib/ma.js` | MA client (players/queues, commands, AI Radio DJ via `ai_radio/queue_dj`) |
| `lib/mpris.js` | MPRIS D-Bus bridge (org.mpris.MediaPlayer2.hmass.*) |
| `lib/ui.js` | widgets: MaSection (MA menu), createHaRows/createPanelEntity (controls per HA domain), mergeEntityConfig (per-entity config), tooltips |
| `lib/icons.js` | resolver `mdi:…` → `Gio.FileIcon` from `icons/mdi/` (~500 SVGs, Apache-2.0, regenerated via `tools/fetch-mdi.py`) |
| `prefs.js` | GTK4 + libadwaita preferences window |
| `schemas/` | GSettings schema (compiled by make) |
| `tools/tests/` | tests + harness (`harness/` stubs shell API, `mock_server.py` simulates HA/MA) |

## Hard rules

1. **ESM primarily (GNOME 45–48), automatic transpilation for GNOME 42–44.**
   Source code in the repository is modern clean ESM (`import`/`export`).
   The script `tools/build-legacy.py` automatically generates the CJS variant for GNOME 42–44
   into `build/v42`. `make check` validates both variants and `make install` installs
   the appropriate version according to the running GNOME Shell.
2. **Two Soup versions depend on the entry point.** Shell and tests set
   `imports.gi.versions.Soup = '2.4'`, prefs (GTK4) `'3.0'` — **always before
   `lib/` is loaded**. `lib/*.js` must not pin Soup version nor handle it other
   than through forward compatibility (see `_createSoupMessage` in `lib/ws.js`).
3. **No deprecated modules:** `Lang`, `Mainloop`, `ByteArray` (EGO review rules).
   Use arrow functions, `GLib.timeout_add_*`, `TextDecoder`.
4. Register widgets via `GObject.registerClass`; handle signals manually
   (GJS 1.72 has no GLib promise integration).
5. **An exception must never crash the shell.** Message and event handlers have local
   try/catch; log repeating errors throttled (the `_logLimited` pattern).
6. **Never overwrite `gschemas.compiled` in-place while the shell is running** —
   the shell has the file mmapped and truncation will crash it (painfully verified).
   Install only via `make install` (atomic directory replacement).
7. New GSettings key = `schemas/*.gschema.xml` + UI in `prefs.js` +
   wiring in `extension.js` + `make check` (recompiles schema) + test.
8. **No telemetry, subprocesses, or binaries**; network communication only to
   user-configured servers via libsoup.
9. Credentials (tokens, server URLs) reside only in user's GSettings.
   **Never write them into code, tests, logs, or commits.**
10. **Never change the user's personal system settings** (keyboard shortcuts,
    theme, dock…), even if they appear "broken" — they are intentional
    (painfully verified: panel-run-dialog rewritten to Alt+F2 destroyed
    user-configured switch to workspace 2). Only read external settings.
    Only modify the extension's own keys for testing and always restore them.
11. Interactive elements in panel: handle hover via `track_hover` +
    `notify::hover` (native pattern), not `enter-event`; tooltip positions
    must be monitor-aware (`findMonitorForActor`) — panel can be on top or bottom
    (dash-to-panel).

## Tests

- New feature ⇒ new test: logic into `run-ui-tests.js`/`run-tests.js`
  (with fakes from `tools/tests/harness/`), integration API into standalone
  `tools/tests/test-*.js`.
- Harness stubs `imports.ui.*` and `St` — new shell APIs used must be added
  to the harness, not bypassed.
- **Known pre-existing harness limitations**: `Rows/Slider: scroll-event on
  Gjs_SliderRow` and `Ind/OfflineUI: Me.dir` are harness issues, NOT production
  code bugs. Do not modify `lib/` to silence harness quirks; expand the harness instead.
- After modifying `lib/`, `extension.js`, or `prefs.js`, `make check` + `make test`
  must pass (including UI phases for UI changes).

## Live debugging (User's X11 session, DISPLAY=:1)

```bash
journalctl --user -f /usr/bin/gnome-shell | grep -i hmass   # extension logs
DISPLAY=:1 import -window root /tmp/shot.png                # screenshot
```

- **Shell caches extension modules** — `make install` + Disable/Enable via
  D-Bus DOES NOT re-import `extension.js`/`lib/*.js` (`ReloadExtension` does not
  work on GNOME 42); new code is loaded only after restarting the shell.
  Verify code version visually (screenshot), do not trust soft reload.
- **Restarting the shell**: Alt+F2 → `r` does NOT work on Ubuntu 22.04 (missing
  `/usr/libexec/mutter-restart-helper`). Reliable: `kill -QUIT $(pgrep -n gnome-shell)` —
  systemd (`org.gnome.Shell@x11.service`) restores the shell in ~3s, session and
  windows survive. The panel will be empty for ~5s.
- **St.Icon + gicon**: Assign gicon/icon_name ONLY AFTER construction
  (`icon.gicon = …`), not in constructor params — GJS 1.72 silently discards them
  in params for St.Icon resulting in 0×0 size (painfully verified). SVGs for
  FileIcon must have `width`/`height` attributes (viewBox alone is not enough).
- **Adw.ActionRow + input field**: A field in `add_prefix`/`add_suffix` will not
  expand — internal `title_box` template has `hexpand=True` and takes up available
  space. Either use `_collapseTitleBox` (finds GtkBox with hexpand and collapses it),
  or for URL/token rows use `_fieldRow` (title+description stacked, field full width).
  Subtitle label must have class `subtitle` and `Pango.WrapMode` (not `Gtk.WrapMode`).
- **Entity autocomplete: NOT Gtk.EntryCompletion, NOT popup above window** —
  EntryCompletion with tens of thousands of items flickers; Gtk.Popover on
  GTK 4.6 (= Ubuntu 22.04; `modal` property was added in 4.10) grabs keyboard focus
  on open, causing typing into entry to freeze. Pattern: list embedded below
  the field (Gtk.Revealer + Gtk.ListBox inside Gtk.Box, similar to Adw.EntryRow),
  filter in JS with precomputed fields, 30 items limit, 300ms debounce, trigger
  from 2–3 characters, query cache, `has_focus` property (NOT method!) —
  `_attachEntityCompletion` in prefs.js. Batch conversion of 45k entities in GLib.idle
  (otherwise UI freezes).
- **Device names from HA**: `/api/config/*_registry/list` returns 404
  (reverse proxy blocks them). POST `/api/template` works — but template output has
  a 256 kB limit, hence chunking by 2500 entities (`_haEnrichDevices` in prefs.js).
- **i18n**: gettext domain "hmass", msgid in English, cs/nl in po/*.po.
  Forced language (setting `interface-language`) is handled by `lib/i18n.js` - JSON
  maps `locale/l10n/<lang>.json` are generated by `tools/gen-l10n.py` (`make all`),
  because `setlocale`/`LANGUAGE` is process-wide and would switch the entire GNOME session.
  Note: modules in `lib/` must import via `Me.imports.lib.*` (`imports.lib.*` does not
  exist in shell — ImportError), and literals translated via variable (`humanState`)
  must stay visible for xgettext — build lookup table inside function so msgmerge doesn't
  mark msgids obsolete.
- **Prefs process and GC warnings**: `gjs org.gnome.Shell.Extensions` process
  chronically logs "Attempting to run a JS callback during garbage collection…
  The offending callback was SourceFunc()" — harmless background noise while window
  is running. But if prefs window DOES NOT OPEN and process takes ~100% CPU, it got
  stuck in a blocked callback loop. Fix: `pkill -f org.gnome.Shell.Extensions`, check
  disk space, vacuum journal if needed, and reopen prefs.
- Settings changes take effect in ~1s (connection keys after ~0.8s).
- Keep live tests that alter home state (scenes, playback) minimal — verify by reading where possible.

## Git

- Commit message: `area: what (English, imperative)` + optional body with why.
  Examples: `menu: remove status rows`, `shortcut: open menu and focus Assist chat`.
- One logical change = one commit; build artifacts are kept in `.gitignore`.
- Branch `main`, push to `origin` when task is done.

## Definition of done

- [ ] `make check` and `make test` pass (or any limitations clearly documented)
- [ ] no new exceptions in journalctl after extension reload
- [ ] UI changes verified (test, or screenshot/reload in live session)
- [ ] README/AGENTS.md updated if behavior changed
- [ ] commit + push
