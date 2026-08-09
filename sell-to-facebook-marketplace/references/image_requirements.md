# Facebook Marketplace Image Requirements

- **Formats accepted by this skill:** `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp` (see `lib/marketplace_draft.mjs`'s `imageExts` filter).
- **Minimum:** at least 1 photo per listing (folder with zero matching images is rejected).
- **Recommended by Facebook:** square or landscape photos, ~1080px on the long edge for a sharp thumbnail. This skill does not currently resize images before upload — Facebook's own uploader downsizes on ingest.
- **Order:** photos are uploaded in the order `fs.readdirSync` returns them (typically alphabetical on macOS/APFS). Name files `01-...`, `02-...` etc. if a specific photo order matters for the listing.
- **One folder = one item:** every image in the folder is treated as a view/angle of the same item. Don't mix multiple items in one folder.
- **No semantic inference from filenames:** image names are never treated as evidence for title, category, condition, materials, functionality, or included accessories. Provide those fields explicitly via metadata JSON.
