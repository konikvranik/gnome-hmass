# gnome-hmass

Rozšíření GNOME Shell (42–44) integrující **Home Assistant** a **Music Assistant**.

Licence: **GPL-2.0-or-later** (viz [LICENSE](LICENSE)). Projekt se řídí
[Kodexem chování GNOME](https://conduct.gnome.org/) - prosím chovejte se k němu
přítomní v issue a diskuzích zdvořile a vstřícně.

## Co umí

### Home Assistant
- **Hodnoty v horní liště** – libovolné entity (typicky sensory) se zobrazí jako
  kompaktní text přímo v panelu GNOME (např. `21.4 °C`).
- **Popup menu po kliknutí** – ovládací prvky se **vybírají automaticky podle
  domény** entity:
  | Doména | Ovládací prvek |
  |---|---|
  | `switch`, `light`, `fan`, `input_boolean`, `automation`, `cover`, `humidifier` | přepínač (toggle) |
  | `script`, `scene`, `button`, `input_button` | tlačítko spuštění |
  | `input_number`, `number` | posuvník s min/max/krok z HA |
  | `light` s jasem | navíc posuvník jasu |
  | `media_player` | navíc posuvník hlasitosti |
  | `cover` s pozicí | navíc posuvník pozice |
  | `input_select`, `select` | rozbalovací seznam voleb |
  | `input_text` | textové pole |
  | `sensor`, `binary_sensor`, `weather` a ostatní | zobrazení hodnoty |
- Hodnoty se aktualizují v reálném čase přes WebSocket (subscribe `state_changed`).
- Stav spojení – barevné tečky v liště + text v menu.

### Music Assistant a přehrávače
- **Ovládání přehrávání v menu**: výběr přehrávače, název skladby/interpreta,
  tlačítka přehrávání, posuvník pozice, hlasitost, (volitelně shuffle/repeat).
  Každý prvek lze v nastavení zapnout/vypnout.
- **MPRIS most pro vybrané přehrávače** – v nastavení zaškrtnete konkrétní
  přehrávače z **Music Assistant i Home Assistant** (`media_player.*`);
  každý dostane vlastní MPRIS jméno (`org.mpris.MediaPlayer2.hmass.<id>`),
  takže multimediální klávesy, GNOME OSD i nativní ovládání médií umí
  ovládat každý zvlášť. Pokud je stejný přehrávač v MA i HA, upřednostní
  se Music Assistant. Bez výběru se bridgeuje aktivní přehrávač MA.
- Přehrávač menu se volí v menu; volba se uloží jako výchozí.

### Chování při výpadku serverů
Když je HA nebo MA nedostupný, rozšíření se chová zdrženlivě:

- **V liště se jen přepne ikona na `network-offline-symbolic`** (a stavové
  tečky zčervenají) – žádné notifikace, žádné dialogy, nic jiného se nemění.
- Automatické opakování připojení s rostoucím odstupem (1 → 60 s); visící
  připojení přeruší watchdog po 20 s. Špatný token/neplatný API klíč
  nezpůsobí žádnou smyčku – nový pokus až po změně nastavení.
- Nic nespadne: nevalidní zprávy, zlobivý server posílající odpad ani pád
  serveru uprostřed sezení rozšíření nezhroutí; výjimky v obsluze zpráv
  se izolují, aby nerušily zbytek.
- **Tiché logování** – opakované chyby stejného druhu se zalogují maximálně
  jednou za minutu, takže journal se nezaplaví (testy to explicitně počítají).
- MPRIS most bez spojení hlásí `Stopped` a `CanPlay = false` místo chyb.

## Instalace

```bash
make install
```

Poté restartujte GNOME Shell (**Alt+F2** → `r` na X11; na Waylandu odhlášení
a přihlášení) a povolte rozšíření:

```bash
gnome-extensions enable hmass@pvranik
```

Ručně: zkopírujte `metadata.json extension.js prefs.js stylesheet.css lib schemas`
do `~/.local/share/gnome-shell/extensions/hmass@pvranik/` (adresář `schemas`
musí obsahovat zkompilované `gschemas.compiled`, vytvoří `make`).

## Nastavení

Otevřete přes tlačítko *Nastavení* v menu rozšíření nebo:

```bash
gnome-extensions prefs hmass@pvranik
```

### Home Assistant
1. **URL** – např. `http://homeassistant.local:8123`.
2. **Token** – v HA: profil uživatele → *Zabezpečení* → *Dlouhodobé přístupové
   tokeny* → vytvořit token a vložit sem.
3. **Entity v liště** a **entity v menu** – zadejte `entity_id`; po kliknutí na
   *Otestovat spojení* se u polí nastaví automatické doplňování podle skutečných
   entit.

### Music Assistant a přehrávače
1. **URL** – např. `http://music-assistant:8095` (port 8095, WS endpoint `/ws`
   se odvodí automaticky; u starších verzí MA se zkusí i `/websocketapi`).
2. **API klíč** – v MA: *Nastavení → Uživatelé → API klíče* (vyžadováno, pokud
   má MA zapnuté přihlášení; u add-onu v HA běžte přes běžný port MA).
3. **Výchozí přehrávač** (pro menu) – vyplní se po testu spojení.
4. **Přehrávače v MPRIS** – checklist se naplní po otestování spojení HA i MA
   (nebo automaticky při otevření nastavení, jsou-li údaje vyplněné);
   zaškrtnutí = přehrávač bude v MPRIS. Duplicitní přehrávač (MA i HA) se
   zobrazí jednou s předností MA.

## Test spojení z terminálu

```bash
gjs tools/test-ha.js http://ha:8123 <TOKEN>
gjs tools/test-ma.js http://mass:8095 <API_KLIC>
```

## Vývoj a testy

Kompletní testovací sada (102 testů ve třech fázích) se spouští jedním příkazem:

```bash
make test
```

| Fáze | Co pokrývá |
|---|---|
| **E2E** (`run-tests.js`) | HA i MA protokol proti mock serverům (handshake, push eventy, příkazy vč. per-player), MPRIS most na D-Bus (vlastnosti, metody, PropertiesChanged, GetAll, dva souběžné mosty, pádové regresní testy), **offline scénáře**: mrtvý port, zlobivý server (nevalidní rámce, abrupt close), odmítnutý token, pád serveru za běhu, MPRIS bez dat, limity logování |
| **UI** (`run-ui-tests.js`) | panel, menu a řádky HA (všechny domény: přepínač, jas, input_number, select, script, sensor, input_text, hlasitost, žaluzie), SliderRow (guard zpětné vazby, debounce), celý Indicator s mock servery včetně MPRIS manageru a uvolnění D-Bus jmen, **Indicator s nedostupnými servery** (offline ikona, tečky, tiché logování) |
| **Prefs** (`run-prefs-tests.js`) | checklist přehrávačů, deduplikace MA/HA bez rozdílu diakritiky, preference MA, persist do nastavení |

UI testy běží mimo GNOME Shell díky stubům shell API (`tools/tests/harness/`)
a nahraditelným třídám widgetů St. Mock servery simulují oba protokoly lokálně,
takže testy nepotřebují reálné HA/MA.

Ověřené proti: GNOME Shell 42 (Ubuntu 22.04, libsoup 3.0, GJS 1.72) a
Music Assistant server 2.5–2.10 (WebSocket `/ws`, se fallbackem na starší
`/websocketapi`).

## Řešení problémů

- Logy rozšíření: `journalctl -f /usr/bin/gnome-shell` (nebo Alt+F2 → `lg`).
  Hledání řádků `hmass`, `homeassistant`, `musicassistant`.
- Tečka v liště **žlutá** = připojuje se; **červená** = chyba (detail v menu).
- Neověřený (self-signed) certifikát: zapněte volbu v nastavení (vyžaduje
  libsoup ≥ 3.2 – Ubuntu 22.04 má 3.0, tam doporučujeme HTTP v lokální síti).
- Změny nastavení spojení se projeví do ~1 s, rozhraní do ~0,3 s; automatické
  opakování spojení s rostoucím intervalem (1 s → 60 s).

## Odinstalace

```bash
make uninstall
```

## Publikování na extensions.gnome.org

1. Vytvořte balíček: `make zip` → `hmass@pvranik.zip` (obsahuje jen potřebné
   soubory včetně XML schématu a licence, bez zkompilovaných schémat a
   vývojových nástrojů).
2. Přihlaste se GNOME účtem na <https://extensions.gnome.org/upload/>, balíček
   nahrajte a vyplňte metadata (licence: GPL-2.0+).
3. `metadata.json` obsahuje `url` odkazující na veřejný repozitář - upravte na
   skutečnou adresu (recenzent ji používá pro hlášení chyb).
4. Recenze řídí [pravidla EGO](https://gjs.guide/extensions/review-guidelines/review-guidelines.html) -
   kód jim odpovídá: čistý životní cyklus `enable()`/`disable()`, bez
   zastaralých modulů (`ByteArray`, `Lang`, `Mainloop`), bez telemetrie,
   subprocessů a binárek; schéma i cesta odpovídají předpisu; licence je
   GPL-2.0-or-later.

Poznámka: GNOME 42–44 jsou již mimo aktivní podporu GNOME; při přidání
podpory novějších verzí (45+ vyžaduje přechod na ESM importy) přidejte
příslušné položky do `shell-version` a vždy uvádějte jen vydání, která jste
skutečně otestovali.
