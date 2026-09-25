#!/bin/bash
# Kompletní testovací sada rozšíření: E2E protokoly + UI + prefs.
#   bash tools/tests/run-all.sh
set -u
cd "$(dirname "$0")/../.."
export GSETTINGS_BACKEND=memory
export GSETTINGS_SCHEMA_DIR="$PWD/schemas"
export GI_TYPELIB_PATH="/usr/lib/gnome-shell:/usr/lib/x86_64-linux-gnu/mutter-10"
export LD_LIBRARY_PATH="/usr/lib/gnome-shell:/usr/lib/x86_64-linux-gnu/mutter-10"

# uvolnit porty po případném dřívějším běhu
for p in 8721 8722 8723 8724 8725; do
  fuser -k ${p}/tcp 2>/dev/null || true
done

rm -f /tmp/mock-ha.log /tmp/mock-ma.log
python3 tools/tests/mock_server.py ha 8721 /tmp/mock-ha.log & P1=$!
python3 tools/tests/mock_server.py ma 8722 /tmp/mock-ma.log & P2=$!
# scénáře pro offline testy: zlobivý server, odmítnutý token, pád serveru
HM_MOCK_SCENARIO=garbage python3 tools/tests/mock_server.py ma 8723 /tmp/mock-garbage.log & P3=$!
HM_MOCK_SCENARIO=reject python3 tools/tests/mock_server.py ha 8724 /tmp/mock-reject.log & P4=$!
HM_MOCK_SCENARIO=die python3 tools/tests/mock_server.py ma 8725 /tmp/mock-die.log & P5=$!
trap 'kill $P1 $P2 $P3 $P4 $P5 2>/dev/null' EXIT
sleep 0.6

RC=0
echo "=== E2E: protokoly HA/MA + MPRIS most ==="
gjs tools/tests/run-tests.js "$PWD" || RC=1
echo
echo "=== UI: panel, menu, řádky, Indicator, MPRIS manager ==="
# načtení mutter/St knihoven drží proces po doběhnutí testů naživu,
# proto timeout a úspěch podle výsledku v výstupu
UI_OUT=$(timeout 90 gjs tools/tests/run-ui-tests.js "$PWD" 2>&1) || true
echo "$UI_OUT"
echo "$UI_OUT" | grep -q "VŠECHNY UI TESTY PROŠLY" || RC=1
echo
echo "=== Prefs: checklist přehrávačů, dedup, persist ==="
gjs tools/tests/run-prefs-tests.js "$PWD" || RC=1
echo
echo "=== Kompatibilita: Libsoup 2.4 (GNOME Shell 42 / Ubuntu 22.04) ==="
gjs tools/tests/test-soup2.js "$PWD" || RC=1

echo
if [ "$RC" -eq 0 ]; then
    echo "KOMPLETNÍ SADA PROŠLA"
else
    echo "SADA SELHALA"
fi
exit $RC
