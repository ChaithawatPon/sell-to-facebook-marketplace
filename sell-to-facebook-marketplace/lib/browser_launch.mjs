const CHROME_CRASH_ARGS = [
  '--disable-crash-reporter',
  '--disable-crashpad',
  '--disable-breakpad',
]

// Google SSO blocks Playwright-controlled Chrome outright ("This browser or
// app may not be secure") unless the automation fingerprint is hidden. Any
// phase that can hit a Google-authenticated login (Google/Gmail/Slack SSO)
// needs this, not just the one script it was originally patched into.
const AUTOMATION_STEALTH_ARGS = ['--disable-blink-features=AutomationControlled']

function wantsBundledBrowser(channel) {
  const requested = String(process.env.MARKETPLACE_BROWSER || '').toLowerCase()
  return requested === 'bundled' || requested === 'chromium' || channel === 'bundled'
}

function shouldAvoidInstalledChrome() {
  return process.env.CODEX_SANDBOX === 'seatbelt' && !process.env.MARKETPLACE_ALLOW_SANDBOX_CHROME
}

function withStableChromeOptions(options) {
  const next = { ...options }
  if (wantsBundledBrowser(next.channel) || shouldAvoidInstalledChrome()) {
    delete next.channel
  }
  if (next.channel) {
    next.args = Array.from(new Set([...(next.args || []), ...CHROME_CRASH_ARGS, ...AUTOMATION_STEALTH_ARGS]))
    next.ignoreDefaultArgs = Array.from(new Set([...(next.ignoreDefaultArgs || []), '--enable-automation']))
  }
  return next
}

function isBundledBrowserMissing(error) {
  return /Executable doesn't exist|playwright install/i.test(String(error?.message || error))
}

function isChromeStartupAbort(error) {
  const text = String(error?.message || error)
  return (
    /Target page, context or browser has been closed/i.test(text) &&
    (/Crashpad|RegisterApplication|Operation not permitted|SIGABRT|Abort trap/i.test(text))
  )
}

function appendBrowserHint(error, label) {
  const message = String(error?.message || error)
  const hint = [
    '',
    `[${label}] Chrome could not start from this process. On macOS this usually means the agent sandbox blocked Chrome AppKit/Crashpad startup.`,
    'Fix: run this phase with the approved/elevated command, or install the bundled Playwright browser with `npx playwright install chromium` and run with `MARKETPLACE_BROWSER=bundled`.',
  ].join('\n')
  error.message = `${message}${hint}`
  return error
}

function appendBundledBrowserHint(error, label) {
  const message = String(error?.message || error)
  const hint = [
    '',
    `[${label}] Installed Chrome was skipped because this command is running inside the Codex seatbelt sandbox.`,
    'Fix: install the bundled Playwright browser with `npx playwright install chromium`, or run the phase with the approved/elevated command so installed Chrome can start normally.',
  ].join('\n')
  error.message = `${message}${hint}`
  return error
}

async function retryWithBundled(open, options, label, originalError) {
  const fallbackOptions = { ...options }
  delete fallbackOptions.channel
  try {
    console.warn(`[${label}] Installed Chrome failed before startup; retrying with bundled Playwright Chromium.`)
    return await open(fallbackOptions)
  } catch (fallbackError) {
    if (isBundledBrowserMissing(fallbackError)) {
      throw appendBrowserHint(originalError, label)
    }
    throw fallbackError
  }
}

export async function launchPersistentContext(chromium, userDataDir, options, { label = 'browser' } = {}) {
  const launchOptions = withStableChromeOptions(options)
  try {
    return await chromium.launchPersistentContext(userDataDir, launchOptions)
  } catch (error) {
    if (!launchOptions.channel && shouldAvoidInstalledChrome() && isBundledBrowserMissing(error)) {
      throw appendBundledBrowserHint(error, label)
    }
    if (launchOptions.channel && isChromeStartupAbort(error)) {
      return retryWithBundled(
        (fallbackOptions) => chromium.launchPersistentContext(userDataDir, fallbackOptions),
        launchOptions,
        label,
        error
      )
    }
    throw error
  }
}

export async function launchBrowser(chromium, options, { label = 'browser' } = {}) {
  const launchOptions = withStableChromeOptions(options)
  try {
    return await chromium.launch(launchOptions)
  } catch (error) {
    if (!launchOptions.channel && shouldAvoidInstalledChrome() && isBundledBrowserMissing(error)) {
      throw appendBundledBrowserHint(error, label)
    }
    if (launchOptions.channel && isChromeStartupAbort(error)) {
      return retryWithBundled((fallbackOptions) => chromium.launch(fallbackOptions), launchOptions, label, error)
    }
    throw error
  }
}
