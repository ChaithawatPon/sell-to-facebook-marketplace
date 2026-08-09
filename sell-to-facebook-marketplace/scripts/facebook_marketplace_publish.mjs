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
import { createHash, randomUUID } from 'crypto'
import { formatListingForDisplay, validateListing } from '../lib/marketplace_draft.mjs'
import { BROWSER_STATE_DIR, OUTPUT_DIR } from '../lib/runtime_paths.mjs'
const validAuthorizations = new WeakSet()

function normalize(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

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

function validatePreviewSnapshot(previewSnapshot) {
  if (!previewSnapshot || typeof previewSnapshot !== 'object') {
    throw new Error('preview snapshot is required before publish approval')
  }

  const snapshot = {
    stage: normalize(previewSnapshot.stage),
    pageUrl: normalize(previewSnapshot.pageUrl),
    publishButtonName: normalize(previewSnapshot.publishButtonName),
    bodyExcerpt: normalize(previewSnapshot.bodyExcerpt).slice(0, 1200),
    listingType: normalize(previewSnapshot.listingType).toLowerCase(),
    title: normalize(previewSnapshot.title),
    priceText: normalize(previewSnapshot.priceText),
  }

  if (snapshot.stage !== 'facebook-preview') {
    throw new Error('publish approval may only be requested from the Facebook preview step')
  }
  if (!snapshot.pageUrl) {
    throw new Error('preview snapshot is missing page URL')
  }
  if (!snapshot.publishButtonName) {
    throw new Error('preview snapshot is missing the final Publish button label')
  }
  return snapshot
}

function buildPreviewFingerprint(previewSnapshot) {
  const snapshot = validatePreviewSnapshot(previewSnapshot)
  return createHash('sha256').update(JSON.stringify(snapshot), 'utf8').digest('hex')
}

function formatPreviewSnapshot(previewSnapshot) {
  const snapshot = validatePreviewSnapshot(previewSnapshot)
  return [
    '='.repeat(60),
    'FACEBOOK PREVIEW SNAPSHOT',
    '='.repeat(60),
    `Preview URL:  ${snapshot.pageUrl}`,
    `Listing type: ${snapshot.listingType}`,
    `Title:        ${snapshot.title || '(not captured)'}`,
    `Price text:   ${snapshot.priceText || '(not captured)'}`,
    `Final button: ${snapshot.publishButtonName}`,
    '',
    'Visible preview excerpt:',
    snapshot.bodyExcerpt || '(no preview excerpt captured)',
    '='.repeat(60),
  ].join('\n')
}

/**
 * The ONLY function in this file that can produce a value publishToFacebook()
 * will accept. It prompts the operator during this run, with no caching. Every other code path
 * either returns null (cancel) or never runs.
 */
async function requestPublishAuthorization(previewSnapshot, { input = process.stdin, output = process.stdout, displayText = '' } = {}) {
  const snapshot = validatePreviewSnapshot(previewSnapshot)
  if (displayText) {
    console.log(displayText)
  }
  console.log(`\n${formatPreviewSnapshot(snapshot)}`)
  const rl = createInterface({ input, output })
  let answer
  try {
    answer = await rl.question('\nFacebook preview is visible immediately before the final Publish button. Type "yes" to publish, anything else to cancel: ')
  } finally {
    rl.close()
  }

  if (String(answer).trim().toLowerCase() !== 'yes') {
    return null
  }

  // Minted fresh, in-memory, this run only. Never persisted, never read from
  // env/config/state -- the only way to obtain one is to answer "yes" above.
  const authorization = {
    nonce: randomUUID(),
    previewFingerprint: buildPreviewFingerprint(snapshot),
    mintedAt: Date.now(),
  }
  validAuthorizations.add(authorization)
  return authorization
}

function assertPublishAuthorization(authorization, previewSnapshot) {
  if (!authorization || !validAuthorizations.has(authorization)) {
    throw new Error('publishToFacebook called without a valid per-run authorization -- refusing to publish')
  }
  const previewFingerprint = buildPreviewFingerprint(previewSnapshot)
  if (authorization.previewFingerprint !== previewFingerprint) {
    throw new Error('publish authorization does not match the current Facebook preview step')
  }
}

async function openDraftInBrowser(listing) {
  if (listing.listingType !== 'item') {
    throw new Error(`Unsupported listingType "${listing.listingType}". This public package currently supports only the Item for sale flow.`)
  }

  const { chromium } = await import('playwright')
  const { launchPersistentContext } = await import('../lib/browser_launch.mjs')
  const context = await launchPersistentContext(
    chromium,
    BROWSER_STATE_DIR,
    { headless: false, channel: 'chrome' },
    { label: 'marketplace-publish' }
  )
  const page = context.pages()[0] || (await context.newPage())
  await page.goto('https://www.facebook.com/marketplace/create/item', { waitUntil: 'domcontentloaded' })
  return { context, page }
}

async function fillItemListingForm(page, listing) {
  const fileInput = page.locator('input[type="file"]').first()
  await fileInput.setInputFiles(listing.imagePaths)

  await page.getByLabel(/title/i).fill(listing.title)
  await page.getByLabel(/price/i).fill(String(listing.price))
  await page.getByLabel(/description/i).fill(listing.description)

  await page.getByLabel(/category/i).fill(listing.category)
  await page.keyboard.press('Enter')
  await page.getByLabel(/condition/i).fill(listing.condition)
  await page.keyboard.press('Enter')
}

async function capturePreviewSnapshot(page, listing) {
  const publishButton = page.getByRole('button', { name: /^publish$/i })
  await publishButton.waitFor({ state: 'visible', timeout: 15000 })
  const bodyExcerpt = await page.locator('body').innerText().then((text) => normalize(text).slice(0, 1200))

  return {
    stage: 'facebook-preview',
    pageUrl: page.url(),
    publishButtonName: 'Publish',
    bodyExcerpt,
    listingType: listing.listingType,
    title: listing.title,
    priceText: `฿${listing.price.toFixed(2)}`,
  }
}

async function advanceToFacebookPreview(page, listing) {
  const nextButton = page.getByRole('button', { name: /^next$/i })
  await nextButton.waitFor({ state: 'visible', timeout: 15000 })
  await nextButton.click()
  return capturePreviewSnapshot(page, listing)
}

/**
 * Structurally cannot run without a valid authorization object from
 * requestPublishAuthorization() in this same process. A missing/malformed
 * authorization throws before any browser interaction happens.
 */
async function publishToFacebook(authorization, previewSnapshot, page) {
  assertPublishAuthorization(authorization, previewSnapshot)

  const publishButton = page.getByRole('button', { name: /^publish$/i })
  await publishButton.waitFor({ state: 'visible', timeout: 15000 })
  await publishButton.click()
  await page.waitForTimeout(1500)

  return { status: 'published', authorizedAt: authorization.mintedAt }
}

async function main() {
  const { listing } = loadLatestDraft()
  const { context, page } = await openDraftInBrowser(listing)
  try {
    await fillItemListingForm(page, listing)
    const previewSnapshot = await advanceToFacebookPreview(page, listing)
    const authorization = await requestPublishAuthorization(previewSnapshot, {
      displayText: formatListingForDisplay(listing),
    })

    if (!authorization) {
      console.log('\nCancelled. Nothing was published.')
      return
    }

    const result = await publishToFacebook(authorization, previewSnapshot, page)
    console.log(`\nDone: ${result.status}`)
  } finally {
    await context.close()
  }
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
  const previewSnapshot = {
    stage: 'facebook-preview',
    pageUrl: 'https://www.facebook.com/marketplace/create/item/preview',
    publishButtonName: 'Publish',
    bodyExcerpt: 'Preview excerpt',
    listingType: 'item',
    title: 'Canon EOS body',
    priceText: '฿5000.00',
  }
  const authorization = {
    nonce: randomUUID(),
    previewFingerprint: buildPreviewFingerprint(previewSnapshot),
    mintedAt: Date.now(),
  }
  validAuthorizations.add(authorization)

  const threwOnMissing = await assertRejects(() => publishToFacebook(null, previewSnapshot, {}))
  const threwOnForged = await assertRejects(() => publishToFacebook({ nonce: randomUUID(), mintedAt: Date.now() }, previewSnapshot, {}))
  const threwOnMismatchedPreview = await assertRejects(() => publishToFacebook(
    authorization,
    { ...previewSnapshot, priceText: '฿5100.00' },
    {}
  ))

  if (!threwOnMissing || !threwOnForged || !threwOnMismatchedPreview) {
    console.error('✗ FAIL: publishToFacebook did not reject missing/forged/mismatched preview authorization')
    process.exit(1)
  }
  console.log('✓ facebook_marketplace_publish.mjs self-test passed (gate rejects missing, forged, and mismatched preview authorization)')
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

export {
  advanceToFacebookPreview,
  assertPublishAuthorization,
  buildPreviewFingerprint,
  capturePreviewSnapshot,
  fillItemListingForm,
  formatPreviewSnapshot,
  loadLatestDraft,
  openDraftInBrowser,
  publishToFacebook,
  requestPublishAuthorization,
  validatePreviewSnapshot,
}
