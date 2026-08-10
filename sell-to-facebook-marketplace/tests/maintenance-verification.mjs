import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import {
  expectedApprovalToken,
  runMaintenanceSession,
  validatePacket,
  validatePreActionSnapshot,
  verifyPostReload,
  visiblePriceValues,
} from '../scripts/facebook_marketplace_maintenance.mjs'

function packet(action) {
  return validatePacket({
    schema_version: 1,
    packet_id: `MMP-${action}`,
    created_at: '2026-08-10T11:59:00.000Z',
    expires_at: '2026-08-10T12:14:00.000Z',
    listings: [{
      listing_id: '1234567890',
      listing_url: 'https://www.facebook.com/marketplace/item/1234567890/',
      expected_title: 'Example canvas tote bag',
      expected_price_thb: 850,
      action,
      ...(action === 'update' ? { changes: { title: 'Example navy canvas tote bag', description: 'Example public description', price_thb: 790 } } : {}),
    }],
  })
}

test('update verification requires every approved field after reload', () => {
  const update = packet('update')
  assert.deepEqual(
    verifyPostReload(update, { listingId: update.listingId, values: update.changes }),
    { status: 'verified', action: 'update', listingId: update.listingId, verifiedFields: ['title', 'description', 'price_thb'] }
  )
  assert.throws(
    () => verifyPostReload(update, { listingId: update.listingId, values: { ...update.changes, price_thb: 800 } }),
    /price_thb/
  )
})

test('delete verification requires two independent absence signals', () => {
  const deletion = packet('delete')
  assert.deepEqual(verifyPostReload(deletion, { originalAbsent: true, unavailableConfirmed: true }), {
    status: 'verified',
    action: 'delete',
    listingId: deletion.listingId,
  })
  assert.throws(() => verifyPostReload(deletion, { originalAbsent: true, unavailableConfirmed: false }), /requires selling-page absence/)
})

test('delete-and-relist verification requires one distinct matching replacement', () => {
  const relist = packet('delete_and_relist')
  const replacement = {
    listingId: '5555555555',
    listingUrl: 'https://www.facebook.com/marketplace/item/5555555555/',
    title: relist.expectedTitle,
    priceThb: relist.expectedPriceThb,
  }
  assert.deepEqual(verifyPostReload(relist, { originalAbsent: true, replacements: [replacement] }), {
    status: 'verified',
    action: 'delete_and_relist',
    originalListingId: relist.listingId,
    replacementListingId: replacement.listingId,
  })
  assert.throws(() => verifyPostReload(relist, { originalAbsent: true, replacements: [] }), /exactly one replacement/)
  assert.throws(() => verifyPostReload(relist, { originalAbsent: true, replacements: [{ ...replacement, listingId: relist.listingId, listingUrl: relist.listingUrl }] }), /distinct canonical/)
})

test('price evidence never treats 1850 as 850', () => {
  assert.deepEqual(visiblePriceValues('Example item 1,850 THB'), [1850])
  assert.deepEqual(visiblePriceValues('Example item ฿850.00'), [850])
})

test('manual session stays open through approval, reload verification, and local outcome write', async () => {
  const update = packet('update')
  const snapshot = validatePreActionSnapshot({
    stage: 'facebook-maintenance-preview',
    listingId: update.listingId,
    listingUrl: update.listingUrl,
    currentTitle: update.expectedTitle,
    currentPriceThb: update.expectedPriceThb,
    action: update.action,
    visibleActionName: 'Edit listing',
    proposedChanges: update.changes,
  }, update)
  const answers = [expectedApprovalToken(update), `verify ${update.packetId}`]
  const outputDir = await mkdtemp('/private/tmp/marketplace-maintenance-test-')
  try {
    const result = await runMaintenanceSession({
      packet: update,
      previewAdapter: { async capture() { return snapshot } },
      verificationAdapter: { async capture() { return { listingId: update.listingId, values: update.changes } } },
      output: new PassThrough(),
      clock: () => Date.parse('2026-08-10T12:00:00.000Z'),
      outputDir,
      ask: async () => answers.shift(),
    })
    assert.equal(result.status, 'verified')
    assert.match(result.outcomePath, /maintenance-verification\.json$/)
    const saved = JSON.parse(await readFile(result.outcomePath, 'utf8'))
    assert.equal(saved.packetId, update.packetId)
    assert.deepEqual(saved.verifiedFields, Object.keys(update.changes))
  } finally {
    await rm(outputDir, { recursive: true, force: true })
  }
})
