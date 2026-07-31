// Know Your Government — backend proxy Worker
//
// Role: this Worker is now a thin, fast cache in front of data that
// scripts/scrape.js (run daily via GitHub Actions) already fetched from
// india.gov.in and committed into /data as clean JSON. Only one place —
// the scraper — talks to india.gov.in directly. This Worker just re-serves
// that data quickly, with CORS headers, so the frontend has a fast endpoint
// to call instead of hitting GitHub's raw file URLs directly each time.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*", // tighten this to your actual frontend domain once deployed
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

const GITHUB_RAW_BASE =
  "https://raw.githubusercontent.com/hellocharuagrawal/know-your-government/main/data";

async function fetchFromGitHub(filename) {
  const res = await fetch(`${GITHUB_RAW_BASE}/${filename}`);
  if (!res.ok) throw new Error(`GitHub raw fetch failed for ${filename}: ${res.status}`);
  return res.json();
}

async function refreshCache(env) {
  const results = { refreshedAt: new Date().toISOString(), errors: [] };

  try {
    const chiefs = await fetchFromGitHub("chiefs.json");
    await env.GOVT_DATA.put("chiefs", JSON.stringify(chiefs));
    results.chiefsCount = chiefs.length;
  } catch (e) {
    results.errors.push(`Chiefs fetch failed: ${e.message}`);
  }

  try {
    const members = await fetchFromGitHub("lok-sabha-members.json");
    await env.GOVT_DATA.put("lok-sabha-members", JSON.stringify(members));
    results.lokSabhaCount = members.length;
  } catch (e) {
    results.errors.push(`Lok Sabha fetch failed: ${e.message}`);
  }

  try {
    const ministers = await fetchFromGitHub("council-of-ministers.json");
    await env.GOVT_DATA.put("council-of-ministers", JSON.stringify(ministers));
    results.ministersCount = ministers.length;
  } catch (e) {
    results.errors.push(`Ministers fetch failed: ${e.message}`);
  }

  await env.GOVT_DATA.put("last-refresh-meta", JSON.stringify(results));
  return results;
}

async function respondWithCached(env, key) {
  const cached = await env.GOVT_DATA.get(key);
  if (!cached) {
    return new Response(
      JSON.stringify({ error: "No cached data yet. Try GET /api/refresh first." }),
      { status: 404, headers: { "content-type": "application/json", ...CORS_HEADERS } }
    );
  }
  return new Response(cached, {
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (url.pathname === "/api/lok-sabha-members") {
      return respondWithCached(env, "lok-sabha-members");
    }

    if (url.pathname === "/api/chiefs") {
      return respondWithCached(env, "chiefs");
    }

    if (url.pathname === "/api/council-of-ministers") {
      return respondWithCached(env, "council-of-ministers");
    }

    if (url.pathname === "/api/refresh") {
      const result = await refreshCache(env);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { "content-type": "application/json", ...CORS_HEADERS },
      });
    }

    if (url.pathname === "/api/image") {
      const imageUrl = url.searchParams.get("url");
      if (!imageUrl) {
        return new Response("Missing url parameter", { status: 400, headers: CORS_HEADERS });
      }
      // Safety allowlist: only proxy images from known government photo hosts,
      // so this endpoint can't be used to fetch arbitrary URLs.
      const ALLOWED_IMAGE_HOSTS = ["sansad.in", "static.india.gov.in", "static2.india.gov.in"];
      let parsedUrl;
      try {
        parsedUrl = new URL(imageUrl);
      } catch {
        return new Response("Invalid url parameter", { status: 400, headers: CORS_HEADERS });
      }
      if (!ALLOWED_IMAGE_HOSTS.includes(parsedUrl.hostname)) {
        return new Response("Host not allowed", { status: 403, headers: CORS_HEADERS });
      }
      try {
        const imageRes = await fetch(imageUrl);
        if (!imageRes.ok) {
          return new Response("Upstream image fetch failed", { status: 502, headers: CORS_HEADERS });
        }
        const contentType = imageRes.headers.get("content-type") || "image/jpeg";
        return new Response(imageRes.body, {
          headers: {
            "content-type": contentType,
            "cache-control": "public, max-age=86400",
            ...CORS_HEADERS,
          },
        });
      } catch (e) {
        return new Response(`Image proxy error: ${e.message}`, { status: 500, headers: CORS_HEADERS });
      }
    }

    if (url.pathname === "/api/status") {
      const meta = await env.GOVT_DATA.get("last-refresh-meta");
      return new Response(meta || JSON.stringify({ status: "never refreshed" }), {
        headers: { "content-type": "application/json", ...CORS_HEADERS },
      });
    }

    return new Response(
      JSON.stringify({
        message: "Know Your Government API",
        endpoints: ["/api/chiefs", "/api/lok-sabha-members", "/api/council-of-ministers", "/api/image?url=...", "/api/refresh", "/api/status"],
      }),
      { headers: { "content-type": "application/json", ...CORS_HEADERS } }
    );
  },

  // This runs automatically on the schedule defined in wrangler.toml (daily at 3am UTC)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshCache(env));
  },
};
