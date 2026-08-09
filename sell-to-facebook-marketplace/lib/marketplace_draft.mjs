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

/**
 * Analyze image metadata to guess item type and condition.
 * This is a simple heuristic; real image analysis would be more sophisticated.
 */
export function analyzeImages(imagePaths, imageFolderPath = '') {
  if (!imagePaths || imagePaths.length === 0) {
    return { type: 'unknown', condition: 'Good', colors: [] }
  }

  // In a real implementation, this would analyze actual image content.
  // For now, we use filename heuristics and return reasonable defaults.
  const types = new Map()
  ;[...imagePaths, imageFolderPath].forEach((p) => {
    const basename = path.basename(p).toLowerCase()
    if (basename.includes('laptop') || basename.includes('computer') || basename.includes('pc')) types.set('computer', 1)
    if (basename.includes('phone') || basename.includes('mobile')) types.set('phone', 1)
    if (basename.includes('chair') || basename.includes('table') || basename.includes('desk')) types.set('furniture', 1)
    if (basename.includes('book')) types.set('book', 1)
    if (basename.includes('toy')) types.set('toy', 1)
    if (basename.includes('shirt') || basename.includes('pants') || basename.includes('dress')) types.set('clothing', 1)
    if (basename.includes('bag') || basename.includes('handbag') || basename.includes('purse')) types.set('bag', 1)
  })

  const detectedType = types.size > 0 ? Array.from(types.keys())[0] : 'item'

  return {
    type: detectedType,
    condition: 'Good',
    colors: [],
  }
}

/**
 * Determine Facebook Marketplace category from detected item type.
 */
export function guessCategory(detectedType) {
  const typeMap = {
    computer: ['Electronics', 'Computers'],
    phone: ['Electronics', 'Mobile Phones'],
    furniture: ['Home', 'Furniture'],
    book: ['Books', 'Books'],
    toy: ['Toys', 'Toys & Games'],
    clothing: ['Fashion', 'Clothing'],
    bag: ['Fashion', 'Handbags'],
  }

  if (typeMap[detectedType]) {
    return typeMap[detectedType].join(' > ')
  }

  return 'Electronics > Other'
}

/**
 * Generate a title from the detected type and condition.
 */
export function generateTitle(detectedType, condition, price) {
  const adjective = condition === 'Like New' ? 'like new' : condition.toLowerCase()
  const typeNames = {
    computer: 'laptop/computer',
    phone: 'smartphone',
    furniture: 'furniture',
    book: 'book',
    toy: 'toy',
    clothing: 'clothing item',
    bag: 'leather bag',
    item: 'item',
  }

  const name = typeNames[detectedType] || 'item'
  const title = `${name} in ${adjective} condition`

  // Capitalize first letter
  return title.charAt(0).toUpperCase() + title.slice(1)
}

/**
 * Generate a description from item type and price.
 */
export function generateDescription(detectedType, condition, price, numPhotos) {
  const phrases = {
    computer: `Selling my personal laptop/computer. All working perfectly. ${numPhotos} photos showing condition.`,
    phone: `Selling my personal smartphone. All working perfectly. No cracks or damage. ${numPhotos} photos included.`,
    furniture: `Selling a piece of furniture. In ${condition.toLowerCase()} condition. All working/structurally sound. ${numPhotos} photos.`,
    book: `Selling a book in ${condition.toLowerCase()} condition. See photos for details.`,
    toy: `Selling a toy/game. In ${condition.toLowerCase()} condition. All pieces included. ${numPhotos} photos.`,
    clothing: `Selling clothing item in ${condition.toLowerCase()} condition. Clean and ready to wear. ${numPhotos} photos.`,
    bag: `Selling a leather bag in ${condition.toLowerCase()} condition. See the photos for its details and condition. ${numPhotos} photos included.`,
    item: `Selling an item in ${condition.toLowerCase()} condition. See ${numPhotos} photos for details.`,
  }

  return (
    phrases[detectedType] ||
    `Selling an item in ${condition.toLowerCase()} condition. ${numPhotos} photos included.`
  )
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
export function draftListing(imageFolderPath, price) {
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

  // Analyze images to guess item type
  const analysis = analyzeImages(imagePaths, imageFolderPath)

  // Generate listing fields
  const category = guessCategory(analysis.type)
  const condition = CONDITIONS[2] // Default to "Good"
  const title = generateTitle(analysis.type, condition, numPrice)
  const description = generateDescription(analysis.type, condition, numPrice, imagePaths.length)

  const listing = {
    title,
    category,
    condition,
    description,
    price: numPrice,
    imagePaths,
    imageCount: imagePaths.length,
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

export default { analyzeImages, guessCategory, generateTitle, generateDescription, draftListing, validateListing, formatListingForDisplay }
