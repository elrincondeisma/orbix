#!/bin/sh
# miniclaudio-hook-version: 1
# miniClaudio — reenvía el payload del hook al servidor local de la mascota.
# Diseñado para no fallar, no bloquear y no imprimir nada. Sale 0 siempre.
#
# Decisiones deliberadas (docs/design/03-contrato-eventos.md §4):
#   - /bin/sh, no bash: menos que cargar, arranca antes.
#   - Sin jq: el payload se reenvía tal cual con --data-binary @-. Cero parseo.
#   - Sin set -e: un fallo intermedio no debe abortar antes del exit 0.
#   - --data-binary y no -d: -d normaliza saltos de línea; el payload va intacto.
#   - Sin -f: no queremos que curl escriba en stderr por un 4xx.
#   - -m 1 --connect-timeout 0.3: con miniClaudio cerrado esto falla en microsegundos.

DIR="${HOME}/.claude/miniclaudio"
PORT=$(cat "${DIR}/port" 2>/dev/null) || PORT=41414
[ -z "${PORT}" ] && PORT=41414
TOKEN=$(cat "${DIR}/token" 2>/dev/null) || TOKEN=""

curl -s -m 1 --connect-timeout 0.3 \
     -X POST \
     -H 'Content-Type: application/json' \
     -H "X-MiniClaudio-Token: ${TOKEN}" \
     --data-binary @- \
     "http://127.0.0.1:${PORT}/event" >/dev/null 2>&1

exit 0
