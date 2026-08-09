#!/usr/bin/env node
/** Marketplace autopilot: auto-reply/follow-up plus stale-listing audit. */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { autoInbox } from './facebook_marketplace_inbox.mjs'
import { scanSellingInventory } from './facebook_marketplace_inventory.mjs'
import { OUTPUT_DIR, timestampSlug } from '../lib/runtime_paths.mjs'

async function writeSummary(summary, { outputDir = OUTPUT_DIR } = {}) {
  await mkdir(outputDir, { recursive: true })
  const timestamp = timestampSlug()
  const path = join(outputDir, `${timestamp}-autopilot-summary.json`)
  await writeFile(path, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  return path
}

async function runAutopilot() {
  const inbox = await autoInbox()
  const inventory = await scanSellingInventory({ writePlanFile: true })
  const summary = {
    status: 'completed',
    ranAt: new Date().toISOString(),
    inbox,
    inventory,
    maintenanceNote: 'Inbox replies/follow-ups were sent automatically only for verified seller threads. Selling-page maintenance is reported as a relisting plan; public delete/relist actions remain review-gated.',
  }
  summary.summaryPath = await writeSummary(summary)
  console.log(JSON.stringify(summary, null, 2))
  return summary
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function runSelfTest() {
  const tempDir = await mkdtemp('/private/tmp/marketplace-autopilot-self-test-')
  try {
    const path = await writeSummary({ ok: true }, { outputDir: tempDir })
    assert(/autopilot-summary\.json$/.test(path), 'summary file path generation failed')
    console.log('✓ facebook_marketplace_autopilot.mjs self-test passed')
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

const isMain = resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  if (process.argv.includes('--self-test')) runSelfTest().catch((error) => { console.error(error); process.exit(1) })
  else runAutopilot().catch((error) => { console.error('Marketplace autopilot failed:', error); process.exit(1) })
}

export { runAutopilot }
