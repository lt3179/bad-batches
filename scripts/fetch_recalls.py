"""
Pull recall data from the official FDA (openFDA) and USDA/FSIS APIs,
normalize both into one schema, and write data/recalls.json.

Design constraints (see project spec):
  - No AI/LLM anywhere in this pipeline. Every transformation below is a
    fixed rule: a direct field mapping, a regex, or a lookup table.
  - No scraping. Both sources are official, structured, keyless JSON APIs.

Run: python scripts/fetch_recalls.py
Env vars:
  RECALL_LOOKBACK_YEARS  how far back to pull (default 3)
  RECALL_DEBUG           if set, prints the raw keys of the first record
                          from each source, useful for fixing field
                          mappings if an agency changes its schema.
"""

import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import date, timedelta

from state_utils import parse_distribution_text, STATE_NAME_TO_ABBR, ALL_ABBRS

FDA_BASE = "https://api.fda.gov/food/enforcement.json"
FSIS_BASE = "https://www.fsis.usda.gov/fsis/api/recall/v/1"

LOOKBACK_YEARS = int(os.environ.get("RECALL_LOOKBACK_YEARS", "3"))
DEBUG = bool(os.environ.get("RECALL_DEBUG"))

OUTPUT_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "data", "recalls.json",
)


def _get_json(url, retries=3, pause=2):
    """Plain HTTP GET + JSON parse, with light retry. No AI involved."""
    last_err = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "recall-map/1.0"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as e:  # network hiccups, rate limiting, etc.
            last_err = e
            time.sleep(pause)
    raise RuntimeError(f"Failed to fetch {url}: {last_err}")


def _first_present(d, keys, default=None):
    """Return the first non-empty value found among candidate field names."""
    for k in keys:
        if k in d and d[k] not in (None, "", []):
            return d[k]
    return default


# ---------------------------------------------------------------------------
# FDA (openFDA food enforcement)
# ---------------------------------------------------------------------------

def fetch_fda():
    start = (date.today() - timedelta(days=365 * LOOKBACK_YEARS)).strftime("%Y%m%d")
    end = date.today().strftime("%Y%m%d")
    date_filter = f"recall_initiation_date:[{start}+TO+{end}]"

    records = []
    skip = 0
    limit = 1000
    total = None

    while True:
        query = {
            "search": date_filter,
            "limit": str(limit),
            "skip": str(skip),
        }
        url = FDA_BASE + "?" + urllib.parse.urlencode(query, safe="+[]:")
        payload = _get_json(url)
        batch = payload.get("results", [])
        if total is None:
            total = payload.get("meta", {}).get("results", {}).get("total", len(batch))
            if DEBUG and batch:
                print("[DEBUG] FDA first record keys:", sorted(batch[0].keys()), file=sys.stderr)

        records.extend(batch)
        skip += limit

        # openFDA caps `skip` at 25000 regardless of limit.
        if len(batch) < limit or skip >= 25000 or skip >= (total or 0):
            break

    return [normalize_fda(r) for r in records]


def normalize_fda(r):
    dist_text = r.get("distribution_pattern", "")
    parsed = parse_distribution_text(dist_text)

    return {
        "id": f"FDA-{r.get('recall_number', r.get('event_id', ''))}",
        "source": "FDA",
        "title": r.get("product_description", "").strip(),
        "firm": r.get("recalling_firm", "").strip(),
        "reason": r.get("reason_for_recall", "").strip(),
        "classification": r.get("classification", "").strip(),  # "Class I/II/III"
        "status": r.get("status", "").strip(),
        "recall_date": r.get("recall_initiation_date", ""),  # YYYYMMDD
        "report_date": r.get("report_date", ""),
        "states": parsed["states"],
        "nationwide": parsed["nationwide"],
        "distribution_parsed": parsed["parsed"],
        "raw_distribution_text": dist_text,
        "url": None,  # openFDA enforcement records don't include a direct URL
    }


# ---------------------------------------------------------------------------
# USDA / FSIS
# ---------------------------------------------------------------------------

