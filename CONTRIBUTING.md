# Přispívání a coding style

Díky za zájem o příspěvek! Před odesláním prosím projděte tato pravidla -
drží kód konzistentní a v souladu s [pravidly recenze
extensions.gnome.org](https://gjs.guide/extensions/review-guidelines/review-guidelines.html).

## Jazyk

- **Komentáře, UI texty, dokumentace i commit message: česky.**
  Identifikátory (názvy tříd, funkcí, proměnných), logovací zprávy a technické
  pojmy z API zůstávají anglicky.
- Czech je primární jazyk projektu (UI rozšíření je české); issue a PR můžete
  psát česky i anglicky.

## JavaScript / GJS

- GNOME Shell 42: `imports.gi` bez ESM (ESM až od GNOME 45 - pokud přidáváte
  podporu 45+, držte obě větve odděleně a testujte obojí).
- Odsazení **4 mezery**, žádné taby; řetězce v single quotes;
  středníky povinné.
- Žádné zastaralé moduly: `Lang`, `Mainloop`, `ByteArray`
  (viz EGO pravidla) - použijte arrow funkce, `GLib.timeout_add_*`,
  `new TextDecoder()`/`imports.gi.GLib`.
- Třídy widgetů registrujte přes `GObject.registerClass`; signály promise
  řešte ručně (GJS 1.72 nemá `Promise` integraci s GLib).
- Každý soubor začíná SPDX hlavičkou (`SPDX-License-Identifier: GPL-2.0-or-later`)
  a copyright poznámkou.
- Žádné telemetrie, subprocessy ani binárky; volání ven jen na uživatelem
  zadané servery (HA/MA) přes `libsoup`.
- Chyby ošetřujte lokálně - výjimka v obsluze jedné zprávy nesmí shodit
  shell; opakované logy omezujte (vzor `_logLimited`).

## Struktura

| Adresář | Obsah |
|---|---|
| `lib/` | klientská logika (WS klienti HA/MA, MPRIS most, UI widgety) |
| `tools/tests/` | testy + harness (stub shell API, mock servery) |
| `schemas/` | GSettings schéma |
| `icons/` | ikony rozšíření |

Nový GSettings klíč = zápis v `schemas/*.gschema.xml` + UI v `prefs.js`
+ zapojení v `extension.js` + test.

## Testy

- `make check` musí projít (syntax kontrola všech JS souborů).
- `make test` musí projít u zásahů do `lib/`, `extension.js`, `prefs.js`
  (mock servery, UI stuby - reálné servery nejsou potřeba).
- Nová funkce = i nový test (unit ve `run-ui-tests.js` / `run-tests.js`;
  živá integrační API do samostatného souboru v `tools/tests/`).
- Před znovupoužitím cizího kódu ověřte licenci a uveďte zdroj v komentáři.

## Commity a PR

- Commit message: krátký předmět v imperativu (např. „menu: odstranit
  stavové řádky"), volitelně tělo s vysvětlením proč.
- Jedna logická změna = jeden commit; bez konflikních souborů navíc
  (zip, `gschemas.compiled` - ty drží `.gitignore`).
- PR: popište co a proč, přiložte výstup testů.
