import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canonicalizeMarketplaceListingUrl,
  extractMarketplaceListingIdentity,
  recommendAction,
} from '../scripts/facebook_marketplace_inventory.mjs'

test('canonical listing identity strips tracking data and rejects non-item URLs', () => {
  assert.equal(
    canonicalizeMarketplaceListingUrl('https://m.facebook.com/marketplace/item/123456/?ref=share'),
    'https://www.facebook.com/marketplace/item/123456/'
  )
  assert.equal(canonicalizeMarketplaceListingUrl('https://example.com/marketplace/item/123456/'), null)
  assert.equal(canonicalizeMarketplaceListingUrl('https://www.facebook.com/marketplace/you/selling/'), null)
})

test('listing identity fails closed when missing or ambiguous', () => {
  assert.deepEqual(extractMarketplaceListingIdentity([]), {
    listingId: null,
    listingUrl: null,
    identityStatus: 'missing',
  })
  assert.equal(
    extractMarketplaceListingIdentity(['/marketplace/item/1/', '/marketplace/item/2/']).identityStatus,
    'ambiguous'
  )
  assert.deepEqual(
    extractMarketplaceListingIdentity([
      '/marketplace/item/123456/?ref=share',
      'https://www.facebook.com/marketplace/item/123456/?tracking=ignored',
    ]),
    {
      listingId: '123456',
      listingUrl: 'https://www.facebook.com/marketplace/item/123456/',
      identityStatus: 'verified',
    }
  )
})

test('stale thresholds preserve review-only recommendations', () => {
  const thresholds = { minClicks: 10, maxAgeDays: 7 }
  assert.deepEqual(
    recommendAction({ clicks: 10, ageDays: 6, canDeleteAndRelist: true }, thresholds),
    { stale: false, action: 'keep_live', reasons: [] }
  )
  assert.equal(
    recommendAction({ clicks: 9, ageDays: 6, canDeleteAndRelist: false }, thresholds).action,
    'refresh_content_review'
  )
  assert.equal(
    recommendAction({ clicks: 0, ageDays: 7, canDeleteAndRelist: true }, thresholds).action,
    'delete_and_relist_review'
  )
})
