---
name: sell-to-facebook-marketplace
description: Create, update, and manage Facebook Marketplace seller listings, including drafting new listings from photos and price, scanning seller inbox conversations, sending tightly-scoped safe buyer replies or one-time follow-ups, and reviewing stale listings for relisting. Use when a user wants seller-side Marketplace help. Publishing, public listing changes, and deletion still require fresh explicit approval each run.
---

# Sell to Facebook Marketplace

Seller-side Facebook Marketplace automation with a hard publish gate.

The package supports three main modes:

1. Draft a new listing from a photo folder and price.
2. Scan or auto-handle seller inbox threads when the latest buyer message can be answered safely from visible evidence.
3. Audit active listings for low engagement and write a relisting review plan.

## Safety model

- New listing publication always requires an explicit per-run `yes` at the final confirmation prompt.
- Seller inbox automation is limited to verified seller-side threads, evidence-backed answers, and one follow-up after at least 24 hours of buyer silence.
- Inventory review is non-destructive. It can recommend relisting work, but it does not delete, repost, or mark listings sold.
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
7. Write a review plan JSON file under local `output/`.

## Listing draft workflow

Use this when the user wants to create a listing from photos.

1. Start at `https://www.facebook.com/marketplace/create`.
2. Choose the correct listing type:
   - `Item for sale` for ordinary products
   - `Vehicle for sale` for cars or motorcycles
   - `Home for sale or rent` for property
3. Attach photos through Facebook's upload flow and confirm the clearest full-item photo is first.
4. Draft title, category, condition, and description from the photo folder and price.
5. Fill the live form with accurate text only. Use relevant Thai and English search terms; never pad with unrelated keywords.
6. Show the drafted result and wait for a fresh approval prompt.
7. Publish only if the operator types `yes` in that process run.

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
2. Capture visible title, price, listed-on date, status, and click count from each active listing card.
3. Mark a listing stale when either:
   - the visible 14-day click count is below 10; or
   - the listing has stayed active for at least 7 days.
4. If Facebook exposes `Delete & relist`, recommend `delete_and_relist_review`.
5. Otherwise recommend `refresh_content_review` with title, keyword, and lead-photo improvements.
6. Write the plan to local `output/` for later manual action.

## UI reliability notes

- Facebook's `More details` panel can fail to expand after redraws. Focus the button and press Enter if a pointer click is unreliable.
- The final creation flow can show both `Next` and `View next image`. Match the exact accessible name `Next` so the script never advances the photo carousel by mistake.

## Commands

From the installed skill directory:

```bash
# Install dependencies once
npm install

# Default autopilot: inbox automation + stale listing audit
node scripts/facebook_marketplace_autopilot.mjs

# Draft a listing from a photo folder and price
node scripts/facebook_marketplace_draft.mjs <image-folder> <price>

# Confirm and publish the latest draft
node scripts/facebook_marketplace_publish.mjs

# Scan buyer conversations without sending
node scripts/facebook_marketplace_inbox.mjs --scan

# Auto-send safe buyer replies and eligible follow-ups
node scripts/facebook_marketplace_inbox.mjs --auto

# Audit active listings and write a relisting review plan
node scripts/facebook_marketplace_inventory.mjs --scan

# Run package self-tests
npm test
```

## Runtime layout

The repository ships only source files. These local runtime directories are created on demand and are intentionally gitignored:

```text
sell-to-facebook-marketplace/
├── output/   # generated draft, summary, and review JSON
└── state/    # browser profile cache, prepared image conversions, follow-up state
```

## Guardrails summary

- No API keys and no third-party Marketplace API usage.
- No auto-publish without a fresh in-process confirmation.
- No auto-negotiation, holds, reservations, status changes, or guessed item facts.
- No committed browser state, cookies, screenshots, message logs, or real listing data.
