from __future__ import annotations

import csv
import json
import sqlite3
import tempfile
import threading
import unittest
from contextlib import closing
from pathlib import Path

from atlas_csv_importer import ImportCancelled, ImportOptions, default_dataset_url, import_csv


HEADERS = [
    "wikidata_qid", "label_native", "label_en", "label_zh", "coordinates_wkt",
    "native_language_label_en", "country_label_en", "heritage_designation_labels_native",
    "architectural_style_label_en", "inception_values", "nativeWikiViewCount",
    "enWikiViewCount", "wikiViewCount", "wikipedia_sitelinks_count", "source_record_urls",
    "nativewiki_url", "enwiki_url", "commons_image_urls", "wikicommons_category",
    "official_website_urls",
]


def row(qid: str, native: str, english: str, coordinates: str = "POINT(2 48)") -> list[str]:
    return [
        qid, native, english, "中文名", coordinates, "French", "France",
        "Monument historique | Patrimoine", "Gothic | Baroque", "+1926-00-00T00:00:00Z",
        "12", "34", "46", "2", "https://registry.test/1 | https://registry.test/2",
        "https://fr.wikipedia.test/item", "https://en.wikipedia.test/item",
        "https://commons.test/first.jpg | https://commons.test/second.jpg",
        "https://commons.wikimedia.org/wiki/Category:Test_place",
        "https://official.test/",
    ]


def write_csv(path: Path, rows: list[list[str]], extra_column: bool = False) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow([*HEADERS, "future_column"] if extra_column else HEADERS)
        writer.writerows([*values, "future value"] if extra_column else values for values in rows)


