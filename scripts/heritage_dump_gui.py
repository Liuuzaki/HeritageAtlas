#!/usr/bin/env python3
"""
Heritage Dump Desktop — architecture filter v1
===============================================
A local Tkinter application for creating resumable CSV/JSONL exports from
Wikidata heritage designations (P1435).

Included registry presets
-------------------------
- France heritage designations (optional Mérimée links)
- England heritage designations (optional National Heritage List links)
- Japanese cultural heritage designations (optional P4275 links)
- Italy heritage designations (optional Vincoli in Rete links)
- Netherlands heritage designations (optional Rijksmonument links)
- Custom Wikidata external-ID property

Features
--------
- choose a registry and output folder
- filter to items with at least one explicit Wikipedia sitelink
- Start / Abort / Resume (durable checkpoints)
- stage and row progress in the UI
- optional architecture/building-only type filter
- resumable native-language + English Wikipedia pageview collection
- Excel-friendly UTF-8-with-BOM CSV files
- a concise, fixed-order places CSV with the requested labels, URLs, coordinates, and view totals
- a raw JSONL snapshot of each item for later reprocessing

Dependencies: Python 3.9+ with the standard library. Tkinter is included with
most standard Python installers.

This software reads data from Wikidata and a public Wikidata SPARQL endpoint;
it does not copy official heritage databases directly. Respect Wikidata and
Wikimedia API etiquette by setting a real contact email in USER_AGENT.
"""

from __future__ import annotations

import csv
import json
import os
import platform
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

import tkinter as tk
from tkinter import filedialog, messagebox, ttk


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Replace this value before running the app. Wikimedia asks API clients to use
# an identifiable User-Agent, preferably with a contact method.
USER_AGENT = "Liuuzaki@qq.com"

SPARQL_ENDPOINT = "https://qlever.dev/api/wikidata"
WIKIDATA_API = "https://www.wikidata.org/w/api.php"
PAGEVIEWS_API = "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article"
VIEW_START = "2015070100"  # First consistently available Wikimedia pageview month.
PAGEVIEW_DEFAULT_WORKERS = 4
PAGEVIEW_MAX_WORKERS = 10
PAGEVIEW_WRITE_BATCH_SIZE = 50

PROPERTY_RE = re.compile(r"^P[1-9][0-9]*$")

# Display names for the preset languages and common custom language codes.
# Unknown custom codes fall back to the label entered by the user.
LANGUAGE_LABELS_EN = {
    "ar": "Arabic",
    "ca": "Catalan",
    "cs": "Czech",
    "da": "Danish",
    "de": "German",
    "el": "Greek",
    "en": "English",
    "es": "Spanish",
    "fi": "Finnish",
    "fr": "French",
    "he": "Hebrew",
    "hi": "Hindi",
    "hu": "Hungarian",
    "id": "Indonesian",
    "it": "Italian",
    "ja": "Japanese",
    "ko": "Korean",
    "nl": "Dutch",
    "no": "Norwegian",
    "pl": "Polish",
    "pt": "Portuguese",
    "ro": "Romanian",
    "ru": "Russian",
    "sv": "Swedish",
    "th": "Thai",
    "tr": "Turkish",
    "uk": "Ukrainian",
    "vi": "Vietnamese",
    "zh": "Chinese",
}


def language_label_en(language_code: str, fallback: str) -> str:
    """Return a readable English language name for the output CSV."""
    normalized = language_code.strip().lower()
    return LANGUAGE_LABELS_EN.get(normalized, LANGUAGE_LABELS_EN.get(normalized.split("-", 1)[0], fallback))


@dataclass(frozen=True)
class RegistryDefinition:
    display_name: str
    slug: str
    property_id: str
    property_label: str
    native_language: str
    native_language_label: str
    record_url_template: str = ""
    # Discovery for presets is based on P1435, never on the optional external-ID
    # property. Known values are included directly, and designation-country QIDs
    # expand the scope to other national designations maintained in Wikidata.
    discovery_designation_qids: Tuple[str, ...] = ()
    designation_country_qids: Tuple[str, ...] = ()
    designation_scope_label: str = ""


PRESETS: List[RegistryDefinition] = [
    RegistryDefinition(
        "France heritage designations (P1435)",
        # New folder avoids mixing a former P380-only export with this scope.
        "france_designations_p1435_v2",
        "P380",
        "Mérimée ID",
        "fr",
        "French",
        "https://www.pop.culture.gouv.fr/notice/merimee/{id}",
        (
            "Q916475",   # Historical Monument
            "Q10387575", # monument historique inscrit
            "Q10387684", # classified historical monument
        ),
        ("Q142",),
        "France",
    ),
    RegistryDefinition(
        "England heritage designations (P1435)",
        # New folder avoids mixing a former P1216-only export with this scope.
        "england_designations_p1435_v2",
        "P1216",
        "National Heritage List for England number",
        "en",
        "English",
        "https://historicengland.org.uk/listing/the-list/list-entry/{id}",
        (
            "Q15700818",  # Grade I listed building
            "Q15700831",  # Grade II* listed building
            "Q15700834",  # Grade II listed building
            "Q219538",    # scheduled monument
            "Q7309375",   # Registered Battlefield
            "Q21408194",  # protected shipwreck (Section 1)
            "Q26789527",  # Grade I listed park and garden
            "Q97819899",  # Grade II listed park and garden
            "Q111987264", # Grade II* listed park and garden
        ),
        ("Q145",),
        "England / United Kingdom",
    ),
    RegistryDefinition(
        "Japanese cultural heritage designations (P1435)",
        # New folder avoids mixing a former P4275-only export with this scope.
        "japan_cultural_designations_p1435_v2",
        "P4275",
        "Japanese Database of National Cultural Properties ID",
        "ja",
        "Japanese",
        "https://kunishitei.bunka.go.jp/heritage/detail/{id}",
        (
            "Q1139795",  # National Treasure of Japan / 国宝
            "Q1188622",  # Important Cultural Property of Japan / 重要文化財
            "Q11579194", # Registered Tangible Cultural Property of Japan / 登録有形文化財
        ),
        ("Q17",),
        "Japan",
    ),
    RegistryDefinition(
        "Italy heritage designations (P1435)",
        # New folder avoids mixing a former P4249-only export with this scope.
        "italy_designations_p1435_v2",
        "P4249",
        "Vincoli in Rete ID",
        "it",
        "Italian",
        "",
        (
            "Q26971668",  # Italian national heritage
            "Q121871437", # cultural heritage monument in Italy
        ),
        ("Q38",),
        "Italy",
    ),
    RegistryDefinition(
        "Netherlands heritage designations (P1435)",
        # New folder avoids mixing a former P359-only export with this scope.
        "netherlands_designations_p1435_v2",
        "P359",
        "Rijksmonument ID",
        "nl",
        "Dutch",
        "https://monumentenregister.cultureelerfgoed.nl/monumenten/{id}",
        ("Q916333",),  # Rijksmonument
        ("Q55",),
        "the Netherlands",
    ),
]

CUSTOM_DISPLAY = "Custom Wikidata external-ID property"

INDEX_FIELDS = [
    "wikidata_qid",
    "wikidata_url",
    "source_property",
    "source_property_label",
    "source_identifier",
    "source_record_url",
]

PLACE_FIELDS = [
    "wikidata_qid",
    "label_native",
    "label_en",
    "label_zh",
    "coordinates_wkt",
    "native_language_label_en",
    "country_label_en",
    "heritage_designation_labels_native",
    "architectural_style_label_en",
    "inception_values",
    "nativeWikiViewCount",
    "enWikiViewCount",
    "wikiViewCount",
    "wikipedia_sitelinks_count",
    "source_record_urls",
    "nativewiki_url",
    "enwiki_url",
    "commons_image_urls",
    "wikicommons_category",
    "official_website_urls",
]


VIEW_LOG_FIELDS = [
    "wikidata_qid",
    "language",
    "project",
    "title",
    "article_url",
    "view_count",
    "view_count_start",
    "view_count_end",
    "status",
    "error",
    "fetched_at_utc",
]


class AbortRequested(Exception):
    """Raised internally when the user requests a graceful stop."""


# ---------------------------------------------------------------------------
# File and network helpers
# ---------------------------------------------------------------------------


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def require_user_agent() -> None:
    if "replace-with-your-email" in USER_AGENT:
        raise RuntimeError(
            "Edit USER_AGENT near the top of heritage_dump_gui.py and replace "
            "the placeholder email before starting an export."
        )


