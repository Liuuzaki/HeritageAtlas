from __future__ import annotations

import csv
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from atlas_csv_folder_importer import (
    FolderImportOptions,
    find_heritage_csvs,
    import_folder,
)


HEADERS = [
    "wikidata_qid",
    "label_native",
    "coordinates_wkt",
    "country_label_en",
    "inception_values",
    "official_website_urls",
]


def write_csv(path: Path, rows: list[list[str]], headers: list[str] = HEADERS) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(headers)
        writer.writerows(rows)


def row(qid: str, label: str, country: str = "France") -> list[str]:
    return [
        qid,
        label,
        "POINT(2 48)",
        country,
        "+1914-00-00T00:00:00Z | +1920-00-00T00:00:00Z",
        "https://first.test/ | https://second.test/",
    ]


class AtlasCsvFolderImporterTest(unittest.TestCase):
    def test_finds_exact_names_and_combines_nested_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = root / "heritage_places.csv"
            second = root / "nested" / "heritage_places.csv"
            write_csv(first, [row("Q1", "First version"), row("Q2", "Second place")])
            write_csv(second, [row("Q1", "Updated version", "Italy | France")])
            write_csv(root / "wrong-case" / "Heritage_places.csv", [row("Q3", "Wrong case")])
            write_csv(root / "heritage_places_copy.csv", [row("Q4", "Wrong name")])

            self.assertEqual(find_heritage_csvs(root), [first, second])

            database = root / "atlas.sqlite"
            report = import_folder(
                FolderImportOptions(root, database, "Registry", "v1", "Atlas", "replace")
            )

            self.assertEqual(report.files_found, 2)
            self.assertEqual(report.input_rows, 3)
            self.assertEqual(report.imported_rows, 3)
            self.assertEqual(report.total_places, 2)
            with closing(sqlite3.connect(database)) as connection:
                places = connection.execute(
                    "SELECT wikidata_qid, label_native, country_label_en, inception_values, "
                    "official_website_urls FROM places ORDER BY wikidata_qid"
                ).fetchall()
            self.assertEqual(
                places,
                [
                    ("Q1", "Updated version", "Italy", "+1914", "https://first.test/"),
                    ("Q2", "Second place", "France", "+1914", "https://first.test/"),
                ],
            )

    def test_failed_combination_leaves_existing_output_unchanged(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "heritage_places.csv"
            database = root / "atlas.sqlite"
            options = FolderImportOptions(root, database, "Registry", "v1", "Atlas", "replace")
            write_csv(source, [row("QOLD", "Original")])
            import_folder(options)

            write_csv(source, [row("QNEW", "Must not persist")])
            write_csv(
                root / "nested" / "heritage_places.csv",
                [["QBROKEN", "Broken"]],
                headers=["wikidata_qid", "label_native"],
            )
            with self.assertRaises(ValueError):
                import_folder(options)

            with closing(sqlite3.connect(database)) as connection:
                qids = connection.execute("SELECT wikidata_qid FROM places").fetchall()
            self.assertEqual(qids, [("QOLD",)])


if __name__ == "__main__":
    unittest.main()
