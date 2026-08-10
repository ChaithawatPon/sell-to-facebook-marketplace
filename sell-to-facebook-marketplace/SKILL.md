---
name: sell-to-facebook-marketplace
description: Create, update, and manage Facebook Marketplace seller item listings, including preparing new item listings, handling safe buyer replies, reviewing stale inventory, and running approval-gated update, delete, or delete-and-relist maintenance. Use when a user wants seller-side Marketplace item help. Publishing, public listing changes, and deletion require fresh exact approval each run.
---

# Sell to Facebook Marketplace

Seller-side Facebook Marketplace automation with a hard publish gate.

The package supports four main modes:

1. Draft a new item listing from a photo folder, price, and explicit metadata JSON.
2. Scan or auto-handle seller inbox threads when the latest buyer message can be answered safely from visible evidence.
3. Audit active listings for low engagement and write a relisting review plan.
4. Prepare and approval-gate one exact stale-listing update, delete, or Facebook `Delete & relist` action from a validated maintenance packet, then verify the manually applied result.

## Safety model

- New listing publication always requires an explicit per-run `yes` after Facebook's own preview is visible immediately before the final Publish button.
- Seller inbox automation is limited to verified seller-side threads, evidence-backed answers, and one follow-up after at least 24 hours of buyer silence.
- Inventory review is non-destructive. It records a canonical listing ID and URL when exactly one can be verified; missing or ambiguous identities remain review-only.
- Maintenance is never part of autopilot. The preview tool accepts exactly one listing per packet, verifies the live listing and action affordance, and requires the operator to type `approve <packet_id> <listing_id> <action>` in the same process.
- Prior chat approval, packet contents, command flags, environment variables, and saved state cannot authorize an update or deletion. A changed live preview invalidates approval.
- The packaged maintenance session never clicks a public-action control. After fresh approval, the operator applies the exact action manually in Facebook; the same process then reloads, verifies, and records the outcome before reporting success. It does not mark items sold or out of stock.
- Runtime state lives in local `state/` and `output/` directories created at run time and excluded from version control.

## Default autopilot

When the user invokes the skill without a narrower subtask, run:

1. Open `https://www.facebook.com/marketplace/inbox/`.
2. Scan Marketplace seller conversations.
3. Auto-send concise Thai replies only when all of the following are true:
   - the account is clearly the seller of the linked listing;
   - the latest substantive message is from the buyer;
   - the reply is directly supported by the visible listing details or thread context; and
   - the buyer is not negotiating, requesting a commitment, or asking for a sale-status change.
4. Auto-send at most one follow-up when the seller sent the latest substantive message at least 24 hours ago, the listing is still active, and no prior follow-up remains unanswered.
5. Open `https://www.facebook.com/marketplace/you/selling/`.
6. Flag active listings with fewer than 10 visible clicks in 14 days or more than 7 days live.
7. Write a review plan JSON file under local `output/`. Do not invoke maintenance automatically.

## Listing draft workflow

Use this when the user wants to create an item listing.

1. Start at `https://www.facebook.com/marketplace/create`.
2. Use the `Item for sale` flow only. This public package does not currently support Vehicle or Home listing routes.
3. Attach photos through Facebook's upload flow and confirm the clearest full-item photo is first.
4. Supply explicit metadata JSON for title, category, condition, and description. The draft helper will not infer claims from filenames or image names.
5. Fill the live form with accurate text only. Use relevant Thai and English search terms; never pad with unrelated keywords.
6. Advance to Facebook's own preview step immediately before the final Publish button.
7. Show the draft plus Facebook preview snapshot and wait for a fresh approval prompt.
8. Publish only if the operator types `yes` in that process run while that preview is on screen.

## Inbox workflow

Use inbox mode for seller-side buyer messages.

1. Open `https://www.facebook.com/marketplace/inbox/`.
2. Inspect conversations where the latest substantive message is from the buyer or where a seller follow-up may now be eligible.
3. Confirm the linked listing and that the account is the seller before replying.
4. Auto-reply only when the answer is evidence-backed or a safe clarifying question.
5. Skip the thread and surface it for manual handling when:
   - the account appears to be the buyer instead of the seller;
   - a third party owns the listing;
   - the item identity is unclear;
   - the buyer is negotiating, asking for a hold, deposit, reservation, or status change; or
   - the reply would require inventing dimensions, warranty, delivery, availability, or other facts not visible in the listing or thread.

## Follow-up policy

- Send at most one follow-up after 24 hours of buyer silence.
- Require that the seller sent the last substantive message.
- Require that the listing is still active.
- Match the established Thai tone in the thread when possible.
- Store dedupe state locally so the same unanswered thread is not followed up twice.

The neutral fallback line is:

`หากมีคำถามเพิ่มเติมเกี่ยวกับรายการนี้ สอบถามได้เลยครับ`

## Inventory review

