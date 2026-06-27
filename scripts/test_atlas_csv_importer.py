from __future__ import annotations

import csv
import json
import sqlite3
import tempfile
import threading
import unittest
from contextlib import closing
from pathlib import Path

from atlas_csv_importer import ImportCancelled, ImportOptions, import_csv


HEADERS = [
    "wikidata_qid",
    "label_en",
    "latitude",
    "longitude",
    "country_label",
    "architectural_style_labels",
    "heritage_designation_labels",
    "wiki_view_count",
]


def write_csv(path: Path, rows: list[list[str]]) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(HEADERS)
        writer.writerows(rows)


class AtlasCsvImporterTest(unittest.TestCase):
    def test_create_then_merge(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "places.csv"
            database = root / "atlas.sqlite"
            manifest = root / "atlas-manifest.json"
            write_csv(
                source,
                [
                    ["Q1", "Old name", "48.1", "2.1", "France", "Gothic", "Monument", "10"],
                    ["Q2", "Preserved", "49.0", "3.0", "France", "Romanesque", "Listed", "20"],
                    ["Q_BAD", "Bad coordinates", "999", "3", "France", "", "", "0"],
                    ["", "No QID", "48", "2", "France", "", "", "0"],
                ],
            )
            first = import_csv(
                ImportOptions(
                    source, database, "Mérimée", "v1", "Atlas v1", "replace", manifest,
                    "https://example.test/atlas.sqlite",
                )
            )
            self.assertEqual(first.total_places, 2)
            self.assertEqual(first.skipped_coordinates, 1)
            self.assertEqual(first.skipped_no_qid, 1)

            write_csv(
                source,
                [
                    ["Q1", "Updated name", "48.2", "2.2", "France", "Baroque", "Protected", "30"],
                    ["Q3", "Added", "50", "4", "Belgium", "Modern", "Landmark", "40"],
                ],
            )
            second = import_csv(
                ImportOptions(source, database, "European registry", "v2", "Atlas v2", "merge", manifest)
            )
            self.assertEqual(second.previous_places, 2)
            self.assertEqual(second.added_places, 1)
            self.assertEqual(second.updated_places, 1)
            self.assertEqual(second.total_places, 3)

            with closing(sqlite3.connect(database)) as connection:
                places = connection.execute(
                    "SELECT qid, name, registry_name FROM places ORDER BY qid"
                ).fetchall()
                styles = connection.execute(
                    "SELECT qid, style FROM place_styles ORDER BY qid, style"
                ).fetchall()
                metadata = dict(connection.execute("SELECT key, value FROM metadata"))
            self.assertEqual(
                places,
                [
                    ("Q1", "Updated name", "European registry"),
                    ("Q2", "Preserved", "Mérimée"),
                    ("Q3", "Added", "European registry"),
                ],
            )
            self.assertEqual(styles, [("Q1", "Baroque"), ("Q2", "Romanesque"), ("Q3", "Modern")])
            self.assertEqual(metadata, {"version": "v2", "name": "Atlas v2", "place_count": "3"})

            manifest_data = json.loads(manifest.read_text(encoding="utf-8"))
            self.assertEqual(manifest_data["recordCount"], 3)
            self.assertEqual(manifest_data["datasetUrl"], "atlas.sqlite")
            self.assertEqual(manifest_data["sha256"], second.sha256)

    def test_cancelled_merge_rolls_back(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "places.csv"
            database = root / "atlas.sqlite"
            write_csv(source, [["Q1", "Original", "48", "2", "France", "Gothic", "", "1"]])
            import_csv(ImportOptions(source, database, "Registry", "v1", "Atlas", "replace"))

            write_csv(source, [["Q1", "Must not persist", "49", "3", "France", "Modern", "", "2"]])
            cancelled = threading.Event()
            cancelled.set()
            with self.assertRaises(ImportCancelled):
                import_csv(ImportOptions(source, database, "Registry", "v2", "Atlas", "merge"), cancel=cancelled)
            with closing(sqlite3.connect(database)) as connection:
                name = connection.execute("SELECT name FROM places WHERE qid = 'Q1'").fetchone()[0]
            self.assertEqual(name, "Original")


if __name__ == "__main__":
    unittest.main()
