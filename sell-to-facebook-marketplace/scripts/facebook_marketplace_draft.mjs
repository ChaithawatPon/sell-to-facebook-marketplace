#!/usr/bin/env node
/**
 * Phase 1: auto-draft a Facebook Marketplace listing from an image folder + price.
 *
 * Usage:
 *   node scripts/facebook_marketplace_draft.mjs <image-folder> <price>
 *   node scripts/facebook_marketplace_draft.mjs --self-test
 */

import { fileURLToPath } from 'url'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { draftListing, formatListingForDisplay, loadMetadataFile, validateMetadata } from '../lib/marketplace_draft.mjs'
import { OUTPUT_DIR, timestampSlug } from '../lib/runtime_paths.mjs'

const args = process.argv.slice(2)
const SELF_TEST = args.includes('--self-test')

function parseCliArgs(argv) {
  const positional = []
  let metadataPath = ''

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--metadata') {
      metadataPath = argv[index + 1] || ''
      index += 1
      continue
    }
    positional.push(value)
  }

  return {
    imageFolder: positional[0] || '',
    price: positional[1],
    metadataPath,
  }
}

function runSelfTest() {
  const metadata = {
    listingType: 'item',
    title: 'Canon EOS body',
    category: 'Electronics > Cameras',
    condition: 'Good',
    description: 'Body only. See photos for cosmetic wear and included accessories.',
  }
  const validation = validateMetadata(metadata)
  if (!validation.isValid) {
    console.error('✗ FAIL: explicit metadata should have validated')
    process.exit(1)
  }

  const fakeListing = {
    ...metadata,
    price: 5000,
    imagePaths: ['/tmp/a.jpg', '/tmp/b.jpg'],
    imageCount: 2,
    imageEvidence: { imageCount: 2, imageFileNames: ['a.jpg', 'b.jpg'] },
    metadataSource: 'explicit',
    timestamp: new Date().toISOString(),
  }
  const rendered = formatListingForDisplay(fakeListing)
  if (!rendered.includes('Canon EOS body') || !rendered.includes('Listing type: item') || !rendered.includes('฿5000.00')) {
    console.error('✗ FAIL: formatListingForDisplay did not render expected fields')
    process.exit(1)
  }

  try {
    draftListing('/definitely/does/not/exist', 100, metadata)
    console.error('✗ FAIL: draftListing did not throw on a missing folder')
    process.exit(1)
  } catch {
  }

  const tempDir = join('/private/tmp', `marketplace-draft-self-test-${timestampSlug()}`)
  try {
    mkdirSync(tempDir, { recursive: true })
    writeFileSync(join(tempDir, 'looks-like-laptop.jpg'), 'not-an-image')
    try {
      draftListing(tempDir, 100, null)
      console.error('✗ FAIL: draftListing accepted missing metadata')
      process.exit(1)
    } catch (error) {
      if (!String(error.message).includes('Metadata validation failed')) {
        throw error
      }
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }

  console.log('✓ facebook_marketplace_draft.mjs self-test passed')
  process.exit(0)
}

function main() {
  const { imageFolder, price, metadataPath } = parseCliArgs(args)

  if (!imageFolder || price === undefined || !metadataPath) {
    console.error('Usage: node scripts/facebook_marketplace_draft.mjs <image-folder> <price> --metadata <metadata.json>')
    process.exit(1)
  }

  const listing = draftListing(resolve(imageFolder), price, loadMetadataFile(resolve(metadataPath)))

  mkdirSync(OUTPUT_DIR, { recursive: true })
  const stamp = timestampSlug()
  const outPath = join(OUTPUT_DIR, `${stamp}-listing-draft.json`)
  writeFileSync(outPath, JSON.stringify(listing, null, 2))

  console.log(formatListingForDisplay(listing))
  console.log(`\nDraft written to: ${outPath}`)
  console.log('Next: node scripts/facebook_marketplace_publish.mjs')
}

const isMain = resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  if (SELF_TEST) runSelfTest()
  else main()
}
