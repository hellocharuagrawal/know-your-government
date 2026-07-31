# /data

This folder holds the output of the scheduled scraper (`scripts/scrape.js`,
run automatically by `.github/workflows/scrape.yml`).

Files that will appear here once the workflow has run at least once:
- `lok-sabha-members.json` — all Lok Sabha members, fetched from india.gov.in
- `council-of-ministers.json` — the Union Council of Ministers
- `last-run.json` — timestamp and summary of the most recent scrape, including
  any errors, so it's easy to tell if a source has changed shape or gone down

Every scheduled run either updates these files (and commits the change, so
you get a full git history of every data change over time) or leaves them
untouched if nothing changed upstream.

## Note on first run

These files don't exist yet in a fresh clone of this repo — they're generated
the first time the GitHub Action runs (either on its daily schedule, or
triggered manually from the Actions tab in GitHub → this workflow → "Run workflow").
