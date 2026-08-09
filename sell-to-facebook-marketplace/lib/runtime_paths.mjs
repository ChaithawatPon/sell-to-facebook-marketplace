import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const OUTPUT_DIR = join(ROOT, 'output')
const STATE_DIR = join(ROOT, 'state')
const BROWSER_STATE_DIR = join(STATE_DIR, 'browser', 'facebook')
const FOLLOW_UP_STATE_FILE = join(STATE_DIR, 'marketplace-follow-ups.json')
const PREPARED_STATE_DIR = join(STATE_DIR, 'prepared')

function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-')
}

export {
  BROWSER_STATE_DIR,
  FOLLOW_UP_STATE_FILE,
  OUTPUT_DIR,
  PREPARED_STATE_DIR,
  ROOT,
  STATE_DIR,
  timestampSlug,
}
