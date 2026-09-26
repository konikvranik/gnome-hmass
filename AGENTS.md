# AGENTS.md — pokyny pro AI asistenty a automatizované nástroje

Tento soubor je **jediný zdroj pravdy** pro práci s repozitářem. Ostatní
vstupní soubory agentů (`CLAUDE.md`, `GEMINI.md`) ho pouze importují.
Platí pro všechny nástroje: ZCode, Claude Code, Antigravity (`agy`),
Gemini CLI, opencode, Junie/IntelliJ AI Assistant, Codex, Cursor.

## Projekt v jednom odstavci

Rozšíření GNOME Shell (42–44, ověřeno na 42.9/X11) propojující Home
Assistant a Music Assistant: hodnoty a ovládání entit v horní liště,
menu s přehráváním a Assist chatem, MPRIS most pro multimediální klávesy.
Čisté GJS (SpiderMonkey) — **žádný bundler, žádné npm, žádné závislosti**;
vše přes GObject introspection. Licence GPL-2.0-or-later.

## Jazykové konvence

- **Komentáře, UI texty, dokumentace, commit message: česky.**
- Identifikátory (třídy, funkce, proměnné), log zprávy, názvy v API: anglicky.
- Rozšíření je primárně české (UI); kód čtou i ostatní — komentář vysvětluje
  *proč*, ne *co* řádek dělá.

## Příkazy

```bash
make check          # syntax kontrola všech JS (rychlé, povinné po každé změně)
make test           # celá testovací suita (E2E + UI + prefs + Soup kompatibilita)
make install        # atomická instalace do ~/.local/share/gnome-shell/extensions/
make zip            # balíček pro extensions.gnome.org (bez testů a README)
```

Živé testy proti reálným HA/MA (čtou přihlašovací údaje z GSettings uživatele;
spouštět z adresáře repa):

```bash
GSETTINGS_SCHEMA_DIR=schemas DISPLAY=:1 gjs -I . tools/tests/test-live-integration.js
GSETTINGS_SCHEMA_DIR=schemas DISPLAY=:1 gjs -I . tools/tests/test-live-ui.js
```

Reload rozšíření bez restartu shellu (bezpečné — instalace je atomická):

```bash
B=/org/gnome/Shell/Extensions
gdbus call --session --dest org.gnome.Shell.Extensions --object-path $B \
  --method org.gnome.Shell.Extensions.DisableExtension hmass@pvranik
gdbus call --session --dest org.gnome.Shell.Extensions --object-path $B \
  --method org.gnome.Shell.Extensions.EnableExtension hmass@pvranik
```

## Architektura

| Soubor | Role |
|---|---|
| `extension.js` | `HMassIndicator` (PanelMenu.Button): panel, menu, životní cyklus, MPRIS manager, keybinding |
| `lib/ws.js` | WebSocket klient (reconnect, backoff, watchdog) — **verzeagnostic k Soup** |
| `lib/ha.js` | klient HA (auth, get_states, subscribe_events, conversation/process s agentem z preferované Assist pipeline) |
| `lib/ma.js` | klient MA (players/queues, příkazy, AI Radio DJ přes `ai_radio/queue_dj`) |
| `lib/mpris.js` | MPRIS D-Bus most (org.mpris.MediaPlayer2.hmass.*) |
| `lib/ui.js` | widgety: MaSection (menu MA), createHaRows/createPanelEntity (ovládání podle domény HA), tooltipy |
| `prefs.js` | GTK4 + libadwaita nastavení |
| `schemas/` | GSettings schéma (kompiluje make) |
| `tools/tests/` | testy + harness (`harness/` stubuje shell API, `mock_server.py` simuluje HA/MA) |

## Tvrdá pravidla

1. **GNOME Shell 42 API, ne ESM.** Žádné `import`/`export`; importy přes
   `imports.gi` a `Me.imports`. ESM až od GNOME 45 — pokud přidáváte podporu,
   držte obě varianty odděleně a testujte obě.
