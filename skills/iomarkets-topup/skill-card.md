## Description:

IoMarkets Topup helps agents quote and buy travel eSIMs and mobile airtime or data top-ups with USDC on Algorand via x402.

This skill is ready for commercial/non-commercial use.

## Publisher:

[sergovashakmadze](https://clawhub.ai/user/sergovashakmadze)

### License/Terms of Use:

MIT-0

## Use Case:

External users and agent developers use this skill to buy travel eSIMs for a traveller's own phone across 197 destinations, and to look up mobile operators, quote USDC prices, and complete human-confirmed airtime or data top-ups for supported phone numbers.

### Deployment Geography for Use:

Global, subject to live catalog availability in supported countries.

## Known Risks and Mitigations:

Risk: The skill can initiate paid purchases.

Mitigation: Require explicit human confirmation of what is delivered, to whom, and the USDC price before every purchase, and keep a low wallet budget.

Risk: Operator auto-detection can be wrong for MVNO phone numbers, and a voucher bought for the wrong network may be delivered without being redeemable or refundable.

Mitigation: Confirm the operator with the human before buying and use the alternate brand information the lookup returns to correct the selected network.

Risk: An eSIM bought for the wrong destination or an unsupported device is not refundable once installed.

Mitigation: Confirm the destination and the validity window with the human before buying, and check the device supports eSIM. eSIMs are sold for travel on ordinary consumer smartphones; the upstream supplier's terms exclude routers, dongles, IoT devices, hotspots and automated background traffic.

Risk: Local MCP use can expose wallet-signing capability if the mnemonic is mishandled.

Mitigation: Prefer the hosted MCP when possible; for local signing, store the mnemonic in a protected file and avoid inline secrets in configuration.

Risk: Some product types are supplier-gated or unavailable even if implemented.

Mitigation: Use the live catalog as the authority before offering prepaid bills, international payouts, or any option to a human. A quote for an unavailable type is refused up front rather than accepted and then failed.

## Reference(s):

- [IoMarkets homepage](https://iomarkets.app)
- [IoMarkets agent documentation](https://iomarkets.app/agent.md)
- [Receipt format and public verifier](https://iomarkets.app/receipts.md)
- [IoMarkets Topup ClawHub listing](https://clawhub.ai/sergovashakmadze/skills/iomarkets-topup)

## Skill Output:

**Output Type(s):** [Guidance, API calls, Shell commands, Configuration]

**Output Format:** [Markdown text with HTTP examples and JSON MCP configuration snippets]

**Output Parameters:** [1D]

**Other Properties Related to Output:** [May include human-confirmation wording, quote and order status details, eSIM activation (LPA) strings, receipt or refund links, and budget or operator checks.]

## Skill Version(s):

0.2.6 (source: frontmatter and server release metadata)

## Ethical Considerations:

Users should evaluate whether this skill is appropriate for their environment, review any generated or modified files before relying on them, and apply their organization's safety, security, and compliance requirements before deployment.
