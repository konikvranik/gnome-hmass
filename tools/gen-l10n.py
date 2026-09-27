#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
# SPDX-FileCopyrightText: 2026 konikvranik
"""
Generuje JSON překladové mapy z .po souborů pro vynucený jazyk rozhraní
(nastavení interface-language). Gettext totiž neumí přepnout jazyk jen pro
jedno rozšíření (setlocale je procesové), proto v tomto režimu mapujeme
msgid -> msgstr rovnou z JSON.

    python3 tools/gen-l10n.py po/cs.po locale/l10n/cs.json
"""

import json
import sys


def po_unescape(s):
    out = []
    i = 0
    while i < len(s):
        c = s[i]
        if c == '\\' and i + 1 < len(s):
            n = s[i + 1]
            out.append({'n': '\n', 't': '\t', '"': '"', '\\': '\\'}.get(n, n))
            i += 2
        else:
            out.append(c)
            i += 1
    return ''.join(out)


def parse_po(path):
    entries = []
    mid = mstr = None
    state = None

    def unquote(lines):
        raw = ''.join(lines)
        if len(raw) >= 2 and raw[0] == '"' and raw[-1] == '"':
            raw = raw[1:-1]
        return po_unescape(raw)

    def flush():
        if mid is not None and mstr:
            entries.append((unquote(mid), unquote(mstr)))

    for line in open(path, encoding='utf-8'):
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        if line.startswith('msgid '):
            flush()
            mid, mstr, state = [line[6:].strip()], None, 'id'
        elif line.startswith('msgstr '):
            mstr, state = [line[7:].strip()], 'str'
        elif line.startswith('"') and state == 'id':
            mid.append(line)
        elif line.startswith('"') and state == 'str':
            mstr.append(line)
    flush()
    return entries


def main():
    src, dst = sys.argv[1], sys.argv[2]
    result = {}
    for msgid, msgstr in parse_po(src):
        if msgid and msgstr:
            result[msgid] = msgstr
    with open(dst, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=0, sort_keys=True)
        f.write('\n')
    print(f'{dst}: {len(result)} překladů')


if __name__ == '__main__':
    main()
