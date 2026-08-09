import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import {
  assertPublishAuthorization,
  buildPreviewFingerprint,
  requestPublishAuthorization,
} from '../scripts/facebook_marketplace_publish.mjs'

function createPreviewSnapshot(overrides = {}) {
  return {
    stage: 'facebook-preview',
    pageUrl: 'https://www.facebook.com/marketplace/create/item/preview',
    publishButtonName: 'Publish',
    bodyExcerpt: 'Facebook preview text',
    listingType: 'item',
    title: 'Canvas tote bag',
    priceText: '฿850.00',
    ...overrides,
  }
}

test('publish approval is bound to the exact Facebook preview snapshot', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  input.end('yes\n')

  const previewSnapshot = createPreviewSnapshot()
  const authorization = await requestPublishAuthorization(previewSnapshot, {
    input,
    output,
    displayText: 'DRAFT',
  })

  assert.ok(authorization)
  assert.equal(authorization.previewFingerprint, buildPreviewFingerprint(previewSnapshot))
  assert.doesNotThrow(() => assertPublishAuthorization(authorization, previewSnapshot))
  assert.throws(
    () => assertPublishAuthorization(authorization, createPreviewSnapshot({ priceText: '฿900.00' })),
    /does not match the current Facebook preview step/
  )
})

test('publish approval cannot be requested before a Facebook preview snapshot exists', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  input.end('yes\n')

  await assert.rejects(
    () => requestPublishAuthorization({ stage: 'draft-only', pageUrl: '', publishButtonName: '' }, { input, output }),
    /may only be requested from the Facebook preview step/
  )
})
