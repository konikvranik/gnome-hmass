#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
# SPDX-FileCopyrightText: 2026 konikvranik
"""
Transpilátor z moderního ESM kódu (GNOME 45+) na legacy CJS kód (GNOME 42-44).
Zachovává mapování řádků 1:1, nepřidává žádné externí závislosti.
"""

import os
import re
import sys
import shutil
import json

def transform_js(content: str, rel_path: str) -> str:
    lines = content.split('\n')
    out_lines = []
    is_in_lib = rel_path.startswith('lib/')
    is_extension_js = (rel_path == 'extension.js')
    is_prefs_js = (rel_path == 'prefs.js')

    i = 0
    while i < len(lines):
        line = lines[i]

        # 1. gi:// importy:
        # import Foo from 'gi://Foo'; -> const Foo = imports.gi.Foo;
        # import { A, B } from 'gi://X'; -> const { A, B } = imports.gi.X;
        m = re.match(r"^import\s+([A-Za-z0-9_]+)\s+from\s+'gi://([A-Za-z0-9_]+)';?$", line)
        if m:
            var_name, mod_name = m.groups()
            out_lines.append(f"const {var_name} = imports.gi.{mod_name};")
            i += 1
            continue

        m = re.match(r"^import\s+\{([^}]+)\}\s+from\s+'gi://([A-Za-z0-9_]+)';?$", line)
        if m:
            vars_list, mod_name = m.groups()
            out_lines.append(f"const {{{vars_list}}} = imports.gi.{mod_name};")
            i += 1
            continue

        # 2. GNOME Shell UI / misc importy:
        # import * as Foo from 'resource:///org/gnome/shell/ui/foo.js'; -> const Foo = imports.ui.foo;
        m = re.match(r"^import\s+\*\s+as\s+([A-Za-z0-9_]+)\s+from\s+'resource:///org/gnome/shell/ui/([A-Za-z0-9_]+)\.js';?$", line)
        if m:
            var_name, mod_name = m.groups()
            out_lines.append(f"const {var_name} = imports.ui.{mod_name};")
            i += 1
            continue

        # import { Slider } from 'resource:///org/gnome/shell/ui/slider.js'; -> const Slider = imports.ui.slider;
        m = re.match(r"^import\s+\{\s*Slider\s*\}\s+from\s+'resource:///org/gnome/shell/ui/slider\.js';?$", line)
        if m:
            out_lines.append("const Slider = imports.ui.slider;")
            i += 1
            continue

        # import { BarLevel } from 'resource:///org/gnome/shell/ui/barLevel.js'; -> const BarLevel = imports.ui.barLevel;
        m = re.match(r"^import\s+\{\s*BarLevel\s*\}\s+from\s+'resource:///org/gnome/shell/ui/barLevel\.js';?$", line)
        if m:
            out_lines.append("const BarLevel = imports.ui.barLevel;")
            i += 1
            continue

        # import * as Util from 'resource:///org/gnome/shell/misc/util.js'; -> const Util = imports.misc.util;
        m = re.match(r"^import\s+\*\s+as\s+([A-Za-z0-9_]+)\s+from\s+'resource:///org/gnome/shell/misc/([A-Za-z0-9_]+)\.js';?$", line)
        if m:
            var_name, mod_name = m.groups()
            out_lines.append(f"const {var_name} = imports.misc.{mod_name};")
            i += 1
            continue

        # 3. Extension / ExtensionPreferences importy:
        # import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
        if 'resource:///org/gnome/shell/extensions/extension.js' in line:
            out_lines.append("const ExtensionUtils = imports.misc.extensionUtils;")
            out_lines.append("const Me = ExtensionUtils.getCurrentExtension();")
            if 'gettext' in line:
                out_lines.append("const _ = ExtensionUtils.gettext || (s => s);")
            i += 1
            continue

        # import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
        if 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js' in line:
            out_lines.append("const ExtensionUtils = imports.misc.extensionUtils;")
            out_lines.append("const Me = ExtensionUtils.getCurrentExtension();")
            if 'gettext' in line:
                out_lines.append("const _ = ExtensionUtils.gettext || (s => s);")
            i += 1
            continue

        # 4. Relativní importy v rámci rozšíření:
        # V rootu (extension.js, prefs.js): from './lib/foo.js' -> Me.imports.lib.foo
        # V lib/ (ha.js, ma.js): from './foo.js' -> Me.imports.lib.foo
        m = re.match(r"^import\s+\*\s+as\s+([A-Za-z0-9_]+)\s+from\s+'\./(?:lib/)?([A-Za-z0-9_]+)\.js';?$", line)
        if m:
            var_name, mod_name = m.groups()
            if is_in_lib:
                out_lines.append(f"const {var_name} = Me.imports.lib.{mod_name};")
            else:
                out_lines.append(f"const {var_name} = Me.imports.lib.{mod_name};")
            i += 1
            continue

        m = re.match(r"^import\s+\{([^}]+)\}\s+from\s+'\./(?:lib/)?([A-Za-z0-9_]+)\.js';?$", line)
        if m:
            vars_list, mod_name = m.groups()
            if is_in_lib:
                out_lines.append(f"const {{{vars_list}}} = Me.imports.lib.{mod_name};")
            else:
                out_lines.append(f"const {{{vars_list}}} = Me.imports.lib.{mod_name};")
            i += 1
            continue

        # 5. Exporty:
        # export class Foo -> var Foo = class Foo
        m = re.match(r"^export\s+class\s+([A-Za-z0-9_]+)(.*)$", line)
        if m:
            cls_name, rest = m.groups()
            out_lines.append(f"var {cls_name} = class {cls_name}{rest}")
            i += 1
            continue

        # export function foo( -> var foo = function foo(
        m = re.match(r"^export\s+function\s+([A-Za-z0-9_]+)\s*\((.*)$", line)
        if m:
            fn_name, rest = m.groups()
            out_lines.append(f"var {fn_name} = function {fn_name}({rest}")
            i += 1
            continue

        # export const Foo = / export var Foo = -> var Foo =
        m = re.match(r"^export\s+(?:const|var|let)\s+([A-Za-z0-9_]+)\s*=(.*)$", line)
        if m:
            var_name, rest = m.groups()
            out_lines.append(f"var {var_name} ={rest}")
            i += 1
            continue

        # export { ... };
        m = re.match(r"^export\s*\{([^}]+)\};?$", line.strip())
        if m:
            i += 1
            continue

        if line.strip() == 'export {' or line.strip().startswith('export {'):
            while i < len(lines) and '}' not in lines[i]:
                i += 1
            i += 1  # skip closing '};' line
            continue

        # 6. Životní cyklus v extension.js:
        # export default class HMassExtension extends Extension { ... } -> let _indicator = null; function init() ...
        if is_extension_js and line.strip().startswith('export default class HMassExtension extends Extension'):
            # Nahradit celou třídu Extension funkcemi init, enable, disable pro GNOME 42
            out_lines.append("let _indicator = null;")
            out_lines.append("")
            out_lines.append("function init() {")
            out_lines.append("    ExtensionUtils.initTranslations();")
            out_lines.append("    I18n.init(ExtensionUtils.getSettings(), Me.dir);")
            out_lines.append("}")
            out_lines.append("")
            out_lines.append("function enable() {")
            out_lines.append("    if (_indicator !== null)")
            out_lines.append("        return;")
            out_lines.append("    _indicator = new HMassIndicator(Me);")
            out_lines.append("    Main.panel.addToStatusArea('hmass', _indicator);")
            out_lines.append("    _indicator._connectClients();")
            out_lines.append("}")
            out_lines.append("")
            out_lines.append("function disable() {")
            out_lines.append("    if (_indicator === null)")
            out_lines.append("        return;")
            out_lines.append("    _indicator.destroy();")
            out_lines.append("    _indicator = null;")
            out_lines.append("}")
            # Přeskočit zbytek deklarace třídy Extension až do konce souboru
            break

        # 7. Životní cyklus v prefs.js:
        # export default class HMassPreferences extends ExtensionPreferences {
        if is_prefs_js and line.strip().startswith('export default class HMassPreferences extends ExtensionPreferences'):
            out_lines.append("function init() {")
            out_lines.append("    ExtensionUtils.initTranslations();")
            out_lines.append("    I18n.init(ExtensionUtils.getSettings(), Me.dir);")
            out_lines.append("}")
            i += 1
            continue

        if is_prefs_js and line.strip().startswith('fillPreferencesWindow(window)'):
            out_lines.append("function fillPreferencesWindow(window) {")
            i += 1
            continue

        if is_prefs_js and 'this.getSettings()' in line:
            line = line.replace('this.getSettings()', 'ExtensionUtils.getSettings()')
        if is_prefs_js and 'this.dir' in line:
            line = line.replace('this.dir', 'Me.dir')

        # Pokud jsme v prefs.js a jsme na poslední neprázdné řádce s uzavírací závorkou třídy '}'
        if is_prefs_js and line.strip() in ('}', '};'):
            # Zkontrolovat, zda za tímto řádkem už nejsou žádné další neprázdné řádky
            remaining_non_empty = [l for l in lines[i+1:] if l.strip()]
            if not remaining_non_empty:
                i += 1
                continue

        out_lines.append(line)
        i += 1

    # Pokud je soubor v lib/ a používá Me, ale Me ještě není definováno:
    joined = '\n'.join(out_lines)
    if is_in_lib and 'Me.' in joined and 'const Me =' not in joined:
        header = "// GNOME 42 legacy Me import\nconst Me = imports.misc.extensionUtils.getCurrentExtension();\n"
        joined = header + joined

    return joined

