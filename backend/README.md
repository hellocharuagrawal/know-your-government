# Backend: Know Your Government API proxy

A small Cloudflare Worker that fetches live data from india.gov.in server-side
(where the browser's CORS restriction doesn't apply), caches it, and serves it
to the frontend with proper CORS headers.

## Why this exists

The frontend can't call india.gov.in's API directly from a browser — their
server doesn't send the permission header browsers require for cross-origin
requests. This Worker sits in between: it's a server, not a browser page, so
CORS doesn't apply to *its* request to india.gov.in. It then serves the data
back to your frontend with CORS headers *you* control.

## One-time setup

1. **Create a free Cloudflare account** at https://dash.cloudflare.com/sign-up
   if you don't have one already.

2. **Install the Wrangler CLI** (Cloudflare's deployment tool). You'll need
   Node.js installed first (https://nodejs.org, LTS version). Then run:
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

1. Trigger the first data fetch manually (the scheduled cron won't have run yet):
   ```
   curl https://know-your-government-api.YOUR-SUBDOMAIN.workers.dev/api/refresh
   ```
   This should return JSON showing how many Lok Sabha members and ministers
   were fetched, or an error message if something went wrong.

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

- The Worker refreshes its cache automatically once a day (see the `crons`
  line in `wrangler.toml` — currently 3am UTC). Adjust as needed.
- If india.gov.in changes their API shape, the fetch functions in
  `src/index.js` will need updating to match.
- Free tier covers 100,000 requests/day, which is far more than this app
  will need.
