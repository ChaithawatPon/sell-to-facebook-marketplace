# Sell to Facebook Marketplace

Public, portable skill package for seller-side Facebook Marketplace item workflows.

The repository contains one installable skill package:

- `sell-to-facebook-marketplace` — prepare item listings from a photo folder, price, and explicit evidence-backed metadata; scan seller inbox threads; send tightly-scoped safe replies/follow-ups; and audit stale listings for relisting review.

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
npm install --prefix sell-to-facebook-marketplace
python3 scripts/validate-skills.py .
python3 scripts/install-skill.py sell-to-facebook-marketplace --dest "$HOME/.codex/skills"
```

For Claude-style skill directories, replace `"$HOME/.codex/skills"` with `"$HOME/.claude/skills"`.

The installer excludes runtime-only directories such as `node_modules/`, `output/`, and `state/`, so the documented order above remains safe after `npm install`.

## Draft metadata

New listing drafts require explicit metadata JSON instead of filename-based inference. See [`sell-to-facebook-marketplace/references/listing_metadata.example.json`](sell-to-facebook-marketplace/references/listing_metadata.example.json).

Current public scope is the standard Facebook Marketplace `Item for sale` flow only. Vehicle and Home listing flows are intentionally out of scope until they are implemented and tested.

## Verify

```bash
python3 scripts/validate-skills.py .
npm test --prefix sell-to-facebook-marketplace
```

## Privacy boundary

This repository intentionally excludes browser state, cookies, screenshots, outputs, message logs, local account data, and any real listing or buyer data. Runtime state is created locally under the installed skill directory and is gitignored.

## License

[MIT](LICENSE)
