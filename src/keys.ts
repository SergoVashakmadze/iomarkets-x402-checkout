// Secret loading. Algorand's guidance: never put mnemonics in .env / git. The
// server holds exactly ONE hot key (the refund float); PAY_TO is an address only.
//
// Resolution order for a secret NAME:
//   1. NAME_FILE            — path to a root-owned, mode 0400 file (one line)
//   2. $CREDENTIALS_DIRECTORY/<name-in-kebab-case>   — systemd LoadCredentialEncrypted=
//   3. NAME env var         — dev only; the server logs a warning
// Upgrade path: a KMS-backed signer (GCP Cloud KMS EdDSA / a hardware wallet) only
// has to implement Refunder.send(); nothing else touches the key.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export function loadSecret(name: string, opts: { warn?: (msg: string) => void } = {}): string {
  const file = process.env[`${name}_FILE`];
  if (file) {
    // A configured-but-unreadable path is an operator error, and it must stay
    // fatal — treating it as "unset" would start the service with refunds
    // silently disabled. But a bare ENOENT stack out of node:fs says nothing
    // about which variable is wrong, and on a container deploy the usual cause
    // is ownership rather than a typo (the bind mount is root-owned, the
    // process is not). Name both possibilities.
    try {
      return readFileSync(file, "utf8").trim();
    } catch (e) {
      const why = (e as NodeJS.ErrnoException).code === "EACCES"
        ? "not readable by this process — check the file's owner and mode"
        : "does not exist";
      throw new Error(`${name}_FILE points at ${file}, which ${why}. Fix the path, or unset ${name}_FILE if this deployment has no ${name.toLowerCase().replace(/_/g, " ")}.`);
    }
  }
  const credDir = process.env.CREDENTIALS_DIRECTORY;
  if (credDir) {
    try { return readFileSync(join(credDir, name.toLowerCase().replace(/_/g, "-")), "utf8").trim(); } catch { /* not provided */ }
  }
  const env = process.env[name];
  if (env) {
    opts.warn?.(`⚠️  ${name} is being read from the environment. Use ${name}_FILE (0400, root-owned) or a systemd credential in production.`);
    return env.trim();
  }
  return "";
}
