"""Load and validate the candidate variable catalog."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

CATALOG_PATH = Path(__file__).with_name("catalog.json")
THEMES = {"air", "heat", "water", "land-agriculture", "noise"}
CANDIDATE_FIELDS = {"id", "status", "checked", "theme", "label", "plainDefinition", "source", "collection",
                    "version", "variable", "units", "nativeResolution", "recordStart", "access", "caveats"}
UNAVAILABLE_FIELDS = {"id", "status", "theme", "label", "plainDefinition", "unavailableReason"}


class CatalogError(ValueError):
    pass


def load_catalog(path: Path = CATALOG_PATH) -> list[dict[str, Any]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    variables = data.get("variables")
    if not isinstance(variables, list) or not variables:
        raise CatalogError("catalog must contain a non-empty 'variables' list")
    seen = set()
    for entry in variables:
        status = entry.get("status")
        required = {"candidate": CANDIDATE_FIELDS, "unavailable": UNAVAILABLE_FIELDS}.get(status)
        if required is None:
            raise CatalogError(f"{entry.get('id')}: unknown status {status!r}")
        missing = required - entry.keys()
        extra = entry.keys() - required
        if missing or extra:
            raise CatalogError(f"{entry.get('id')}: missing {sorted(missing)}, unexpected {sorted(extra)}")
        if entry["theme"] not in THEMES:
            raise CatalogError(f"{entry['id']}: unknown theme {entry['theme']!r}")
        if entry["id"] in seen:
            raise CatalogError(f"duplicate id {entry['id']!r}")
        seen.add(entry["id"])
        if status == "unavailable" and not entry["unavailableReason"].strip():
            raise CatalogError(f"{entry['id']}: unavailable entries need a reason")
    return variables


def find(variable_id: str) -> dict[str, Any]:
    for entry in load_catalog():
        if entry["id"] == variable_id:
            return entry
    raise CatalogError(f"unknown variable {variable_id!r}")
