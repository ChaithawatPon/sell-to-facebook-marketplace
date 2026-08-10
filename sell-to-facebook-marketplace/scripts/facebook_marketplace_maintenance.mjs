#!/usr/bin/env node
/** Preview-only maintenance packet gate. This file never mutates a listing. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { BROWSER_STATE_DIR, OUTPUT_DIR, timestampSlug } from '../lib/runtime_paths.mjs'

const ALLOWED_ACTIONS = new Set(['update', 'delete', 'delete_and_relist'])
const ALLOWED_CHANGE_FIELDS = new Set(['title', 'price_thb', 'description', 'category', 'condition'])
const APPROVAL_PREFIX = 'approve'
const MAX_PACKET_LIFETIME_MS = 30 * 60 * 1000
const MAX_APPROVAL_AGE_MS = 5 * 60 * 1000
const liveApprovals = new WeakSet()
const consumedApprovals = new WeakSet()
const validatedPackets = new WeakSet()

function rejectUnsupportedKeys(value, allowed, label) {
  const unsupported = Object.keys(value).filter((key) => !allowed.has(key))
  if (unsupported.length) throw new Error(`${label} contains unsupported fields: ${unsupported.join(', ')}`)
}

function normalize(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function canonicalListingUrl(rawUrl) {
  try {
    const url = new URL(normalize(rawUrl))
    if (url.hostname !== 'facebook.com' && !url.hostname.endsWith('.facebook.com')) return ''
    const match = url.pathname.match(/^\/marketplace\/item\/(\d+)(?:\/|$)/i)
    return match ? `https://www.facebook.com/marketplace/item/${match[1]}/` : ''
  } catch {
    return ''
  }
}

function extractListingId(rawUrl) {
  return canonicalListingUrl(rawUrl).match(/\/item\/(\d+)\/$/)?.[1] || ''
}

function normalizePrice(value, label = 'price') {
  if (!['string', 'number'].includes(typeof value) || (typeof value === 'string' && !/^\d+(?:\.0+)?$/.test(value.trim()))) {
    throw new Error(`${label} must be a non-negative whole-baht amount`)
  }
  const price = Number(value)
  if (!Number.isSafeInteger(price) || price < 0) throw new Error(`${label} must be a non-negative whole-baht amount`)
  return price
}

function normalizeChanges(rawChanges, action) {
  if (action !== 'update') {
    if (rawChanges !== undefined) throw new Error(`${action} must not include changes`)
    return Object.freeze({})
  }
  if (!rawChanges || typeof rawChanges !== 'object' || Array.isArray(rawChanges) || Object.keys(rawChanges).length === 0) {
    throw new Error('update changes must be a non-empty object')
  }
  const changes = {}
  for (const [field, value] of Object.entries(rawChanges)) {
    if (!ALLOWED_CHANGE_FIELDS.has(field)) throw new Error(`changes.${field} is not allowlisted`)
    if (field === 'price_thb') {
      changes[field] = normalizePrice(value, 'changes.price_thb')
      continue
    }
    const text = normalize(value)
    const max = field === 'description' ? 5000 : field === 'title' ? 150 : 100
    if (!text || text.length > max) throw new Error(`changes.${field} must contain 1-${max} characters`)
    changes[field] = text
  }
  return Object.freeze(changes)
}

function validatePacket(rawPacket) {
  if (rawPacket && typeof rawPacket === 'object' && validatedPackets.has(rawPacket)) return rawPacket
  if (!rawPacket || typeof rawPacket !== 'object' || Array.isArray(rawPacket)) throw new Error('maintenance packet must be an object')
  rejectUnsupportedKeys(rawPacket, new Set(['schema_version', 'packet_id', 'created_at', 'expires_at', 'listings']), 'maintenance packet')
  const schemaVersion = rawPacket.schema_version ?? rawPacket.schemaVersion
  const packetId = normalize(rawPacket.packet_id ?? rawPacket.packetId)
  const createdAt = normalize(rawPacket.created_at ?? rawPacket.createdAt)
  const expiresAt = normalize(rawPacket.expires_at ?? rawPacket.expiresAt)
  if (schemaVersion !== 1) throw new Error('maintenance packet must declare schema_version 1')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,80}$/.test(packetId)) throw new Error('maintenance packet has invalid packet_id')
  if (!Array.isArray(rawPacket.listings) || rawPacket.listings.length !== 1) throw new Error('maintenance packet must contain exactly one listing')
  const createdMs = Date.parse(createdAt)
  const expiresMs = Date.parse(expiresAt)
  if (!Number.isFinite(createdMs) || !Number.isFinite(expiresMs) || expiresMs <= createdMs) throw new Error('maintenance packet timestamps are invalid')
  if (expiresMs - createdMs > MAX_PACKET_LIFETIME_MS) throw new Error('maintenance packet lifetime must not exceed 30 minutes')

  const rawListing = rawPacket.listings[0]
  if (!rawListing || typeof rawListing !== 'object' || Array.isArray(rawListing)) throw new Error('maintenance packet listing must be an object')
  rejectUnsupportedKeys(rawListing, new Set(['listing_id', 'listing_url', 'expected_title', 'expected_price_thb', 'action', 'changes']), 'maintenance packet listing')
  const listingId = normalize(rawListing.listing_id ?? rawListing.listingId)
  const listingUrl = canonicalListingUrl(rawListing.listing_url ?? rawListing.listingUrl)
  const expectedTitle = normalize(rawListing.expected_title ?? rawListing.expectedTitle)
  const action = normalize(rawListing.action).toLowerCase()
  if (!/^[1-9]\d*$/.test(listingId)) throw new Error('maintenance packet has invalid listing_id')
  if (!listingUrl || extractListingId(listingUrl) !== listingId) throw new Error('listing_url must match listing_id')
  if (!expectedTitle || expectedTitle.length > 150) throw new Error('expected_title must contain 1-150 characters')
  if (!ALLOWED_ACTIONS.has(action)) throw new Error(`unsupported maintenance action "${action}"`)
  const expectedPriceThb = normalizePrice(rawListing.expected_price_thb ?? rawListing.expectedPriceThb, 'expected_price_thb')
  const changes = normalizeChanges(rawListing.changes, action)
  if (changes.title === expectedTitle) throw new Error('changes.title must differ from expected_title')
  if (changes.price_thb === expectedPriceThb) throw new Error('changes.price_thb must differ from expected_price_thb')
  const listing = Object.freeze({
    listingId,
    listingUrl,
    expectedTitle,
    expectedPriceThb,
    action,
    ...(action === 'update' ? { changes } : {}),
  })
  const validated = Object.freeze({ schemaVersion: 1, packetId, createdAt: new Date(createdMs).toISOString(), expiresAt: new Date(expiresMs).toISOString(), changes, listings: Object.freeze([listing]), ...listing })
  validatedPackets.add(validated)
  return validated
}

function assertFreshPacket(packet, now = Date.now()) {
  const validated = validatePacket(packet)
  if (Date.parse(validated.createdAt) > now + 60_000) throw new Error('maintenance packet created_at is in the future')
  if (Date.parse(validated.expiresAt) <= now) throw new Error('maintenance packet is stale')
  return validated
}

function packetFingerprint(packet) {
  const validated = validatePacket(packet)
  return createHash('sha256').update(JSON.stringify({
    schemaVersion: validated.schemaVersion,
    packetId: validated.packetId,
    createdAt: validated.createdAt,
    expiresAt: validated.expiresAt,
    listingId: validated.listingId,
    listingUrl: validated.listingUrl,
    expectedTitle: validated.expectedTitle,
    expectedPriceThb: validated.expectedPriceThb,
    action: validated.action,
    changes: validated.changes,
  }), 'utf8').digest('hex')
}

function validatePreActionSnapshot(rawSnapshot, packet) {
  const validatedPacket = validatePacket(packet)
  if (!rawSnapshot || typeof rawSnapshot !== 'object') throw new Error('live pre-action snapshot is required')
  const snapshot = {
    stage: normalize(rawSnapshot.stage),
    listingId: normalize(rawSnapshot.listingId),
    listingUrl: canonicalListingUrl(rawSnapshot.listingUrl),
    currentTitle: normalize(rawSnapshot.currentTitle),
    currentPriceThb: normalizePrice(rawSnapshot.currentPriceThb, 'snapshot price'),
    action: normalize(rawSnapshot.action).toLowerCase(),
    visibleActionName: normalize(rawSnapshot.visibleActionName),
    proposedChanges: rawSnapshot.proposedChanges && typeof rawSnapshot.proposedChanges === 'object' ? { ...rawSnapshot.proposedChanges } : {},
  }
  if (snapshot.stage !== 'facebook-maintenance-preview') throw new Error('approval requires Facebook maintenance preview state')
  if (snapshot.listingId !== validatedPacket.listingId || snapshot.listingUrl !== validatedPacket.listingUrl) throw new Error('live listing identity does not match packet')
  if (snapshot.currentTitle !== validatedPacket.expectedTitle || snapshot.currentPriceThb !== validatedPacket.expectedPriceThb) throw new Error('live listing title or price does not match packet')
  if (snapshot.action !== validatedPacket.action) throw new Error('live action does not match packet')
  const actionPattern = snapshot.action === 'update' ? /^(edit|edit listing|update|save)$/i : snapshot.action === 'delete' ? /^(delete|delete listing)$/i : /^(delete & relist|delete and relist)$/i
  if (!actionPattern.test(snapshot.visibleActionName)) throw new Error('exact Facebook action affordance is not visible')
  if (JSON.stringify(snapshot.proposedChanges) !== JSON.stringify(validatedPacket.changes)) throw new Error('proposed changes do not match packet')
  return Object.freeze({ ...snapshot, proposedChanges: Object.freeze({ ...snapshot.proposedChanges }) })
}

function snapshotFingerprint(snapshot, packet) {
  return createHash('sha256').update(JSON.stringify(validatePreActionSnapshot(snapshot, packet)), 'utf8').digest('hex')
}

function expectedApprovalToken(packet) {
  const validated = validatePacket(packet)
  return `${APPROVAL_PREFIX} ${validated.packetId} ${validated.listingId} ${validated.action}`
}

function parseApprovalToken(value) {
  const match = normalize(value).match(/^approve\s+([A-Za-z0-9][A-Za-z0-9._-]{2,80})\s+([1-9]\d*)\s+(update|delete|delete_and_relist)$/)
  if (!match) throw new Error('approval token must use: approve <packet_id> <listing_id> <action>')
  return { packetId: match[1], listingId: match[2], action: match[3] }
}

function formatMaintenancePreview(packet, snapshot) {
  const validatedPacket = validatePacket(packet)
  const validatedSnapshot = validatePreActionSnapshot(snapshot, validatedPacket)
  return [
    '='.repeat(64),
    'FACEBOOK MARKETPLACE MAINTENANCE PREVIEW — NO ACTION TAKEN',
    '='.repeat(64),
    `Packet:       ${validatedPacket.packetId}`,
    `Listing ID:   ${validatedPacket.listingId}`,
    `Listing URL:  ${validatedPacket.listingUrl}`,
    `Current title: ${validatedSnapshot.currentTitle}`,
    `Current price: THB ${validatedSnapshot.currentPriceThb}`,
    `Action:       ${validatedPacket.action}`,
    `Changes:      ${JSON.stringify(validatedPacket.changes)}`,
    `Visible UI:   ${validatedSnapshot.visibleActionName}`,
    '='.repeat(64),
  ].join('\n')
}

async function requestMaintenanceAuthorization(packet, snapshot, { input = process.stdin, output = process.stdout, clock = Date.now, ask } = {}) {
  const validatedPacket = assertFreshPacket(packet, clock())
  const validatedSnapshot = validatePreActionSnapshot(snapshot, validatedPacket)
  const requiredPhrase = expectedApprovalToken(validatedPacket)
  output.write(`${formatMaintenancePreview(validatedPacket, validatedSnapshot)}\n`)
  let answer
  const question = `Type exactly "${requiredPhrase}" to approve this one manual action; anything else cancels: `
  if (ask) {
    answer = await ask(question)
  } else {
    const rl = createInterface({ input, output })
    try {
      answer = await rl.question(question)
    } finally {
      rl.close()
    }
  }
  if (String(answer) !== requiredPhrase) return null
  const approvedAt = clock()
  assertFreshPacket(validatedPacket, approvedAt)
  const approval = { nonce: randomUUID(), phrase: requiredPhrase, packetFingerprint: packetFingerprint(validatedPacket), snapshotFingerprint: snapshotFingerprint(validatedSnapshot, validatedPacket), mintedAt: approvedAt }
  liveApprovals.add(approval)
  return approval
}

function assertAuthorization(approval, packet, snapshot, now = Date.now()) {
  const validatedPacket = assertFreshPacket(packet, now)
  if (!approval || !liveApprovals.has(approval) || consumedApprovals.has(approval)) throw new Error('fresh unused in-process maintenance approval is missing')
  const parsed = parseApprovalToken(approval.phrase)
  if (parsed.packetId !== validatedPacket.packetId || parsed.listingId !== validatedPacket.listingId || parsed.action !== validatedPacket.action) throw new Error('approval token does not match packet')
  if (now < approval.mintedAt || now - approval.mintedAt > MAX_APPROVAL_AGE_MS) throw new Error('maintenance approval expired')
  if (approval.packetFingerprint !== packetFingerprint(validatedPacket) || approval.snapshotFingerprint !== snapshotFingerprint(snapshot, validatedPacket)) throw new Error('packet or live preview changed after approval')
  return true
}

function consumeAuthorization(approval, packet, snapshot, now = Date.now()) {
  assertAuthorization(approval, packet, snapshot, now)
  consumedApprovals.add(approval)
}

function expectedPriceVisible(text, price) {
  return visiblePriceValues(text).includes(Number(price))
}

function visiblePriceValues(text) {
  const normalized = normalize(text)
  const values = []
  for (const match of normalized.matchAll(/฿\s*([\d,]+)(?:\.00)?/g)) values.push(Number(match[1].replace(/,/g, '')))
  for (const match of normalized.matchAll(/(?:^|[^\d,])([\d][\d,]*)\s*(?:THB|บาท)/gi)) values.push(Number(match[1].replace(/,/g, '')))
  return [...new Set(values.filter(Number.isSafeInteger))]
}

function exactPriceTexts(price) {
  const comma = Number(price).toLocaleString('en-US')
  return [`฿${comma}`, `฿${comma}.00`, `THB ${comma}`, `${comma} THB`, `${comma} บาท`]
}

function parseVisiblePrice(text) {
  const match = normalize(text).match(/([\d,]+)(?:\.00)?/)
  if (!match) throw new Error('visible listing price is not a whole-baht amount')
  return normalizePrice(match[1].replace(/,/g, ''), 'visible listing price')
}

async function findVisibleExactText(container, candidates, label) {
  const matches = []
  for (const text of candidates) {
    const locator = container.getByText(text, { exact: true })
    for (let index = 0; index < await locator.count(); index += 1) {
      const candidate = locator.nth(index)
      if (await candidate.isVisible()) matches.push(normalize(await candidate.innerText()))
    }
  }
  if (matches.length !== 1) throw new Error(`expected one exact visible ${label}, found ${matches.length}`)
  return matches[0]
}

function actionPatterns(action) {
  return action === 'update' ? [/^edit listing$/i, /^edit$/i] : action === 'delete' ? [/^delete listing$/i, /^delete$/i] : [/^delete & relist$/i, /^delete and relist$/i]
}

async function findVisibleActionName(page, action) {
  const matches = []
  for (const role of ['button', 'link', 'menuitem']) {
    for (const pattern of actionPatterns(action)) {
      const locator = page.getByRole(role, { name: pattern })
      for (let index = 0; index < await locator.count(); index += 1) {
        const candidate = locator.nth(index)
        if (await candidate.isVisible()) matches.push(normalize(await candidate.innerText()) || normalize(await candidate.getAttribute('aria-label')))
      }
    }
  }
  if (matches.length !== 1) throw new Error(`expected one visible ${action} affordance, found ${matches.length}`)
  return matches[0]
}

function createMaintenancePreviewAdapter(page) {
  return {
    async capture(rawPacket) {
      const packet = assertFreshPacket(rawPacket)
      await page.goto(packet.listingUrl, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(1000)
      const currentUrl = canonicalListingUrl(page.url())
      if (currentUrl !== packet.listingUrl) throw new Error('Facebook redirected away from the exact listing URL')
      const mainRegion = page.getByRole('main')
      if (await mainRegion.count() !== 1 || !(await mainRegion.isVisible())) throw new Error('expected one visible Facebook listing main region')
      const titleHeading = mainRegion.getByRole('heading', { name: packet.expectedTitle, exact: true })
      const visibleHeadings = []
      for (let index = 0; index < await titleHeading.count(); index += 1) {
        if (await titleHeading.nth(index).isVisible()) visibleHeadings.push(titleHeading.nth(index))
      }
      if (visibleHeadings.length !== 1) throw new Error(`expected one exact visible listing-title heading, found ${visibleHeadings.length}`)
      const currentTitle = normalize(await visibleHeadings[0].innerText())
      const visiblePriceText = await findVisibleExactText(mainRegion, exactPriceTexts(packet.expectedPriceThb), 'listing price')
      const currentPriceThb = parseVisiblePrice(visiblePriceText)
      const visibleActionName = await findVisibleActionName(mainRegion, packet.action)
      return validatePreActionSnapshot({
        stage: 'facebook-maintenance-preview',
        listingId: packet.listingId,
        listingUrl: packet.listingUrl,
        currentTitle,
        currentPriceThb,
        action: packet.action,
        visibleActionName,
        proposedChanges: packet.changes,
      }, packet)
    },
  }
}

async function visibleExactValue(container, expected, label) {
  return findVisibleExactText(container, [normalize(expected)], label)
}

async function collectSellingRecords(page) {
  return page.evaluate(() => {
    const normalizeInner = (value) => String(value || '').replace(/\s+/g, ' ').trim()
    const records = new Map()
    for (const anchor of document.querySelectorAll('a[href*="/marketplace/item/"]')) {
      const match = anchor.href.match(/\/marketplace\/item\/(\d+)/)
      if (!match) continue
      let container = anchor
      for (let depth = 0; container?.parentElement && depth < 6; depth += 1) {
        if (container.getAttribute?.('aria-label')) break
        container = container.parentElement
      }
      const text = normalizeInner(container?.textContent || anchor.textContent)
      const title = normalizeInner(anchor.getAttribute('aria-label') || anchor.textContent)
      records.set(match[1], {
        listingId: match[1],
        listingUrl: `https://www.facebook.com/marketplace/item/${match[1]}/`,
        title,
        text,
      })
    }
    return [...records.values()]
  })
}

async function collectAllSellingRecords(page, maxPasses = 20) {
  const records = new Map()
  let stableEndPasses = 0
  let previousHeight = -1
  for (let pass = 0; pass < maxPasses; pass += 1) {
    for (const record of await collectSellingRecords(page)) records.set(record.listingId, record)
    const scrollState = await page.evaluate(() => ({
      height: document.documentElement.scrollHeight,
      atEnd: window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 50,
    }))
    if (scrollState.atEnd && scrollState.height === previousHeight) stableEndPasses += 1
    else stableEndPasses = 0
    if (stableEndPasses >= 2) return { records: [...records.values()], scanComplete: true }
    previousHeight = scrollState.height
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    await page.waitForTimeout(500)
  }
  return { records: [...records.values()], scanComplete: false }
}

function createMaintenanceVerificationAdapter(page) {
  return {
    async capture(rawPacket) {
      const packet = assertFreshPacket(rawPacket)
      if (packet.action === 'update') {
        await page.goto(packet.listingUrl, { waitUntil: 'domcontentloaded' })
        await page.waitForTimeout(1000)
        if (canonicalListingUrl(page.url()) !== packet.listingUrl) throw new Error('updated listing did not reload at the canonical URL')
        const mainRegion = page.getByRole('main')
        if (await mainRegion.count() !== 1 || !(await mainRegion.isVisible())) throw new Error('updated listing main region is unavailable')
        const values = {}
        for (const [field, expected] of Object.entries(packet.changes)) {
          if (field === 'price_thb') {
            values[field] = parseVisiblePrice(await findVisibleExactText(mainRegion, exactPriceTexts(expected), 'updated price'))
          } else {
            values[field] = await visibleExactValue(mainRegion, expected, `updated ${field}`)
          }
        }
        return { listingId: packet.listingId, values }
      }

      await page.goto('https://www.facebook.com/marketplace/you/selling/', { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(1000)
      const inventory = await collectAllSellingRecords(page)
      if (!inventory.scanComplete) throw new Error('selling-page verification scan did not reach a stable end')
      const records = inventory.records
      const originalAbsent = !records.some((record) => record.listingId === packet.listingId)
      if (packet.action === 'delete') {
        await page.goto(packet.listingUrl, { waitUntil: 'domcontentloaded' })
        await page.waitForTimeout(750)
        const bodyText = normalize(await page.locator('body').innerText())
        const unavailableConfirmed = /listing (?:isn't|is not|is no longer) available|content (?:isn't|is not) available/i.test(bodyText)
        return { originalAbsent, unavailableConfirmed }
      }
      const replacements = records
        .filter((record) => record.listingId !== packet.listingId && record.title === packet.expectedTitle && expectedPriceVisible(record.text, packet.expectedPriceThb))
        .map((record) => ({ ...record, priceThb: visiblePriceValues(record.text).find((price) => price === packet.expectedPriceThb) }))
      return { originalAbsent, replacements }
    },
  }
}

function verifyPostReload(packet, afterReload) {
  const validated = validatePacket(packet)
  if (!afterReload || typeof afterReload !== 'object') throw new Error('post-reload evidence is required')
  if (validated.action === 'update') {
    if (normalize(afterReload.listingId) !== validated.listingId) throw new Error('updated listing identity changed')
    const values = afterReload.values && typeof afterReload.values === 'object' ? afterReload.values : {}
    for (const [field, expected] of Object.entries(validated.changes)) {
      const actual = field === 'price_thb' ? normalizePrice(values[field], 'verified price') : normalize(values[field])
      if (actual !== expected) throw new Error(`post-reload verification failed for ${field}`)
    }
    return { status: 'verified', action: validated.action, listingId: validated.listingId, verifiedFields: Object.keys(validated.changes) }
  }
  if (validated.action === 'delete') {
    if (afterReload.originalAbsent !== true || afterReload.unavailableConfirmed !== true) throw new Error('delete verification requires selling-page absence and unavailable listing page')
    return { status: 'verified', action: validated.action, listingId: validated.listingId }
  }
  if (afterReload.originalAbsent !== true || !Array.isArray(afterReload.replacements) || afterReload.replacements.length !== 1) throw new Error('delete_and_relist verification requires original absence and exactly one replacement')
  const replacement = afterReload.replacements[0]
  if (normalize(replacement.listingId) === validated.listingId || extractListingId(replacement.listingUrl) !== normalize(replacement.listingId)) throw new Error('replacement must have a distinct canonical listing identity')
  if (normalize(replacement.title) !== validated.expectedTitle || normalizePrice(replacement.priceThb, 'replacement price') !== validated.expectedPriceThb) throw new Error('replacement title or price does not match original')
  return { status: 'verified', action: validated.action, originalListingId: validated.listingId, replacementListingId: normalize(replacement.listingId) }
}

async function loadPacketFromFile(path) {
  return validatePacket(JSON.parse(await readFile(path, 'utf8')))
}

async function writeVerificationOutcome(result, outputDir = OUTPUT_DIR) {
  await mkdir(outputDir, { recursive: true })
  const path = join(outputDir, `${timestampSlug()}-maintenance-verification.json`)
  await writeFile(path, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  return path
}

async function waitForManualCompletion(packet, { input = process.stdin, output = process.stdout, ask } = {}) {
  const requiredPhrase = `verify ${validatePacket(packet).packetId}`
  output.write('\nApply only the approved action manually in the open Facebook window. Inspect Facebook\'s final confirmation before any destructive click. Do not act if five minutes have passed since approval.\n')
  let answer
  const question = `After Facebook finishes, type exactly "${requiredPhrase}" to reload and verify; anything else cancels verification: `
  if (ask) {
    answer = await ask(question)
  } else {
    const rl = createInterface({ input, output })
    try {
      answer = await rl.question(question)
    } finally {
      rl.close()
    }
  }
  return String(answer) === requiredPhrase
}

async function runPreview({ packet, adapter, input = process.stdin, output = process.stdout, clock = Date.now } = {}) {
  const validated = assertFreshPacket(packet, clock())
  if (!adapter?.capture) throw new Error('maintenance preview adapter is missing')
  const snapshot = await adapter.capture(validated)
  const approval = await requestMaintenanceAuthorization(validated, snapshot, { input, output, clock })
  return approval
    ? { status: 'approved_for_manual_action', packetId: validated.packetId, listingId: validated.listingId, action: validated.action, approvalPhrase: approval.phrase }
    : { status: 'cancelled', packetId: validated.packetId, listingId: validated.listingId, action: validated.action }
}

async function runMaintenanceSession({ packet, previewAdapter, verificationAdapter, input = process.stdin, output = process.stdout, clock = Date.now, outputDir = OUTPUT_DIR, ask } = {}) {
  const validated = assertFreshPacket(packet, clock())
  if (!previewAdapter?.capture || !verificationAdapter?.capture) throw new Error('maintenance session adapters are incomplete')
  const snapshot = await previewAdapter.capture(validated)
  const approval = await requestMaintenanceAuthorization(validated, snapshot, { input, output, clock, ask })
  if (!approval) return { status: 'cancelled', packetId: validated.packetId, listingId: validated.listingId, action: validated.action }
  const refreshedSnapshot = await previewAdapter.capture(validated)
  consumeAuthorization(approval, validated, refreshedSnapshot, clock())
  if (!await waitForManualCompletion(validated, { input, output, ask })) {
    const cancelled = { status: 'verification_cancelled', packetId: validated.packetId, listingId: validated.listingId, action: validated.action, verifiedAt: new Date(clock()).toISOString() }
    cancelled.outcomePath = await writeVerificationOutcome(cancelled, outputDir)
    return cancelled
  }
  const verificationStartedAt = clock()
  let outcome
  if (verificationStartedAt - approval.mintedAt > MAX_APPROVAL_AGE_MS) {
    outcome = {
      status: 'verification_failed',
      packetId: validated.packetId,
      listingId: validated.listingId,
      action: validated.action,
      reason: 'manual maintenance and verification request exceeded the five-minute approval window',
      verifiedAt: new Date(clock()).toISOString(),
    }
  } else {
    try {
      const evidence = await verificationAdapter.capture(validated)
      const verification = verifyPostReload(validated, evidence)
      outcome = { ...verification, packetId: validated.packetId, verifiedAt: new Date(clock()).toISOString() }
    } catch (error) {
      outcome = {
        status: 'verification_failed',
        packetId: validated.packetId,
        listingId: validated.listingId,
        action: validated.action,
        reason: normalize(error?.message || error),
        verifiedAt: new Date(clock()).toISOString(),
      }
    }
  }
  outcome.outcomePath = await writeVerificationOutcome(outcome, outputDir)
  return outcome
}

async function runSelfTest() {
  const now = Date.now()
  const packet = validatePacket({ schema_version: 1, packet_id: 'MMP-SELF-TEST', created_at: new Date(now - 1000).toISOString(), expires_at: new Date(now + 600_000).toISOString(), listings: [{ listing_id: '1234567890', listing_url: 'https://www.facebook.com/marketplace/item/1234567890/', expected_title: 'Example tote bag', expected_price_thb: 850, action: 'update', changes: { title: 'Example navy tote bag', price_thb: 790 } }] })
  const snapshot = validatePreActionSnapshot({ stage: 'facebook-maintenance-preview', listingId: packet.listingId, listingUrl: packet.listingUrl, currentTitle: packet.expectedTitle, currentPriceThb: packet.expectedPriceThb, action: packet.action, visibleActionName: 'Edit listing', proposedChanges: packet.changes }, packet)
  if (expectedApprovalToken(packet) !== 'approve MMP-SELF-TEST 1234567890 update' || !snapshot) throw new Error('maintenance self-test failed')
  console.log('✓ facebook_marketplace_maintenance.mjs self-test passed')
}

async function main() {
  if (process.argv.includes('--self-test')) return runSelfTest()
  const index = process.argv.indexOf('--packet')
  if (index < 0 || !process.argv[index + 1]) throw new Error('Usage: facebook_marketplace_maintenance.mjs --packet <path> | --self-test')
  const packet = await loadPacketFromFile(process.argv[index + 1])
  const { chromium } = await import('playwright')
  const { launchPersistentContext } = await import('../lib/browser_launch.mjs')
  const context = await launchPersistentContext(chromium, BROWSER_STATE_DIR, { headless: false, channel: 'chrome' }, { label: 'marketplace-maintenance-preview' })
  try {
    const page = context.pages()[0] || await context.newPage()
    console.log(JSON.stringify(await runMaintenanceSession({
      packet,
      previewAdapter: createMaintenancePreviewAdapter(page),
      verificationAdapter: createMaintenanceVerificationAdapter(page),
    }), null, 2))
  } finally {
    await context.close()
  }
}

const isMain = resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url))
if (isMain) main().catch((error) => { console.error('Marketplace maintenance preview failed:', error); process.exit(1) })

export {
  ALLOWED_ACTIONS,
  ALLOWED_CHANGE_FIELDS,
  APPROVAL_PREFIX,
  assertAuthorization,
  assertFreshPacket,
  canonicalListingUrl,
  createMaintenancePreviewAdapter,
  createMaintenanceVerificationAdapter,
  expectedApprovalToken,
  extractListingId,
  findVisibleActionName,
  findVisibleExactText,
  formatMaintenancePreview,
  loadPacketFromFile,
  packetFingerprint,
  parseApprovalToken,
  requestMaintenanceAuthorization,
  runMaintenanceSession,
  runPreview,
  snapshotFingerprint,
  validatePacket,
  validatePreActionSnapshot,
  verifyPostReload,
  visiblePriceValues,
  waitForManualCompletion,
  writeVerificationOutcome,
}