def load_json(path: Path, default: Dict[str, Any]) -> Dict[str, Any]:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def write_json_atomic(path: Path, payload: Dict[str, Any]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, path)


def append_csv_rows(path: Path, fields: List[str], rows: Iterable[Dict[str, Any]]) -> int:
    """Append CSV records; use BOM only when creating a fresh file for Excel."""
    rows = list(rows)
    if not rows:
        return 0

    is_new = not path.exists() or path.stat().st_size == 0
    encoding = "utf-8-sig" if is_new else "utf-8"
    with path.open("a", encoding=encoding, newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        if is_new:
            writer.writeheader()
        writer.writerows(rows)
        handle.flush()
        os.fsync(handle.fileno())
    return len(rows)


def read_csv(path: Path) -> List[Dict[str, str]]:
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def ensure_csv_schema(path: Path, expected_fields: List[str], display_name: str) -> None:
    """Reject output created by an older schema instead of mixing CSV headers."""
    if not path.exists() or path.stat().st_size == 0:
        return
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        actual_fields = next(csv.reader(handle), [])
    if actual_fields != expected_fields:
        raise RuntimeError(
            f"{display_name} was created by an older output schema. "
            "Use Reset selected output before exporting with this version."
        )


def quote_source_identifier(value: str) -> str:
    return urllib.parse.quote(value, safe="")


def source_record_url(registry: RegistryDefinition, identifier: str) -> str:
    """Build a registry URL without percent-encoding the registry identifier.

    Some heritage sites treat punctuation such as slashes as part of the
    record path, so their identifier must be inserted exactly as supplied by
    Wikidata (for example, ``101/00000138`` rather than ``101%2F00000138``).
    """
    if not registry.record_url_template:
        return ""
    return registry.record_url_template.format(id=identifier)


def commons_file_url(filename: str) -> str:
    return (
        "https://commons.wikimedia.org/wiki/Special:FilePath/"
        + urllib.parse.quote(filename, safe="")
    )


def commons_category_url(category: str) -> str:
    if not category:
        return ""
    title = category if category.startswith("Category:") else f"Category:{category}"
    return (
        "https://commons.wikimedia.org/wiki/"
        + urllib.parse.quote(title.replace(" ", "_"), safe="():/")
    )


def wikipedia_url(language: str, title: str) -> str:
    return (
        f"https://{language}.wikipedia.org/wiki/"
        + urllib.parse.quote(title.replace(" ", "_"), safe="()/:")
    )


def wikipedia_title_from_url(url: str) -> str:
    """Recover a Wikipedia article title from an exported article URL.

    The concise CSV intentionally retains article URLs but not the internal
    title columns. The Pageviews endpoint needs the title, so this reverses
    ``wikipedia_url`` for ordinary ``/wiki/...`` article links.
    """
    if not url:
        return ""
    parsed = urllib.parse.urlsplit(url)
    if not parsed.netloc.endswith(".wikipedia.org"):
        return ""
    prefix = "/wiki/"
    if not parsed.path.startswith(prefix):
        return ""
    encoded_title = parsed.path[len(prefix):]
    if not encoded_title:
        return ""
    return urllib.parse.unquote(encoded_title).replace("_", " ")


def last_completed_month_start() -> str:
    """Return a monthly Pageviews end point, excluding the partial current month."""
    now = datetime.now(timezone.utc).date()
    first_of_current_month = now.replace(day=1)
    final_day_previous_month = first_of_current_month - timedelta(days=1)
    return final_day_previous_month.replace(day=1).strftime("%Y%m%d") + "00"


def slug_with_architecture_filter(registry_slug: str, architecture_only: bool) -> str:
    # v2 isolates the stricter built-only rule from older architecture-only runs
    # whose checkpoints may contain broad ontology matches.
    return registry_slug + ("__architecture_p31_v1" if architecture_only else "")


def request_json(
    url: str,
    *,
    params: Optional[Dict[str, str]] = None,
    accept: str = "application/json",
    abort_event: threading.Event,
    log: callable,
    retries: int = 7,
) -> Dict[str, Any]:
    """Fetch JSON with cancellation checks and polite exponential backoff."""
    if params:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)

    delay = 2.0
    last_error: Optional[Exception] = None
    for attempt in range(retries):
        if abort_event.is_set():
            raise AbortRequested()

        request = urllib.request.Request(
            url,
            headers={"User-Agent": USER_AGENT, "Accept": accept},
        )
        try:
            with urllib.request.urlopen(request, timeout=90) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            last_error = exc
            if exc.code == 429:
                retry_after = exc.headers.get("Retry-After")
                try:
                    pause = float(retry_after) if retry_after else delay
                except ValueError:
                    pause = delay
            elif 500 <= exc.code < 600:
                pause = delay
            else:
                raise
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            last_error = exc
            pause = delay

        if attempt == retries - 1:
            break

        pause = min(pause, 120)
        log(f"Temporary request failure ({type(last_error).__name__}); retrying in {pause:.0f}s")
        # Sleep in short chunks so an Abort click is responsive during backoff.
        remaining = pause
        while remaining > 0:
            if abort_event.is_set():
                raise AbortRequested()
            step = min(0.5, remaining)
            time.sleep(step)
            remaining -= step
        delay = min(delay * 2, 120)

    raise RuntimeError(f"Request failed after {retries} attempts: {url}") from last_error


# ---------------------------------------------------------------------------
# Wikidata extraction helpers
# ---------------------------------------------------------------------------


def sparql_literal(text: str) -> str:
    return json.dumps(text, ensure_ascii=False)


def binding_value(binding: Dict[str, Any], key: str) -> str:
    return binding.get(key, {}).get("value", "")


def qid_from_uri(uri: str) -> str:
    return uri.rsplit("/", 1)[-1]


def property_claim_values(entity: Dict[str, Any], property_id: str) -> List[str]:
    """Flatten direct string/QID/time values while retaining full claims in JSONL."""
    values: List[str] = []
    for claim in entity.get("claims", {}).get(property_id, []):
        if claim.get("rank") == "deprecated":
            continue
        snak = claim.get("mainsnak", {})
        if snak.get("snaktype") != "value":
            continue
        raw = snak.get("datavalue", {}).get("value")
        if isinstance(raw, str):
            values.append(raw)
        elif isinstance(raw, dict):
            if "id" in raw:
                values.append(str(raw["id"]))
            elif "time" in raw:
                values.append(str(raw["time"]))
            elif "amount" in raw:
                values.append(str(raw["amount"]))
    return list(dict.fromkeys(values))


def coordinate_wkt(entity: Dict[str, Any]) -> str:
    for claim in entity.get("claims", {}).get("P625", []):
        if claim.get("rank") == "deprecated":
            continue
        raw = claim.get("mainsnak", {}).get("datavalue", {}).get("value")
        if isinstance(raw, dict) and "longitude" in raw and "latitude" in raw:
            return f"POINT({raw['longitude']} {raw['latitude']})"
    return ""


def term(entity: Dict[str, Any], bucket: str, language: str) -> str:
    return entity.get(bucket, {}).get(language, {}).get("value", "")


def aliases(entity: Dict[str, Any], language: str) -> str:
    values = [
        entry.get("value", "")
        for entry in entity.get("aliases", {}).get(language, [])
        if entry.get("value")
    ]
    return " | ".join(values)


def get_wikipedia_sitelink(entity: Dict[str, Any], language: str) -> Tuple[str, str]:
    link = entity.get("sitelinks", {}).get(f"{language}wiki", {})
    title = link.get("title", "")
    return (title, wikipedia_url(language, title)) if title else ("", "")


def all_wikipedia_sitelinks(entity: Dict[str, Any], native_language: str) -> str:
    entries: List[str] = []
    for site, value in entity.get("sitelinks", {}).items():
        if not site.endswith("wiki") or site == "commonswiki":
            continue
        language = site[:-4]
        if language in {native_language, "en"}:
            continue
        title = value.get("title", "")
        if title:
            entries.append(f"{language}:{wikipedia_url(language, title)}")
    return " | ".join(sorted(entries))


def wikipedia_sitelinks_count(entity: Dict[str, Any]) -> int:
    return sum(
        1
        for site in entity.get("sitelinks", {})
        if site.endswith("wiki") and site != "commonswiki"
    )


# ---------------------------------------------------------------------------
# Exporter
# ---------------------------------------------------------------------------


