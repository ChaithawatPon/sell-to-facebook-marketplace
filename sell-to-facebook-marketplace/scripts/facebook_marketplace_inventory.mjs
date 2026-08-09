#!/usr/bin/env node
/** Marketplace selling inventory audit and relisting-plan generator. */
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { launchPersistentContext } from '../lib/browser_launch.mjs'
import { BROWSER_STATE_DIR, OUTPUT_DIR, timestampSlug } from '../lib/runtime_paths.mjs'

const MS_PER_DAY = 24 * 60 * 60 * 1000

function normalize(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function parseThaiPrice(raw) {
  const match = normalize(raw).match(/฿\s*([\d,]+)/)
  return match ? Number(match[1].replace(/,/g, '')) : null
}

function parseMonthDay(raw, now = new Date()) {
  const match = normalize(raw).match(/^(\d{1,2})\/(\d{1,2})$/)
  if (!match) return null
  const month = Number(match[1]) - 1
  const day = Number(match[2])
  const date = new Date(now.getFullYear(), month, day, 0, 0, 0, 0)
  if (date.getTime() > now.getTime()) date.setFullYear(date.getFullYear() - 1)
  return date
}

function ageInDays(date, now = new Date()) {
  if (!date) return null
  return Math.floor((now.getTime() - date.getTime()) / MS_PER_DAY)
}

function inferRelistingSuggestions(card) {
  const suggestions = []
  if (/add a longer title/i.test(card.tip)) suggestions.push('lengthen title with brand, model, and product keywords')
  if (/renew your listing/i.test(card.tip)) suggestions.push('refresh title/description and consider a fresh repost window')
  if (card.clicks === 0) suggestions.push('replace lead image and first-line hook because the listing is getting zero detail views')
  if (card.clicks < 10) suggestions.push('add Thai + English search terms and clearer condition details')
  if (!suggestions.length) suggestions.push('keep monitoring; no relisting change suggested yet')
  return suggestions
}

function recommendAction(card, thresholds) {
  const reasons = []
  if (card.clicks < thresholds.minClicks) reasons.push(`only ${card.clicks} clicks in the last 14 days`)
  if (card.ageDays !== null && card.ageDays >= thresholds.maxAgeDays) reasons.push(`listed for ${card.ageDays} days`)
  if (!reasons.length) return { stale: false, action: 'keep_live', reasons }
  if (card.canDeleteAndRelist && (card.clicks === 0 || card.ageDays >= thresholds.maxAgeDays)) {
    return { stale: true, action: 'delete_and_relist_review', reasons }
  }
  return { stale: true, action: 'refresh_content_review', reasons }
}

async function launchPage() {
  const context = await launchPersistentContext(
    chromium,
    BROWSER_STATE_DIR,
    { headless: false, channel: 'chrome' },
    { label: 'marketplace-selling' }
  )
  return { context, page: context.pages()[0] || await context.newPage() }
}

async function openSellingPage(page) {
  await page.goto('https://www.facebook.com/marketplace/you/selling/', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
}

async function collectSellingCards(page, now = new Date()) {
  const rawCards = await page.evaluate(() => {
    const normalizeInner = (value) => String(value || '').replace(/\s+/g, ' ').trim()
    const labeled = Array.from(document.querySelectorAll('[aria-label]')).map((node) => ({
      ariaLabel: node.getAttribute('aria-label') || '',
      text: normalizeInner(node.textContent),
    }))
    return labeled
      .filter((node) => node.ariaLabel && /clicks? on listing/i.test(node.text) && /listed on marketplace/i.test(node.text.toLowerCase()))
      .map((node) => ({
        title: node.ariaLabel,
        text: node.text,
        relatedLabels: labeled.filter((candidate) => candidate.ariaLabel.endsWith(` ${node.ariaLabel}`) || candidate.ariaLabel === node.ariaLabel).map((candidate) => candidate.ariaLabel),
      }))
  })

  return rawCards.map((card) => {
    const text = normalize(card.text)
    const listedOnMatch = text.match(/Listed on (\d{1,2}\/\d{1,2})/i)
    const clicksMatch = text.match(/(\d+)\s+clicks?\s+on listing/i)
    const statusMatch = text.match(/(In stock|Active|Pending|Out of stock|Sold|No longer available)\s*·\s*Listed on/i)
    const tipMatch = text.match(/Tip:\s*([^฿]+?)(?=฿|In stock|Active|Pending|Out of stock|Sold|No longer available)/i)
    const listedDate = listedOnMatch ? parseMonthDay(listedOnMatch[1], now) : null
    return {
      title: card.title,
      text,
      price: parseThaiPrice(text),
      status: statusMatch ? statusMatch[1] : '',
      listedOnText: listedOnMatch ? listedOnMatch[1] : '',
      listedAt: listedDate ? listedDate.toISOString() : null,
      ageDays: ageInDays(listedDate, now),
      clicks: clicksMatch ? Number(clicksMatch[1]) : 0,
      tip: tipMatch ? normalize(tipMatch[1]) : '',
      canDeleteAndRelist: card.relatedLabels.includes(`Delete & relist ${card.title}`),
      canMarkAsSold: card.relatedLabels.includes(`Mark as sold ${card.title}`),
      canMarkOutOfStock: card.relatedLabels.includes(`Mark out of stock ${card.title}`),
    }
  })
}

async function writePlan(plan) {
  await mkdir(OUTPUT_DIR, { recursive: true })
  const timestamp = timestampSlug()
  const path = join(OUTPUT_DIR, `${timestamp}-inventory-maintenance-plan.json`)
  await writeFile(path, `${JSON.stringify(plan, null, 2)}\n`, 'utf8')
  return path
}

async function scanSellingInventory({ minClicks = 10, maxAgeDays = 7, writePlanFile = true } = {}) {
  const { context, page } = await launchPage()
  try {
    await openSellingPage(page)
    const now = new Date()
    const cards = await collectSellingCards(page, now)
    const activeListings = cards.filter((card) => !/(sold|out of stock|no longer available)/i.test(card.status))
    const staleListings = activeListings
      .map((card) => {
        const recommendation = recommendAction(card, { minClicks, maxAgeDays })
        return {
          ...card,
          stale: recommendation.stale,
          recommendedAction: recommendation.action,
          staleReasons: recommendation.reasons,
          relistingSuggestions: inferRelistingSuggestions(card),
        }
      })
      .filter((card) => card.stale)

    const result = {
      status: 'scanned',
      scannedListings: cards.length,
      activeListings: activeListings.length,
      thresholds: { minClicks, maxAgeDays },
      staleListings,
      nonStaleListings: activeListings.filter((card) => !staleListings.some((stale) => stale.title === card.title)).map((card) => ({
        title: card.title,
        clicks: card.clicks,
        ageDays: card.ageDays,
        status: card.status,
      })),
    }
    if (writePlanFile) {
      result.planPath = await writePlan(result)
    }
    console.log(JSON.stringify(result, null, 2))
    return result
  } finally {
    await context.close()
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function runSelfTest() {
  const now = new Date('2026-08-08T12:00:00+07:00')
  const date = parseMonthDay('4/4', now)
  assert(date instanceof Date, 'month/day parsing failed')
  assert(ageInDays(date, now) === 126, 'age calculation changed unexpectedly')
  const action = recommendAction({ clicks: 0, ageDays: 126, canDeleteAndRelist: true, tip: 'Renew your listing?' }, { minClicks: 10, maxAgeDays: 7 })
  assert(action.stale && action.action === 'delete_and_relist_review', 'stale relist recommendation failed')
  assert(parseThaiPrice('฿5,000฿6,300') === 5000, 'price parsing failed')
  console.log('✓ facebook_marketplace_inventory.mjs self-test passed')
}

const isMain = resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  if (process.argv.includes('--self-test')) runSelfTest().catch((error) => { console.error(error); process.exit(1) })
  else if (process.argv.includes('--scan')) scanSellingInventory().catch((error) => { console.error('Marketplace selling scan failed:', error); process.exit(1) })
  else console.error('Usage: facebook_marketplace_inventory.mjs --scan | --self-test')
}

export { collectSellingCards, parseMonthDay, scanSellingInventory }
