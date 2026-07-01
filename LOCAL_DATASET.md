# Local SQLite atlas mode

The website no longer reads `public/data/places.json` at runtime.

On the first visit, the visitor clicks **Download dataset**. The app downloads
`atlas-sample.zip` from the repository's latest GitHub Release. The release API
and asset name are configured in `site-public/data/atlas-manifest.json`. The app
verifies GitHub's SHA-256 digest, extracts its SQLite database, then stores both
the release ZIP and database in the browser's Origin Private File System (OPFS)
when available. It falls back to IndexedDB otherwise. Later visits hash the
stored ZIP to decide whether an update is needed, while reopening the stored
database directly.

The app then queries SQLite in the browser. Search, filters, map-viewport
queries, sorting, and 20-result pagination do not request place data again.

## Import a production dataset

The single importer reads CSV directly and can either merge records into an
existing atlas (matching on Wikidata QID) or replace it with a new database.
Run it without arguments to use the desktop interface:

```powershell
python scripts/atlas_csv_importer.py
```

For an automated build, use the same tool from the command line:

```powershell
python scripts/atlas_csv_importer.py `
  --input "heritage_places_with_views.csv" `
  --output "build/heritage-atlas-2026-06.sqlite" `
  --mode merge `
  --version "2026-06-27" `
  --name "Heritage Atlas · 2026-06-27"
```

Use `--mode replace` when the CSV is the complete dataset. The default
`--mode merge` preserves places not present in the CSV and updates matching
QIDs. Rows without a QID are skipped. Places without valid coordinates are
kept in the database and search results, but do not appear on the map.

The current CSV format stores every source column, including labels in three
languages, WKT coordinates, language and country, heritage/designation data,
inception values, all Wikipedia counts and links, source-record links, Commons
images, and official websites. Additional future CSV columns are also retained
as SQLite columns and shown on the record page. `label_native` is the primary
place heading; `label_en` and `label_zh` appear beneath it. The first URL in
`commons_image_urls` is used as the thumbnail.

Package the `.sqlite` file as `atlas-sample.zip` and upload that ZIP as a GitHub
Release asset. The manifest stays in the site repo and points to GitHub's
latest-release API. The deployment workflow fetches `atlas-sample.zip` from the
latest release into the Pages artifact. The app downloads that same-origin ZIP
and uses the asset size and SHA-256 digest supplied by GitHub. GitHub Pages never
serves the unpacked SQLite database. Vite deploys only `site-public/`; files
under `public/data/` remain local dataset build inputs and are not copied to
`dist/`. The Vite development and preview servers proxy the latest release ZIP
at the same route so the installation flow can be tested locally. Publishing a
GitHub Release triggers the Pages workflow, keeping the static ZIP synchronized
with the latest-release API response.

## What the database contains

- `places`: one row per Wikidata item, with every CSV field plus derived
  latitude/longitude values used by the map
- `metadata`: dataset version information

The importer creates indexes for country, native label, map
coordinates, and Wikipedia view count.

## Local storage behavior

- The user does not select the database file on every visit.
- Clearing browser/site data removes the installed atlas.
- Incognito/private windows may not keep it.
- The browser can refuse persistent-storage protection, so treat the local
  atlas as a re-downloadable cache.

## SQLite engine

The app loads sql.js WebAssembly only when it opens a dataset. The URL is in
`src/sqlite.ts`. For a fully self-hosted setup, download `sql-wasm.js` and
`sql-wasm.wasm` into `public/vendor/sql.js/`, then change `SQL_JS_BASE_URL` to
`${import.meta.env.BASE_URL}vendor/sql.js/`.
