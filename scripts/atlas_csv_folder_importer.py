#!/usr/bin/env python3
"""Combine recursively discovered heritage CSV files into one atlas database.

Run without arguments to open the desktop interface, or pass command-line
arguments for repeatable/automated imports.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import queue
import sqlite3
import sys
import threading
import uuid
from contextlib import closing
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any, Callable

from atlas_csv_importer import (
    ImportCancelled,
    ImportOptions,
    default_dataset_url,
    file_sha256,
    import_csv,
    text,
)


TARGET_FILENAME = "heritage_places.csv"
FolderProgressCallback = Callable[[int, int, Path, int], None]


@dataclass(frozen=True)
class FolderImportOptions:
    input_folder: Path
    output_path: Path
    version: str
    name: str
    mode: str = "merge"
    manifest_path: Path | None = None
    dataset_url: str | None = None


@dataclass(frozen=True)
class FolderImportReport:
    files_found: int
    input_rows: int
    imported_rows: int
    skipped_no_qid: int
    missing_coordinates: int
    total_places: int
    bytes: int
    sha256: str


def find_heritage_csvs(folder: Path) -> list[Path]:
    """Return exact filename matches in deterministic relative-path order."""
    def raise_walk_error(error: OSError) -> None:
        raise error

    matches: list[Path] = []
    for current_folder, _subfolders, filenames in os.walk(folder, onerror=raise_walk_error):
        matches.extend(
            Path(current_folder) / filename
            for filename in filenames
            if filename == TARGET_FILENAME
        )
    return sorted(matches, key=lambda path: path.relative_to(folder).as_posix())


def _copy_database(source_path: Path, destination_path: Path) -> None:
    """Copy a live-compatible SQLite snapshot, including any committed WAL data."""
    with closing(sqlite3.connect(source_path)) as source:
        with closing(sqlite3.connect(destination_path)) as destination:
            source.backup(destination)


def _write_manifest(options: FolderImportOptions, report: FolderImportReport) -> None:
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
    temporary = options.manifest_path.with_name(
        f".{options.manifest_path.name}.{uuid.uuid4().hex}.tmp"
    )
    try:
        temporary.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        os.replace(temporary, options.manifest_path)
    finally:
        temporary.unlink(missing_ok=True)


def import_folder(
    options: FolderImportOptions,
    progress: FolderProgressCallback | None = None,
    cancel: threading.Event | None = None,
) -> FolderImportReport:
    input_folder = options.input_folder.expanduser().resolve()
    output_path = options.output_path.expanduser().resolve()
    manifest_path = options.manifest_path.expanduser().resolve() if options.manifest_path else None
    options = FolderImportOptions(
        input_folder=input_folder,
        output_path=output_path,
        version=options.version.strip(),
        name=options.name.strip(),
        mode=options.mode,
        manifest_path=manifest_path,
        dataset_url=text(options.dataset_url),
    )

    if not input_folder.is_dir():
        raise ValueError(f"Input folder not found: {input_folder}")
    if options.mode not in {"merge", "replace"}:
        raise ValueError("Mode must be 'merge' or 'replace'.")
    if not options.version or not options.name:
        raise ValueError("Dataset version and name are required.")
    if manifest_path == output_path:
        raise ValueError("The manifest and SQLite output must be different files.")

    input_paths = find_heritage_csvs(input_folder)
    if not input_paths:
        raise ValueError(
            f'No files exactly named "{TARGET_FILENAME}" were found in {input_folder}.'
        )
    if output_path in input_paths or manifest_path in input_paths:
        raise ValueError("The SQLite output and manifest must be separate from the input CSV files.")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    working_path = output_path.with_name(f".{output_path.name}.{uuid.uuid4().hex}.tmp")
    input_rows = imported_rows = skipped_no_qid = missing_coordinates = 0
    last_total = 0

    try:
        if options.mode == "merge" and output_path.exists() and output_path.stat().st_size:
            _copy_database(output_path, working_path)

        for file_index, input_path in enumerate(input_paths, start=1):
            if cancel is not None and cancel.is_set():
                raise ImportCancelled()
            child_mode = (
                "merge" if working_path.exists() and working_path.stat().st_size else "replace"
            )
            rows_before_file = input_rows

            def child_progress(rows: int) -> None:
                if progress is not None:
                    progress(
                        file_index,
                        len(input_paths),
                        input_path,
                        rows_before_file + rows,
                    )

            report = import_csv(
                ImportOptions(
                    input_path=input_path,
                    output_path=working_path,
                    version=options.version,
                    name=options.name,
                    mode=child_mode,
                    finalize=file_index == len(input_paths),
                ),
                progress=child_progress,
                cancel=cancel,
            )
            input_rows += report.input_rows
            imported_rows += report.imported_rows
            skipped_no_qid += report.skipped_no_qid
            missing_coordinates += report.missing_coordinates
            last_total = report.total_places

        if cancel is not None and cancel.is_set():
            raise ImportCancelled()
        os.replace(working_path, output_path)
    finally:
        working_path.unlink(missing_ok=True)

    result = FolderImportReport(
        files_found=len(input_paths),
        input_rows=input_rows,
        imported_rows=imported_rows,
        skipped_no_qid=skipped_no_qid,
        missing_coordinates=missing_coordinates,
        total_places=last_total,
        bytes=output_path.stat().st_size,
        sha256=file_sha256(output_path),
    )
    _write_manifest(options, result)
    return result


def report_text(report: FolderImportReport) -> str:
    return (
        f"Combined {report.files_found:,} CSV files and processed {report.input_rows:,} rows.\n"
        f"Imported {report.imported_rows:,} rows; database total {report.total_places:,} places.\n"
        f"Skipped {report.skipped_no_qid:,} rows without a QID; "
        f"kept {report.missing_coordinates:,} places without map coordinates.\n"
        f"SQLite size: {report.bytes:,} bytes\nSHA-256: {report.sha256}"
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=f'Recursively combine files exactly named "{TARGET_FILENAME}" into one '
        "Heritage Atlas SQLite database. Run without arguments to open the desktop interface."
    )
    parser.add_argument("--input-folder", type=Path, help="Folder to search recursively")
    parser.add_argument("--output", type=Path, help="SQLite database to create or update")
    parser.add_argument("--mode", choices=("merge", "replace"), default="merge")
    parser.add_argument("--manifest", type=Path, help="Optional atlas manifest JSON to write")
    parser.add_argument("--version", default=date.today().isoformat())
    parser.add_argument("--name", help="Dataset display name; defaults to Heritage Atlas · VERSION")
    parser.add_argument("--dataset-url", help="Dataset URL for the manifest; defaults to the SQLite filename")
    parser.add_argument("--ui", action="store_true", help="Open the desktop interface")
    return parser


def run_cli(args: argparse.Namespace, parser: argparse.ArgumentParser) -> int:
    required = (
        ("--input-folder", args.input_folder),
        ("--output", args.output),
    )
    missing = [flag for flag, value in required if not value]
    if missing:
        parser.error(f"the following arguments are required in command-line mode: {', '.join(missing)}")
    options = FolderImportOptions(
        input_folder=args.input_folder,
        output_path=args.output,
        version=args.version,
        name=args.name or f"Heritage Atlas · {args.version}",
        mode=args.mode,
        manifest_path=args.manifest,
        dataset_url=args.dataset_url,
    )
    try:
        report = import_folder(
            options,
            progress=lambda current, total, path, rows: print(
                f"[{current}/{total}] {path}: {rows:,} total rows processed...",
                end="\r",
                flush=True,
            ),
        )
    except (OSError, ValueError, sqlite3.Error, csv.Error) as error:
        print(f"Import failed: {error}", file=sys.stderr)
        return 1
    print(" " * 100, end="\r")
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

    class FolderImporterWindow:
        def __init__(self, root: Any) -> None:
            self.root = root
            self.events: queue.Queue[tuple[str, Any]] = queue.Queue()
            self.cancel_event = threading.Event()
            self.running = False
            self.closing = False
            today = date.today().isoformat()
            self.folder_var = tk.StringVar()
            self.output_var = tk.StringVar()
            self.version_var = tk.StringVar(value=today)
            self.name_var = tk.StringVar(value=f"Heritage Atlas · {today}")
            self.mode_var = tk.StringVar(value="merge")
            self.write_manifest_var = tk.BooleanVar(value=True)
            self.manifest_var = tk.StringVar()
            self.dataset_url_var = tk.StringVar()
            self.status_var = tk.StringVar(
                value=f'Choose a folder containing files named "{TARGET_FILENAME}".'
            )
            self._build()
            self.root.after(100, self._poll_events)

        def _build(self) -> None:
            self.root.title("Heritage Atlas Folder Importer")
            self.root.minsize(780, 640)
            self.root.columnconfigure(0, weight=1)
            self.root.rowconfigure(0, weight=1)
            outer = ttk.Frame(self.root, padding=20)
            outer.grid(sticky="nsew")
            outer.columnconfigure(1, weight=1)

            ttk.Label(outer, text="Combine heritage CSV folders", font=("Segoe UI", 16, "bold")).grid(
                row=0, column=0, columnspan=3, sticky="w", pady=(0, 4)
            )
            ttk.Label(
                outer,
                text=f'Recursively imports every file exactly named "{TARGET_FILENAME}".',
            ).grid(row=1, column=0, columnspan=3, sticky="w", pady=(0, 18))

            ttk.Label(outer, text="Input folder").grid(row=2, column=0, sticky="w", padx=(0, 12), pady=5)
            ttk.Entry(outer, textvariable=self.folder_var).grid(row=2, column=1, sticky="ew", pady=5)
            ttk.Button(outer, text="Browse…", command=self._choose_folder).grid(row=2, column=2, padx=(8, 0), pady=5)
            ttk.Label(outer, text="SQLite file").grid(row=3, column=0, sticky="w", padx=(0, 12), pady=5)
            ttk.Entry(outer, textvariable=self.output_var).grid(row=3, column=1, sticky="ew", pady=5)
            ttk.Button(outer, text="Browse…", command=self._choose_output).grid(row=3, column=2, padx=(8, 0), pady=5)
            ttk.Separator(outer).grid(row=4, column=0, columnspan=3, sticky="ew", pady=12)

            for row, (label, variable) in enumerate((
                ("Dataset version", self.version_var),
                ("Dataset name", self.name_var),
            ), start=5):
                ttk.Label(outer, text=label).grid(row=row, column=0, sticky="w", padx=(0, 12), pady=5)
                ttk.Entry(outer, textvariable=variable).grid(row=row, column=1, columnspan=2, sticky="ew", pady=5)

            ttk.Label(outer, text="Import mode").grid(row=8, column=0, sticky="nw", padx=(0, 12), pady=7)
            modes = ttk.Frame(outer)
            modes.grid(row=8, column=1, columnspan=2, sticky="w")
            ttk.Radiobutton(modes, text="Merge into existing database", variable=self.mode_var, value="merge").grid(
                row=0, column=0, sticky="w"
            )
            ttk.Radiobutton(modes, text="Replace with a new database", variable=self.mode_var, value="replace").grid(
                row=1, column=0, sticky="w", pady=(3, 0)
            )

            ttk.Separator(outer).grid(row=9, column=0, columnspan=3, sticky="ew", pady=12)
            ttk.Checkbutton(
                outer,
                text="Write website manifest",
                variable=self.write_manifest_var,
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

            self.progress = ttk.Progressbar(outer, mode="indeterminate")
            self.progress.grid(row=13, column=0, columnspan=3, sticky="ew", pady=(20, 7))
            ttk.Label(outer, textvariable=self.status_var, wraplength=720).grid(
                row=14, column=0, columnspan=3, sticky="w"
            )
            buttons = ttk.Frame(outer)
            buttons.grid(row=15, column=0, columnspan=3, sticky="e", pady=(16, 0))
            self.cancel_button = ttk.Button(buttons, text="Cancel", command=self.cancel, state="disabled")
            self.cancel_button.grid(row=0, column=0, padx=(0, 8))
            self.import_button = ttk.Button(buttons, text="Combine CSV files", command=self.start)
            self.import_button.grid(row=0, column=1)
            self.root.protocol("WM_DELETE_WINDOW", self.close)

        def _choose_folder(self) -> None:
            value = filedialog.askdirectory(title="Choose folder to search")
            if value:
                self.folder_var.set(value)
                folder = Path(value)
                if not self.output_var.get():
                    self.output_var.set(str(folder / "heritage_atlas.sqlite"))
                if not self.manifest_var.get():
                    self.manifest_var.set(str(folder / "atlas-manifest.json"))

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

        def options(self) -> FolderImportOptions:
            if not self.folder_var.get().strip():
                raise ValueError("Choose an input folder.")
            if not self.output_var.get().strip():
                raise ValueError("Choose a SQLite output file.")
            manifest: Path | None = None
            if self.write_manifest_var.get():
                if not self.manifest_var.get().strip():
                    raise ValueError("Choose a manifest file or turn off website manifest output.")
                manifest = Path(self.manifest_var.get())
            return FolderImportOptions(
                input_folder=Path(self.folder_var.get()),
                output_path=Path(self.output_var.get()),
                version=self.version_var.get(),
                name=self.name_var.get(),
                mode=self.mode_var.get(),
                manifest_path=manifest,
                dataset_url=self.dataset_url_var.get() or None,
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
            self.status_var.set("Finding matching CSV files…")

            def worker() -> None:
                try:
                    result = import_folder(
                        options,
                        progress=lambda current, total, path, rows: self.events.put(
                            ("progress", (current, total, path, rows))
                        ),
                        cancel=self.cancel_event,
                    )
                except ImportCancelled:
                    self.events.put(("cancelled", None))
                except BaseException as error:
                    self.events.put(("error", error))
                else:
                    self.events.put(("complete", result))

            threading.Thread(target=worker, name="atlas-folder-import", daemon=True).start()

        def cancel(self) -> None:
            self.cancel_event.set()
            self.cancel_button.configure(state="disabled")
            self.status_var.set("Cancelling safely…")

        def _poll_events(self) -> None:
            try:
                while True:
                    kind, value = self.events.get_nowait()
                    if kind == "progress":
                        current, total, path, rows = value
                        self.status_var.set(
                            f"File {current:,} of {total:,}: {path} ({rows:,} total rows processed)"
                        )
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
                self.status_var.set("Import cancelled. The destination database was not changed.")
            elif kind == "complete":
                self.status_var.set(
                    f"Import complete: {value.files_found:,} files, {value.total_places:,} places."
                )
                messagebox.showinfo("Import complete", report_text(value), parent=self.root)
            else:
                self.status_var.set("Import failed. The destination database was not changed.")
                messagebox.showerror("Import failed", str(value), parent=self.root)

        def close(self) -> None:
            if not self.running:
                self.root.destroy()
                return
            if messagebox.askyesno(
                "Import in progress",
                "Cancel the import and close when it stops?",
                parent=self.root,
            ):
                self.closing = True
                self.cancel()

    try:
        root = tk.Tk()
    except tk.TclError as error:
        print(f"Could not open the desktop interface: {error}", file=sys.stderr)
        return 1
    FolderImporterWindow(root)
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
