#!/usr/bin/python3
"""Vygeneruje sadu MDI ikon pro rozšíření (icons/mdi/*.svg).

Zdroj: balíček @mdi/svg (Apache-2.0, Pictogramers MDI) - stažený z npm
a rozbalený, např.:

    curl -sL -o /tmp/mdi.tgz https://registry.npmjs.org/@mdi/svg/-/svg-7.4.47.tgz
    mkdir -p /tmp/mdi-svg && tar xzf /tmp/mdi.tgz -C /tmp/mdi-svg

Použití:

    tools/fetch-mdi.py --mdi-dir /tmp/mdi-svg/package [--states states.json]

    --states  volitelný výpis GET /api/states z Home Assistant;
              ikony použité na dané instanci se přidají do sady

Výstup: icons/mdi/<jmeno>.svg s vypečenou bílou výplní (tmavý panel GNOME)
a icons/mdi/LICENSE. Sada je commitnutá v repu - skript slouží jen
k doplnění nových ikon (např. po přidání entit v HA).
"""
import argparse
import json
import os
import re
import shutil
import sys

# Výchozí ikony HA domén (fallback, když entita nemá vlastní icon)
DOMAIN_DEFAULTS = {
    'light': 'lightbulb',
    'switch': 'light-switch',
    'fan': 'fan',
    'cover': 'window-shutter',
    'climate': 'thermostat',
    'humidifier': 'air-humidifier',
    'siren': 'bullhorn',
    'lock': 'lock',
    'vacuum': 'robot-vacuum',
    'media_player': 'speaker',
    'sensor': 'eye',
    'binary_sensor': 'checkbox-marked-circle',
    'weather': 'weather-cloudy',
    'scene': 'palette',
    'script': 'script-text',
    'automation': 'robot',
    'button': 'gesture-tap-button',
    'input_boolean': 'toggle-switch-variant',
    'input_number': 'ray-vertex',
    'input_select': 'format-list-bulleted',
    'input_text': 'form-textbox',
    'input_button': 'gesture-tap-button',
    'number': 'ray-vertex',
    'select': 'format-list-bulleted',
    'text': 'form-textbox',
    'todo': 'clipboard-check-outline',
    'alarm_control_panel': 'shield-home',
    'camera': 'cctv',
    'update': 'cloud-download',
    'person': 'account',
    'device_tracker': 'map-marker-radius',
    'sun': 'weather-sunny',
    'schedule': 'calendar-clock',
    'timer': 'timer-outline',
    'counter': 'counter',
    'calendar': 'calendar',
    'water_heater': 'water-boiler',
}

# Běžné ikony domácí automatizace - buffer pro veřejné uživatele
# (názvy ověřit proti balíčku @mdi/svg; skript neexistující přeskočí)
COMMON = """
thermometer thermometer-high thermometer-low water-percent water
battery battery-high battery-medium battery-low battery-alert
home home-outline lamp ceiling-light lightbulb-group string-lights
led-strip led-strip-variant light-switch ceiling-fan
window-shutter window-open window-closed blinds
garage garage-open door-open door-closed doorbell
lock lock-open lock-alert thermostat thermostat-box air-filter
air-purifier air-humidifier air-conditioner washing-machine tumble-dryer dishwasher
fridge stove microwave kettle coffee-maker toaster
television speaker speaker-bluetooth soundbar
cellphone laptop desktop-tower monitor router wifi-strength-4 wifi
network-strength-4 power-plug power-plug-off power power-socket power-socket-eu
battery-charging lightning-bolt leaf fire
water-pump water-boiler gauge speedometer
pulse heart-pulse smoke-detector
motion-sensor magnet human
motion-sensor-off volume-high volume-off play pause stop skip-next
skip-previous cast cast-connected
robot robot-vacuum robot-mower
solar-power wind-turbine hydro-power transmission-tower
counter meter-gas meter-electric chart-line chart-areaspline
chart-bar clock clock-outline calendar-clock calendar-today
timer timer-outline restart update cloud-download
shield-home shield-lock security account account-group
map-marker map-marker-radius home-assistant
lightbulb lightbulb-on lightbulb-off lightbulb-auto
toggle-switch toggle-switch-variant toggle-switch-off
gesture-tap-button gesture-tap hand-back-left
script-text robot palette eye eye-settings
form-textbox format-list-bulleted ray-vertex
chevron-up chevron-down chevron-left chevron-right
arrow-up-bold arrow-down-bold minus plus close check
alert alert-circle check-circle information
sun-snowflake snowflake weather-sunny weather-night
weather-partly-cloudy weather-rainy weather-snowy weather-fog
weather-windy weather-lightning weather-hail
flower flower-tulip sprout leaf-off tree
dog cat baby
car car-battery car-wash
diameter-variant ruler triangle-outline square-circle
cube package-variant
sun-thermometer thermometer-water pool
shower-head water-check water-alert water-off
fingerprint key key-variant security-network
cctv camera camera-off video camera-front
record-circle motion-play
wall-sconce-flat-variant lamp-outline string-lights-off
signal sine-wave radio-tower antenna
ip new-box text android chart-timeline
restart-off alert-octagram
"""

WHITE_FILL = '#FFFFFF'


def collect_names(states_path):
    names = set(DOMAIN_DEFAULTS.values())
    for token in COMMON.split():
        names.add(token)
    if states_path:
        with open(states_path) as f:
            for ent in json.load(f):
                icon = (ent.get('attributes') or {}).get('icon') or ''
                if icon.startswith('mdi:'):
                    names.add(icon[4:])
    return names


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--mdi-dir', required=True,
                    help='rozbalený balíček @mdi/svg (obsahuje svg/)')
    ap.add_argument('--states', help='volitelný JSON /api/states z HA')
    ap.add_argument('--out', default=os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        'icons', 'mdi'))
    args = ap.parse_args()

    src = os.path.join(args.mdi_dir, 'svg')
    if not os.path.isdir(src):
        sys.exit(f'chybí {src} - rozbalte @mdi/svg (viz hlavičku skriptu)')

    names = collect_names(args.states)
    os.makedirs(args.out, exist_ok=True)

    written, missing = 0, []
    for name in sorted(names):
        # MDI má varianty -name-outline/-off; přesná shoda, jinak -variant
        for candidate in (name, name + '-variant'):
            path = os.path.join(src, candidate + '.svg')
            if os.path.exists(path):
                break
        else:
            missing.append(name)
            continue
        with open(path) as f:
            svg = f.read()
        # vypéct bílou výplň - panel GNOME je tmavý, ne-symbolická SVG
        # se obarvit nedají
        svg = re.sub(r'<svg ', f'<svg fill="{WHITE_FILL}" ', svg, count=1)
        with open(os.path.join(args.out, candidate + '.svg'), 'w') as f:
            f.write(svg)
        written += 1

    shutil.copy(os.path.join(args.mdi_dir, 'LICENSE'),
                os.path.join(args.out, 'LICENSE'))

    print(f'zapsáno {written} ikon do {args.out}')
    if missing:
        print(f'v balíčku nenalezeno ({len(missing)}):')
        for m in missing:
            print(f'  {m}')


if __name__ == '__main__':
    main()
