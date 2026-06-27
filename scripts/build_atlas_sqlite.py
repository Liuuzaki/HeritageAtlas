#!/usr/bin/env python3
"""Build the browser-local SQLite atlas used by Heritage Atlas.

Input must be the compact JSON created by csv_to_places_json.py.

Example:
  python scripts/build_atlas_sqlite.py \
    --input /path/to/places.json \
    --output public/data/heritage-atlas-2026-06.sqlite \
    --manifest public/data/atlas-manifest.json \
    --version 2026-06-27 \
    --name "Heritage Atlas · 2026-06-27"

For a production release, upload the SQLite file to a GitHub Release or CDN,
then set datasetUrl in the manifest to that public, CORS-enabled URL.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
from pathlib import Path
from typing import Any

SCHEMA = """
PRAGMA journal_mode = OFF;
PRAGMA synchronous = OFF;
PRAGMA temp_store = MEMORY;

CREATE TABLE metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE places (
  qid TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  native_name TEXT,
  country TEXT,
  city TEXT,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  registry_name TEXT NOT NULL,
  registry_identifier TEXT,
  registry_url TEXT,
  thumbnail_primary TEXT,
  thumbnail_backups_json TEXT NOT NULL DEFAULT '[]',
  thumbnail_source_page TEXT,
  thumbnail_kind TEXT NOT NULL DEFAULT 'generated',
  wikipedia_native TEXT,
  wikipedia_english TEXT,
  wiki_view_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE place_styles (
  qid TEXT NOT NULL,
  style TEXT NOT NULL,
  PRIMARY KEY (qid, style)
) WITHOUT ROWID;

CREATE TABLE place_designations (
  qid TEXT NOT NULL,
  designation TEXT NOT NULL,
  PRIMARY KEY (qid, designation)
) WITHOUT ROWID;

CREATE INDEX idx_places_country ON places(country);
CREATE INDEX idx_places_registry ON places(registry_name);
CREATE INDEX idx_places_coordinates ON places(latitude, longitude);
CREATE INDEX idx_places_views ON places(wiki_view_count DESC, qid);
CREATE INDEX idx_styles_style ON place_styles(style, qid);
CREATE INDEX idx_designations_designation ON place_designations(designation, qid);
"""


def text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def number(value: Any) -> int:
    try:
        return int(value or 0)
    except (ValueError, TypeError):
        return 0


def real(value: Any) -> float:
    try:
        return float(value)
    except (ValueError, TypeError):
        return 0.0


def insert_place(connection: sqlite3.Connection, place: dict[str, Any]) -> None:
    registry = place.get("registry") if isinstance(place.get("registry"), dict) else {}
    thumbnail = place.get("thumbnail") if isinstance(place.get("thumbnail"), dict) else {}
    wikipedia = place.get("wikipedia") if isinstance(place.get("wikipedia"), dict) else {}
    qid = text(place.get("qid"))
    if not qid:
        return

    connection.execute(
        """
        INSERT OR REPLACE INTO places (
          qid, name, native_name, country, city, latitude, longitude,
          registry_name, registry_identifier, registry_url,
          thumbnail_primary, thumbnail_backups_json, thumbnail_source_page, thumbnail_kind,
          wikipedia_native, wikipedia_english, wiki_view_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            qid,
            text(place.get("name")) or qid,
            text(place.get("nativeName")),
            text(place.get("country")),
            text(place.get("city")),
            real(place.get("latitude")),
            real(place.get("longitude")),
            text(registry.get("name")) or "Unspecified registry",
            text(registry.get("identifier")),
            text(registry.get("url")),
            text(thumbnail.get("primary")),
            json.dumps(thumbnail.get("backups") if isinstance(thumbnail.get("backups"), list) else [], ensure_ascii=False, separators=(",", ":")),
            text(thumbnail.get("sourcePage")),
            text(thumbnail.get("kind")) or "generated",
            text(wikipedia.get("native")),
            text(wikipedia.get("english")),
            number(place.get("wikiViewCount")),
        ),
    )
    connection.execute("DELETE FROM place_styles WHERE qid = ?", (qid,))
    connection.execute("DELETE FROM place_designations WHERE qid = ?", (qid,))
    connection.executemany(
        "INSERT OR IGNORE INTO place_styles (qid, style) VALUES (?, ?)",
        [(qid, text(style)) for style in place.get("styles", []) if text(style)],
    )
    connection.executemany(
        "INSERT OR IGNORE INTO place_designations (qid, designation) VALUES (?, ?)",
        [(qid, text(item)) for item in place.get("designations", []) if text(item)],
    )


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path, help="Compact places.json input")
    parser.add_argument("--output", required=True, type=Path, help="SQLite database to write")
    parser.add_argument("--manifest", type=Path, help="Optional manifest JSON to write")
    parser.add_argument("--version", required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--dataset-url", help="Download URL written to the manifest; defaults to the output filename")
    args = parser.parse_args()

    places = json.loads(args.input.read_text(encoding="utf-8"))
    if not isinstance(places, list):
        raise SystemExit("Input JSON must be an array of places.")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    if args.output.exists():
        args.output.unlink()

    with sqlite3.connect(args.output) as connection:
        connection.executescript(SCHEMA)
        for place in places:
            if isinstance(place, dict):
                insert_place(connection, place)
        count = connection.execute("SELECT COUNT(*) FROM places").fetchone()[0]
        connection.executemany(
            "INSERT INTO metadata (key, value) VALUES (?, ?)",
            [("version", args.version), ("name", args.name), ("place_count", str(count))],
        )
        connection.commit()
        connection.execute("VACUUM")

    size = args.output.stat().st_size
    checksum = sha256(args.output)
    print(f"Wrote {count:,} places to {args.output} ({size:,} bytes)")
    print(f"SHA-256: {checksum}")

    if args.manifest:
        args.manifest.parent.mkdir(parents=True, exist_ok=True)
        manifest = {
            "version": args.version,
            "name": args.name,
            "datasetUrl": args.dataset_url or args.output.name,
            "bytes": size,
            "sha256": checksum,
            "recordCount": count,
        }
        args.manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"Wrote manifest to {args.manifest}")


if __name__ == "__main__":
    main()
