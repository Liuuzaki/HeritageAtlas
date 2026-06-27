#!/usr/bin/env python3
"""Convert a heritage dumper CSV into the compact JSON format used by this site.

Example:
    python scripts/csv_to_places_json.py \
      --input /path/to/heritage_places_with_views.csv \
      --output build/places.json \
      --registry "Mérimée"

The importer accepts several likely field names from the desktop dumper. It
skips records with no usable coordinates because they cannot appear on the map.
"""
from __future__ import annotations

import argparse
import csv
import json
import re
from pathlib import Path
from typing import Iterable


def first(row: dict[str, str], *names: str) -> str:
    for name in names:
        value = (row.get(name) or "").strip()
        if value:
            return value
    return ""


def split_values(value: str) -> list[str]:
    return [part.strip() for part in re.split(r"\s*\|\s*", value) if part.strip()]


def coordinates(row: dict[str, str]) -> tuple[float, float] | None:
    lat = first(row, "latitude", "lat")
    lon = first(row, "longitude", "lon", "lng")
    if lat and lon:
        try:
            return float(lat), float(lon)
        except ValueError:
            return None

    wkt = first(row, "coordinates_wkt", "coordinate_wkt")
    match = re.fullmatch(r"POINT\(([-0-9.]+)\s+([-0-9.]+)\)", wkt)
    if match:
        return float(match.group(2)), float(match.group(1))
    return None


def number(value: str) -> int:
    try:
        return int(float(value.replace(",", "")))
    except ValueError:
        return 0


def commons_url(filename: str) -> str:
    from urllib.parse import quote
    return f"https://commons.wikimedia.org/wiki/Special:FilePath/{quote(filename)}?width=330"


def commons_page(filename: str) -> str:
    from urllib.parse import quote
    return f"https://commons.wikimedia.org/wiki/File:{quote(filename.replace(' ', '_'))}"


def convert(rows: Iterable[dict[str, str]], registry: str) -> list[dict]:
    places: list[dict] = []
    for row in rows:
        point = coordinates(row)
        if point is None:
            continue
        latitude, longitude = point
        qid = first(row, "wikidata_qid", "qid", "item")
        if not qid:
            continue

        image_links = split_values(first(row, "image_links", "commons_file_urls"))
        filename = first(row, "image_filename", "commons_image_filename")
        primary = image_links[0] if image_links else (commons_url(filename) if filename else "")
        image_page = first(row, "commons_file_page_url", "image_source_page") or (commons_page(filename) if filename else "")

        places.append({
            "qid": qid,
            "name": first(row, "label_en", "name_en", "name", "label_native") or qid,
            "nativeName": first(row, "label_native", "label_fr", "label_ja", "name_native"),
            "country": first(row, "country_label", "country", "country_name"),
            "city": first(row, "city", "locality", "admin_unit"),
            "latitude": latitude,
            "longitude": longitude,
            "registry": {
                "name": registry,
                "identifier": first(row, "source_identifier", "merimee_id", "registry_id", "identifier"),
                "url": first(row, "source_record_url", "merimee_pop_url", "registry_url"),
            },
            "designations": split_values(first(row, "heritage_designation_labels", "heritage_designation", "designation")),
            "styles": split_values(first(row, "architectural_style_labels", "architectural_style", "styles")),
            "thumbnail": {
                "primary": primary,
                "backups": image_links[1:],
                "sourcePage": image_page,
                "kind": "commons" if filename or "wikimedia.org" in primary else ("external" if primary else "generated"),
            },
            "wikipedia": {
                "native": first(row, "native_wikipedia_url", "frwiki_url", "jawiki_url"),
                "english": first(row, "enwiki_url", "english_wikipedia_url"),
            },
            "wikiViewCount": number(first(row, "wikiViewCount", "wiki_view_count")),
        })
    return places


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", default=Path("build/places.json"), type=Path)
    parser.add_argument("--registry", required=True)
    args = parser.parse_args()

    with args.input.open("r", encoding="utf-8-sig", newline="") as handle:
        places = convert(csv.DictReader(handle), args.registry)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(places, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {len(places):,} mapped places to {args.output}")


if __name__ == "__main__":
    main()
