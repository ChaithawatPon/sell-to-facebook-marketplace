import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import {
  assertAuthorization,
  expectedApprovalToken,
  findVisibleActionName,
  findVisibleExactText,
  requestMaintenanceAuthorization,
  validatePacket,
  validatePreActionSnapshot,
} from '../scripts/facebook_marketplace_maintenance.mjs'

const now = Date.parse('2026-08-10T12:00:00.000Z')

function rawPacket(action = 'delete', overrides = {}) {
  const listing = {
    listing_id: '1234567890',
    listing_url: 'https://m.facebook.com/marketplace/item/1234567890/?ref=share',
    expected_title: 'Example canvas tote bag',
    expected_price_thb: 850,
    action,
    ...(action === 'update' ? { changes: { title: 'Example navy canvas tote bag', price_thb: 790 } } : {}),
    ...(overrides.listing || {}),
  }
  return {
    schema_version: 1,
    packet_id: 'MMP-TEST-001',
    created_at: '2026-08-10T11:59:00.000Z',
    expires_at: '2026-08-10T12:14:00.000Z',
    listings: [listing],
    ...overrides.packet,
  }
}

function snapshot(packet, overrides = {}) {
  return validatePreActionSnapshot({
    stage: 'facebook-maintenance-preview',
    listingId: packet.listingId,
    listingUrl: packet.listingUrl,
    currentTitle: packet.expectedTitle,
    currentPriceThb: packet.expectedPriceThb,
    action: packet.action,
    visibleActionName: packet.action === 'delete_and_relist' ? 'Delete & relist' : packet.action === 'delete' ? 'Delete listing' : 'Edit listing',
    proposedChanges: packet.changes,
    ...overrides,
  }, packet)
}

async function authorize(packet, liveSnapshot, answer = expectedApprovalToken(packet), clock = () => now) {
  const input = new PassThrough()
  const output = new PassThrough()
  input.end(`${answer}\n`)
  return requestMaintenanceAuthorization(packet, liveSnapshot, { input, output, clock })
}

test('packet validation is one-item, canonical, short-lived, and action-specific', () => {
  const update = validatePacket(rawPacket('update'))
  assert.equal(update.listingUrl, 'https://www.facebook.com/marketplace/item/1234567890/')
  assert.deepEqual(update.changes, { title: 'Example navy canvas tote bag', price_thb: 790 })
  assert.throws(() => validatePacket(rawPacket('delete', { listing: { changes: {} } })), /must not include changes/)
  assert.throws(() => validatePacket(rawPacket('update', { listing: { changes: { photos: ['x'] } } })), /not allowlisted/)
  assert.throws(() => validatePacket(rawPacket('delete', { packet: { unexpected: true } })), /unsupported fields/)
  assert.throws(() => validatePacket(rawPacket('delete', { listing: { unexpected: true } })), /unsupported fields/)
  assert.throws(() => validatePacket(rawPacket('delete', { listing: { expected_price_thb: null } })), /whole-baht/)
  assert.throws(() => validatePacket(rawPacket('delete', { packet: { listings: [] } })), /exactly one listing/)
  assert.throws(() => validatePacket(rawPacket('delete', { packet: { expires_at: '2026-08-10T13:00:00.000Z' } })), /30 minutes/)
})

test('approval requires the exact token and remains bound to packet plus live snapshot', async () => {
  const packet = validatePacket(rawPacket('delete'))
  const liveSnapshot = snapshot(packet)
  assert.equal(await authorize(packet, liveSnapshot, 'yes'), null)
  assert.equal(await authorize(packet, liveSnapshot, ` ${expectedApprovalToken(packet)}`), null)
  const approval = await authorize(packet, liveSnapshot)
  assert.ok(approval)
  assert.equal(assertAuthorization(approval, packet, liveSnapshot, now), true)
  assert.throws(() => assertAuthorization({ ...approval }, packet, liveSnapshot, now), /missing/)
  assert.throws(
    () => assertAuthorization(approval, packet, { ...liveSnapshot, visibleActionName: 'Delete' }, now),
    /changed/
  )
  assert.throws(() => assertAuthorization(approval, packet, liveSnapshot, now + 301_000), /expired/)
})

test('approval is rejected when the packet expires while the prompt is open', async () => {
  const packet = validatePacket(rawPacket('delete'))
  const liveSnapshot = snapshot(packet)
  const times = [now, Date.parse(packet.expiresAt) + 1]
  await assert.rejects(
    () => authorize(packet, liveSnapshot, expectedApprovalToken(packet), () => times.shift()),
    /stale/
  )
})

test('maintenance script contains no public-action click path', () => {
  const source = readFileSync(new URL('../scripts/facebook_marketplace_maintenance.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /\.click\s*\(/)
  assert.match(source, /Preview-only maintenance packet gate/)
})

test('duplicate visible identity or action controls fail closed', async () => {
  const makeLocator = (values) => ({
    async count() { return values.length },
    nth(index) {
      return {
        async isVisible() { return true },
        async innerText() { return values[index] },
        async getAttribute() { return values[index] },
      }
    },
  })
  const textContainer = { getByText() { return makeLocator(['฿850', '฿850']) } }
  await assert.rejects(() => findVisibleExactText(textContainer, ['฿850'], 'price'), /found 2/)

  const actionContainer = {
    getByRole(role, { name }) {
      return role === 'button' && name.test('Delete listing') ? makeLocator(['Delete listing', 'Delete listing']) : makeLocator([])
    },
  }
  await assert.rejects(() => findVisibleActionName(actionContainer, 'delete'), /found 2/)
})