class AtlasCsvImporterTest(unittest.TestCase):
    def test_public_database_gets_site_relative_url(self) -> None:
        self.assertEqual(default_dataset_url(Path("project/public/data/atlas.sqlite")), "data/atlas.sqlite")

    def test_imports_every_column_and_keeps_missing_coordinates(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "places.csv"
            database = root / "atlas.sqlite"
            manifest = root / "atlas-manifest.json"
            write_csv(source, [row("Q1", "Nom natif", "English name", "")], extra_column=True)

            report = import_csv(ImportOptions(source, database, "Registry", "v1", "Atlas", "replace", manifest))
            self.assertEqual(report.total_places, 1)
            self.assertEqual(report.missing_coordinates, 1)
            self.assertEqual(report.skipped_no_qid, 0)

            with closing(sqlite3.connect(database)) as connection:
                columns = {item[1] for item in connection.execute("PRAGMA table_info(places)")}
                stored = connection.execute(
                    """SELECT label_native, label_en, label_zh, coordinates_wkt,
                              native_language_label_en, country_label_en,
                              heritage_designation_labels_native, architectural_style_label_en,
                              inception_values, nativeWikiViewCount, enWikiViewCount, wikiViewCount,
                              wikipedia_sitelinks_count, source_record_urls, nativewiki_url, enwiki_url,
                              commons_image_urls, wikicommons_category, official_website_urls, latitude, longitude,
                              future_column, source_fields_json
                       FROM places WHERE wikidata_qid = 'Q1'"""
                ).fetchone()
            self.assertTrue(set(HEADERS).issubset(columns))
            self.assertIn("future_column", columns)
            self.assertEqual(stored[0:3], ("Nom natif", "English name", "中文名"))
            self.assertEqual(stored[9:13], (12, 34, 46, 2))
            self.assertIn("first.jpg", stored[16])
            self.assertEqual(stored[17], "https://commons.wikimedia.org/wiki/Category:Test_place")
            self.assertIsNone(stored[19])
            self.assertIsNone(stored[20])
            self.assertEqual(stored[21], "future value")
            self.assertEqual(json.loads(stored[22])["future_column"], "future value")
            self.assertEqual(json.loads(manifest.read_text(encoding="utf-8"))["recordCount"], 1)

    def test_merge_updates_qid_and_preserves_other_places(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "places.csv"
            database = root / "atlas.sqlite"
            write_csv(source, [row("Q1", "Original", "One"), row("Q2", "Preserved", "Two")])
            import_csv(ImportOptions(source, database, "Registry", "v1", "Atlas", "replace"))
            write_csv(source, [row("Q1", "Updated", "One updated"), row("Q3", "Added", "Three")])
            report = import_csv(ImportOptions(source, database, "Registry 2", "v2", "Atlas", "merge"))
            self.assertEqual((report.added_places, report.updated_places, report.total_places), (1, 1, 3))
            with closing(sqlite3.connect(database)) as connection:
                places = connection.execute(
                    "SELECT wikidata_qid, label_native, registry_name FROM places ORDER BY wikidata_qid"
                ).fetchall()
            self.assertEqual(places, [("Q1", "Updated", "Registry 2"), ("Q2", "Preserved", "Registry"), ("Q3", "Added", "Registry 2")])

    def test_merge_migrates_legacy_database(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "places.csv"
            database = root / "legacy.sqlite"
            with closing(sqlite3.connect(database)) as connection:
                connection.executescript("""
                    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                    CREATE TABLE places (
                      qid TEXT PRIMARY KEY, name TEXT NOT NULL, native_name TEXT, country TEXT,
                      city TEXT, latitude REAL NOT NULL, longitude REAL NOT NULL,
                      registry_name TEXT NOT NULL, registry_identifier TEXT, registry_url TEXT,
                      thumbnail_primary TEXT, thumbnail_backups_json TEXT NOT NULL DEFAULT '[]',
                      thumbnail_source_page TEXT, thumbnail_kind TEXT NOT NULL DEFAULT 'generated',
                      wikipedia_native TEXT, wikipedia_english TEXT,
                      wiki_view_count INTEGER NOT NULL DEFAULT 0
                    );
                    CREATE TABLE place_styles (qid TEXT, style TEXT, PRIMARY KEY (qid, style));
                    CREATE TABLE place_designations (qid TEXT, designation TEXT, PRIMARY KEY (qid, designation));
                    INSERT INTO places VALUES (
                      'QLEGACY', 'Legacy English', 'Nom ancien', 'France', '', 48, 2,
                      'Old registry', '', 'https://registry.test/legacy', 'https://commons.test/legacy.jpg',
                      '[]', '', 'commons', 'https://fr.wikipedia.test/legacy', '', 99
                    );
                    INSERT INTO place_styles VALUES ('QLEGACY', 'Gothic');
                    INSERT INTO place_designations VALUES ('QLEGACY', 'Listed');
                """)
            write_csv(source, [row("QNEW", "Nouveau", "New")])
            report = import_csv(ImportOptions(source, database, "New registry", "v2", "Atlas", "merge"))
            self.assertEqual(report.total_places, 2)
            with closing(sqlite3.connect(database)) as connection:
                legacy = connection.execute(
                    "SELECT label_native, label_en, country_label_en, architectural_style_label_en, "
                    "heritage_designation_labels_native, wikiViewCount FROM places WHERE wikidata_qid='QLEGACY'"
                ).fetchone()
            self.assertEqual(legacy, ("Nom ancien", "Legacy English", "France", "Gothic", "Listed", 99))

    def test_cancelled_merge_rolls_back(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "places.csv"
            database = root / "atlas.sqlite"
            write_csv(source, [row("Q1", "Original", "Original")])
            import_csv(ImportOptions(source, database, "Registry", "v1", "Atlas", "replace"))
            write_csv(source, [row("Q1", "Must not persist", "Changed")])
            cancelled = threading.Event()
            cancelled.set()
            with self.assertRaises(ImportCancelled):
                import_csv(ImportOptions(source, database, "Registry", "v2", "Atlas", "merge"), cancel=cancelled)
            with closing(sqlite3.connect(database)) as connection:
                name = connection.execute("SELECT label_native FROM places WHERE wikidata_qid = 'Q1'").fetchone()[0]
            self.assertEqual(name, "Original")


if __name__ == "__main__":
    unittest.main()
