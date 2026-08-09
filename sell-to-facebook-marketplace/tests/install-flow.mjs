import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const REPO_ROOT = dirname(PACKAGE_ROOT)
const INSTALLER = join(REPO_ROOT, 'scripts', 'install-skill.py')

test('install-skill excludes runtime directories from copied package', () => {
  const destinationParent = mkdtempSync('/private/tmp/marketplace-install-test-')
  try {
    const installedPath = execFileSync(
      'python3',
      [INSTALLER, 'sell-to-facebook-marketplace', '--dest', destinationParent, '--root', REPO_ROOT],
      { encoding: 'utf8' }
    ).trim()

    assert.ok(existsSync(installedPath), 'installed package path should exist')
    assert.equal(existsSync(join(installedPath, 'node_modules')), false)
    assert.equal(existsSync(join(installedPath, 'output')), false)
    assert.equal(existsSync(join(installedPath, 'state')), false)
    assert.ok(readdirSync(installedPath).includes('SKILL.md'))
  } finally {
    rmSync(destinationParent, { recursive: true, force: true })
  }
})
