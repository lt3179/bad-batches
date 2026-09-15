# Bad Batches

A map of the US where you click your state and see current food recalls
affecting it, pulled directly from the FDA and USDA/FSIS's own APIs. No
AI or LLM is used anywhere in the data pipeline: extraction is done with
direct field mapping from official structured JSON, plus a fixed regex
and lookup-table parser for the one field (FDA's `distribution_pattern`)
that comes back as free text.

## How it works

1. `scripts/fetch_recalls.py` pulls from:
   - `https://api.fda.gov/food/enforcement.json` (openFDA, free, no key)
   - `https://www.fsis.usda.gov/fsis/api/recall/v/1` (USDA/FSIS, free, no key)
2. Both sources are normalized into one schema and written to
   `data/recalls.json`.
3. A GitHub Action (`.github/workflows/update-recalls.yml`) runs that
   script once a day and commits the updated file.
4. `index.html` / `app.js` / `style.css` are a static frontend (Leaflet
   map) that reads `data/recalls.json` directly. No backend, no database.

Region grouping is intentionally not a fixed map layer. Real food
distribution doesn't follow static geographic regions, so the "which
other states got this batch" view is built per-recall from each recall's
own reported distribution list. A Census 4-region overlay is available
as a secondary browsing toggle only.

## Local development

```bash
python3 scripts/fetch_recalls.py   # writes data/recalls.json
python3 -m http.server 8000        # serve the static site locally
```

Then open `http://localhost:8000`.

To debug what fields an agency is actually returning (useful if a
mapping breaks), run:

```bash
RECALL_DEBUG=1 python3 scripts/fetch_recalls.py
```

## Known gaps / things to verify on first live run

- **FSIS field names are not yet confirmed against a live response.**
  The FSIS Recall API's documentation page doesn't publish an exact
  field dictionary, so `scripts/fetch_recalls.py::normalize_fsis()`
  checks several plausible field names per attribute
  (`field_states`/`states`, `field_recall_date`/`recall_date`, etc).
  Run with `RECALL_DEBUG=1` once against the live API and check the
  printed keys against the `_first_present(...)` candidate lists in
  `normalize_fsis()`, tightening them if needed.
- **CDC outbreak data is not included.** There's no clean structured
  API for it, only narrative outbreak pages, which would require
  scraping. Left out for now rather than compromise on the no-scraping
  goal.
- **FDA distribution parsing is best-effort.** Records where
  `distribution_pattern` doesn't match a known state name/abbreviation
  pattern are flagged `distribution_parsed: false` rather than guessed
  at. Check the modal's "distribution not confirmed" fallback for how
  those surface in the UI.
- **Severity color blending for overlapping recalls** currently shows
  the single most severe classification per state. The plan is to
  workshop a clearer way to show "multiple recalls, mixed severity" per
  state once real data is flowing.

## Deploying

1. Push this repo to a new GitHub repository.
2. In the repo's Settings, go to Pages, and set the source to the `main`
   branch, root folder.
3. In the repo's Settings, go to Actions, General, and make sure
   "Read and write permissions" is enabled for the `GITHUB_TOKEN` (needed
   for the daily Action to commit updated data).
4. Trigger the "Update recall data" workflow manually once from the
   Actions tab (`workflow_dispatch`) to populate real data instead of
   the empty placeholder in `data/recalls.json`.
