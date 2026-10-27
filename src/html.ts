// Serving a page that was authored as an Artifact body fragment.
//
// `src/console.html` and `src/verify.html` are written the way the Artifact tool wants
// them — no <!doctype>, no <head>, with the <title> and the font <link> sitting at the
// top of the body — because that is what makes them previewable and editable as
// artifacts. A <title> parsed inside <body> is not reliably honoured, so both tags are
// lifted into a real <head> here rather than trusting the parser to do it.
//
// Shared so that the two pages cannot answer this question differently.

import { readFileSync } from "node:fs";

export interface Fragment {
  /** The <title> and <link> tags, ready for a real <head>. */
  head: string;
  /** Everything else, ready for <body>. */
  body: string;
}

const HEAD_TAG = /^\s*(?:<title>[\s\S]*?<\/title>|<link\b[^>]*>)\s*/gm;

/** Read once at startup — these pages are static and the container is immutable. */
export function readFragment(url: URL): Fragment {
  const raw = readFileSync(url, "utf8");
  return { head: (raw.match(HEAD_TAG) ?? []).join(""), body: raw.replace(HEAD_TAG, "") };
}

/** The document around a fragment. `inject` is script/meta the page needs, verbatim. */
export function page(f: Fragment, opts: { description: string; inject?: string }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="${opts.description.replace(/"/g, "&quot;")}">
${f.head}
<style>html{color-scheme:light dark}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>
${opts.inject ?? ""}
</head><body>
${f.body}
</body></html>`;
}