def build_legacy(src_dir: str, out_dir: str):
    os.makedirs(out_dir, exist_ok=True)
    os.makedirs(os.path.join(out_dir, 'lib'), exist_ok=True)

    # 1. Zkopírovat statické assety (schemas, icons, locale, stylesheet.css, LICENSE, README)
    for asset in ['schemas', 'icons', 'locale']:
        src_path = os.path.join(src_dir, asset)
        dst_path = os.path.join(out_dir, asset)
        if os.path.exists(src_path):
            if os.path.exists(dst_path):
                shutil.rmtree(dst_path)
            shutil.copytree(src_path, dst_path)

    for f in ['stylesheet.css', 'LICENSE', 'README.md']:
        src_path = os.path.join(src_dir, f)
        if os.path.exists(src_path):
            shutil.copy2(src_path, os.path.join(out_dir, f))

    # 2. metadata.json s verzemi 42, 43, 44
    meta_src = os.path.join(src_dir, 'metadata.json')
    with open(meta_src, 'r', encoding='utf-8') as f:
        meta = json.load(f)
    meta['shell-version'] = ['42', '43', '44']
    with open(os.path.join(out_dir, 'metadata.json'), 'w', encoding='utf-8') as f:
        json.dump(meta, f, indent=4, ensure_ascii=False)
        f.write('\n')

    # 3. Transpilace JS souborů
    js_files = ['extension.js', 'prefs.js']
    lib_dir = os.path.join(src_dir, 'lib')
    if os.path.exists(lib_dir):
        for f in os.listdir(lib_dir):
            if f.endswith('.js'):
                js_files.append(os.path.join('lib', f))

    for rel_path in js_files:
        src_file = os.path.join(src_dir, rel_path)
        dst_file = os.path.join(out_dir, rel_path)
        with open(src_file, 'r', encoding='utf-8') as f:
            content = f.read()
        transformed = transform_js(content, rel_path)
        with open(dst_file, 'w', encoding='utf-8') as f:
            f.write(transformed)

    print(f"Úspěšně vygenerována GNOME 42 verze do: {out_dir}")

def main():
    import argparse
    parser = argparse.ArgumentParser(description="Transpilace GNOME Shell rozšíření z ESM na CJS (GNOME 42)")
    parser.add_argument('--src', default='.', help="Zdrojový adresář (ESM kód)")
    parser.add_argument('--out', default='build/v42', help="Výstupní adresář pro GNOME 42")
    args = parser.parse_args()

    build_legacy(os.path.abspath(args.src), os.path.abspath(args.out))

if __name__ == '__main__':
    main()