class HeritageExporter:
    """Runs a two-stage, resumable registry export in a background thread."""

    def __init__(
        self,
        registry: RegistryDefinition,
        root_output_dir: Path,
        require_wikipedia: bool,
        architecture_only: bool,
        max_identifier_rows: int,
        abort_event: threading.Event,
        events: queue.Queue,
    ) -> None:
        self.registry = registry
        self.require_wikipedia = require_wikipedia
        self.architecture_only = architecture_only
        self.max_identifier_rows = max_identifier_rows
        self.abort_event = abort_event
        self.events = events
        self.output_dir = root_output_dir / slug_with_architecture_filter(registry.slug, architecture_only)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.labels_cache_path = self.output_dir / "entity_label_cache.json"

    # --- event plumbing --------------------------------------------------

    def emit(self, kind: str, **payload: Any) -> None:
        self.events.put({"kind": kind, **payload})

    def log(self, message: str) -> None:
        self.emit("log", message=message)

    def check_abort(self) -> None:
        if self.abort_event.is_set():
            raise AbortRequested()

    # --- state paths -----------------------------------------------------

    @property
    def index_csv(self) -> Path:
        return self.output_dir / "registry_identifiers.csv"

    @property
    def index_checkpoint(self) -> Path:
        return self.output_dir / "index_checkpoint.json"

    @property
    def raw_jsonl(self) -> Path:
        return self.output_dir / "items.jsonl"

    @property
    def places_csv(self) -> Path:
        return self.output_dir / "heritage_places.csv"

    @property
    def enrich_checkpoint(self) -> Path:
        return self.output_dir / "enrich_checkpoint.json"

    @property
    def metadata_path(self) -> Path:
        return self.output_dir / "metadata.json"

    # --- discovery -------------------------------------------------------

    def uses_designation_discovery(self) -> bool:
        return bool(
            self.registry.discovery_designation_qids
            or self.registry.designation_country_qids
        )

    def discovery_scope_label(self) -> str:
        if self.uses_designation_discovery():
            scope = self.registry.designation_scope_label or "the selected scope"
            return f"heritage designations (P1435) for {scope}"
        return f"{self.registry.property_label} ({self.registry.property_id})"

    def build_index_query(self, last_identifier: str, last_item_uri: str, limit: int) -> str:
        cursor = ""
        if last_identifier:
            cursor = f"""
  FILTER(
    ?identifier_text > {sparql_literal(last_identifier)}
    || (
      ?identifier_text = {sparql_literal(last_identifier)}
      && ?item_text > {sparql_literal(last_item_uri)}
    )
  )
"""

        wiki_filter = ""
        if self.require_wikipedia:
            wiki_filter = """
  FILTER EXISTS {
    ?article schema:about ?item ;
             schema:isPartOf ?wiki .
    ?wiki wikibase:wikiGroup "wikipedia" .
  }
"""

        architecture_filter = ""
        if self.architecture_only:
            # Positive, auditable inclusion rule:
            # one of the item's *direct* P31 values must be architectural
            # structure (Q811979) or a subclass of it. No blacklist is used.
            architecture_filter = """
  ?item wdt:P31 ?architecture_class .
  ?architecture_class wdt:P279* wd:Q811979 .
"""

        if self.uses_designation_discovery():
            known_values = " ".join(
                f"wd:{qid}" for qid in self.registry.discovery_designation_qids
            )
            country_values = " ".join(
                f"wd:{qid}" for qid in self.registry.designation_country_qids
            )
            scope_clauses: List[str] = []
            if known_values:
                scope_clauses.append(f"""
    VALUES ?designation {{ {known_values} }}
""")
            if country_values:
                scope_clauses.append(f"""
    VALUES ?designation_country {{ {country_values} }}
    ?designation wdt:P17 ?designation_country .
""")
            designation_scope = "  UNION\n".join(
                f"  {{\n{clause}  }}" for clause in scope_clauses
            )
            # The external identifier is deliberately blank at discovery time.
            # A hydrated item later contributes its optional ID only to the
            # official record URL, never to eligibility for this export.
            discovery_pattern = f"""
  ?item wdt:P1435 ?designation .
{designation_scope}
  BIND("" AS ?identifier)
  # Use the stable item URI as the cursor key: one discovery row per item.
  BIND(STR(?item) AS ?identifier_text)
"""
        else:
            discovery_pattern = f"""
  ?item wdt:{self.registry.property_id} ?identifier .
  BIND(STR(?identifier) AS ?identifier_text)
"""

        return f"""
PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX schema: <http://schema.org/>
PREFIX wikibase: <http://wikiba.se/ontology#>

SELECT DISTINCT ?item ?identifier ?identifier_text ?item_text WHERE {{
{discovery_pattern}{architecture_filter}{wiki_filter}
  BIND(STR(?item) AS ?item_text)
{cursor}}}
ORDER BY ?identifier_text ?item_text
LIMIT {limit}
"""

    def run_index(self) -> Dict[str, Any]:
        state = load_json(
            self.index_checkpoint,
            {
                "completed": False,
                "last_identifier": "",
                "last_item_uri": "",
                "rows_written": 0,
                "started_at_utc": utc_now(),
            },
        )
        if state.get("completed"):
            self.log(f"Index already complete: {state.get('rows_written', 0):,} discovery rows.")
            return state

        total = int(state.get("rows_written", 0))
        last_identifier = str(state.get("last_identifier", ""))
        last_item_uri = str(state.get("last_item_uri", ""))
        self.emit("stage", text="Indexing Wikidata items", indeterminate=True)
        self.log(
            f"Indexing {self.discovery_scope_label()} from the public SPARQL endpoint..."
        )

        while True:
            self.check_abort()
            if self.max_identifier_rows and total >= self.max_identifier_rows:
                state.update(
                    {
                        "completed": False,
                        "paused_by_limit": True,
                        "updated_at_utc": utc_now(),
                    }
                )
                write_json_atomic(self.index_checkpoint, state)
                self.log(f"Paused at requested test limit: {total:,} rows.")
                return state

            limit = 2000
            if self.max_identifier_rows:
                limit = min(limit, self.max_identifier_rows - total)

            payload = request_json(
                SPARQL_ENDPOINT,
                params={"query": self.build_index_query(last_identifier, last_item_uri, limit)},
                accept="application/sparql-results+json",
                abort_event=self.abort_event,
                log=self.log,
            )
            self.check_abort()
            bindings = payload.get("results", {}).get("bindings", [])
            if not bindings:
                state.update({"completed": True, "completed_at_utc": utc_now()})
                write_json_atomic(self.index_checkpoint, state)
                self.log(f"Index complete: {total:,} discovery rows.")
                return state

            rows: List[Dict[str, str]] = []
            for binding in bindings:
                item_uri = binding_value(binding, "item")
                identifier = binding_value(binding, "identifier")
                if not item_uri:
                    continue
                qid = qid_from_uri(item_uri)
                rows.append(
                    {
                        "wikidata_qid": qid,
                        "wikidata_url": f"https://www.wikidata.org/wiki/{qid}",
                        "source_property": self.registry.property_id,
                        "source_property_label": self.registry.property_label,
                        "source_identifier": identifier,
                        "source_record_url": source_record_url(self.registry, identifier) if identifier else "",
                    }
                )

            self.check_abort()
            append_csv_rows(self.index_csv, INDEX_FIELDS, rows)
            total += len(rows)
            final = bindings[-1]
            last_identifier = binding_value(final, "identifier_text")
            last_item_uri = binding_value(final, "item_text")
            state.update(
                {
                    "completed": False,
                    "paused_by_limit": False,
                    "last_identifier": last_identifier,
                    "last_item_uri": last_item_uri,
                    "rows_written": total,
                    "updated_at_utc": utc_now(),
                }
            )
            write_json_atomic(self.index_checkpoint, state)
            self.emit("progress", current=total, total=None, label=f"Indexed {total:,} discovery rows")

            if len(bindings) < limit:
                state.update({"completed": True, "completed_at_utc": utc_now()})
                write_json_atomic(self.index_checkpoint, state)
                self.log(f"Index complete: {total:,} discovery rows.")
                return state

    # --- entity enrichment ------------------------------------------------

    def read_index(self) -> Tuple[List[str], Dict[str, List[str]]]:
        by_qid: Dict[str, List[str]] = {}
        ordered_qids: List[str] = []
        for row in read_csv(self.index_csv):
            qid = (row.get("wikidata_qid") or "").strip()
            identifier = (row.get("source_identifier") or "").strip()
            if not qid:
                continue
            if qid not in by_qid:
                by_qid[qid] = []
                ordered_qids.append(qid)
            if identifier and identifier not in by_qid[qid]:
                by_qid[qid].append(identifier)
        return ordered_qids, by_qid

    def wikidata_entities(self, qids: List[str], languages: str) -> Dict[str, Dict[str, Any]]:
        payload = request_json(
            WIKIDATA_API,
            params={
                "action": "wbgetentities",
                "format": "json",
                "formatversion": "2",
                "ids": "|".join(qids),
                "props": "info|labels|descriptions|aliases|claims|sitelinks",
                "languages": languages,
                "maxlag": "5",
                "origin": "*",
            },
            abort_event=self.abort_event,
            log=self.log,
        )
        entities = payload.get("entities", [])
        if isinstance(entities, dict):
            return entities
        return {
            entity.get("id", ""): entity
            for entity in entities
            if isinstance(entity, dict) and entity.get("id")
        }

    def load_label_cache(self) -> Dict[str, Dict[str, str]]:
        return load_json(self.labels_cache_path, {})

    def entity_languages(self) -> str:
        """Return the distinct label languages needed for item exports."""
        return "|".join(dict.fromkeys((self.registry.native_language, "en", "zh")))

    def resolve_labels(self, qids: Set[str]) -> Dict[str, Dict[str, str]]:
        """Resolve linked QIDs into native and English labels, cached locally."""
        cache = self.load_label_cache()
        missing = [
            qid
            for qid in sorted(qids)
            if qid and (
                qid not in cache
                or "native" not in cache[qid]
                or "en" not in cache[qid]
            )
        ]
        if not missing:
            return cache

        languages = self.entity_languages()

        for offset in range(0, len(missing), 50):
            self.check_abort()
            batch = missing[offset : offset + 50]
            entities = self.wikidata_entities(batch, languages)
            for qid in batch:
                entity = entities.get(qid, {})
                cache[qid] = {
                    "native": term(entity, "labels", self.registry.native_language),
                    "en": term(entity, "labels", "en"),
                }
            write_json_atomic(self.labels_cache_path, cache)
        return cache

    def project_entity(
        self,
        qid: str,
        entity: Dict[str, Any],
        source_ids: List[str],
        label_cache: Dict[str, Dict[str, str]],
        fetched_at: str,
    ) -> Dict[str, str]:
        """Project an item to the concise, public-facing CSV schema."""
        del fetched_at  # The raw JSONL snapshot retains the per-item fetch timestamp.
        native_title, native_url = get_wikipedia_sitelink(entity, self.registry.native_language)
        en_title, en_url = get_wikipedia_sitelink(entity, "en")

        images = property_claim_values(entity, "P18")
        designation_qids = property_claim_values(entity, "P1435")
        country_qids = property_claim_values(entity, "P17")
        architectural_style_qids = property_claim_values(entity, "P149")
        if self.uses_designation_discovery():
            # P4275 is optional in this discovery mode; recover it from the
            # hydrated entity for official record URLs when Wikidata has it.
            source_ids = list(dict.fromkeys(source_ids + property_claim_values(entity, self.registry.property_id)))

        native_designations = [
            label_cache.get(item_qid, {}).get("native", "") or item_qid
            for item_qid in designation_qids
        ]
        country_labels_en = [
            label_cache.get(item_qid, {}).get("en", "") or item_qid
            for item_qid in country_qids
        ]
        architectural_style_labels_en = [
            label_cache.get(item_qid, {}).get("en", "") or item_qid
            for item_qid in architectural_style_qids
        ]

        return {
            "wikidata_qid": qid,
            "label_native": term(entity, "labels", self.registry.native_language),
            "label_en": term(entity, "labels", "en"),
            "label_zh": term(entity, "labels", "zh"),
            "coordinates_wkt": coordinate_wkt(entity),
            "native_language_label_en": language_label_en(
                self.registry.native_language,
                self.registry.native_language_label,
            ),
            "country_label_en": " | ".join(country_labels_en),
            "heritage_designation_labels_native": " | ".join(native_designations),
            "architectural_style_label_en": " | ".join(architectural_style_labels_en),
            "inception_values": " | ".join(property_claim_values(entity, "P571")),
            "nativeWikiViewCount": "",
            "enWikiViewCount": "",
            "wikiViewCount": "",
            "wikipedia_sitelinks_count": str(wikipedia_sitelinks_count(entity)),
            "source_record_urls": " | ".join(
                source_record_url(self.registry, identifier) for identifier in source_ids
            ),
            "nativewiki_url": native_url,
            "enwiki_url": en_url,
            "commons_image_urls": " | ".join(commons_file_url(image) for image in images),
            "wikicommons_category": commons_category_url(
                (property_claim_values(entity, "P373") or [""])[0]
            ),
            "official_website_urls": " | ".join(property_claim_values(entity, "P856")),
        }

    def run_enrich(self) -> Dict[str, Any]:
        if not self.index_csv.exists():
            raise RuntimeError("No index file exists. Complete the index stage first.")

        qids, source_ids_by_qid = self.read_index()
        state = load_json(
            self.enrich_checkpoint,
            {
                "completed": False,
                "next_offset": 0,
                "unique_qids_total": len(qids),
                "started_at_utc": utc_now(),
            },
        )
        next_offset = int(state.get("next_offset", 0))
        ensure_csv_schema(self.places_csv, PLACE_FIELDS, self.places_csv.name)
        if state.get("completed") and next_offset >= len(qids):
            self.log(f"Entity export already complete: {len(qids):,} unique items.")
            return state
        if next_offset > len(qids):
            raise RuntimeError(
                "The index is shorter than the enrichment checkpoint. Reset this "
                "database output before starting again."
            )

        languages = self.entity_languages()

        self.emit("stage", text="Fetching Wikidata item details", indeterminate=False)
        self.emit("progress", current=next_offset, total=len(qids), label=f"Fetched {next_offset:,}/{len(qids):,} items")
        self.log(f"Fetching {len(qids):,} unique Wikidata items (resuming at {next_offset:,})...")

        for offset in range(next_offset, len(qids), 50):
            self.check_abort()
            batch = qids[offset : offset + 50]
            entities_by_qid = self.wikidata_entities(batch, languages)
            self.check_abort()
            fetched_at = utc_now()

            linked_qids: Set[str] = set()
            for qid in batch:
                entity = entities_by_qid.get(qid, {})
                linked_qids.update(property_claim_values(entity, "P1435"))
                linked_qids.update(property_claim_values(entity, "P17"))
                linked_qids.update(property_claim_values(entity, "P149"))
            label_cache = self.resolve_labels(linked_qids)
            self.check_abort()

            raw_lines: List[str] = []
            rows: List[Dict[str, str]] = []
            for qid in batch:
                entity = entities_by_qid.get(qid, {})
                raw_lines.append(
                    json.dumps(
                        {
                            "wikidata_qid": qid,
                            "fetched_at_utc": fetched_at,
                            "missing_or_unavailable": not bool(entity) or bool(entity.get("missing")),
                            "entity": entity,
                        },
                        ensure_ascii=False,
                    )
                )
                if entity and not entity.get("missing"):
                    rows.append(
                        self.project_entity(
                            qid,
                            entity,
                            source_ids_by_qid[qid],
                            label_cache,
                            fetched_at,
                        )
                    )

            self.check_abort()
            with self.raw_jsonl.open("a", encoding="utf-8") as handle:
                handle.write("\n".join(raw_lines) + "\n")
                handle.flush()
                os.fsync(handle.fileno())
            append_csv_rows(self.places_csv, PLACE_FIELDS, rows)

            next_offset = offset + len(batch)
            state.update(
                {
                    "completed": next_offset >= len(qids),
                    "next_offset": next_offset,
                    "unique_qids_total": len(qids),
                    "updated_at_utc": utc_now(),
                }
            )
            if state["completed"]:
                state["completed_at_utc"] = utc_now()
            write_json_atomic(self.enrich_checkpoint, state)
            self.emit("progress", current=next_offset, total=len(qids), label=f"Fetched {next_offset:,}/{len(qids):,} items")

            # A small pause is friendly to the Action API; cancellation is still fast.
            if next_offset < len(qids):
                for _ in range(5):
                    self.check_abort()
                    time.sleep(0.1)

        self.log(f"Entity export complete: {len(qids):,} unique items.")
        return state

    # --- lifecycle --------------------------------------------------------

    def write_metadata(self, index_state: Dict[str, Any], enrich_state: Dict[str, Any]) -> None:
        write_json_atomic(
            self.metadata_path,
            {
                "application": "Heritage Dump Desktop",
                "registry": asdict(self.registry),
                "scope": (
                    (
                        "Wikidata items with a heritage designation (P1435) in "
                        + (self.registry.designation_scope_label or "the selected scope")
                        + "; eligibility does not require an external identifier."
                        if self.uses_designation_discovery()
                        else "Wikidata items with the configured source property"
                    )
                    + (" and at least one Wikipedia sitelink" if self.require_wikipedia else "")
                    + (
                        " and a direct P31 type that is architectural structure (Q811979) "
                        "or one of its subclasses."
                        if self.architecture_only else "."
                    )
                ),
                "source_endpoints": {
                    "sparql_discovery": SPARQL_ENDPOINT,
                    "wikidata_entity_api": WIKIDATA_API,
                },
                "output_files": {
                    "identifiers": self.index_csv.name,
                    "raw_entities": self.raw_jsonl.name,
                    "places": self.places_csv.name,
                    "designation_label_cache": self.labels_cache_path.name,
                },
                "places_csv_columns": PLACE_FIELDS,
                "view_count_note": "Run the GUI's Fetch / Resume Wikipedia views action to create heritage_places_with_views.csv.",
                "architecture_filter_applied": self.architecture_only,
                "updated_at_utc": utc_now(),
                "index_state": index_state,
                "enrichment_state": enrich_state,
            },
        )

    def run(self) -> None:
        try:
            require_user_agent()
            self.log(f"Output folder: {self.output_dir}")
            index_state = self.run_index()
            self.check_abort()

            # A requested test limit makes this an intentionally partial index.
            if not index_state.get("completed"):
                self.log("Index is partial; resume with no test limit to continue discovery.")
                self.write_metadata(index_state, load_json(self.enrich_checkpoint, {}))
                self.emit("done", status="partial", output_dir=str(self.output_dir))
                return

            enrich_state = self.run_enrich()
            self.check_abort()
            self.write_metadata(index_state, enrich_state)
            self.emit("done", status="complete", output_dir=str(self.output_dir))
        except AbortRequested:
            self.log("Stopped safely. Completed batches and checkpoints remain on disk; click Start / Resume to continue.")
            self.emit("done", status="aborted", output_dir=str(self.output_dir))
        except Exception as exc:
            self.log(f"ERROR: {type(exc).__name__}: {exc}")
            self.emit("error", message=f"{type(exc).__name__}: {exc}", output_dir=str(self.output_dir))


