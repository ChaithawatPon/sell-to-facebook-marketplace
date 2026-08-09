#!/usr/bin/env node
/**
 * Phase 2: load the latest draft, show it to the operator, and publish only on explicit
 * per-run approval.
 *
 * Standing publish gate (non-negotiable, see SKILL.md "Standing Publish Gate"):
 * publishToFacebook() only accepts an authorization object minted by
 * requestPublishAuthorization() during THIS process run. There is no env var,
 * config field, or state file that can produce a valid authorization --
 * the only source of a usable token is the operator typing "yes" at the prompt below,
 * this run. Nothing upstream of that prompt can reach the publish click.
 *
 * Usage:
 *   node scripts/facebook_marketplace_publish.mjs
 *   node scripts/facebook_marketplace_publish.mjs --self-test
 */

import { fileURLToPath } from 'url'
import { readFileSync, readdirSync, existsSync } from 'fs'
import { join, resolve } from 'path'
import { createInterface } from 'readline/promises'
import { randomUUID } from 'crypto'
import { formatListingForDisplay, validateListing } from '../lib/marketplace_draft.mjs'
import { BROWSER_STATE_DIR, OUTPUT_DIR } from '../lib/runtime_paths.mjs'
const validAuthorizations = new WeakSet()

function loadLatestDraft() {
  if (!existsSync(OUTPUT_DIR)) {
    throw new Error(`No drafts found -- run scripts/facebook_marketplace_draft.mjs first (missing ${OUTPUT_DIR})`)
  }
  const drafts = readdirSync(OUTPUT_DIR)
    .filter((f) => f.endsWith('-listing-draft.json'))
    .sort()
  if (drafts.length === 0) {
    throw new Error('No drafts found -- run scripts/facebook_marketplace_draft.mjs first')
  }
  const latest = drafts[drafts.length - 1]
  const listing = JSON.parse(readFileSync(join(OUTPUT_DIR, latest), 'utf-8'))
  const validation = validateListing(listing)
  if (!validation.isValid) {
    throw new Error(`Draft ${latest} failed validation:\n${validation.errors.join('\n')}`)
  }
  return { listing, path: join(OUTPUT_DIR, latest) }
}

/**
 * The ONLY function in this file that can produce a value publishToFacebook()
 * will accept. It prompts the operator during this run, with no caching. Every other code path
 * either returns null (cancel) or never runs.
 */
async function requestPublishAuthorization(listing, { input = process.stdin, output = process.stdout } = {}) {
  console.log(formatListingForDisplay(listing))
  const rl = createInterface({ input, output })
  let answer
  try {
    answer = await rl.question('\nReady to publish this listing to Facebook Marketplace? Type "yes" to publish, anything else to cancel: ')
  } finally {
    rl.close()
  }

  if (String(answer).trim().toLowerCase() !== 'yes') {
    return null
  }

  // Minted fresh, in-memory, this run only. Never persisted, never read from
  // env/config/state -- the only way to obtain one is to answer "yes" above.
  const authorization = { nonce: randomUUID(), mintedAt: Date.now() }
  validAuthorizations.add(authorization)
  return authorization
}

/**
 * Structurally cannot run without a valid authorization object from
 * requestPublishAuthorization() in this same process. A missing/malformed
 * authorization throws before any browser interaction happens.
 */
async function publishToFacebook(authorization, listing) {
  if (!authorization || !validAuthorizations.has(authorization)) {
    throw new Error('publishToFacebook called without a valid per-run authorization -- refusing to publish')
  }

  const { chromium } = await import('playwright')
  const { launchPersistentContext } = await import('../lib/browser_launch.mjs')
  const context = await launchPersistentContext(
    chromium,
    BROWSER_STATE_DIR,
    { headless: false, channel: 'chrome' },
    { label: 'marketplace-publish' }
  )

  try {
    const page = context.pages()[0] || (await context.newPage())
    await page.goto('https://www.facebook.com/marketplace/create/item', { waitUntil: 'domcontentloaded' })

    const fileInput = page.locator('input[type="file"]').first()
    await fileInput.setInputFiles(listing.imagePaths)

    await page.getByLabel(/title/i).fill(listing.title)
    await page.getByLabel(/price/i).fill(String(listing.price))
    await page.getByLabel(/description/i).fill(listing.description)

    await page.getByLabel(/category/i).fill(listing.category)
    await page.keyboard.press('Enter')
    await page.getByLabel(/condition/i).fill(listing.condition)
    await page.keyboard.press('Enter')

    const publishButton = page.getByRole('button', { name: /^publish$/i })
    await publishButton.waitFor({ state: 'visible', timeout: 15000 })
    await publishButton.click()
    await page.waitForTimeout(1500)

    return { status: 'published', authorizedAt: authorization.mintedAt }
  } finally {
    await context.close()
  }
}

async function main() {
  const { listing } = loadLatestDraft()
  const authorization = await requestPublishAuthorization(listing)

  if (!authorization) {
    console.log('\nCancelled. Nothing was published.')
    return
  }

  const result = await publishToFacebook(authorization, listing)
  console.log(`\nDone: ${result.status}`)
}

async function assertRejects(fn) {
  try {
    await fn()
  } catch {
    return true
  }
  return false
}

async function runSelfTest() {
  // No stdin/browser: prove the structural gate rejects any authorization
  // that wasn't minted by requestPublishAuthorization(). Awaited directly --
  // this must not depend on microtask/macrotask ordering, since it's the one
  // test whose whole job is proving the gate can't be bypassed.
  const threwOnMissing = await assertRejects(() => publishToFacebook(null, {}))
  const threwOnForged = await assertRejects(() => publishToFacebook({ nonce: randomUUID(), mintedAt: Date.now() }, {}))

  if (!threwOnMissing || !threwOnForged) {
    console.error('✗ FAIL: publishToFacebook did not reject an invalid/forged authorization')
    process.exit(1)
  }
  console.log('✓ facebook_marketplace_publish.mjs self-test passed (gate rejects missing/forged authorization)')
  process.exit(0)
}

const isMain = resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  if (process.argv.includes('--self-test')) {
    runSelfTest()
  } else {
    main().catch((err) => {
      console.error('Fatal publish error:', err)
      process.exit(1)
    })
  }
}

export { requestPublishAuthorization, publishToFacebook, loadLatestDraft }
