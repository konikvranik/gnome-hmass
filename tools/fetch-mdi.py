#!/usr/bin/python3
"""Generates full set of MDI icons for extension (icons/mdi/*.svg).

Source: @mdi/svg package (Apache-2.0, Pictogrammers MDI) - same set
as used by Home Assistant. Downloaded from npm and unpacked, e.g.:

    curl -sL -o /tmp/mdi.tgz https://registry.npmjs.org/@mdi/svg/-/svg-7.4.47.tgz
    mkdir -p /tmp/mdi-svg && tar xzf /tmp/mdi.tgz -C /tmp/mdi-svg

Usage:

    tools/fetch-mdi.py --mdi-dir /tmp/mdi-svg/package [--states states.json]

    --states  optional output of GET /api/states from Home Assistant; the script
              will report icons that could not be found in the set

Generates full package (7.4k icons, ~3.5 MB) - no cherry-picking,
so no icon for any new entity is ever missing. Output: icons/mdi/<name>.svg
with baked-in white fill (dark GNOME panel) and explicit dimensions
(St.Icon/GdkPixbuf on GNOME 42 won't load SVG without width/height).
The set is committed in repo; this script is used to update to a new MDI version.
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
                    help='unpacked @mdi/svg package (contains svg/)')
    ap.add_argument('--states', help='optional JSON /api/states from HA '
                    '(verification of missing icons)')
    ap.add_argument('--out', default=os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        'icons', 'mdi'))
    args = ap.parse_args()

    src = os.path.join(args.mdi_dir, 'svg')
    if not os.path.isdir(src):
        sys.exit(f'missing {src} - unpack @mdi/svg (see script header)')
    if os.path.isdir(args.out):
        shutil.rmtree(args.out)
    os.makedirs(args.out)

    written = 0
    for fn in sorted(os.listdir(src)):
        if not fn.endswith('.svg'):
            continue
        with open(os.path.join(src, fn)) as f:
            svg = f.read()
        # Bake white fill - GNOME panel is dark, non-symbolic SVGs cannot be recolored dynamically
        svg = re.sub(r'<svg ',
                     f'<svg fill="{WHITE_FILL}" width="24" height="24" ',
                     svg, count=1)
        with open(os.path.join(args.out, fn), 'w') as f:
            f.write(svg)
        written += 1

    shutil.copy(os.path.join(args.mdi_dir, 'LICENSE'),
                os.path.join(args.out, 'LICENSE'))

    print(f'wrote {written} icons to {args.out}')
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
            print(f'  NOT FOUND in MDI set: {ic}')
        for ic in non_mdi:
            print(f'  not mdi: (domain icon will be used): {ic}')


if __name__ == '__main__':
    main()
