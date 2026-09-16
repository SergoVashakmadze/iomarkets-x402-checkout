#!/bin/sh
# Container entrypoint. This is the Docker equivalent of the systemd unit's
# ExecStartPre: refuse to start on a configuration that cannot take money.
#
# Without this the container would happily serve quotes and 402 challenges while
# PAY_TO is not opted in to USDC, or SUPPLIER=mock delivers nothing — taking
# payments it can never settle. Exiting non-zero here makes Docker's restart
# policy back off instead, which is the behaviour we want: visibly broken beats
# silently taking money.
set -e

TSX=/app/node_modules/.bin/tsx

echo "→ preflight (production gate)"
"$TSX" /app/scripts/preflight.ts --production

echo "→ starting server"
exec "$TSX" /app/src/server.ts
