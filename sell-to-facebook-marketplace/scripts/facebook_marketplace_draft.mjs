#!/usr/bin/env node
/**
 * Phase 1: auto-draft a Facebook Marketplace listing from an image folder + price.
 *
 * Usage:
 *   node scripts/facebook_marketplace_draft.mjs <image-folder> <price>
 *   node scripts/facebook_marketplace_draft.mjs --self-test
 */

import { fileURLToPath } from 'url'
import { mkdirSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { draftListing, formatListingForDisplay } from '../lib/marketplace_draft.mjs'
import { OUTPUT_DIR, timestampSlug } from '../lib/runtime_paths.mjs'

const args = process.argv.slice(2)
const SELF_TEST = args.includes('--self-test')

function runSelfTest() {
  // No filesystem/browser access -- just prove draftListing() rejects bad input
  // and formatListingForDisplay() renders a well-formed listing.
  const fakeListing = {
    title: 'Laptop in good condition',
    category: 'Electronics > Computers',
    condition: 'Good',
    description: 'Selling my personal laptop.',
    price: 5000,
    imagePaths: ['/tmp/a.jpg', '/tmp/b.jpg'],
    imageCount: 2,
    timestamp: new Date().toISOString(),
  }

  const rendered = formatListingForDisplay(fakeListing)
  if (!rendered.includes('Laptop in good condition') || !rendered.includes('฿5000.00')) {
    console.error('✗ FAIL: formatListingForDisplay did not render expected fields')
    process.exit(1)
  }

  let threw = false
  try {
    draftListing('/definitely/does/not/exist', 100)
  } catch {
    threw = true
  }
  if (!threw) {
    console.error('✗ FAIL: draftListing did not throw on a missing folder')
    process.exit(1)
  }

  console.log('✓ facebook_marketplace_draft.mjs self-test passed')
  process.exit(0)
}

function main() {
  const [imageFolder, price] = args

  if (!imageFolder || price === undefined) {
    console.error('Usage: node scripts/facebook_marketplace_draft.mjs <image-folder> <price>')
    process.exit(1)
  }

  const listing = draftListing(resolve(imageFolder), price)

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
