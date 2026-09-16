// The receipt checker, for people rather than for agents.
//
// `POST /v1/verify` made the strongest claim in this project reachable by anything that
// can send JSON. This page makes it reachable by a person who has been handed a receipt
// and wants to know whether it means anything — a prospect's ops lead, a judge, a
// counterparty's finance team. None of them are going to run curl.
//
// It calls the same endpoint the CLI and the MCP tool call, so there is no second
// implementation of "verified" to disagree with the first one.

import { page, readFragment } from "./html.js";

const FRAGMENT = readFragment(new URL("./verify.html", import.meta.url));

export function verifyPageHtml(): string {
  return page(FRAGMENT, {
    description:
      "Check a signed delivery receipt: the ed25519 signature, and both Algorand transactions it names. " +
      "Works on receipts from any service using the same format.",
  });
}