Use selling-page audit mode for active listings.

1. Open `https://www.facebook.com/marketplace/you/selling/`.
2. Capture visible title, price, listed-on date, status, click count, and exactly one canonical `/marketplace/item/<id>/` identity from each active listing card when available.
3. Mark a listing stale when either:
   - the visible 14-day click count is below 10; or
   - the listing has stayed active for at least 7 days.
4. If Facebook exposes `Delete & relist`, recommend `delete_and_relist_review`.
5. Otherwise recommend `refresh_content_review` with title, keyword, and lead-photo improvements.
6. Write the plan to local `output/` for later manual action. A candidate with a missing or ambiguous listing identity is not maintenance-eligible.

## Stale-listing maintenance

Use maintenance mode only after reviewing the inventory plan and agreeing on one exact listing and action.

1. Copy `references/maintenance_packet.example.json` and replace every example value, including `created_at` and `expires_at`, with the exact current listing evidence. It must contain exactly one canonical Facebook Marketplace item URL, its matching numeric listing ID, expected current title and price, an expiry time no more than 30 minutes after creation, and one action: `update`, `delete`, or `delete_and_relist`.
2. For `update`, include at least one exact replacement among `title`, `price_thb`, `description`, `category`, or `condition`. Deletion actions cannot include changes.
3. Run the packet preview. The workflow rejects packets longer than 30 minutes, expired packets, mismatched URLs, unsupported fields, and missing or ambiguous live identity.
4. Inspect the live pre-action snapshot. The listing title and price must match the packet, and Facebook must expose the exact edit or destructive action named by the packet. The tool does not click it.
5. Keep the process open and show the operator the exact approval token. Treat anything other than that exact token as cancellation. The tool refreshes and rechecks the preview after the token; because the public click remains manual, the operator must not act after the five-minute session window expires.
6. After approval, apply only the approved fields or exact Facebook action manually, then request verification within five minutes. For a destructive action, inspect Facebook's own final confirmation dialog before the manual click and stop if its listing/action differs. The tool records `verification_failed` for an expired session but cannot prevent an out-of-band manual click.
7. Reload and verify: updates must show every approved field, deletion needs both seller-page absence and an unavailable original page, and delete-and-relist needs original absence plus exactly one matching replacement with a distinct ID.
8. Record the machine-readable outcome locally: `verification_cancelled` when the operator declines the verification step, `verification_failed` when evidence is incomplete or mismatched, and `verified` only when every postcondition passes. Never claim completion from a click alone.

Do not batch packets, infer changes, invoke the maintenance session from autopilot, or substitute `Mark as sold`/`Mark out of stock` for the approved action.

## UI reliability notes

- Facebook's `More details` panel can fail to expand after redraws. Focus the button and press Enter if a pointer click is unreliable.
- The final creation flow can show both `Next` and `View next image`. Match the exact accessible name `Next` so the script never advances the photo carousel by mistake.
- If the script cannot reach Facebook's own preview page and final `Publish` button for the standard item flow, it must abort rather than ask for approval early.

## Commands

From the installed skill directory:

```bash
# Default autopilot: inbox automation + stale listing audit
node scripts/facebook_marketplace_autopilot.mjs

# Draft an item listing from a photo folder, price, and explicit metadata JSON
node scripts/facebook_marketplace_draft.mjs <image-folder> <price> --metadata references/listing_metadata.example.json

# Confirm and publish the latest draft
node scripts/facebook_marketplace_publish.mjs

# Scan buyer conversations without sending
node scripts/facebook_marketplace_inbox.mjs --scan

# Auto-send safe buyer replies and eligible follow-ups
node scripts/facebook_marketplace_inbox.mjs --auto

# Audit active listings and write a relisting review plan
node scripts/facebook_marketplace_inventory.mjs --scan

# Run one preview/approval/manual-action/reload-verification session (the tool does not click)
node scripts/facebook_marketplace_maintenance.mjs --packet references/maintenance_packet.example.json

# Run package self-tests
npm test
```

If the package was installed via this repository's `scripts/install-skill.py`, production dependencies are already installed in the destination. Only manual copies need a separate `npm ci`.

## Runtime layout

The repository ships only source files. These local runtime directories are created on demand and are intentionally gitignored:

```text
sell-to-facebook-marketplace/
├── output/   # generated draft, summary, and review JSON
└── state/    # browser profile cache, prepared image conversions, follow-up state
```

## Guardrails summary

- No API keys and no third-party Marketplace API usage.
- No auto-publish or public maintenance without fresh in-process confirmation bound to Facebook's live preview/action step.
- The packaged maintenance command is preview-only and contains no public-action click path.
- No bulk maintenance, unstable listing identity, saved approval, or success without post-action reload verification.
- No auto-negotiation, holds, reservations, status changes, or guessed item facts.
- No committed browser state, cookies, screenshots, message logs, or real listing data.