2. **Dvě verze Soup závisí na vstupním bodě.** Shell a testy nastavují
   `imports.gi.versions.Soup = '2.4'`, prefs (GTK4) `'3.0'` — **vždy dřív,
   než se načte `lib/`**. `lib/*.js` nesmí verzi Soup pinovat ani řešit jinak
   než dopřednou kompatibilitou (viz `_createSoupMessage` v `lib/ws.js`).
3. **Žádné zastaralé moduly:** `Lang`, `Mainloop`, `ByteArray` (pravidla
   recenze EGO). Používat arrow funkce, `GLib.timeout_add_*`, `TextDecoder`.
4. Widgety registerovat přes `GObject.registerClass`; signály řešit ručně
   (GJS 1.72 nemá GLib promise integraci).
5. **Výjimka nesmí shodit shell.** Obsluha zpráv a eventů má lokální
   try/catch; opakované chyby logovat throttlovaně (vzor `_logLimited`).
6. **Nikdy nepřepisovat `gschemas.compiled` za běhu shellu na místě** —
   shell má soubor mmapnutý a truncation ho shodí (OVĚŘENO BOLESTIVĚ).
   Instalace jen přes `make install` (atomická výměna adresáře).
7. Nový GSettings klíč = `schemas/*.gschema.xml` + UI v `prefs.js` +
   zapojení v `extension.js` + `make check` (překompiluje schéma) + test.
8. **Žádná telemetrie, subprocessy ani binárky**; komunikace jen na
   uživatelem zadané servery přes libsoup.
9. Přihlašovací údaje (tokeny, URL serverů) jsou jen v GSettings uživatele.
   **Nikdy je nezapisovat do kódu, testů, logů ani commitů.**
10. Interaktivní prvky v panelu: hover řešit přes `track_hover` +
    `notify::hover` (nativní vzor), ne `enter-event`; pozice tooltipů
    monitor-aware (`findMonitorForActor`) — panel může být nahoře i dole
    (dash-to-panel).

## Testy

- Nová funkce ⇒ nový test: logika do `run-ui-tests.js`/`run-tests.js`
  (s fakes z `tools/tests/harness/`), integrační API do samostatného
  `tools/tests/test-*.js`.
- Harness stubuje `imports.ui.*` a `St` — nové použité API shellu je nutné
  doplnit do harnessu, ne obcházet.
- **Známá předexistující selhání (4)**: `Rows/Slider: scroll-event na
  Gjs_SliderRow` a `Ind/OfflineUI: Me.dir` — chyba harnessu, NE produkčního
  kódu. Neopravovat zásahem do `lib/`; řešením je jen rozšíření harnessu.
- Po změnách `lib/`, `extension.js`, `prefs.js` musí projít
  `make check` + `make test` (a pro UI změny i UI fáze).

## Ladění naživo (X11 session uživatele, DISPLAY=:1)

```bash
journalctl --user -f /usr/bin/gnome-shell | grep -i hmass   # logy rozšíření
DISPLAY=:1 import -window root /tmp/shot.png                # screenshot
```

- Změny nastavení se projeví do ~1 s (connection klíče po ~0,8 s).
- Nepřehánějte živé testy, které mění stav domácnosti (scény, přehrávání) —
  ověřovat čtením, kde to jde.

## Git

- Commit message: `oblast: co (česky, imperativ)` + volitelné tělo s proč.
  Příklady: `menu: odstranit stavové řádky`, `zkratka: otevřít menu a
  foucnout do Assist chatu`.
- Jedna logická změna = jeden commit; build artefakty drží `.gitignore`.
- Větev `main`, push na `origin` po dokončení úlohy.

## Definition of done

- [ ] `make check` i `make test` prošly (nebo nová selhání vysvětlena)
- [ ] žádné nové výjimky v journalu po reload rozšíření
- [ ] změna UI ověřena (test, nebo screenshot/reload v živé session)
- [ ] README/AGENTS.md aktualizovány, pokud se změnilo chování
- [ ] commit + push
