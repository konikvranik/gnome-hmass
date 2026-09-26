#!/usr/bin/python3
"""Vygeneruje kompletní sadu MDI ikon pro rozšíření (icons/mdi/*.svg).

Zdroj: balíček @mdi/svg (Apache-2.0, Pictogramers MDI) - stejná sada,
jakou používá Home Assistant. Stažený z npm a rozbalený, např.:

    curl -sL -o /tmp/mdi.tgz https://registry.npmjs.org/@mdi/svg/-/svg-7.4.47.tgz
    mkdir -p /tmp/mdi-svg && tar xzf /tmp/mdi.tgz -C /tmp/mdi-svg

Použití:

    tools/fetch-mdi.py --mdi-dir /tmp/mdi-svg/package [--states states.json]

    --states  volitelný výpis GET /api/states z Home Assistant; skript
              jen ohlásí ikony, které by se v sadě nenašly

Generuje se celý balíček (7,4k ikon, ~3,5 MB obsahu) - žádný výběr,
aby nikdy nechyběla ikona nové entity. Výstup: icons/mdi/<jmeno>.svg
s vypečenou bílou výplní (tmavý panel GNOME) a explicitními rozměry
(St.Icon/GdkPixbuf na GNOME 42 SVG bez width/height nenačte).
Sada je commitnutá v repu; skript slouží k obnově při nové verzi MDI.
"""
import argparse
import json
import os
import re
import shutil
import sys

WHITE_FILL = '#FFFFFF'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--mdi-dir', required=True,
                    help='rozbalený balíček @mdi/svg (obsahuje svg/)')
    ap.add_argument('--states', help='volitelný JSON /api/states z HA '
                    '(jen kontrola, co by se nenašlo)')
    ap.add_argument('--out', default=os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        'icons', 'mdi'))
    args = ap.parse_args()

    src = os.path.join(args.mdi_dir, 'svg')
    if not os.path.isdir(src):
        sys.exit(f'chybí {src} - rozbalte @mdi/svg (viz hlavičku skriptu)')
    if os.path.isdir(args.out):
        shutil.rmtree(args.out)
    os.makedirs(args.out)

    written = 0
    for fn in sorted(os.listdir(src)):
        if not fn.endswith('.svg'):
            continue
        with open(os.path.join(src, fn)) as f:
            svg = f.read()
        # vypéct bílou výplň - panel GNOME je tmavý, ne-symbolická SVG
        # se obarvit nedají
        svg = re.sub(r'<svg ',
                     f'<svg fill="{WHITE_FILL}" width="24" height="24" ',
                     svg, count=1)
        with open(os.path.join(args.out, fn), 'w') as f:
            f.write(svg)
        written += 1

    shutil.copy(os.path.join(args.mdi_dir, 'LICENSE'),
                os.path.join(args.out, 'LICENSE'))

    print(f'zapsáno {written} ikon do {args.out}')
    if args.states:
        with open(args.states) as f:
            states = json.load(f)
        wanted = sorted({
            (ent.get('attributes') or {}).get('icon')
            for ent in states
            if (ent.get('attributes') or {}).get('icon')
        })
        missing = [
            ic for ic in wanted
            if ic.startswith('mdi:')
            and not os.path.exists(os.path.join(args.out, ic[4:] + '.svg'))
        ]
        non_mdi = [ic for ic in wanted if not ic.startswith('mdi:')]
        for ic in missing:
            print(f'  NENALEZENO v MDI sadě: {ic}')
        for ic in non_mdi:
            print(f'  není mdi: (použije se ikona domény): {ic}')


if __name__ == '__main__':
    main()
