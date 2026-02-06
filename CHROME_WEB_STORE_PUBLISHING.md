# Chrome Web Store Publishing Kit

This file contains:

- store-ready listing copy
- a release checklist tailored to the current `manifest.json`
- exact zip commands to publish

## 1) Store Listing Copy

### Short Description

Find matching OpenReview forums from arXiv abstract pages and copy BibTeX in one click.

### Full Description

arXiv -> OpenReview Linker adds an OpenReview panel directly to arXiv abstract pages so you can quickly jump from a paper to its OpenReview forum.

What it does:

- Detects paper title and arXiv ID on `arxiv.org/abs/*`
- Finds matching OpenReview forum results by title
- Shows quick actions to open forum/search results
- Lists available versions/venues when found
- Lets you copy BibTeX with one click
- Includes a toolbar popup with the same core workflow

Why it is useful:

- Saves time when checking peer-review discussions for papers you read on arXiv
- Reduces manual searching and copy/paste steps

Notes:

- Matching is title-based; if metadata differs significantly, matches may fail
- OpenReview UI changes may require extension updates

## 2) Release Checklist (Tailored to Current Manifest)

Current manifest snapshot (from this repo):

- `manifest_version`: `3`
- `name`: `arXiv → OpenReview Linker`
- `version`: `1.7.4`
- `permissions`: `storage`, `tabs`, `scripting`
- `host_permissions`: `https://openreview.net/*`, `https://arxiv.org/*`
- icons: `16`, `48`, `128`

Pre-upload checks:

1. Update `manifest.json`:
- Keep `version` strictly incremented for every store upload.
- Replace the current release-style `description` with a stable product description.
  Example: `Find matching OpenReview forums from arXiv pages and copy BibTeX quickly.`

2. Verify assets:
- `icons/icon16.png`, `icons/icon48.png`, `icons/icon128.png` are present and clean.
- Add real screenshots under `screenshots/` for listing use.

3. Verify runtime behavior:
- Test on multiple `https://arxiv.org/abs/*` pages.
- Confirm popup works and no console errors in:
  - content script context
  - service worker (`background.js`)
  - popup

4. Privacy and permissions disclosure prep:
- Explain why each permission is required:
  - `storage`: local cache
  - `tabs`: open background tabs for lookup
  - `scripting`: run extraction logic on loaded pages
- Explain host access:
  - arXiv pages for injection
  - OpenReview pages for lookup/scraping

5. Store listing readiness:
- Short description
- Full description
- Screenshots
- Category and language
- Support email / homepage (if available)

6. Policy/compliance:
- Complete Chrome Web Store privacy/data usage form accurately.
- If required by your selected disclosures, provide a privacy policy URL.

## 3) Exact Packaging Commands

Run from:

`/Users/reza/Projects/arxiv-openreview-extension`

Create a clean package folder:

```bash
mkdir -p dist
```

Create upload zip (excludes git metadata and macOS junk):

```bash
zip -r dist/arxiv-openreview-linker-v1.7.4.zip . \
  -x "*.git*" \
  -x "dist/*" \
  -x "*.DS_Store" \
  -x "__MACOSX/*"
```

Optional: validate zip contents quickly:

```bash
unzip -l dist/arxiv-openreview-linker-v1.7.4.zip | head -n 40
```

Then upload `dist/arxiv-openreview-linker-v1.7.4.zip` in the Chrome Web Store Developer Dashboard.
