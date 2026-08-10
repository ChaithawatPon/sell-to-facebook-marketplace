import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const scripts = [
  ['scripts/facebook_marketplace_draft.mjs', '--self-test'],
  ['scripts/facebook_marketplace_publish.mjs', '--self-test'],
  ['scripts/facebook_marketplace_inbox.mjs', '--self-test'],
  ['scripts/facebook_marketplace_inventory.mjs', '--self-test'],
  ['scripts/facebook_marketplace_maintenance.mjs', '--self-test'],
  ['scripts/facebook_marketplace_autopilot.mjs', '--self-test'],
]

for (const args of scripts) {
  test(`self-test ${args[0]}`, () => {
    const output = execFileSync(process.execPath, args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    assert.match(output, /self-test passed/i)
  })
}
