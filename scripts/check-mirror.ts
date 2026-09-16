// Does the PUBLIC plugin mirror still match this repo?
//
//   pnpm check-mirror
//
// Read-only. Fetches the three published files over HTTPS and diffs them against the
// local ones. Exits non-zero on any difference.
//
// WHY THIS EXISTS. `SergoVashakmadze/iomarkets-topup-plugin` is a separate public repo
// and **nothing links it to this one** — no submodule, no CI, no subtree. It is what
// `/plugin marketplace add` installs, so it is the copy strangers actually run, and it
// has drifted twice:
//
//   • 2026-08-28 → 09-01: the mirror advertised eSIMs, prepaid bills and payouts for
//     four days after this repo stopped selling them. Caught by a person remembering.
//   • 2026-09-01 → 09-02: the REVERSE, and nobody had thought to look. The mirror was
//     corrected to v0.2.0 with an honest description, and **this repo kept the old
//     v0.1.0 manifest** still promising "travel eSIMs, and bank / mobile-money / UPI
//     payouts in 150+ countries". The handover's rule only pointed one way.
//
// A rule that has to be remembered in both directions is a rule that will be forgotten
// in one of them. This is thirty seconds and it cannot be forgotten in either.
//
// It is a script rather than a test on purpose: it depends on GitHub being reachable,
// and a test suite that fails when a third party has a bad minute is a test suite people
// learn to ignore — the lesson from `test/challenge-tag.test.ts`.

import { readFileSync } from "node:fs";

const RAW = "https://raw.githubusercontent.com/SergoVashakmadze/iomarkets-topup-plugin/main";

/** Published path → local path. Everything the mirror carries that we also hold. */
const FILES: Array<[string, string]> = [
  [".claude-plugin/plugin.json", ".claude-plugin/plugin.json"],
  [".claude-plugin/marketplace.json", ".claude-plugin/marketplace.json"],
  ["skills/iomarkets-topup/SKILL.md", "skills/iomarkets-topup/SKILL.md"],
];

/** Trailing-whitespace and final-newline differences are not drift worth failing on. */
const normalise = (s: string) => s.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trimEnd();

/** The first line that differs, which is the only one anyone reads. */
function firstDifference(a: string, b: string): string {
  const left = a.split("\n"), right = b.split("\n");
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] !== right[i]) {
      return `line ${i + 1}\n      published: ${(left[i] ?? "(absent)").slice(0, 120)}\n      local:     ${(right[i] ?? "(absent)").slice(0, 120)}`;
    }
  }
  return "(files differ only in whitespace)";
}

let drift = 0;
let unreachable = 0;

for (const [remote, local] of FILES) {
  let published: string;
  try {
    const res = await fetch(`${RAW}/${remote}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      // A file the mirror does not have at all is real drift, not an outage.
      if (res.status === 404) {
        console.log(`✗ ${remote}\n      not published on the mirror at all`);
        drift++;
        continue;
      }
      console.log(`? ${remote}  HTTP ${res.status} — could not check`);
      unreachable++;
      continue;
    }
    published = await res.text();
  } catch (e) {
    console.log(`? ${remote}  ${(e as Error).message} — could not check`);
    unreachable++;
    continue;
  }

  const here = readFileSync(local, "utf8");
  if (normalise(published) === normalise(here)) {
    console.log(`✓ ${remote}`);
  } else {
    console.log(`✗ ${remote}  DRIFT at ${firstDifference(normalise(published), normalise(here))}`);
    drift++;
  }
}

// The version is the thing a user sees before they see anything else, so it gets named.
try {
  const local = JSON.parse(readFileSync(".claude-plugin/plugin.json", "utf8")) as { version?: string };
  console.log(`\nplugin version (local): ${local.version ?? "unset"}`);
} catch { /* the diff above already said the file is unreadable */ }

if (drift) {
  console.error(
    `\n⛔ ${drift} file(s) differ from the published mirror.\n` +
    `   Decide which side is right — it has been each of them once — then copy and push:\n` +
    `     git clone git@github.com:SergoVashakmadze/iomarkets-topup-plugin.git\n` +
    `   The mirror is what \`/plugin marketplace add\` installs, so the published copy is\n` +
    `   the one strangers run. Bump the version in BOTH plugin.json and marketplace.json.`,
  );
  process.exit(1);
}
if (unreachable) {
  console.error(`\n⚠️  ${unreachable} file(s) could not be checked. That is a statement about GitHub, not about the mirror — re-run.`);
  process.exit(2);
}
console.log("\n✅ the published mirror matches this repo.");
