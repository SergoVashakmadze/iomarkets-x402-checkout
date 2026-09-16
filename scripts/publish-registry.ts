// Publish `server.json` to the MCP registry — no third-party binary in the loop.
//
//   pnpm publish-registry            # validate, authenticate, publish
//   pnpm publish-registry --dry-run  # validate and authenticate, publish nothing
//
// WHY THIS EXISTS INSTEAD OF `mcp-publisher`. The documented route was
// `sudo snap install mcp-publisher`, and on 2026-09-02 that snap — version 1.1.0, packaged
// by a third party, not by the MCP maintainers — **refused our server.json as a "deprecated
// schema"**. It was wrong: the registry's own OpenAPI gives that exact schema as its example,
// 37 of the 40 most recently published servers use it, and `POST /v0/validate` answers
// `{"valid":true,"issues":[]}`. A tool that is wrong about the registry it publishes to is a
// tool to stop using.
//
// It also wanted the ed25519 **seed on its command line**, where any process on the box can
// read it out of `ps`. That is how the previous key came to be rotated on the same day. This
// script reads the PEM in-process and the seed never leaves it.
//
// The registry's own API is three calls and no install:
//   POST /v0/validate    — is this document acceptable? (no auth)
//   POST /v0/auth/dns    — sign an RFC3339 timestamp with the key whose public half is in
//                          our DNS TXT record; receive a short-lived JWT
//   POST /v0/publish     — the ServerJSON document itself as the body, Bearer that JWT.
//                          NOT wrapped in {"server": …} — that returns a confusing 422
//                          complaining about a missing $schema that is plainly present.
//
// The DNS TXT record at `iomarkets.app` is the whole trust anchor:
//   v=MCPv1; k=ed25519; p=<base64 public key>
// Rotating the key means editing that record — nothing on the box or in this repo changes.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPrivateKey, sign } from "node:crypto";

const REGISTRY = process.env.MCP_REGISTRY_URL ?? "https://registry.modelcontextprotocol.io";
const KEY_FILE = process.env.MCP_REGISTRY_KEY_FILE ?? `${process.env.HOME}/.secrets/mcp-registry-key.pem`;
const DOMAIN = process.env.MCP_REGISTRY_DOMAIN ?? "iomarkets.app";
const dryRun = process.argv.includes("--dry-run");

const server = JSON.parse(readFileSync(fileURLToPath(new URL("../server.json", import.meta.url)), "utf8")) as {
  name: string; version: string; description: string;
};
console.log(`publishing   ${server.name} v${server.version}`);
console.log(`description  ${server.description}`);
console.log(`             ${server.description.length}/100 characters\n`);

/** 1. Would the registry accept this document at all? Free, unauthenticated, catches typos. */
const validate = await fetch(`${REGISTRY}/v0/validate`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(server),
});
const validateBody = await validate.text();
console.log(`validate     ${validate.status} ${validateBody.slice(0, 200)}`);
if (!validate.ok) process.exit(1);

/**
 * 2. Prove control of the domain: ed25519 over an RFC3339 timestamp, hex-encoded.
 *
 * The timestamp must not carry milliseconds — the registry parses it strictly, and a
 * `2026-09-02T19:18:16.229Z` is rejected where `2026-09-02T19:18:16Z` is accepted.
 */
const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const signed_timestamp = sign(null, Buffer.from(timestamp), createPrivateKey(readFileSync(KEY_FILE))).toString("hex");
const auth = await fetch(`${REGISTRY}/v0/auth/dns`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ domain: DOMAIN, timestamp, signed_timestamp }),
});
const authBody = (await auth.json().catch(() => ({}))) as { registry_token?: string; expires_at?: number; detail?: string };
if (!auth.ok || !authBody.registry_token) {
  console.error(`\n⛔ auth ${auth.status}: ${authBody.detail ?? "DNS authentication failed"}`);
  console.error(`   The TXT record on ${DOMAIN} must carry the public half of ${KEY_FILE}:`);
  console.error(`     dig +short TXT ${DOMAIN}`);
  process.exit(1);
}
console.log(`auth         ok, token expires ${new Date((authBody.expires_at ?? 0) * 1000).toISOString()}`);

if (dryRun) {
  console.log("\n--dry-run: the document validates and the key authenticates. Nothing published.");
  process.exit(0);
}

/** 3. Publish. The body is the document itself. */
const publish = await fetch(`${REGISTRY}/v0/publish`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${authBody.registry_token}` },
  body: JSON.stringify(server),
});
const publishBody = await publish.text();
if (!publish.ok) {
  console.error(`\n⛔ publish ${publish.status}: ${publishBody.slice(0, 400)}`);
  // A version that already exists is the common one, and it is not a failure of this script.
  if (publish.status === 409 || /already exists/i.test(publishBody)) {
    console.error(`   That version is already published. Bump "version" in server.json.`);
  }
  process.exit(1);
}
console.log(`publish      ${publish.status} ok`);

// Read it back from the registry rather than trusting the response: the search index lags,
// so ask the versions endpoint, which is authoritative.
const versions = await fetch(`${REGISTRY}/v0/servers/${encodeURIComponent(server.name)}/versions`)
  .then((r) => r.json() as Promise<{ servers?: Array<{ server: { version: string }; _meta?: Record<string, { isLatest?: boolean }> }> }>)
  .catch(() => ({ servers: [] }));
for (const entry of versions.servers ?? []) {
  const latest = entry._meta?.["io.modelcontextprotocol.registry/official"]?.isLatest;
  console.log(`  v${entry.server.version}${latest ? "  ← isLatest" : ""}`);
}
console.log(`\n✅ ${server.name} v${server.version} published. The search index takes a few minutes to catch up.`);
