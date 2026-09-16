# IoMarkets Topup as a container.
#
# The production host runs everything in Docker, including Caddy,
# which owns 80/443 — there is no host Caddy and no host Node. So the systemd
# path in deploy/iomarkets-app.service does not apply there; use deploy/entrypoint.sh.
#
# No native modules: persistence is Node's built-in node:sqlite (hence Node >= 22.5
# in package.json engines), which is why --ignore-scripts is safe here.

FROM node:24-alpine AS deps
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@10.30.0 --activate
COPY package.json pnpm-lock.yaml ./
# --prod: tsx is a runtime dependency (it executes src/*.ts), so this still runs.
RUN pnpm install --frozen-lockfile --ignore-scripts --prod

# ── the batch payout console (web/) ───────────────────────────────────────────
# A CLIENT-ONLY build: `dist/client` is a prerendered shell plus hashed assets, which
# the Hono process serves at /pay (src/pay-console.ts). No second server, so nothing
# to route between and no CORS. bun is the package manager web/ ships with (bun.lock).
FROM oven/bun:1.4-alpine AS web
WORKDIR /web
COPY web/package.json web/bun.lock ./
RUN bun install --frozen-lockfile
COPY web/ ./
RUN bun run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production

# Unprivileged, no home, no shell to hijack — the systemd unit's User=iomarkets.
#
# The uid/gid are PINNED. Alpine's `adduser -S` would otherwise pick whatever is
# free (100:101 on the first build), and the host-side secret files that get
# bind-mounted in — /etc/iomarkets/topup.env, /etc/iomarkets/refund.mnemonic —
# have to be chown'd to a uid known in advance. Get this wrong and the container
# cannot read .env; dotenv then fails SILENTLY and the app falls back to its
# defaults, which means NETWORK=testnet on a mainnet box. `preflight --production`
# is what catches it .
RUN addgroup -S -g 10001 iomarkets \
 && adduser -S -u 10001 -G iomarkets -H -s /sbin/nologin iomarkets

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
# The receipt spec is served at /receipts.md, so it ships with the code rather than
# being duplicated into a template string that would drift. docs/RECEIPTS.md.
COPY docs/RECEIPTS.md ./docs/RECEIPTS.md
COPY deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
# src/pay-console.ts resolves ../web/dist/client relative to itself, so the layout
# inside the image has to mirror the repo's. Assets only — no node_modules, no source.
COPY --from=web /web/dist/client ./web/dist/client

# The SQLite db and its WAL are the only state the service writes; everything
# else is read-only at runtime (read_only: true in the compose file).
RUN mkdir -p /app/data \
 && chown -R iomarkets:iomarkets /app/data \
 && chmod +x /usr/local/bin/entrypoint.sh

USER iomarkets
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
