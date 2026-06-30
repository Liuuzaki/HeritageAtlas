#!/usr/bin/env python3
"""Merge a heritage CSV directly into a Heritage Atlas SQLite database.

Run without arguments to open the desktop interface, or pass command-line
arguments for repeatable/automated imports.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import queue
import re
import sqlite3
import sys
import threading
import uuid
from contextlib import closing
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any, Callable, Iterator


PLACES_TABLE_SQL = """
CREATE TABLE {table} (
  wikidata_qid TEXT PRIMARY KEY,
  label_native TEXT NOT NULL DEFAULT '',
  label_en TEXT,
  label_zh TEXT,
  coordinates_wkt TEXT,
  native_language_label_en TEXT,
  country_label_en TEXT,
  heritage_designation_labels_native TEXT,
  architectural_style_label_en TEXT,
  inception_values TEXT,
  nativeWikiViewCount INTEGER NOT NULL DEFAULT 0,
  enWikiViewCount INTEGER NOT NULL DEFAULT 0,
  wikiViewCount INTEGER NOT NULL DEFAULT 0,
  wikipedia_sitelinks_count INTEGER NOT NULL DEFAULT 0,
  source_record_urls TEXT,
  nativewiki_url TEXT,
  enwiki_url TEXT,
  commons_image_urls TEXT,
  wikicommons_category TEXT,
  official_website_urls TEXT,
  latitude REAL,
  longitude REAL,
  registry_name TEXT NOT NULL DEFAULT 'Unspecified registry',
  source_fields_json TEXT NOT NULL DEFAULT '{{}}'
);
"""

SCHEMA = """
PRAGMA journal_mode = OFF;
PRAGMA synchronous = OFF;
PRAGMA temp_store = MEMORY;

