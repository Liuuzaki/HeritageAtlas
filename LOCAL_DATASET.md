# Local SQLite atlas mode

The website no longer reads `public/data/places.json` at runtime.

On the first visit, the visitor clicks **Download dataset**. The app downloads
the SQLite file named in `public/data/atlas-manifest.json`, stores it in the
browser's Origin Private File System (OPFS) when available, and falls back to
IndexedDB otherwise. Later visits reopen the stored dataset automatically.

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
  --registry "Mérimée" `
  --mode merge `
  --manifest "public/data/atlas-manifest.json" `
  --version "2026-06-27" `
  --name "Heritage Atlas · 2026-06-27" `
  --dataset-url "https://YOUR-DATA-HOST/heritage-atlas-2026-06.sqlite"
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

Upload the `.sqlite` file to a host that permits cross-origin `fetch()`
requests from your GitHub Pages domain. The manifest stays in the site repo;
it is tiny and tells the app whether a newer dataset exists.

Do not put a large production SQLite file in the GitHub Pages repository
unless you deliberately want GitHub Pages to deliver the initial download.
A GitHub Release asset or a separate CDN is a better default.

## What the database contains

- `places`: one row per Wikidata item, with every CSV field plus derived
  latitude/longitude values used by the map
- `metadata`: dataset version information

The importer creates indexes for country, registry, native label, map
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
