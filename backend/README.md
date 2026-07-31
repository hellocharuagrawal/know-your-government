# Backend: Know Your Government API cache

A small Cloudflare Worker that serves government data fast, with proper CORS
headers, so the frontend can call it freely from a browser.

## How this fits with the rest of the project

There's now exactly **one place** that talks to india.gov.in directly:
`scripts/scrape.js`, run daily by GitHub Actions, which fetches the data and
commits it as JSON into `/data`. This Worker doesn't call india.gov.in at
all anymore — it just reads those already-clean JSON files from GitHub
(via GitHub's raw file URLs, which are public and CORS-friendly) and caches
them, so the frontend gets fast responses instead of hitting GitHub directly
on every load.

```
india.gov.in  --(daily, server-to-server)-->  GitHub Actions  --(commits)-->  /data/*.json
                                                                                    |
                                                                     (Worker reads this)
                                                                                    v
                                                            Cloudflare Worker (this folder)
                                                                                    |
                                                                    (fast, CORS-friendly)
                                                                                    v
                                                                    frontend/index.html
```

## One-time setup

1. **Create a free Cloudflare account** at https://dash.cloudflare.com/sign-up
   if you don't have one already.

2. **Install the Wrangler CLI.** You'll need Node.js installed first
   (https://nodejs.org, LTS version). Then run:
   ```
   npm install -g wrangler
   ```

3. **Log in to Cloudflare from the CLI:**
   ```
   wrangler login
   ```
   This opens a browser window to authorize.

4. **Create the KV namespace** (this is the cache storage):
   ```
   wrangler kv namespace create GOVT_DATA
   ```
   This prints an `id` — copy it.

5. **Update `wrangler.toml`** in this folder — replace
   `REPLACE_WITH_YOUR_KV_NAMESPACE_ID` with the id you just copied.

## Deploy

From this `backend/` folder, run:
```
wrangler deploy
```

Wrangler will print your live URL, something like:
```
https://know-your-government-api.YOUR-SUBDOMAIN.workers.dev
```

## Test it

1. Trigger the first cache fill manually (the scheduled cron won't have run yet):
   ```
   curl https://know-your-government-api.YOUR-SUBDOMAIN.workers.dev/api/refresh
   ```
   This pulls whatever's currently in the repo's `/data` folder and caches it.
   It should return JSON showing how many Lok Sabha members and ministers
   were loaded, or an error if the data files don't exist yet (run the
   scraper first, via the GitHub Actions tab, if so).

2. Then check the actual data:
   ```
   curl https://know-your-government-api.YOUR-SUBDOMAIN.workers.dev/api/lok-sabha-members
   ```

## Connecting the frontend

In `frontend/index.html`, replace the direct `fetch()` calls to
`www.india.gov.in` with calls to your Worker's URL instead — for example:
```js
fetch("https://know-your-government-api.YOUR-SUBDOMAIN.workers.dev/api/lok-sabha-members")
```
Since this is now same-purpose infrastructure you control, there's no CORS
issue calling it from your frontend.

## Ongoing maintenance

- The scraper (GitHub Actions) refreshes the source data once a day at 3am UTC.
- This Worker refreshes its own cache once a day at 4am UTC, an hour later,
  so it always picks up that day's fresh scrape rather than racing it.
- If india.gov.in changes their API shape, only `scripts/scrape.js` needs
  updating — this Worker doesn't know or care what upstream source the
  JSON came from.
- Free tier covers 100,000 requests/day, far more than this app will need.
