import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { PREPARED_STATE_DIR, timestampSlug } from './runtime_paths.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Facebook Marketplace categories, externalized to references/facebook_categories.json
const CATEGORIES = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'references', 'facebook_categories.json'), 'utf-8')
)

const CONDITIONS = ['Like New', 'Excellent', 'Good', 'Fair', 'For Parts or Not Working']
const SUPPORTED_LISTING_TYPES = ['item']

/**
 * Collect non-claim evidence about the provided image set.
 */
export function analyzeImages(imagePaths) {
  if (!imagePaths || imagePaths.length === 0) {
    return { imageCount: 0, imageFileNames: [] }
  }

  return {
    imageCount: imagePaths.length,
    imageFileNames: imagePaths.map((imagePath) => path.basename(imagePath)),
  }
}

function normalizeString(value) {
  return String(value || '').trim()
}

export function validateMetadata(metadata) {
  const errors = []
  const normalized = metadata && typeof metadata === 'object'
    ? {
        listingType: normalizeString(metadata.listingType || 'item').toLowerCase(),
        title: normalizeString(metadata.title),
        category: normalizeString(metadata.category),
        condition: normalizeString(metadata.condition),
        description: normalizeString(metadata.description),
      }
    : null

  if (!normalized) {
    return { isValid: false, errors: ['metadata must be a JSON object'] }
  }
  if (!SUPPORTED_LISTING_TYPES.includes(normalized.listingType)) {
    errors.push(`listingType must be one of: ${SUPPORTED_LISTING_TYPES.join(', ')}`)
  }
  if (!normalized.title) errors.push('metadata.title is required')
  if (!normalized.category) errors.push('metadata.category is required')
  if (!normalized.condition) errors.push('metadata.condition is required')
  if (!normalized.description) errors.push('metadata.description is required')
  if (normalized.condition && !CONDITIONS.includes(normalized.condition)) {
    errors.push(`metadata.condition must be one of: ${CONDITIONS.join(', ')}`)
  }

  return {
    isValid: errors.length === 0,
    errors,
    metadata: normalized,
  }
}

export function loadMetadataFile(metadataPath) {
  if (!metadataPath) {
    throw new Error('Metadata file is required. Pass --metadata <path-to-json> with evidence-backed title, category, condition, and description.')
  }
  if (!fs.existsSync(metadataPath)) {
    throw new Error(`Metadata file not found: ${metadataPath}`)
  }

  let raw
  try {
    raw = JSON.parse(fs.readFileSync(metadataPath, 'utf8'))
  } catch (error) {
    throw new Error(`Could not parse metadata JSON: ${error.message}`)
  }

  const validation = validateMetadata(raw)
  if (!validation.isValid) {
    throw new Error(`Metadata validation failed:\n${validation.errors.join('\n')}`)
  }
  return validation.metadata
}

function prepareHeicImages(imageFolderPath, files) {
  const preparedDir = path.join(PREPARED_STATE_DIR, timestampSlug())
  const imagePaths = []

  for (const file of files) {
    const extension = path.extname(file).toLowerCase()
    const sourcePath = path.join(imageFolderPath, file)
    if (extension !== '.heic' && extension !== '.heif') {
      imagePaths.push(sourcePath)
      continue
    }

    fs.mkdirSync(preparedDir, { recursive: true })
    const targetPath = path.join(preparedDir, `${path.basename(file, extension)}.jpg`)
    const result = spawnSync('sips', ['-s', 'format', 'jpeg', sourcePath, '--out', targetPath], { encoding: 'utf8' })
    if (result.error || result.status !== 0 || !fs.existsSync(targetPath)) {
      const detail = result.error?.message || result.stderr?.trim() || 'sips did not create a JPEG'
      throw new Error(`Could not convert ${file} to JPEG: ${detail}`)
    }
    imagePaths.push(targetPath)
  }

  return imagePaths
}

/**
 * List valid Facebook Marketplace categories.
 */
export function listValidCategories() {
  const cats = []
  Object.entries(CATEGORIES).forEach(([parent, children]) => {
    cats.push(`${parent}`)
    children.forEach((child) => {
      cats.push(`  > ${child}`)
    })
  })
  return cats.join('\n')
}

