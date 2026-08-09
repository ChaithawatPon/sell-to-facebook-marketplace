import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { draftListing, loadMetadataFile, validateListing } from '../lib/marketplace_draft.mjs'

function withTempDir(callback) {
  const dir = mkdtempSync('/private/tmp/marketplace-draft-test-')
  try {
    return callback(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('draftListing requires explicit metadata and does not infer claims from filenames', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'mint-phone-no-cracks.jpg'), 'not-an-image')
    assert.throws(() => draftListing(dir, 1500), /Metadata validation failed/)
  })
})

test('draftListing uses explicit metadata without filename inference', () => {
  withTempDir((dir) => {
    const imagePath = join(dir, 'leather-bag-working-perfectly.jpg')
    const metadataPath = join(dir, 'metadata.json')
    writeFileSync(imagePath, 'not-an-image')
    writeFileSync(metadataPath, JSON.stringify({
      listingType: 'item',
      title: 'Canvas tote bag',
      category: 'Fashion > Handbags',
      condition: 'Fair',
      description: 'Canvas tote bag only. Wear is visible in the photos.',
    }))

    const listing = draftListing(dir, 850, loadMetadataFile(metadataPath))
    assert.equal(listing.title, 'Canvas tote bag')
    assert.equal(listing.condition, 'Fair')
    assert.equal(listing.description, 'Canvas tote bag only. Wear is visible in the photos.')
    assert.deepEqual(listing.imageEvidence.imageFileNames, ['leather-bag-working-perfectly.jpg'])
    assert.equal(validateListing(listing).isValid, true)
  })
})

test('draftListing rejects unsupported listing types in metadata', () => {
  withTempDir((dir) => {
    const imagePath = join(dir, 'car.jpg')
    const metadataPath = join(dir, 'metadata.json')
    writeFileSync(imagePath, 'not-an-image')
    writeFileSync(metadataPath, JSON.stringify({
      listingType: 'vehicle',
      title: 'Sedan',
      category: 'Vehicles',
      condition: 'Good',
      description: 'Facts only.',
    }))

    assert.throws(() => loadMetadataFile(metadataPath), /listingType must be one of: item/)
  })
})