def fetch_fsis():
    payload = _get_json(FSIS_BASE)

    # The FSIS endpoint has been observed to return either a bare list or a
    # dict wrapping the list, so handle both defensively.
    if isinstance(payload, list):
        records = payload
    elif isinstance(payload, dict):
        records = _first_present(payload, ["results", "data", "recalls"], default=[])
    else:
        records = []

    if DEBUG and records:
        print("[DEBUG] FSIS first record keys:", sorted(records[0].keys()), file=sys.stderr)

    return [normalize_fsis(r) for r in records]


def normalize_fsis(r):
    # FSIS field names aren't fully confirmed against a live response yet
    # (see README "Known gaps"), so this checks several plausible candidate
    # names per attribute. RECALL_DEBUG=1 prints the real keys on first run
    # so this list can be tightened.
    title = _first_present(r, ["field_title", "title", "field_summary"], default="")
    firm = _first_present(r, ["field_establishment", "field_company", "establishment"], default="")
    reason = _first_present(r, ["field_recall_reason", "field_product_items", "reason"], default="")
    classification = _first_present(r, ["field_recall_classification", "field_risk_level", "classification"], default="")
    status = _first_present(r, ["field_recall_type", "field_active_notice", "status"], default="")
    recall_date = _first_present(r, ["field_recall_date", "field_last_modified_date", "recall_date"], default="")
    recall_number = _first_present(r, ["field_recall_number", "recall_number", "nid"], default="")
    url = _first_present(r, ["field_recall_url", "url", "path"], default=None)

    states_raw = _first_present(r, ["field_states", "field_states_array", "states"], default=[])
    if isinstance(states_raw, str):
        raw_list = [s.strip() for s in states_raw.split(",") if s.strip()]
    elif isinstance(states_raw, list):
        raw_list = [str(s).strip() for s in states_raw if str(s).strip()]
    else:
        raw_list = []

    # FSIS has been seen to return either 2-letter codes or full names
    # depending on the field, so normalize both through the same lookup
    # table used for the FDA free-text parser.
    states = sorted({
        s.upper() if s.upper() in ALL_ABBRS else STATE_NAME_TO_ABBR.get(s.lower(), s.upper())
        for s in raw_list
    })

    nationwide = any(s in ("NATIONWIDE", "US", "USA") for s in states) or "nationwide" in str(title).lower()

    return {
        "id": f"FSIS-{recall_number}",
        "source": "FSIS",
        "title": str(title).strip(),
        "firm": str(firm).strip(),
        "reason": str(reason).strip(),
        "classification": str(classification).strip(),
        "status": str(status).strip(),
        "recall_date": recall_date,
        "report_date": recall_date,
        "states": [] if nationwide else states,
        "nationwide": nationwide,
        "distribution_parsed": bool(states) or nationwide,
        "raw_distribution_text": states_raw if isinstance(states_raw, str) else ", ".join(states),
        "url": url,
    }


# ---------------------------------------------------------------------------

def main():
    print(f"Fetching FDA food enforcement records (last {LOOKBACK_YEARS} years)...")
    fda_records = fetch_fda()
    print(f"  {len(fda_records)} FDA records.")

    print("Fetching FSIS recall records...")
    try:
        fsis_records = fetch_fsis()
        print(f"  {len(fsis_records)} FSIS records.")
    except Exception as e:
        # Don't let one source's outage take down the whole pipeline.
        print(f"  FSIS fetch failed, continuing with FDA data only: {e}", file=sys.stderr)
        fsis_records = []

    all_records = fda_records + fsis_records
    all_records.sort(key=lambda r: r.get("recall_date") or "", reverse=True)

    output = {
        "generated_at": date.today().isoformat(),
        "lookback_years": LOOKBACK_YEARS,
        "count": len(all_records),
        "sources": {
            "fda": len(fda_records),
            "fsis": len(fsis_records),
        },
        "recalls": all_records,
    }

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(output, f, indent=2)

    print(f"Wrote {len(all_records)} records to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