/**
 * List valid conditions.
 */
export function listValidConditions() {
  return CONDITIONS
}

/**
 * Validate a proposed listing object.
 */
export function validateListing(listing) {
  const errors = []

  if (!listing.title || listing.title.trim().length === 0) {
    errors.push('title is required and cannot be empty')
  }
  if (!SUPPORTED_LISTING_TYPES.includes(listing.listingType)) {
    errors.push(`listingType must be one of: ${SUPPORTED_LISTING_TYPES.join(', ')}`)
  }
  if (!listing.category || listing.category.trim().length === 0) {
    errors.push('category is required')
  }
  if (!listing.condition || listing.condition.trim().length === 0) {
    errors.push('condition is required')
  }
  if (!listing.description || listing.description.trim().length === 0) {
    errors.push('description is required')
  }
  if (typeof listing.price !== 'number' || listing.price <= 0) {
    errors.push('price must be a positive number')
  }
  if (!Array.isArray(listing.imagePaths) || listing.imagePaths.length === 0) {
    errors.push('imagePaths must be a non-empty array')
  }

  return {
    isValid: errors.length === 0,
    errors,
  }
}

/**
 * Draft a listing from image folder + price.
 */
export function draftListing(imageFolderPath, price, metadata) {
  if (!fs.existsSync(imageFolderPath)) {
    throw new Error(`Image folder not found: ${imageFolderPath}`)
  }

  const stats = fs.statSync(imageFolderPath)
  if (!stats.isDirectory()) {
    throw new Error(`Not a directory: ${imageFolderPath}`)
  }

  // Read image files
  const files = fs.readdirSync(imageFolderPath)
  const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif']
  const imagePaths = prepareHeicImages(
    imageFolderPath,
    files.filter((f) => imageExts.includes(path.extname(f).toLowerCase()))
  )

  if (imagePaths.length === 0) {
    throw new Error(`No images found in: ${imageFolderPath}`)
  }

  // Parse price
  const numPrice = parseFloat(price)
  if (isNaN(numPrice) || numPrice <= 0) {
    throw new Error(`Invalid price: ${price}`)
  }

  const metadataValidation = validateMetadata(metadata)
  if (!metadataValidation.isValid) {
    throw new Error(`Metadata validation failed:\n${metadataValidation.errors.join('\n')}`)
  }
  const analysis = analyzeImages(imagePaths)

  const listing = {
    listingType: metadataValidation.metadata.listingType,
    title: metadataValidation.metadata.title,
    category: metadataValidation.metadata.category,
    condition: metadataValidation.metadata.condition,
    description: metadataValidation.metadata.description,
    price: numPrice,
    imagePaths,
    imageCount: imagePaths.length,
    imageEvidence: analysis,
    metadataSource: 'explicit',
    timestamp: new Date().toISOString(),
  }

  // Validate the draft
  const validation = validateListing(listing)
  if (!validation.isValid) {
    throw new Error(`Draft validation failed:\n${validation.errors.join('\n')}`)
  }

  return listing
}

/**
 * Format a listing for display before confirmation.
 */
export function formatListingForDisplay(listing) {
  const lines = [
    '='.repeat(60),
    'FACEBOOK MARKETPLACE LISTING DRAFT',
    '='.repeat(60),
    '',
    `Listing type: ${listing.listingType}`,
    `Title:       ${listing.title}`,
    `Category:    ${listing.category}`,
    `Condition:   ${listing.condition}`,
    `Price:       ฿${listing.price.toFixed(2)}`,
    `Images:      ${listing.imageCount} photo(s)`,
    '',
    'Description:',
    listing.description,
    '',
    'Photos included:',
    listing.imagePaths.map((p, i) => `  ${i + 1}. ${path.basename(p)}`).join('\n'),
    '',
    '='.repeat(60),
  ]

  return lines.join('\n')
}

export default { analyzeImages, draftListing, formatListingForDisplay, listValidCategories, listValidConditions, loadMetadataFile, validateListing, validateMetadata }