CREATE TABLE metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"""

INDEXES = """
CREATE INDEX IF NOT EXISTS idx_places_country ON places(country_label_en);
CREATE INDEX IF NOT EXISTS idx_places_registry ON places(registry_name);
CREATE INDEX IF NOT EXISTS idx_places_coordinates ON places(latitude, longitude);
CREATE INDEX IF NOT EXISTS idx_places_views ON places(wikiViewCount DESC, wikidata_qid);
CREATE INDEX IF NOT EXISTS idx_places_native_label ON places(label_native COLLATE NOCASE);
"""

SOURCE_COLUMNS = {
    "wikidata_qid", "label_native", "label_en", "label_zh", "coordinates_wkt",
    "native_language_label_en", "country_label_en", "heritage_designation_labels_native",
    "architectural_style_label_en", "inception_values", "nativewikiviewcount",
    "enwikiviewcount", "wikiviewcount", "wikipedia_sitelinks_count", "source_record_urls",
    "nativewiki_url", "enwiki_url", "commons_image_urls", "wikicommons_category",
    "official_website_urls",
}

REQUIRED_COLUMNS = {
    "places": {
        "wikidata_qid", "label_native", "label_en", "label_zh", "coordinates_wkt",
        "native_language_label_en", "country_label_en", "heritage_designation_labels_native",
        "architectural_style_label_en", "inception_values", "nativewikiviewcount",
        "enwikiviewcount", "wikiviewcount", "wikipedia_sitelinks_count", "source_record_urls",
        "nativewiki_url", "enwiki_url", "commons_image_urls", "wikicommons_category",
        "official_website_urls",
        "latitude", "longitude", "registry_name", "source_fields_json",
    },
    "metadata": {"key", "value"},
}

ProgressCallback = Callable[[int], None]


class ImportCancelled(Exception):
    """Raised when the user cancels an import."""


@dataclass(frozen=True)
class ImportOptions:
    input_path: Path
    output_path: Path
    registry: str
    version: str
    name: str
    mode: str = "merge"
    manifest_path: Path | None = None
    dataset_url: str | None = None


@dataclass(frozen=True)
class ImportReport:
    input_rows: int
    imported_rows: int
    unique_places: int
    skipped_no_qid: int
    missing_coordinates: int
    previous_places: int
    total_places: int
    added_places: int
    updated_places: int
    bytes: int
    sha256: str


def text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def first(row: dict[str, str], *names: str) -> str:
    for name in names:
        value = text(row.get(name.lower()))
        if value:
            return value
    return ""


def split_values(value: str) -> list[str]:
    return [part.strip() for part in re.split(r"\s*\|\s*", value) if part.strip()]


_FLOAT = r"[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?"
_POINT = re.compile(rf"POINT\s*\(\s*({_FLOAT})\s+({_FLOAT})\s*\)", re.IGNORECASE)


def coordinates(row: dict[str, str]) -> tuple[float, float] | None:
    latitude = first(row, "latitude", "lat")
    longitude = first(row, "longitude", "lon", "lng")
    try:
        if latitude and longitude:
            point = float(latitude), float(longitude)
        else:
            match = _POINT.fullmatch(first(row, "coordinates_wkt", "coordinate_wkt"))
            if not match:
                return None
            point = float(match.group(2)), float(match.group(1))
    except ValueError:
        return None

    lat, lon = point
    if not math.isfinite(lat) or not math.isfinite(lon):
        return None
    if not -90 <= lat <= 90 or not -180 <= lon <= 180:
        return None
    return point


def integer(value: str) -> int:
    try:
        return int(float(value.replace(",", "")))
    except ValueError:
        return 0


def normalize_row(row: dict[str | None, str | list[str] | None]) -> dict[str, str]:
    normalized: dict[str, str] = {}
    for key, value in row.items():
        if key is None or isinstance(value, list):
            continue
        normalized[key.strip().lstrip("\ufeff").lower()] = value or ""
    return normalized


def place_from_row(row: dict[str, str], registry: str) -> tuple[dict[str, Any] | None, str | None]:
    qid = first(row, "wikidata_qid", "qid", "item")
    if not qid:
        return None, "qid"
    point = coordinates(row)
    latitude, longitude = point if point is not None else (None, None)

    return {
        "wikidata_qid": qid,
        "label_native": first(row, "label_native"),
        "label_en": first(row, "label_en"),
        "label_zh": first(row, "label_zh"),
        "coordinates_wkt": first(row, "coordinates_wkt"),
        "native_language_label_en": first(row, "native_language_label_en"),
        "country_label_en": first(row, "country_label_en"),
        "heritage_designation_labels_native": first(row, "heritage_designation_labels_native"),
        "architectural_style_label_en": first(row, "architectural_style_label_en"),
        "inception_values": first(row, "inception_values"),
        "nativeWikiViewCount": integer(first(row, "nativewikiviewcount")),
        "enWikiViewCount": integer(first(row, "enwikiviewcount")),
        "wikiViewCount": integer(first(row, "wikiviewcount")),
        "wikipedia_sitelinks_count": integer(first(row, "wikipedia_sitelinks_count")),
        "source_record_urls": first(row, "source_record_urls"),
        "nativewiki_url": first(row, "nativewiki_url"),
        "enwiki_url": first(row, "enwiki_url"),
        "commons_image_urls": first(row, "commons_image_urls"),
        "wikicommons_category": first(row, "wikicommons_category", "commons_category_url", "wikicommons_category_url"),
        "official_website_urls": first(row, "official_website_urls"),
        "latitude": latitude,
        "longitude": longitude,
        "registry_name": registry,
        "source_fields_json": json.dumps(row, ensure_ascii=False, separators=(",", ":")),
    }, None


def csv_rows(path: Path) -> Iterator[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        sample = handle.read(16_384)
        handle.seek(0)
        try:
            dialect = csv.Sniffer().sniff(sample, delimiters=",;\t")
        except csv.Error:
            dialect = csv.excel
        reader = csv.DictReader(handle, dialect=dialect)
        if not reader.fieldnames:
            raise ValueError("The CSV has no header row.")
        fields = {field.strip().lstrip("\ufeff").lower() for field in reader.fieldnames if field}
        if not fields.intersection({"wikidata_qid", "qid", "item"}):
            raise ValueError("The CSV needs a Wikidata QID column (wikidata_qid, qid, or item).")
        has_lat_lon = bool(fields.intersection({"latitude", "lat"})) and bool(
            fields.intersection({"longitude", "lon", "lng"})
        )
        if not has_lat_lon and not fields.intersection({"coordinates_wkt", "coordinate_wkt"}):
            raise ValueError("The CSV needs latitude/longitude columns or a coordinates_wkt column.")
        for raw_row in reader:
            if raw_row and any(text(value) for value in raw_row.values() if isinstance(value, str)):
                yield normalize_row(raw_row)


def quote_identifier(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def ensure_source_columns(connection: sqlite3.Connection, row: dict[str, str]) -> list[str]:
    existing = {item[1].lower() for item in connection.execute("PRAGMA table_info(places)")}
    extra: list[str] = []
    for column in row:
        if column not in existing:
            connection.execute(f"ALTER TABLE places ADD COLUMN {quote_identifier(column)} TEXT")
            existing.add(column)
        if column not in SOURCE_COLUMNS:
            extra.append(column)
    return extra


def insert_place(
    connection: sqlite3.Connection,
    place: dict[str, Any],
    source_row: dict[str, str],
    extra_columns: list[str],
) -> None:
    qid = place["wikidata_qid"]
    connection.execute(
        """
        INSERT INTO places (
          wikidata_qid, label_native, label_en, label_zh, coordinates_wkt,
          native_language_label_en, country_label_en, heritage_designation_labels_native,
          architectural_style_label_en, inception_values, nativeWikiViewCount, enWikiViewCount,
          wikiViewCount, wikipedia_sitelinks_count, source_record_urls, nativewiki_url, enwiki_url,
          commons_image_urls, wikicommons_category, official_website_urls, latitude, longitude, registry_name,
          source_fields_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(wikidata_qid) DO UPDATE SET
          label_native=excluded.label_native, label_en=excluded.label_en, label_zh=excluded.label_zh,
          coordinates_wkt=excluded.coordinates_wkt,
          native_language_label_en=excluded.native_language_label_en,
          country_label_en=excluded.country_label_en,
          heritage_designation_labels_native=excluded.heritage_designation_labels_native,
          architectural_style_label_en=excluded.architectural_style_label_en,
          inception_values=excluded.inception_values,
          nativeWikiViewCount=excluded.nativeWikiViewCount,
          enWikiViewCount=excluded.enWikiViewCount, wikiViewCount=excluded.wikiViewCount,
          wikipedia_sitelinks_count=excluded.wikipedia_sitelinks_count,
          source_record_urls=excluded.source_record_urls, nativewiki_url=excluded.nativewiki_url,
          enwiki_url=excluded.enwiki_url, commons_image_urls=excluded.commons_image_urls,
          wikicommons_category=excluded.wikicommons_category,
          official_website_urls=excluded.official_website_urls, latitude=excluded.latitude,
          longitude=excluded.longitude, registry_name=excluded.registry_name,
          source_fields_json=excluded.source_fields_json
        """,
        tuple(place[key] for key in (
            "wikidata_qid", "label_native", "label_en", "label_zh", "coordinates_wkt",
            "native_language_label_en", "country_label_en", "heritage_designation_labels_native",
            "architectural_style_label_en", "inception_values", "nativeWikiViewCount",
            "enWikiViewCount", "wikiViewCount", "wikipedia_sitelinks_count", "source_record_urls",
            "nativewiki_url", "enwiki_url", "commons_image_urls", "wikicommons_category",
            "official_website_urls",
            "latitude", "longitude", "registry_name", "source_fields_json",
        )),
    )
    if extra_columns:
        assignments = ", ".join(f"{quote_identifier(column)} = ?" for column in extra_columns)
        values = [source_row[column] for column in extra_columns]
        connection.execute(
            f"UPDATE places SET {assignments} WHERE wikidata_qid = ?",
            [*values, qid],
        )


def validate_database(connection: sqlite3.Connection) -> None:
    for table, required in REQUIRED_COLUMNS.items():
        columns = {row[1].lower() for row in connection.execute(f"PRAGMA table_info({table})")}
        if not columns:
            raise ValueError(f"The selected file is not a Heritage Atlas database (missing {table}).")
        missing = required - columns
        if missing:
            raise ValueError(f"The database table {table} is missing columns: {', '.join(sorted(missing))}.")


def create_indexes(connection: sqlite3.Connection) -> None:
    for statement in INDEXES.split(";"):
        if statement.strip():
            connection.execute(statement)


def migrate_legacy_database(connection: sqlite3.Connection) -> None:
    columns = {row[1].lower() for row in connection.execute("PRAGMA table_info(places)")}
    if "wikidata_qid" in columns:
        if "wikicommons_category" not in columns:
            connection.execute("ALTER TABLE places ADD COLUMN wikicommons_category TEXT")
        validate_database(connection)
        create_indexes(connection)
        return
    if not {"qid", "name", "latitude", "longitude"}.issubset(columns):
        raise ValueError("The selected file is not a compatible Heritage Atlas database.")

    connection.execute("BEGIN")
    try:
        connection.execute(PLACES_TABLE_SQL.format(table="places_v2"))
        connection.execute(
            """
            INSERT INTO places_v2 (
              wikidata_qid, label_native, label_en, coordinates_wkt,
              country_label_en, heritage_designation_labels_native,
              architectural_style_label_en, nativeWikiViewCount, enWikiViewCount,
              wikiViewCount, wikipedia_sitelinks_count, source_record_urls,
              nativewiki_url, enwiki_url, commons_image_urls, wikicommons_category, latitude, longitude,
              registry_name, source_fields_json
            )
            SELECT
              p.qid, COALESCE(NULLIF(p.native_name, ''), p.name, p.qid), p.name, '',
              p.country,
              COALESCE((SELECT group_concat(designation, ' | ') FROM place_designations d WHERE d.qid = p.qid), ''),
              COALESCE((SELECT group_concat(style, ' | ') FROM place_styles s WHERE s.qid = p.qid), ''),
              0, 0, p.wiki_view_count,
              (CASE WHEN COALESCE(p.wikipedia_native, '') <> '' THEN 1 ELSE 0 END) +
                (CASE WHEN COALESCE(p.wikipedia_english, '') <> '' THEN 1 ELSE 0 END),
              p.registry_url, p.wikipedia_native, p.wikipedia_english,
              p.thumbnail_primary, '', p.latitude, p.longitude, p.registry_name, '{}'
            FROM places p
            """
        )
        connection.execute("DROP TABLE places")
        connection.execute("ALTER TABLE places_v2 RENAME TO places")
        create_indexes(connection)
        connection.commit()
    except BaseException:
        connection.rollback()
        raise


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def default_dataset_url(output_path: Path) -> str:
    """Return a site-relative URL for public assets, otherwise the filename."""
    for parent in output_path.parents:
        if parent.name.lower() == "public":
            return output_path.relative_to(parent).as_posix()
    return output_path.name


def write_manifest(options: ImportOptions, report: ImportReport) -> None:
    if options.manifest_path is None:
        return
    manifest = {
        "version": options.version,
        "name": options.name,
        "datasetUrl": options.dataset_url or default_dataset_url(options.output_path),
        "bytes": report.bytes,
        "sha256": report.sha256,
        "recordCount": report.total_places,
    }
    options.manifest_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = options.manifest_path.with_name(f".{options.manifest_path.name}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, options.manifest_path)
    finally:
        temporary.unlink(missing_ok=True)


def _import_database(
    options: ImportOptions,
    database_path: Path,
    create_new: bool,
    progress: ProgressCallback | None,
    cancel: threading.Event | None,
) -> tuple[int, int, int, int, int, int, int]:
    input_rows = imported_rows = skipped_no_qid = missing_coordinates = 0
    with closing(sqlite3.connect(database_path)) as connection:
        if create_new:
            connection.executescript(SCHEMA + PLACES_TABLE_SQL.format(table="places") + INDEXES)
        else:
            migrate_legacy_database(connection)
        previous_places = connection.execute("SELECT COUNT(*) FROM places").fetchone()[0]
        connection.execute("CREATE TEMP TABLE imported_qids (qid TEXT PRIMARY KEY) WITHOUT ROWID")
        connection.execute("BEGIN")
        extra_columns: list[str] | None = None
        try:
            for row in csv_rows(options.input_path):
                if cancel is not None and cancel.is_set():
                    raise ImportCancelled()
                input_rows += 1
                if extra_columns is None:
                    extra_columns = ensure_source_columns(connection, row)
                place, reason = place_from_row(row, options.registry)
                if place is None:
                    skipped_no_qid += 1
                else:
                    if place["latitude"] is None or place["longitude"] is None:
                        missing_coordinates += 1
                    insert_place(connection, place, row, extra_columns)
                    connection.execute(
                        "INSERT OR IGNORE INTO imported_qids (qid) VALUES (?)",
                        (place["wikidata_qid"],),
                    )
                    imported_rows += 1
                if progress is not None and input_rows % 250 == 0:
                    progress(input_rows)

            if cancel is not None and cancel.is_set():
                raise ImportCancelled()
            total_places = connection.execute("SELECT COUNT(*) FROM places").fetchone()[0]
            unique_places = connection.execute("SELECT COUNT(*) FROM imported_qids").fetchone()[0]
            connection.executemany(
                """
                INSERT INTO metadata (key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value
                """,
                (("version", options.version), ("name", options.name), ("place_count", str(total_places))),
            )
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        if progress is not None:
            progress(input_rows)
        if create_new:
            connection.execute("VACUUM")
    return (
        input_rows, imported_rows, skipped_no_qid, missing_coordinates,
        previous_places, unique_places, total_places,
    )


def import_csv(
    options: ImportOptions,
    progress: ProgressCallback | None = None,
    cancel: threading.Event | None = None,
) -> ImportReport:
    input_path = options.input_path.expanduser().resolve()
    output_path = options.output_path.expanduser().resolve()
    manifest_path = options.manifest_path.expanduser().resolve() if options.manifest_path else None
    options = ImportOptions(
        input_path, output_path, options.registry.strip(), options.version.strip(), options.name.strip(),
        options.mode, manifest_path, text(options.dataset_url),
    )
    if not input_path.is_file():
        raise ValueError(f"CSV file not found: {input_path}")
    if input_path == output_path:
        raise ValueError("The CSV input and SQLite output must be different files.")
    if options.mode not in {"merge", "replace"}:
        raise ValueError("Mode must be 'merge' or 'replace'.")
    if not options.registry:
        raise ValueError("Registry name is required.")
    if not options.version or not options.name:
        raise ValueError("Dataset version and name are required.")
    if manifest_path in {input_path, output_path}:
        raise ValueError("The manifest must be a separate file.")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    replace = options.mode == "replace"
    create_new = replace or not output_path.exists() or output_path.stat().st_size == 0
    use_temporary = create_new
    working_path = output_path
    if use_temporary:
        working_path = output_path.with_name(f".{output_path.name}.{uuid.uuid4().hex}.tmp")

    try:
        values = _import_database(options, working_path, create_new, progress, cancel)
        if use_temporary:
            os.replace(working_path, output_path)
    finally:
        if use_temporary:
            working_path.unlink(missing_ok=True)

    input_rows, imported_rows, no_qid, missing_coordinates, previous, unique_places, total = values
    added = max(0, total - previous)
    report = ImportReport(
        input_rows=input_rows,
        imported_rows=imported_rows,
        unique_places=unique_places,
        skipped_no_qid=no_qid,
        missing_coordinates=missing_coordinates,
        previous_places=previous,
        total_places=total,
        added_places=added,
        updated_places=max(0, unique_places - added),
        bytes=output_path.stat().st_size,
        sha256=file_sha256(output_path),
    )
    write_manifest(options, report)
    return report


def report_text(report: ImportReport) -> str:
    return (
        f"Imported {report.unique_places:,} unique places from {report.input_rows:,} CSV rows.\n"
        f"Added {report.added_places:,}; updated {report.updated_places:,}; "
        f"database total {report.total_places:,}.\n"
        f"Skipped {report.skipped_no_qid:,} rows without a QID; "
        f"kept {report.missing_coordinates:,} places without map coordinates.\n"
        f"SQLite size: {report.bytes:,} bytes\nSHA-256: {report.sha256}"
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Merge a heritage CSV directly into a Heritage Atlas SQLite database. "
        "Run without arguments to open the desktop interface."
    )
    parser.add_argument("--input", type=Path, help="Heritage CSV input")
    parser.add_argument("--output", type=Path, help="SQLite database to create or update")
    parser.add_argument("--registry", help="Registry name assigned to imported rows")
    parser.add_argument("--mode", choices=("merge", "replace"), default="merge")
    parser.add_argument("--manifest", type=Path, help="Optional atlas manifest JSON to write")
    parser.add_argument("--version", default=date.today().isoformat())
    parser.add_argument("--name", help="Dataset display name; defaults to Heritage Atlas · VERSION")
    parser.add_argument("--dataset-url", help="Dataset URL for the manifest; defaults to the SQLite filename")
    parser.add_argument("--ui", action="store_true", help="Open the desktop interface")
    return parser


def run_cli(args: argparse.Namespace, parser: argparse.ArgumentParser) -> int:
    required = (("--input", args.input), ("--output", args.output), ("--registry", args.registry))
    missing = [flag for flag, value in required if not value]
    if missing:
        parser.error(f"the following arguments are required in command-line mode: {', '.join(missing)}")
    name = args.name or f"Heritage Atlas · {args.version}"
    options = ImportOptions(
        args.input, args.output, args.registry, args.version, name, args.mode, args.manifest, args.dataset_url
    )
    try:
        report = import_csv(
            options,
            progress=lambda rows: print(f"Processed {rows:,} rows...", end="\r", flush=True),
        )
    except (OSError, ValueError, sqlite3.Error, csv.Error) as error:
        print(f"Import failed: {error}", file=sys.stderr)
        return 1
    print(" " * 50, end="\r")
    print(report_text(report))
    if args.manifest:
        print(f"Manifest: {args.manifest}")
    return 0


def run_ui() -> int:
    try:
        import tkinter as tk
        from tkinter import filedialog, messagebox, ttk
    except ImportError:
        print("Tkinter is not installed. Use command-line arguments or install Python's Tk support.", file=sys.stderr)
        return 1

    class ImporterWindow:
        def __init__(self, root: Any) -> None:
            self.root = root
            self.events: queue.Queue[tuple[str, Any]] = queue.Queue()
            self.cancel_event = threading.Event()
            self.running = False
            self.closing = False
            today = date.today().isoformat()
            self.input_var = tk.StringVar()
            self.output_var = tk.StringVar()
            self.registry_var = tk.StringVar(value="Mérimée")
            self.version_var = tk.StringVar(value=today)
            self.name_var = tk.StringVar(value=f"Heritage Atlas · {today}")
            self.mode_var = tk.StringVar(value="merge")
            self.write_manifest_var = tk.BooleanVar(value=True)
            self.manifest_var = tk.StringVar()
            self.dataset_url_var = tk.StringVar()
            self.status_var = tk.StringVar(value="Choose a CSV file and destination database.")
            self._build()
            self.root.after(100, self._poll_events)

        def _build(self) -> None:
            self.root.title("Heritage Atlas CSV Importer")
            self.root.minsize(760, 620)
            self.root.columnconfigure(0, weight=1)
            self.root.rowconfigure(0, weight=1)
            outer = ttk.Frame(self.root, padding=20)
            outer.grid(sticky="nsew")
            outer.columnconfigure(1, weight=1)

            ttk.Label(outer, text="Import CSV into Heritage Atlas", font=("Segoe UI", 16, "bold")).grid(
                row=0, column=0, columnspan=3, sticky="w", pady=(0, 4)
            )
            ttk.Label(outer, text="Create a new atlas or merge records into an existing SQLite database.").grid(
                row=1, column=0, columnspan=3, sticky="w", pady=(0, 18)
            )

            def path_row(row: int, label: str, variable: Any, command: Callable[[], None]) -> None:
                ttk.Label(outer, text=label).grid(row=row, column=0, sticky="w", padx=(0, 12), pady=5)
                ttk.Entry(outer, textvariable=variable).grid(row=row, column=1, sticky="ew", pady=5)
                ttk.Button(outer, text="Browse…", command=command).grid(row=row, column=2, padx=(8, 0), pady=5)

            path_row(2, "CSV file", self.input_var, self._choose_input)
            path_row(3, "SQLite file", self.output_var, self._choose_output)
            ttk.Separator(outer).grid(row=4, column=0, columnspan=3, sticky="ew", pady=12)

            fields = (
                ("Registry name", self.registry_var),
                ("Dataset version", self.version_var),
                ("Dataset name", self.name_var),
            )
            for row, (label, variable) in enumerate(fields, start=5):
                ttk.Label(outer, text=label).grid(row=row, column=0, sticky="w", padx=(0, 12), pady=5)
                ttk.Entry(outer, textvariable=variable).grid(row=row, column=1, columnspan=2, sticky="ew", pady=5)

            ttk.Label(outer, text="Import mode").grid(row=8, column=0, sticky="nw", padx=(0, 12), pady=7)
            modes = ttk.Frame(outer)
            modes.grid(row=8, column=1, columnspan=2, sticky="w")
            ttk.Radiobutton(
                modes, text="Merge / update matching QIDs", variable=self.mode_var, value="merge"
            ).grid(row=0, column=0, sticky="w")
            ttk.Radiobutton(
                modes, text="Replace with a new database", variable=self.mode_var, value="replace"
            ).grid(row=1, column=0, sticky="w", pady=(3, 0))

            ttk.Separator(outer).grid(row=9, column=0, columnspan=3, sticky="ew", pady=12)
            ttk.Checkbutton(
                outer, text="Write website manifest", variable=self.write_manifest_var,
                command=self._set_manifest_state,
            ).grid(row=10, column=0, columnspan=3, sticky="w", pady=(0, 4))
            ttk.Label(outer, text="Manifest file").grid(row=11, column=0, sticky="w", padx=(0, 12), pady=5)
            self.manifest_entry = ttk.Entry(outer, textvariable=self.manifest_var)
            self.manifest_entry.grid(row=11, column=1, sticky="ew", pady=5)
            self.manifest_button = ttk.Button(outer, text="Browse…", command=self._choose_manifest)
            self.manifest_button.grid(row=11, column=2, padx=(8, 0), pady=5)
            ttk.Label(outer, text="Dataset URL").grid(row=12, column=0, sticky="w", padx=(0, 12), pady=5)
            self.url_entry = ttk.Entry(outer, textvariable=self.dataset_url_var)
            self.url_entry.grid(row=12, column=1, columnspan=2, sticky="ew", pady=5)
            ttk.Label(outer, text="Leave blank to use the SQLite filename.", foreground="#666666").grid(
                row=13, column=1, columnspan=2, sticky="w"
            )

            self.progress = ttk.Progressbar(outer, mode="indeterminate")
            self.progress.grid(row=14, column=0, columnspan=3, sticky="ew", pady=(20, 7))
            ttk.Label(outer, textvariable=self.status_var, wraplength=700).grid(
                row=15, column=0, columnspan=3, sticky="w"
            )
            buttons = ttk.Frame(outer)
            buttons.grid(row=16, column=0, columnspan=3, sticky="e", pady=(16, 0))
            self.cancel_button = ttk.Button(buttons, text="Cancel", command=self.cancel, state="disabled")
            self.cancel_button.grid(row=0, column=0, padx=(0, 8))
            self.import_button = ttk.Button(buttons, text="Import CSV", command=self.start)
            self.import_button.grid(row=0, column=1)
            self.root.protocol("WM_DELETE_WINDOW", self.close)

        def _choose_input(self) -> None:
            value = filedialog.askopenfilename(
                title="Choose heritage CSV",
                filetypes=(("CSV files", "*.csv"), ("All files", "*.*")),
            )
            if value:
                self.input_var.set(value)
                source = Path(value)
                if not self.output_var.get():
                    self.output_var.set(str(source.with_suffix(".sqlite")))
                if not self.manifest_var.get():
                    self.manifest_var.set(str(source.with_name("atlas-manifest.json")))

        def _choose_output(self) -> None:
            value = filedialog.asksaveasfilename(
                title="Choose or create SQLite database",
                defaultextension=".sqlite",
                filetypes=(("SQLite databases", "*.sqlite *.db"), ("All files", "*.*")),
            )
            if value:
                self.output_var.set(value)

        def _choose_manifest(self) -> None:
            value = filedialog.asksaveasfilename(
                title="Choose manifest",
                defaultextension=".json",
                filetypes=(("JSON files", "*.json"), ("All files", "*.*")),
            )
            if value:
                self.manifest_var.set(value)

        def _set_manifest_state(self) -> None:
            state = "normal" if self.write_manifest_var.get() else "disabled"
            for widget in (self.manifest_entry, self.manifest_button, self.url_entry):
                widget.configure(state=state)

        def options(self) -> ImportOptions:
            if not self.input_var.get().strip():
                raise ValueError("Choose a CSV input file.")
            if not self.output_var.get().strip():
                raise ValueError("Choose a SQLite output file.")
            manifest: Path | None = None
            if self.write_manifest_var.get():
                if not self.manifest_var.get().strip():
                    raise ValueError("Choose a manifest file or turn off website manifest output.")
                manifest = Path(self.manifest_var.get())
            return ImportOptions(
                Path(self.input_var.get()), Path(self.output_var.get()), self.registry_var.get(),
                self.version_var.get(), self.name_var.get(), self.mode_var.get(), manifest,
                self.dataset_url_var.get() or None,
            )

        def start(self) -> None:
            try:
                options = self.options()
            except ValueError as error:
                messagebox.showerror("Cannot start import", str(error), parent=self.root)
                return
            self.running = True
            self.cancel_event.clear()
            self.import_button.configure(state="disabled")
            self.cancel_button.configure(state="normal")
            self.progress.start(12)
            self.status_var.set("Starting import…")

            def worker() -> None:
                try:
                    result = import_csv(
                        options,
                        progress=lambda rows: self.events.put(("progress", rows)),
                        cancel=self.cancel_event,
                    )
                except ImportCancelled:
                    self.events.put(("cancelled", None))
                except BaseException as error:
                    self.events.put(("error", error))
                else:
                    self.events.put(("complete", result))

            threading.Thread(target=worker, name="atlas-csv-import", daemon=True).start()

        def cancel(self) -> None:
            self.cancel_event.set()
            self.cancel_button.configure(state="disabled")
            self.status_var.set("Cancelling safely…")

        def _poll_events(self) -> None:
            try:
                while True:
                    kind, value = self.events.get_nowait()
                    if kind == "progress":
                        self.status_var.set(f"Processed {value:,} CSV rows…")
                    else:
                        self._finish(kind, value)
            except queue.Empty:
                pass
            if self.root.winfo_exists():
                self.root.after(100, self._poll_events)

        def _finish(self, kind: str, value: Any) -> None:
            self.running = False
            self.progress.stop()
            self.import_button.configure(state="normal")
            self.cancel_button.configure(state="disabled")
            if self.closing:
                self.root.destroy()
                return
            if kind == "cancelled":
                self.status_var.set("Import cancelled. No partial merge was saved.")
            elif kind == "complete":
                self.status_var.set(f"Import complete: {value.total_places:,} places in the atlas.")
                messagebox.showinfo("Import complete", report_text(value), parent=self.root)
            else:
                self.status_var.set("Import failed. Review the error message for details.")
                messagebox.showerror("Import failed", str(value), parent=self.root)

        def close(self) -> None:
            if not self.running:
                self.root.destroy()
                return
            should_close = messagebox.askyesno(
                "Import in progress", "Cancel the import and close when it stops?", parent=self.root
            )
            if should_close:
                self.closing = True
                self.cancel()

    try:
        root = tk.Tk()
    except tk.TclError as error:
        print(f"Could not open the desktop interface: {error}", file=sys.stderr)
        return 1
    ImporterWindow(root)
    root.mainloop()
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    actual = sys.argv[1:] if argv is None else argv
    args = parser.parse_args(actual)
    if args.ui or not actual:
        return run_ui()
    return run_cli(args, parser)


if __name__ == "__main__":
    raise SystemExit(main())
