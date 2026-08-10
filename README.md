# Sell to Facebook Marketplace

Public, portable skill package for seller-side Facebook Marketplace item workflows.

The repository contains one installable skill package:

- `sell-to-facebook-marketplace` — prepare item listings from explicit evidence, handle tightly-scoped seller inbox work, audit stale inventory, and preview/approval-gate one update, delete, or delete-and-relist action with post-action verification rules.

## What is included

- `sell-to-facebook-marketplace/SKILL.md` — the skill contract and workflow
- `sell-to-facebook-marketplace/lib/` — shared runtime helpers
- `sell-to-facebook-marketplace/scripts/` — listing, inbox, inventory, and self-test entry points
- `sell-to-facebook-marketplace/references/` — public reference material needed by the skill
- `sell-to-facebook-marketplace/tests/` — smoke tests that run the built-in self-tests
- `scripts/validate-skills.py` — repository validator for the public package contract
- `scripts/install-skill.py` — additive installer that refuses to overwrite an existing skill

## Install

```bash
git clone https://github.com/ChaithawatPon/sell-to-facebook-marketplace.git
cd sell-to-facebook-marketplace
python3 scripts/validate-skills.py .
python3 scripts/install-skill.py sell-to-facebook-marketplace --dest "$HOME/.codex/skills"
```

For Claude-style skill directories, replace `"$HOME/.codex/skills"` with `"$HOME/.claude/skills"`.

The installer copies the package without runtime directories such as `node_modules/`, `output/`, and `state/`, then runs `npm ci --omit=dev` inside the installed destination. If dependency installation fails, the installer removes the incomplete target instead of leaving a broken skill behind.

Optional post-install verification from the installed skill directory:

```bash
cd "$HOME/.codex/skills/sell-to-facebook-marketplace"
node --input-type=module -e "const { chromium } = await import('playwright'); console.log(typeof chromium.launch)"
```

## Draft metadata

New listing drafts require explicit metadata JSON instead of filename-based inference. See [`sell-to-facebook-marketplace/references/listing_metadata.example.json`](sell-to-facebook-marketplace/references/listing_metadata.example.json).

Current public scope is the standard Facebook Marketplace `Item for sale` flow only. Vehicle and Home listing flows are intentionally out of scope until they are implemented and tested.

## Stale-listing maintenance

The inventory scan remains read-only. It captures a canonical listing ID/URL when one unique Marketplace item link is visible and marks missing or ambiguous identities ineligible for maintenance.

To act, copy [`sell-to-facebook-marketplace/references/maintenance_packet.example.json`](sell-to-facebook-marketplace/references/maintenance_packet.example.json), replace all fake identity/content and timestamps with current evidence (the packet may live for at most 30 minutes), then run:

```bash
node sell-to-facebook-marketplace/scripts/facebook_marketplace_maintenance.mjs --packet /path/to/maintenance-packet.json
```

The command validates the packet and live listing, displays and refreshes the pre-action snapshot, and accepts only the exact token `approve <packet_id> <listing_id> <action>` in that same process. It contains no public-action click path: apply the approved action manually in the open Facebook window, then type the exact verification phrase within five minutes. The same process reloads Facebook and writes a local `verified`, `verification_failed`, or `verification_cancelled` outcome. Autopilot never invokes maintenance, and the package provides no flag, environment variable, or stored-state approval bypass.

## Verify

```bash
python3 scripts/validate-skills.py .
npm test --prefix ./sell-to-facebook-marketplace
```

## Privacy boundary

This repository intentionally excludes browser state, cookies, screenshots, outputs, message logs, local account data, and any real listing or buyer data. Runtime state is created locally under the installed skill directory and is gitignored.

## License

[MIT](LICENSE)
