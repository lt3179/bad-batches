"""
Deterministic (non-AI) helpers for turning free-text distribution info
into structured state lists, and for grouping states into a secondary
Census-region view.

Nothing here calls a model. It's plain string/regex matching against a
fixed lookup table, on purpose, so the pipeline stays fully rule-based.
"""

import re

STATE_NAME_TO_ABBR = {
    "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR",
    "california": "CA", "colorado": "CO", "connecticut": "CT",
    "delaware": "DE", "florida": "FL", "georgia": "GA", "hawaii": "HI",
    "idaho": "ID", "illinois": "IL", "indiana": "IN", "iowa": "IA",
    "kansas": "KS", "kentucky": "KY", "louisiana": "LA", "maine": "ME",
    "maryland": "MD", "massachusetts": "MA", "michigan": "MI",
    "minnesota": "MN", "mississippi": "MS", "missouri": "MO",
    "montana": "MT", "nebraska": "NE", "nevada": "NV",
    "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM",
    "new york": "NY", "north carolina": "NC", "north dakota": "ND",
    "ohio": "OH", "oklahoma": "OK", "oregon": "OR", "pennsylvania": "PA",
    "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
    "tennessee": "TN", "texas": "TX", "utah": "UT", "vermont": "VT",
    "virginia": "VA", "washington": "WA", "west virginia": "WV",
    "wisconsin": "WI", "wyoming": "WY",
    "district of columbia": "DC", "washington dc": "DC", "washington d.c.": "DC",
}

ALL_ABBRS = set(STATE_NAME_TO_ABBR.values())

# Sort full names longest-first so "new hampshire" matches before "new" false
# positives, and so multi-word names aren't cut short by a shorter substring.
_NAME_PATTERNS = sorted(STATE_NAME_TO_ABBR.keys(), key=len, reverse=True)

# Matches a standalone two-letter state abbreviation, e.g. "CA" or "TX",
# but not inside a longer word (word boundaries on both sides).
_ABBR_RE = re.compile(r"\b([A-Z]{2})\b")

_NATIONWIDE_RE = re.compile(r"\bnationwide\b", re.IGNORECASE)


def parse_distribution_text(text):
    """
    Deterministically extract a list of US state abbreviations from a
    free-text distribution string (FDA's `distribution_pattern` field).

    Returns a dict:
      {
        "states": [...],          # sorted list of 2-letter codes found
        "nationwide": bool,       # True if the text says "nationwide"
        "parsed": bool,           # False if nothing could be extracted
      }

    This is regex/lookup-table matching only. No inference, no AI.
    """
    if not text:
        return {"states": [], "nationwide": False, "parsed": False}

    lowered = text.lower()
    found = set()

    if _NATIONWIDE_RE.search(lowered):
        return {"states": sorted(ALL_ABBRS), "nationwide": True, "parsed": True}

    # 1. Match full state names (case-insensitive).
    for name in _NAME_PATTERNS:
        if re.search(r"\b" + re.escape(name) + r"\b", lowered):
            found.add(STATE_NAME_TO_ABBR[name])

    # 2. Match standalone two-letter abbreviations against the known set,
    #    checked on the original (not lowercased) text to avoid false
    #    positives from ordinary lowercase words.
    for match in _ABBR_RE.findall(text):
        if match in ALL_ABBRS:
            found.add(match)

    return {
        "states": sorted(found),
        "nationwide": False,
        "parsed": len(found) > 0,
    }


# Secondary/optional browsing view only, per the project spec. Not used to
# determine which states share a batch, that comes from each recall's own
# reported distribution list.
CENSUS_REGION = {
    "CT": "Northeast", "ME": "Northeast", "MA": "Northeast", "NH": "Northeast",
    "RI": "Northeast", "VT": "Northeast", "NJ": "Northeast", "NY": "Northeast",
    "PA": "Northeast",
    "IL": "Midwest", "IN": "Midwest", "MI": "Midwest", "OH": "Midwest",
    "WI": "Midwest", "IA": "Midwest", "KS": "Midwest", "MN": "Midwest",
    "MO": "Midwest", "NE": "Midwest", "ND": "Midwest", "SD": "Midwest",
    "DE": "South", "FL": "South", "GA": "South", "MD": "South",
    "NC": "South", "SC": "South", "VA": "South", "DC": "South",
    "WV": "South", "AL": "South", "KY": "South", "MS": "South",
    "TN": "South", "AR": "South", "LA": "South", "OK": "South",
    "TX": "South",
    "AZ": "West", "CO": "West", "ID": "West", "MT": "West", "NV": "West",
    "NM": "West", "UT": "West", "WY": "West", "AK": "West", "CA": "West",
    "HI": "West", "OR": "West", "WA": "West",
}
