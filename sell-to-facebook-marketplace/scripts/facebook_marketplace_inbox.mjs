#!/usr/bin/env node
/** Marketplace inbox scan, auto-reply, and follow-up helpers. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { launchPersistentContext } from '../lib/browser_launch.mjs'
import { BROWSER_STATE_DIR, FOLLOW_UP_STATE_FILE } from '../lib/runtime_paths.mjs'

const STATE_FILE = FOLLOW_UP_STATE_FILE
const MIN_DELAY_MS = 24 * 60 * 60 * 1000
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 }
const LONG_MONTHS = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
}
const SYSTEM_MESSAGE_RE = /to help identify and reduce scams and fraud|started this chat|is waiting for your response|you can now rate each other|reacted .* to your message/i
const SETTLED_RE = /(sold|unavailable|no longer available|ปิดการขาย|ขายแล้ว|ไม่ขายแล้ว|ยกเลิก|cancelled|รับของแล้ว|นัดรับแล้ว|โอนแล้ว|คืนเงิน|refund|dispute|โกง|แจ้งปัญหา|rate each other|ให้คะแนน)/i
const NEGOTIATION_RE = /(discount|best price|ลดได้|ลดอีก|ลดสุด|ลดราคา|เท่าไรสุด|ขอลด|รับ.*ไหม|เอาเลย|จอง|hold|deposit|มัดจำ|โอน|พร้อมรับ|พร้อมเอา)/i
const STATUS_CHANGE_RE = /(mark as sold|sold|pending|reserve|จอง|ขายแล้ว|ปิดการขาย)/i

function normalize(value) { return String(value || '').replace(/\s+/g, ' ').trim() }
function fingerprint(value) { return createHash('sha256').update(normalize(value), 'utf8').digest('hex').slice(0, 16) }
function stateKey(thread) { return normalize(thread.id || `${thread.buyerName}|${thread.listingTitle}`) }
function substantive(message) {
  const text = normalize(message?.text)
  return text.length > 1 && !/^(seen|ส่งแล้ว|sent|message sent)$/i.test(text) && !SYSTEM_MESSAGE_RE.test(text)
}

function hasSettledOutcome(messages, listingStatus = '') {
  const text = `${listingStatus} ${messages.map((message) => message.text).join(' ')}`.toLowerCase()
  return SETTLED_RE.test(text)
}

function extractTone(messages) {
  const sellerTexts = messages.filter((message) => message.author === 'seller' && substantive(message)).map((message) => normalize(message.text))
  const sample = sellerTexts.slice(-3).join(' ')
  return {
    particle: /คับ(?:\b|$)/.test(sample) ? 'คับ' : /ครับ(?:\b|$)/.test(sample) ? 'ครับ' : '',
    punctuation: /[!?]/.test(sample) ? '!' : '',
  }
}

function sellerParticle(messages) {
  return extractTone(messages).particle || 'ครับ'
}

function draftFollowUp(messages) {
  const tone = extractTone(messages)
  return `หากมีคำถามเพิ่มเติมเกี่ยวกับรายการนี้ สอบถามได้เลย${tone.particle || 'ครับ'}${tone.punctuation}`
}

function draftAutoReply(thread) {
  const particle = sellerParticle(thread.messages)
  const latestBuyer = [...thread.messages].reverse().find((message) => message.author === 'buyer' && substantive(message))
  const buyerText = normalize(latestBuyer?.text).toLowerCase()
  if (!buyerText) return ''
  if (/(ยังมี|available|is it available|มีสินค้านี้ไหม|อยู่ไหม)/i.test(buyerText)) {
    return `ยังมี${particle} สอบถามเพิ่มเติมได้เลย${particle}`
  }
  if (/(สวัสดี|hello|hi|interested|สนใจ)/i.test(buyerText)) {
    return `สวัสดี${particle} ยังมีสินค้าอยู่${particle} สนใจสอบถามเพิ่มเติมได้เลย${particle}`
  }
  return `ต้องการสอบถามรายละเอียดส่วนไหนเพิ่มเติม${particle}`
}

function isFollowUpEligible(thread, state = {}, now = Date.now()) {
  if (!thread.isSellerListing) return { eligible: false, reason: 'not a verified seller listing' }
  if (!thread.listingActive) return { eligible: false, reason: 'listing is not active' }
  const messages = thread.messages.filter(substantive)
  const latest = messages.at(-1)
  if (!latest) return { eligible: false, reason: 'no substantive conversation' }
  if (latest.author !== 'seller') return { eligible: false, reason: 'buyer spoke last' }
  if (!Number.isFinite(latest.timestamp)) return { eligible: false, reason: 'seller message timestamp unavailable' }
  if (now - latest.timestamp < MIN_DELAY_MS) return { eligible: false, reason: 'seller message is newer than 24 hours' }
  if (hasSettledOutcome(messages, thread.listingStatus)) return { eligible: false, reason: 'conversation or listing is settled' }
  const prior = state[stateKey(thread)]
  if (prior && (!prior.buyerReplyAt || prior.buyerReplyAt < prior.sentAt)) return { eligible: false, reason: 'follow-up already sent' }
  return { eligible: true, reason: 'verified seller thread awaiting buyer', reply: draftFollowUp(messages) }
}

function isAutoReplyEligible(thread, state = {}) {
  if (!thread.isSellerListing) return { eligible: false, reason: 'not a verified seller listing' }
  if (!thread.listingActive) return { eligible: false, reason: 'listing is not active' }
  const messages = thread.messages.filter(substantive)
  const latest = messages.at(-1)
  if (!latest) return { eligible: false, reason: 'no substantive conversation' }
  if (latest.author !== 'buyer') return { eligible: false, reason: 'seller spoke last' }
  if (hasSettledOutcome(messages, thread.listingStatus)) return { eligible: false, reason: 'conversation or listing is settled' }
  const latestText = normalize(latest.text)
  if (NEGOTIATION_RE.test(latestText)) return { eligible: false, reason: 'buyer is negotiating or asking for a commitment' }
  if (STATUS_CHANGE_RE.test(latestText)) return { eligible: false, reason: 'buyer is asking for a status-changing action' }
  const prior = state[stateKey(thread)]
  const buyerMessageFingerprint = fingerprint(`${latest.timestampText}|${latestText}`)
  if (prior?.repliedToBuyerFingerprint === buyerMessageFingerprint) {
    return { eligible: false, reason: 'auto-reply already sent for latest buyer message' }
  }
  return {
    eligible: true,
    reason: 'verified seller thread awaiting seller reply',
    reply: draftAutoReply(thread),
    buyerMessageFingerprint,
  }
}

async function readState() {
  try { return JSON.parse(await readFile(STATE_FILE, 'utf8')) } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw error
  }
}

async function writeState(state) {
  await mkdir(dirname(STATE_FILE), { recursive: true })
  await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

async function updateThreadState(thread, patch) {
  const state = await readState()
  state[stateKey(thread)] = { ...(state[stateKey(thread)] || {}), ...patch, listingTitle: normalize(thread.listingTitle) }
  await writeState(state)
}

async function recordFollowUp(thread, message, now = Date.now()) {
  await updateThreadState(thread, { sentAt: now, fingerprint: fingerprint(message), lastFollowUpText: message })
}

async function recordAutoReply(thread, buyerMessage, message, now = Date.now()) {
  await updateThreadState(thread, {
    lastAutoReplyAt: now,
    lastAutoReplyText: message,
    repliedToBuyerAt: Number.isFinite(buyerMessage.timestamp) ? buyerMessage.timestamp : now,
    repliedToBuyerText: normalize(buyerMessage.text).slice(0, 120),
    repliedToBuyerFingerprint: fingerprint(`${buyerMessage.timestampText}|${buyerMessage.text}`),
  })
}

async function launchPage() {
  const context = await launchPersistentContext(
    chromium,
    BROWSER_STATE_DIR,
    { headless: false, channel: 'chrome' },
    { label: 'marketplace-inbox' }
  )
  return { context, page: context.pages()[0] || await context.newPage() }
}

async function openMarketplaceInbox(page) {
  await page.goto('https://www.facebook.com/marketplace/inbox/', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
}

function parseTimeParts(raw) {
  const match = normalize(raw).match(/^(\d{1,2}):(\d{2})\s*([ap]m)$/i)
  if (!match) return null
  let hour = Number(match[1]) % 12
  if (match[3].toLowerCase() === 'pm') hour += 12
  return { hour, minute: Number(match[2]) }
}

function parseMarketplaceTimestamp(raw, now = new Date()) {
  const text = normalize(raw).replace(/\u202f/g, ' ')
  if (!text) return Number.NaN

  const parsedNative = Date.parse(text)
  if (Number.isFinite(parsedNative)) return parsedNative

  const todayMatch = text.match(/^today\s+(\d{1,2}:\d{2}\s*[ap]m)$/i)
  if (todayMatch) {
    const parts = parseTimeParts(todayMatch[1])
    if (!parts) return Number.NaN
    const date = new Date(now)
    date.setHours(parts.hour, parts.minute, 0, 0)
    return date.getTime()
  }

  const yesterdayMatch = text.match(/^yesterday\s+(\d{1,2}:\d{2}\s*[ap]m)$/i)
  if (yesterdayMatch) {
    const parts = parseTimeParts(yesterdayMatch[1])
    if (!parts) return Number.NaN
    const date = new Date(now)
    date.setDate(date.getDate() - 1)
    date.setHours(parts.hour, parts.minute, 0, 0)
    return date.getTime()
  }

  const weekdayMatch = text.match(/^(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s+(\d{1,2}:\d{2}\s*[ap]m)$/i)
  if (weekdayMatch) {
    const parts = parseTimeParts(weekdayMatch[2])
    if (!parts) return Number.NaN
    const target = WEEKDAYS.indexOf(weekdayMatch[1].toLowerCase())
    const date = new Date(now)
    let delta = (date.getDay() - target + 7) % 7
    date.setHours(parts.hour, parts.minute, 0, 0)
    if (delta === 0 && date.getTime() > now.getTime()) delta = 7
    date.setDate(date.getDate() - delta)
    return date.getTime()
  }

  const shortMonthMatch = text.match(/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2})(?:,\s*(\d{4}))?(?:\s+(\d{1,2}:\d{2}\s*[ap]m))?$/i)
  if (shortMonthMatch) {
    const year = shortMonthMatch[3] ? Number(shortMonthMatch[3]) : now.getFullYear()
    const date = new Date(year, MONTHS[shortMonthMatch[1].toLowerCase()], Number(shortMonthMatch[2]), 0, 0, 0, 0)
    if (shortMonthMatch[4]) {
      const parts = parseTimeParts(shortMonthMatch[4])
      if (parts) date.setHours(parts.hour, parts.minute, 0, 0)
    }
    if (!shortMonthMatch[3] && date.getTime() > now.getTime()) date.setFullYear(date.getFullYear() - 1)
    return date.getTime()
  }

  const longMonthMatch = text.match(/^(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),\s*(\d{4})(?:,\s*(\d{1,2}:\d{2}\s*[ap]m))?$/i)
  if (longMonthMatch) {
    const date = new Date(Number(longMonthMatch[3]), LONG_MONTHS[longMonthMatch[1].toLowerCase()], Number(longMonthMatch[2]), 0, 0, 0, 0)
    if (longMonthMatch[4]) {
      const parts = parseTimeParts(longMonthMatch[4])
      if (parts) date.setHours(parts.hour, parts.minute, 0, 0)
    }
    return date.getTime()
  }

  return Number.NaN
}

function parseConversationTitle(text) {
  const normalized = normalize(text)
  const split = normalized.match(/^(.+?)\s+·\s+(.+)$/)
  return split ? { buyerName: split[1], listingTitle: split[2] } : { buyerName: '', listingTitle: normalized }
}

function parseRowDate(text) {
  const normalized = normalize(text)
  const match = normalized.match(/(Today|Yesterday|Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan \d{1,2}|Feb \d{1,2}|Mar \d{1,2}|Apr \d{1,2}|May \d{1,2}|Jun \d{1,2}|Jul \d{1,2}|Aug \d{1,2}|Sep \d{1,2}|Oct \d{1,2}|Nov \d{1,2}|Dec \d{1,2}|\d{1,2}:\d{2})$/i)
  return match ? match[1] : ''
}

function isConversationRowCandidate(row) {
  const text = normalize(row.text)
  if (!text || row.ariaLabel) return false
  if (row.x < 350 || row.x > 1200 || row.y < 120 || row.width < 300 || row.height < 40) return false
  if (/Location:|Within \d+ km|Edit Marketplace Settings|Create new listing|Search Marketplace|New message/.test(text)) return false
  if (!parseRowDate(text)) return false
  return true
}

async function listConversationRows(page) {
  const rows = await page.locator('div[role="button"][tabindex="0"]').evaluateAll((nodes) => nodes.map((node, index) => {
    const rect = node.getBoundingClientRect()
    return {
      index,
      text: String(node.textContent || ''),
      ariaLabel: node.getAttribute('aria-label') || '',
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    }
  }))
  return rows.filter(isConversationRowCandidate)
}

function dedupeMessages(messages) {
  const seen = new Set()
  return messages.filter((message) => {
    const key = `${message.author}|${message.timestampText}|${normalize(message.text)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function parseThreadMessages(rawMessages, buyerName, now) {
  const parsed = []
  for (const raw of rawMessages) {
    const match = normalize(raw).match(/^Enter,\s*Message sent\s+(.+?)\s+by\s*(.*?)(?::\s*(.*))?$/i)
    if (!match) continue
    const [, timestampText, authorText, text = ''] = match
    const normalizedAuthor = normalize(authorText)
    parsed.push({
      author: /^you$/i.test(normalizedAuthor) ? 'seller' : 'buyer',
      authorLabel: normalizedAuthor || buyerName,
      text: normalize(text),
      timestampText: normalize(timestampText),
      timestamp: parseMarketplaceTimestamp(timestampText, now),
    })
  }
  return dedupeMessages(parsed)
}

function isSellerOwnedThread(snapshot) {
  return snapshot.headerButtons.some((label) => /^(Mark as pending|Mark as sold|Mark out of stock|Delete & relist|View buyer)$/i.test(label)) ||
    /(Mark as pending|Mark as sold|Mark out of stock|Delete & relist|View buyer)/i.test(snapshot.bodyText)
}

async function inspectOpenThread(page, row, now = new Date()) {
  const rowLocator = page.locator('div[role="button"][tabindex="0"]').nth(row.index)
  await rowLocator.scrollIntoViewIfNeeded()
  await rowLocator.focus()
  await rowLocator.press('Enter')
  await page.waitForTimeout(1500)

  const snapshot = await page.evaluate(() => {
    const normalizeInner = (value) => String(value || '').replace(/\s+/g, ' ').trim()
    const titleButton = document.querySelector('[aria-label^="Conversation titled "]')
    let threadRoot = titleButton
    while (threadRoot && !threadRoot.querySelector?.('[aria-label^="Enter, Message sent "]')) {
      threadRoot = threadRoot.parentElement
    }
    const scope = threadRoot || document
    const messageButtons = Array.from(scope.querySelectorAll('[aria-label^="Enter, Message sent "]')).map((node) => node.getAttribute('aria-label'))
    const headerButtons = Array.from(scope.querySelectorAll('[aria-label]')).map((node) => node.getAttribute('aria-label')).filter(Boolean)
    return {
      bodyText: normalizeInner(scope.innerText || document.body.innerText),
      conversationTitle: titleButton ? normalizeInner(titleButton.getAttribute('aria-label').replace(/^Conversation titled\s+/i, '')) : '',
      messageButtons,
      headerButtons,
    }
  })

  const title = snapshot.conversationTitle || normalize(row.text)
  const { buyerName, listingTitle } = parseConversationTitle(title)
  const messages = parseThreadMessages(snapshot.messageButtons, buyerName, now)
  const isSellerListing = isSellerOwnedThread(snapshot)
  const listingActive = isSellerListing && !/(marketplace sold|no longer available|unavailable|ปิดการขาย|ขายแล้ว)/i.test(snapshot.bodyText)
  const latestBuyerMessage = [...messages].reverse().find((message) => message.author === 'buyer' && substantive(message))
  const latestSellerMessage = [...messages].reverse().find((message) => message.author === 'seller' && substantive(message))
  return {
    id: normalize(title),
    buyerName,
    listingTitle,
    listingStatus: normalize(snapshot.bodyText),
    isSellerListing,
    listingActive,
    messages,
    latestBuyerMessage,
    latestSellerMessage,
    evidence: {
      rowText: normalize(row.text),
      conversationTitle: title,
      hasPendingButton: snapshot.headerButtons.includes('Mark as pending'),
      bodyPreview: snapshot.bodyText.slice(0, 500),
      messageCount: messages.length,
    },
  }
}

function syncBuyerReplyState(thread, state) {
  const key = stateKey(thread)
  const prior = state[key]
  if (!prior?.sentAt || !thread.latestBuyerMessage?.timestamp) return false
  if (thread.latestBuyerMessage.timestamp <= prior.sentAt) return false
  state[key] = {
    ...prior,
    buyerReplyAt: thread.latestBuyerMessage.timestamp,
    buyerReplyText: normalize(thread.latestBuyerMessage.text).slice(0, 120),
  }
  return true
}

async function sendMarketplaceMessage(page, message) {
  const textbox = page.getByRole('textbox').last()
  await textbox.waitFor({ state: 'visible', timeout: 10000 })
  await textbox.fill(message)
  const sendButton = page.getByRole('button', { name: /^send$/i }).last()
  if (await sendButton.isVisible().catch(() => false)) {
    await sendButton.click()
  } else {
    await textbox.press('Enter')
  }
  await page.getByText(message, { exact: true }).last().waitFor({ state: 'visible', timeout: 10000 })
}

async function sendFollowUp({ page, thread, state, now = Date.now() }) {
  const decision = isFollowUpEligible(thread, state, now)
  if (!decision.eligible) throw new Error(`Refusing automatic follow-up: ${decision.reason}`)
  await sendMarketplaceMessage(page, decision.reply)
  await recordFollowUp(thread, decision.reply, now)
  return { status: 'sent', action: 'follow_up', reply: decision.reply }
}

async function sendAutoReply({ page, thread, state, now = Date.now() }) {
  const decision = isAutoReplyEligible(thread, state)
  if (!decision.eligible) throw new Error(`Refusing automatic reply: ${decision.reason}`)
  await sendMarketplaceMessage(page, decision.reply)
  await recordAutoReply(thread, thread.latestBuyerMessage, decision.reply, now)
  return { status: 'sent', action: 'reply', reply: decision.reply }
}

async function scanInbox({ limit = 30 } = {}) {
  const { context, page } = await launchPage()
  try {
    await openMarketplaceInbox(page)
    const state = await readState()
    let stateChanged = false
    const now = new Date()
    const rows = await listConversationRows(page)
    const replyCandidates = []
    const followUpCandidates = []
    const skipped = []

    for (const row of rows.slice(0, limit)) {
      const thread = await inspectOpenThread(page, row, now)
      stateChanged = syncBuyerReplyState(thread, state) || stateChanged
      const replyDecision = isAutoReplyEligible(thread, state)
      const followDecision = isFollowUpEligible(thread, state, now.getTime())
      const payload = {
        id: stateKey(thread),
        buyerName: thread.buyerName,
        listingTitle: thread.listingTitle,
        latestSellerMessageAt: thread.latestSellerMessage?.timestampText || '',
        latestBuyerMessageAt: thread.latestBuyerMessage?.timestampText || '',
        evidence: thread.evidence,
      }
      if (replyDecision.eligible) replyCandidates.push({ ...payload, reason: replyDecision.reason, reply: replyDecision.reply })
      else if (followDecision.eligible) followUpCandidates.push({ ...payload, reason: followDecision.reason, reply: followDecision.reply })
      else skipped.push({ ...payload, reason: replyDecision.reason !== 'seller spoke last' ? replyDecision.reason : followDecision.reason })
    }

    if (stateChanged) await writeState(state)
    const eligible = [...replyCandidates.map((item) => ({ ...item, action: 'reply' })), ...followUpCandidates.map((item) => ({ ...item, action: 'follow_up' }))]
    const result = { status: 'scanned', scannedThreads: rows.length, eligible, replyCandidates, followUpCandidates, skipped }
    console.log(JSON.stringify(result, null, 2))
    return result
  } finally { await context.close() }
}

async function autoInbox({ limit = 30 } = {}) {
  const { context, page } = await launchPage()
  try {
    await openMarketplaceInbox(page)
    const state = await readState()
    let stateChanged = false
    const now = new Date()
    const rows = await listConversationRows(page)
    const repliesSent = []
    const followUpsSent = []
    const skipped = []

    for (const row of rows.slice(0, limit)) {
      const thread = await inspectOpenThread(page, row, now)
      stateChanged = syncBuyerReplyState(thread, state) || stateChanged
      const payload = {
        id: stateKey(thread),
        buyerName: thread.buyerName,
        listingTitle: thread.listingTitle,
        latestSellerMessageAt: thread.latestSellerMessage?.timestampText || '',
        latestBuyerMessageAt: thread.latestBuyerMessage?.timestampText || '',
        evidence: thread.evidence,
      }
      const replyDecision = isAutoReplyEligible(thread, state)
      if (replyDecision.eligible) {
        const result = await sendAutoReply({ page, thread, state, now: Date.now() })
        const record = { ...payload, reason: replyDecision.reason, reply: result.reply }
        repliesSent.push(record)
        state[stateKey(thread)] = { ...(state[stateKey(thread)] || {}), repliedToBuyerFingerprint: fingerprint(`${thread.latestBuyerMessage.timestampText}|${thread.latestBuyerMessage.text}`) }
        continue
      }
      const followDecision = isFollowUpEligible(thread, state, now.getTime())
      if (followDecision.eligible) {
        const result = await sendFollowUp({ page, thread, state, now: Date.now() })
        followUpsSent.push({ ...payload, reason: followDecision.reason, reply: result.reply })
        state[stateKey(thread)] = { ...(state[stateKey(thread)] || {}), sentAt: Date.now() }
        continue
      }
      skipped.push({ ...payload, reason: replyDecision.reason !== 'seller spoke last' ? replyDecision.reason : followDecision.reason })
    }

    if (stateChanged) await writeState(state)
    const result = { status: 'completed', scannedThreads: rows.length, repliesSent, followUpsSent, skipped }
    console.log(JSON.stringify(result, null, 2))
    return result
  } finally { await context.close() }
}

function assert(condition, message) { if (!condition) throw new Error(message) }
async function runSelfTest() {
  const now = Date.UTC(2026, 7, 8, 12)
  const followThread = { id: 'seller-thread', listingTitle: 'กระเป๋า', isSellerListing: true, listingActive: true, messages: [
    { author: 'buyer', text: 'ยังอยู่ไหม', timestamp: now - 30 * 60 * 60 * 1000, timestampText: 'Thursday 6:00am' },
    { author: 'seller', text: 'ยังอยู่ครับ', timestamp: now - 25 * 60 * 60 * 1000, timestampText: 'Thursday 11:00am' },
  ] }
  const replyThread = { id: 'buyer-thread', listingTitle: 'เตาอบ', isSellerListing: true, listingActive: true, messages: [
    { author: 'buyer', text: 'ยังมีสินค้านี้ไหม', timestamp: now - 2 * 60 * 60 * 1000, timestampText: 'Saturday 10:00am' },
  ], latestBuyerMessage: { author: 'buyer', text: 'ยังมีสินค้านี้ไหม', timestamp: now - 2 * 60 * 60 * 1000, timestampText: 'Saturday 10:00am' } }
  assert(isFollowUpEligible(followThread, {}, now).eligible, 'eligible seller thread was rejected')
  assert(draftFollowUp(followThread.messages).endsWith('ครับ'), 'neutral Thai fallback failed')
  assert(extractTone([{ author: 'seller', text: 'ได้คับ', timestamp: now }]).particle === 'คับ', 'Thai tone extraction failed')
  assert(isAutoReplyEligible(replyThread, {}).eligible, 'eligible buyer-last thread was rejected')
  assert(draftAutoReply(replyThread) === 'ยังมีครับ สอบถามเพิ่มเติมได้เลยครับ', 'availability reply drafting failed')
  assert(!substantive({ text: 'To help identify and reduce scams and fraud, Meta may use technology to review Marketplace messages.' }), 'scam review banner was treated as substantive')
  assert(Number.isFinite(parseMarketplaceTimestamp('Monday 11:56am', new Date('2026-08-08T12:00:00+07:00'))), 'weekday timestamp parsing failed')
  assert(Number.isFinite(parseMarketplaceTimestamp('July 28, 2026, 4:23 PM', new Date('2026-08-08T12:00:00+07:00'))), 'absolute timestamp parsing failed')
  assert(!isAutoReplyEligible({ ...replyThread, messages: [{ author: 'buyer', text: 'ลดได้ไหม', timestamp: now, timestampText: 'Saturday 11:00am' }], latestBuyerMessage: { author: 'buyer', text: 'ลดได้ไหม', timestamp: now, timestampText: 'Saturday 11:00am' } }, {}).eligible, 'negotiation thread was accepted')
  assert(!isFollowUpEligible({ ...followThread, messages: [...followThread.messages, { author: 'buyer', text: 'สนใจ', timestamp: now - 2 * 60 * 60 * 1000, timestampText: 'Saturday 10:00am' }] }, {}, now).eligible, 'buyer-last follow-up was accepted')
  assert(!isFollowUpEligible({ ...followThread, listingActive: false }, {}, now).eligible, 'inactive listing was accepted')
  assert(!isFollowUpEligible(followThread, { 'seller-thread': { sentAt: now - 1000 } }, now).eligible, 'duplicate follow-up was accepted')
  console.log('✓ facebook_marketplace_inbox.mjs self-test passed')
}

const isMain = resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  if (process.argv.includes('--self-test')) runSelfTest().catch((error) => { console.error(error); process.exit(1) })
  else if (process.argv.includes('--scan')) scanInbox().catch((error) => { console.error('Marketplace inbox scan failed:', error); process.exit(1) })
  else if (process.argv.includes('--auto')) autoInbox().catch((error) => { console.error('Marketplace inbox auto-send failed:', error); process.exit(1) })
  else console.error('Usage: facebook_marketplace_inbox.mjs --scan | --auto | --self-test')
}

export {
  autoInbox,
  draftAutoReply,
  draftFollowUp,
  extractTone,
  inspectOpenThread,
  isAutoReplyEligible,
  isFollowUpEligible,
  launchPage,
  listConversationRows,
  normalize,
  openMarketplaceInbox,
  parseMarketplaceTimestamp,
  readState,
  scanInbox,
  sendAutoReply,
  sendFollowUp,
  substantive,
  updateThreadState,
  writeState,
}