# ---------------------------------------------------------------------------
# Resumable Wikimedia pageview collector
# ---------------------------------------------------------------------------


class WikiViewCollector:
    """Collect historical native-language + English Wikipedia views per item.

    A bounded worker pool fetches several *places* concurrently. The GUI thread
    writes returned language rows in durable batches, and a later run skips every
    completed (QID, language) pair recorded in the append-only log.
    """

    def __init__(
        self,
        registry: RegistryDefinition,
        root_output_dir: Path,
        architecture_only: bool,
        abort_event: threading.Event,
        events: queue.Queue,
        view_workers: int = PAGEVIEW_DEFAULT_WORKERS,
    ) -> None:
        if not 1 <= view_workers <= PAGEVIEW_MAX_WORKERS:
            raise ValueError(
                f"view_workers must be from 1 to {PAGEVIEW_MAX_WORKERS}."
            )
        self.registry = registry
        self.abort_event = abort_event
        self.events = events
        self.view_workers = view_workers
        self.output_dir = root_output_dir / slug_with_architecture_filter(registry.slug, architecture_only)

    def emit(self, kind: str, **payload: Any) -> None:
        self.events.put({"kind": kind, **payload})

    def log(self, message: str) -> None:
        self.emit("log", message=message)

    def check_abort(self) -> None:
        if self.abort_event.is_set():
            raise AbortRequested()

    @property
    def places_csv(self) -> Path:
        return self.output_dir / "heritage_places.csv"

    @property
    def views_csv(self) -> Path:
        return self.output_dir / "wiki_views_by_language.csv"

    @property
    def view_window_path(self) -> Path:
        return self.output_dir / "wiki_views_window.json"

    @property
    def final_places_csv(self) -> Path:
        return self.output_dir / "heritage_places_with_views.csv"

    def get_or_create_window(self) -> Tuple[str, str]:
        if self.view_window_path.exists():
            state = load_json(self.view_window_path, {})
            return str(state["view_count_start"]), str(state["view_count_end"])
        start, end = VIEW_START, last_completed_month_start()
        write_json_atomic(
            self.view_window_path,
            {
                "view_count_start": start,
                "view_count_end": end,
                "created_at_utc": utc_now(),
                "definition": "Monthly agent=user pageviews. native Wikipedia plus English Wikipedia.",
            },
        )
        return start, end

    def completed_keys(self, start: str, end: str) -> Set[Tuple[str, str]]:
        complete: Set[Tuple[str, str]] = set()
        for row in read_csv(self.views_csv):
            if (
                row.get("view_count_start") == start
                and row.get("view_count_end") == end
                and row.get("view_count", "") != ""
                and row.get("status") in {"ok", "not_found", "missing_title"}
            ):
                complete.add((row.get("wikidata_qid", ""), row.get("language", "")))
        return complete

    def fetch_count(self, qid: str, language: str, title: str, start: str, end: str) -> Dict[str, str]:
        project = f"{language}.wikipedia.org"
        base = {
            "wikidata_qid": qid,
            "language": language,
            "project": project,
            "title": title,
            "article_url": wikipedia_url(language, title) if title else "",
            "view_count_start": start,
            "view_count_end": end,
            "fetched_at_utc": utc_now(),
        }
        if not title:
            return {**base, "view_count": "0", "status": "missing_title", "error": ""}

        endpoint = (
            f"{PAGEVIEWS_API}/{project}/all-access/user/"
            f"{urllib.parse.quote(title.replace(' ', '_'), safe='')}/monthly/{start}/{end}"
        )
        try:
            payload = request_json(
                endpoint,
                abort_event=self.abort_event,
                log=self.log,
            )
            total = sum(int(item.get("views", 0)) for item in payload.get("items", []))
            return {**base, "view_count": str(total), "status": "ok", "error": ""}
        except AbortRequested:
            raise
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return {**base, "view_count": "0", "status": "not_found", "error": ""}
            return {**base, "view_count": "", "status": "error", "error": f"HTTP {exc.code}"}
        except Exception as exc:
            return {**base, "view_count": "", "status": "error", "error": f"{type(exc).__name__}: {exc}"}

    def fetch_place_counts(
        self,
        qid: str,
        language_requests: List[Tuple[str, str]],
        start: str,
        end: str,
    ) -> List[Dict[str, str]]:
        """Fetch the missing language counts for one place in a pool worker.

        The two language calls for a place remain sequential. Parallelism is
        across places, matching the faster command-line collector while keeping
        at most ``view_workers`` Pageviews requests active at any one time.
        """
        rows: List[Dict[str, str]] = []
        for language, title in language_requests:
            if self.abort_event.is_set():
                break
            try:
                rows.append(self.fetch_count(qid, language, title, start, end))
            except AbortRequested:
                # Return already completed language rows so the GUI thread can
                # persist them before its normal abort handling takes over.
                break
        return rows

    def latest_complete_rows(self, start: str, end: str) -> Dict[Tuple[str, str], Dict[str, str]]:
        rows: Dict[Tuple[str, str], Dict[str, str]] = {}
        for row in read_csv(self.views_csv):
            if (
                row.get("view_count_start") == start
                and row.get("view_count_end") == end
                and row.get("view_count", "") != ""
                and row.get("status") in {"ok", "not_found", "missing_title"}
            ):
                rows[(row.get("wikidata_qid", ""), row.get("language", ""))] = row
        return rows

    def write_joined_csv(self, start: str, end: str) -> None:
        """Write the same concise schema with any completed view totals filled in."""
        places = read_csv(self.places_csv)
        if not places:
            return
        ensure_csv_schema(self.places_csv, PLACE_FIELDS, self.places_csv.name)
        complete = self.latest_complete_rows(start, end)

        tmp = self.final_places_csv.with_suffix(".csv.tmp")
        complete_items = 0
        with tmp.open("w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=PLACE_FIELDS, extrasaction="ignore")
            writer.writeheader()
            for place in places:
                qid = place.get("wikidata_qid", "")
                native = complete.get((qid, self.registry.native_language))
                english = complete.get((qid, "en"))
                # English-native datasets request/count English exactly once.
                if self.registry.native_language == "en":
                    if english is not None:
                        count = int(english["view_count"])
                        place.update(
                            {
                                "nativeWikiViewCount": str(count),
                                "enWikiViewCount": str(count),
                                "wikiViewCount": str(count),
                            }
                        )
                        complete_items += 1
                    else:
                        for key in ("nativeWikiViewCount", "enWikiViewCount", "wikiViewCount"):
                            place[key] = ""
                elif native is not None and english is not None:
                    native_count = int(native["view_count"])
                    english_count = int(english["view_count"])
                    place.update(
                        {
                            "nativeWikiViewCount": str(native_count),
                            "enWikiViewCount": str(english_count),
                            "wikiViewCount": str(native_count + english_count),
                        }
                    )
                    complete_items += 1
                else:
                    for key in ("nativeWikiViewCount", "enWikiViewCount", "wikiViewCount"):
                        place[key] = ""
                writer.writerow(place)
        os.replace(tmp, self.final_places_csv)
        self.log(
            f"Rebuilt {self.final_places_csv.name}: {complete_items:,}/{len(places):,} items have complete view totals."
        )

    def run(self) -> None:
        try:
            require_user_agent()
            if not self.places_csv.exists():
                raise RuntimeError("No heritage_places.csv exists. Finish the data dump before collecting pageviews.")
            ensure_csv_schema(self.places_csv, PLACE_FIELDS, self.places_csv.name)

            start, end = self.get_or_create_window()
            places = read_csv(self.places_csv)
            # The concise CSV stores article URLs rather than title columns.
            # Rebuild titles from those URLs for the Pageviews API.
            complete_rows = self.latest_complete_rows(start, end)
            pending_places: List[Tuple[str, List[Tuple[str, str]]]] = []
            total_requests = 0
            for place in places:
                qid = (place.get("wikidata_qid") or "").strip()
                if not qid:
                    continue
                language_requests = [
                    (
                        self.registry.native_language,
                        wikipedia_title_from_url(place.get("nativewiki_url", "")),
                    )
                ]
                if self.registry.native_language != "en":
                    language_requests.append(
                        ("en", wikipedia_title_from_url(place.get("enwiki_url", "")))
                    )

                missing: List[Tuple[str, str]] = []
                for language, title in language_requests:
                    previous = complete_rows.get((qid, language))
                    # Versions with the concise schema accidentally looked for
                    # deleted title columns, wrote blank-title/missing_title rows,
                    # and therefore recorded every item as zero. Retry exactly
                    # those stale rows automatically when a usable URL exists.
                    stale_missing_title = bool(
                        title
                        and previous is not None
                        and previous.get("status") == "missing_title"
                        and not previous.get("title", "")
                    )
                    if previous is None or stale_missing_title:
                        missing.append((language, title))

                if missing:
                    pending_places.append((qid, missing))
                    total_requests += len(missing)

            self.emit("stage", text="Fetching historical Wikipedia pageviews", indeterminate=False)
            self.emit(
                "progress",
                current=0,
                total=total_requests,
                label=f"Wikipedia views: 0/{total_requests:,} language pages",
            )
            self.log(
                f"Pageview window: {start} to {end}. "
                f"{len(complete_rows):,} language rows already complete; "
                f"{total_requests:,} requests across {len(pending_places):,} places remain. "
                f"Using {self.view_workers} concurrent place workers."
            )

            completed = 0
            row_buffer: List[Dict[str, str]] = []

            def flush_rows() -> None:
                if row_buffer:
                    append_csv_rows(self.views_csv, VIEW_LOG_FIELDS, row_buffer)
                    row_buffer.clear()

            pending_index = 0
            active = set()
            aborting = False
            with ThreadPoolExecutor(
                max_workers=self.view_workers,
                thread_name_prefix="wiki-pageviews",
            ) as pool:
                while pending_index < len(pending_places) and len(active) < self.view_workers:
                    qid, language_requests = pending_places[pending_index]
                    pending_index += 1
                    active.add(
                        pool.submit(
                            self.fetch_place_counts,
                            qid,
                            language_requests,
                            start,
                            end,
                        )
                    )

                while active:
                    if self.abort_event.is_set():
                        aborting = True
                    done, active = wait(active, return_when=FIRST_COMPLETED)
                    for future in done:
                        rows = future.result()
                        for row in rows:
                            row_buffer.append(row)
                            completed += 1
                            if row.get("status") == "error":
                                self.log(
                                    f"View error for {row.get('wikidata_qid', '')} "
                                    f"{row.get('language', '')}: {row.get('error', '')}; "
                                    "it will retry next run."
                                )
                        if len(row_buffer) >= PAGEVIEW_WRITE_BATCH_SIZE:
                            flush_rows()
                        self.emit(
                            "progress",
                            current=completed,
                            total=total_requests,
                            label=(
                                f"Wikipedia views: {completed:,}/{total_requests:,} "
                                "language pages"
                            ),
                        )

                    if self.abort_event.is_set():
                        aborting = True
                    if not aborting:
                        while (
                            pending_index < len(pending_places)
                            and len(active) < self.view_workers
                        ):
                            qid, language_requests = pending_places[pending_index]
                            pending_index += 1
                            active.add(
                                pool.submit(
                                    self.fetch_place_counts,
                                    qid,
                                    language_requests,
                                    start,
                                    end,
                                )
                            )

            flush_rows()
            if aborting:
                raise AbortRequested()

            self.write_joined_csv(start, end)
            self.emit("done", status="views_complete", output_dir=str(self.output_dir))
        except AbortRequested:
            # Completed worker results have already been persisted before this
            # point. Build a useful partial joined CSV from those durable rows.
            try:
                if self.view_window_path.exists() and self.places_csv.exists():
                    start, end = self.get_or_create_window()
                    self.write_joined_csv(start, end)
            finally:
                self.log("Stopped safely. Completed pageview rows are saved; click Fetch / Resume Wikipedia views to continue.")
                self.emit("done", status="views_aborted", output_dir=str(self.output_dir))
        except Exception as exc:
            self.log(f"ERROR: {type(exc).__name__}: {exc}")
            self.emit("error", message=f"{type(exc).__name__}: {exc}", output_dir=str(self.output_dir))


# ---------------------------------------------------------------------------
# Tkinter application
# ---------------------------------------------------------------------------


class HeritageDumpApp(ttk.Frame):
    def __init__(self, master: tk.Tk) -> None:
        super().__init__(master, padding=16)
        self.master = master
        self.master.title("Heritage Dump Desktop — architecture filter v1")
        self.master.minsize(900, 730)
        self.grid(sticky="nsew")
        self.master.columnconfigure(0, weight=1)
        self.master.rowconfigure(0, weight=1)
        self.columnconfigure(0, weight=1)
        self.rowconfigure(4, weight=1)

        self.events: queue.Queue = queue.Queue()
        self.abort_event = threading.Event()
        self.worker: Optional[threading.Thread] = None

        self.registry_var = tk.StringVar(value=PRESETS[0].display_name)
        self.output_var = tk.StringVar(value=str(Path.home() / "heritage_dumps"))
        self.require_wiki_var = tk.BooleanVar(value=True)
        self.architecture_only_var = tk.BooleanVar(value=False)
        self.max_rows_var = tk.StringVar(value="0")
        self.view_workers_var = tk.StringVar(value=str(PAGEVIEW_DEFAULT_WORKERS))
        self.custom_property_var = tk.StringVar(value="")
        self.custom_label_var = tk.StringVar(value="Custom heritage database ID")
        self.custom_language_var = tk.StringVar(value="en")
        self.status_var = tk.StringVar(value="Ready")
        self.progress_label_var = tk.StringVar(value="No export running")

        self.build_ui()
        self.on_registry_changed()
        self.after(100, self.poll_events)

    # --- UI construction --------------------------------------------------

    def build_ui(self) -> None:
        source_frame = ttk.LabelFrame(self, text="1. Select heritage database", padding=12)
        source_frame.grid(row=0, column=0, sticky="ew")
        source_frame.columnconfigure(1, weight=1)

        ttk.Label(source_frame, text="Database:").grid(row=0, column=0, sticky="w", padx=(0, 8), pady=3)
        choices = [item.display_name for item in PRESETS] + [CUSTOM_DISPLAY]
        self.registry_combo = ttk.Combobox(
            source_frame,
            state="readonly",
            values=choices,
            textvariable=self.registry_var,
        )
        self.registry_combo.grid(row=0, column=1, sticky="ew", pady=3)
        self.registry_combo.bind("<<ComboboxSelected>>", lambda _event: self.on_registry_changed())

        self.registry_note = ttk.Label(source_frame, text="", foreground="#555555")
        self.registry_note.grid(row=1, column=1, sticky="w", pady=(2, 0))

        self.custom_frame = ttk.Frame(source_frame)
        self.custom_frame.grid(row=2, column=0, columnspan=2, sticky="ew", pady=(8, 0))
        self.custom_frame.columnconfigure(1, weight=1)
        self.custom_frame.columnconfigure(3, weight=1)
        ttk.Label(self.custom_frame, text="Property ID:").grid(row=0, column=0, sticky="w", padx=(0, 6))
        self.custom_property_entry = ttk.Entry(self.custom_frame, textvariable=self.custom_property_var, width=14)
        self.custom_property_entry.grid(row=0, column=1, sticky="w")
        ttk.Label(self.custom_frame, text="Label:").grid(row=0, column=2, sticky="w", padx=(14, 6))
        self.custom_label_entry = ttk.Entry(self.custom_frame, textvariable=self.custom_label_var)
        self.custom_label_entry.grid(row=0, column=3, sticky="ew")
        ttk.Label(self.custom_frame, text="Native language:").grid(row=1, column=0, sticky="w", padx=(0, 6), pady=(5, 0))
        self.custom_language_entry = ttk.Entry(self.custom_frame, textvariable=self.custom_language_var, width=14)
        self.custom_language_entry.grid(row=1, column=1, sticky="w", pady=(5, 0))
        self.custom_hint = ttk.Label(
            self.custom_frame,
            text="Use a Wikidata external-ID property such as P380.",
            foreground="#555555",
        )
        self.custom_hint.grid(row=1, column=2, columnspan=2, sticky="w", padx=(14, 0), pady=(5, 0))

        options_frame = ttk.LabelFrame(self, text="2. Output and scope", padding=12)
        options_frame.grid(row=1, column=0, sticky="ew", pady=(12, 0))
        options_frame.columnconfigure(1, weight=1)

        ttk.Label(options_frame, text="Output folder:").grid(row=0, column=0, sticky="w", padx=(0, 8), pady=3)
        ttk.Entry(options_frame, textvariable=self.output_var).grid(row=0, column=1, sticky="ew", pady=3)
        ttk.Button(options_frame, text="Browse…", command=self.choose_output_dir).grid(row=0, column=2, padx=(8, 0), pady=3)
        ttk.Button(options_frame, text="Open", command=self.open_output_dir).grid(row=0, column=3, padx=(8, 0), pady=3)

        ttk.Checkbutton(
            options_frame,
            text="Only include items with at least one explicit Wikipedia sitelink",
            variable=self.require_wiki_var,
        ).grid(row=1, column=0, columnspan=4, sticky="w", pady=(7, 2))

        # This is deliberately visible in the same scope panel as the sitelink filter.
        ttk.Checkbutton(
            options_frame,
            text="Only include entries whose direct type is an architectural structure / building",
            variable=self.architecture_only_var,
            command=self.on_scope_changed,
        ).grid(row=2, column=0, columnspan=4, sticky="w", pady=(2, 2))
        ttk.Label(
            options_frame,
            text=("Requires architectural structure (Q811979) and excludes geographic features, "
                  "mountains, and volcanoes."),
            foreground="#555555",
        ).grid(row=3, column=0, columnspan=4, sticky="w", pady=(0, 2))

        ttk.Label(options_frame, text="Test limit (0 = all):").grid(row=4, column=0, sticky="w", padx=(0, 8), pady=(4, 0))
        ttk.Entry(options_frame, textvariable=self.max_rows_var, width=14).grid(row=4, column=1, sticky="w", pady=(4, 0))
        ttk.Label(
            options_frame,
            text="A non-zero limit stops after that many discovery rows; resume with 0 for the full export.",
            foreground="#555555",
        ).grid(row=4, column=2, columnspan=2, sticky="w", padx=(8, 0), pady=(4, 0))

        ttk.Label(options_frame, text="Pageview workers (1–10):").grid(row=5, column=0, sticky="w", padx=(0, 8), pady=(4, 0))
        ttk.Entry(options_frame, textvariable=self.view_workers_var, width=14).grid(row=5, column=1, sticky="w", pady=(4, 0))
        ttk.Label(
            options_frame,
            text="Default 4. Requests are parallel across places; reduce to 1 if Wikimedia rate-limits you.",
            foreground="#555555",
        ).grid(row=5, column=2, columnspan=2, sticky="w", padx=(8, 0), pady=(4, 0))

        action_frame = ttk.LabelFrame(self, text="3. Run", padding=10)
        action_frame.grid(row=2, column=0, sticky="ew", pady=(12, 0))
        self.start_button = ttk.Button(action_frame, text="Start / Resume dump", command=self.start_export)
        self.start_button.pack(side="left")
        self.views_button = ttk.Button(
            action_frame,
            text="Fetch / Resume Wikipedia views",
            command=self.start_views,
        )
        self.views_button.pack(side="left", padx=(8, 0))
        self.abort_button = ttk.Button(action_frame, text="Abort safely", command=self.abort_export, state="disabled")
        self.abort_button.pack(side="left", padx=(8, 0))
        ttk.Button(action_frame, text="Reset selected output", command=self.reset_selected_output).pack(side="left", padx=(8, 0))
        ttk.Label(action_frame, textvariable=self.status_var).pack(side="right")

        progress_frame = ttk.LabelFrame(self, text="4. Progress", padding=12)
        progress_frame.grid(row=3, column=0, sticky="ew", pady=(12, 0))
        progress_frame.columnconfigure(0, weight=1)
        self.progressbar = ttk.Progressbar(progress_frame, mode="determinate", maximum=1, value=0)
        self.progressbar.grid(row=0, column=0, sticky="ew")
        ttk.Label(progress_frame, textvariable=self.progress_label_var).grid(row=1, column=0, sticky="w", pady=(6, 0))

        log_frame = ttk.LabelFrame(self, text="Activity log", padding=8)
        log_frame.grid(row=4, column=0, sticky="nsew", pady=(12, 0))
        log_frame.rowconfigure(0, weight=1)
        log_frame.columnconfigure(0, weight=1)
        self.log_text = tk.Text(log_frame, wrap="word", height=16, state="disabled")
        self.log_text.grid(row=0, column=0, sticky="nsew")
        scroll = ttk.Scrollbar(log_frame, orient="vertical", command=self.log_text.yview)
        scroll.grid(row=0, column=1, sticky="ns")
        self.log_text.configure(yscrollcommand=scroll.set)

        footer = ttk.Label(
            self,
            text=(
                "Dump: country-scoped heritage designations, images, JSONL. Views: resumable native-language + English totals. "
                "Official registry IDs are optional URLs only; built-only mode uses direct P31 → subclass of architectural structure."
            ),
            foreground="#555555",
        )
        footer.grid(row=5, column=0, sticky="w", pady=(8, 0))

    # --- UI helpers -------------------------------------------------------

    def append_log(self, message: str) -> None:
        stamp = datetime.now().strftime("%H:%M:%S")
        self.log_text.configure(state="normal")
        self.log_text.insert("end", f"[{stamp}] {message}\n")
        self.log_text.see("end")
        self.log_text.configure(state="disabled")

    def on_registry_changed(self) -> None:
        is_custom = self.registry_var.get() == CUSTOM_DISPLAY
        state = "normal" if is_custom else "disabled"
        for widget in (self.custom_property_entry, self.custom_label_entry, self.custom_language_entry):
            widget.configure(state=state)

        if is_custom:
            self.registry_note.configure(text="Choose a Wikidata external-ID property and the registry's local language.")
        else:
            preset = next(item for item in PRESETS if item.display_name == self.registry_var.get())
            folder = slug_with_architecture_filter(preset.slug, self.architecture_only_var.get())
            discovery_note = (
                f"Discovery: heritage designation P1435 for {preset.designation_scope_label}; "
                f"{preset.property_id} is optional and used only for official record URLs. "
                if (preset.discovery_designation_qids or preset.designation_country_qids) else
                f"Property {preset.property_id}; "
            )
            self.registry_note.configure(
                text=(
                    f"{discovery_note}native language: {preset.native_language_label}. "
                    f"Exports are stored in a '{folder}' subfolder."
                )
            )

    def selected_registry(self) -> RegistryDefinition:
        if self.registry_var.get() != CUSTOM_DISPLAY:
            return next(item for item in PRESETS if item.display_name == self.registry_var.get())

        property_id = self.custom_property_var.get().strip().upper()
        native_language = self.custom_language_var.get().strip().lower()
        label = self.custom_label_var.get().strip()
        if not PROPERTY_RE.fullmatch(property_id):
            raise ValueError("Custom property ID must look like P380 or P1216.")
        if not re.fullmatch(r"[a-z]{2,3}(?:-[a-z0-9]+)?", native_language):
            raise ValueError("Native language must be a code such as fr, en, ja, it, or nl.")
        if not label:
            raise ValueError("Enter a label for the custom database.")
        slug = re.sub(r"[^a-z0-9]+", "_", f"custom_{property_id}_{label}".lower()).strip("_")
        return RegistryDefinition(
            CUSTOM_DISPLAY,
            slug,
            property_id,
            label,
            native_language,
            native_language,
            "",
        )

    def selected_output_dir(self) -> Path:
        value = self.output_var.get().strip()
        if not value:
            raise ValueError("Choose an output folder.")
        return Path(value).expanduser()

    def choose_output_dir(self) -> None:
        selected = filedialog.askdirectory(initialdir=self.output_var.get() or str(Path.home()))
        if selected:
            self.output_var.set(selected)

    def current_registry_dir(self) -> Path:
        registry = self.selected_registry()
        return self.selected_output_dir() / slug_with_architecture_filter(
            registry.slug, self.architecture_only_var.get()
        )

    def on_scope_changed(self) -> None:
        # This makes the destination distinction visible before a run starts.
        try:
            folder = self.current_registry_dir().name
            self.registry_note.configure(text=self.registry_note.cget("text").split(" Exports are stored")[0] + f" Exports are stored in a '{folder}' subfolder.")
        except Exception:
            pass

    def open_output_dir(self) -> None:
        try:
            directory = self.current_registry_dir()
            directory.mkdir(parents=True, exist_ok=True)
            if sys.platform.startswith("win"):
                os.startfile(str(directory))  # type: ignore[attr-defined]
            elif sys.platform == "darwin":
                subprocess.run(["open", str(directory)], check=False)
            else:
                subprocess.run(["xdg-open", str(directory)], check=False)
        except Exception as exc:
            messagebox.showerror("Cannot open folder", str(exc))

    # --- control actions --------------------------------------------------

    def start_export(self) -> None:
        if self.worker and self.worker.is_alive():
            return
        try:
            registry = self.selected_registry()
            output_dir = self.selected_output_dir()
            max_rows = int(self.max_rows_var.get().strip() or "0")
            if max_rows < 0:
                raise ValueError("Test limit cannot be negative.")
        except (ValueError, OSError) as exc:
            messagebox.showerror("Invalid settings", str(exc))
            return

        self.abort_event.clear()
        self.start_button.configure(state="disabled")
        self.views_button.configure(state="disabled")
        self.abort_button.configure(state="normal")
        self.status_var.set("Running")
        self.progress_label_var.set("Starting…")
        self.append_log(f"Starting {registry.display_name} export.")

        exporter = HeritageExporter(
            registry=registry,
            root_output_dir=output_dir,
            require_wikipedia=self.require_wiki_var.get(),
            architecture_only=self.architecture_only_var.get(),
            max_identifier_rows=max_rows,
            abort_event=self.abort_event,
            events=self.events,
        )
        self.worker = threading.Thread(target=exporter.run, name="heritage-export", daemon=True)
        self.worker.start()

    def start_views(self) -> None:
        if self.worker and self.worker.is_alive():
            return
        try:
            registry = self.selected_registry()
            output_dir = self.selected_output_dir()
            view_workers = int(self.view_workers_var.get().strip() or str(PAGEVIEW_DEFAULT_WORKERS))
            if not 1 <= view_workers <= PAGEVIEW_MAX_WORKERS:
                raise ValueError(f"Pageview workers must be from 1 to {PAGEVIEW_MAX_WORKERS}.")
            expected = output_dir / slug_with_architecture_filter(registry.slug, self.architecture_only_var.get()) / "heritage_places.csv"
            if not expected.exists():
                raise ValueError(
                    "No completed heritage_places.csv exists for the selected database and filters. "
                    "Run Start / Resume dump first.\n\nExpected:\n" + str(expected)
                )
        except (ValueError, OSError) as exc:
            messagebox.showerror("Cannot fetch view counts", str(exc))
            return

        self.abort_event.clear()
        self.start_button.configure(state="disabled")
        self.views_button.configure(state="disabled")
        self.abort_button.configure(state="normal")
        self.status_var.set("Fetching Wikipedia views")
        self.progress_label_var.set("Starting pageview collector…")
        self.append_log(f"Starting Wikipedia pageview collector for {registry.display_name}.")

        collector = WikiViewCollector(
            registry=registry,
            root_output_dir=output_dir,
            architecture_only=self.architecture_only_var.get(),
            abort_event=self.abort_event,
            events=self.events,
            view_workers=view_workers,
        )
        self.worker = threading.Thread(target=collector.run, name="wikipedia-view-collector", daemon=True)
        self.worker.start()

    def abort_export(self) -> None:
        if self.worker and self.worker.is_alive():
            self.abort_event.set()
            self.abort_button.configure(state="disabled")
            self.status_var.set("Stopping safely…")
            self.append_log("Abort requested. Waiting for the current network request or batch to finish.")

    def reset_selected_output(self) -> None:
        if self.worker and self.worker.is_alive():
            messagebox.showwarning("Export is running", "Abort the export before resetting its output.")
            return
        try:
            directory = self.current_registry_dir()
        except Exception as exc:
            messagebox.showerror("Invalid settings", str(exc))
            return

        if not directory.exists():
            messagebox.showinfo("Nothing to reset", f"No output exists yet:\n{directory}")
            return
        if not messagebox.askyesno(
            "Reset selected output",
            f"Delete all generated files for this database?\n\n{directory}\n\nThis cannot be undone.",
        ):
            return
        try:
            shutil.rmtree(directory)
            self.append_log(f"Deleted {directory}")
            self.status_var.set("Selected output reset")
            self.progressbar.stop()
            self.progressbar.configure(mode="determinate", maximum=1, value=0)
            self.progress_label_var.set("No export running")
        except Exception as exc:
            messagebox.showerror("Reset failed", str(exc))

    # --- worker event loop ------------------------------------------------

    def poll_events(self) -> None:
        while True:
            try:
                event = self.events.get_nowait()
            except queue.Empty:
                break
            kind = event.get("kind")
            if kind == "log":
                self.append_log(event["message"])
            elif kind == "stage":
                if event.get("indeterminate"):
                    self.progressbar.configure(mode="indeterminate")
                    self.progressbar.start(10)
                else:
                    self.progressbar.stop()
                    self.progressbar.configure(mode="determinate")
                self.progress_label_var.set(event.get("text", ""))
            elif kind == "progress":
                total = event.get("total")
                current = event.get("current", 0)
                label = event.get("label", "")
                if total:
                    self.progressbar.stop()
                    self.progressbar.configure(mode="determinate", maximum=total, value=current)
                else:
                    if str(self.progressbar.cget("mode")) != "indeterminate":
                        self.progressbar.configure(mode="indeterminate")
                        self.progressbar.start(10)
                self.progress_label_var.set(label)
            elif kind == "done":
                self.progressbar.stop()
                self.start_button.configure(state="normal")
                self.views_button.configure(state="normal")
                self.abort_button.configure(state="disabled")
                status = event.get("status", "complete")
                if status == "complete":
                    self.status_var.set("Complete")
                    self.progress_label_var.set(f"Complete — {event.get('output_dir', '')}")
                    self.append_log("Export complete.")
                elif status == "aborted":
                    self.status_var.set("Stopped safely")
                    self.progress_label_var.set("Stopped safely; click Start / Resume dump to continue")
                elif status == "views_complete":
                    self.status_var.set("Wikipedia views complete")
                    self.progress_label_var.set(f"Views complete — {event.get('output_dir', '')}")
                    self.append_log("Wikipedia view collection complete.")
                elif status == "views_aborted":
                    self.status_var.set("View collection stopped safely")
                    self.progress_label_var.set("Stopped safely; click Fetch / Resume Wikipedia views to continue")
                else:
                    self.status_var.set("Partial test export")
                    self.progress_label_var.set("Partial test export; set limit to 0 and resume for all rows")
            elif kind == "error":
                self.progressbar.stop()
                self.start_button.configure(state="normal")
                self.views_button.configure(state="normal")
                self.abort_button.configure(state="disabled")
                self.status_var.set("Error")
                self.progress_label_var.set("Error — see log")
                messagebox.showerror("Export error", event.get("message", "Unknown error"))
        self.after(100, self.poll_events)


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------


def main() -> None:
    root = tk.Tk()
    # Prefer native themed widgets; avoid forcing a theme that may not exist.
    HeritageDumpApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
