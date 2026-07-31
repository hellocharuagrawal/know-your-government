// Know Your Government — backend proxy Worker
//
// Purpose: fetch live data from india.gov.in server-side (where CORS doesn't apply),
// cache it, and serve it to the frontend with proper CORS headers so the browser allows it.
//
// Endpoints this Worker exposes:
//   GET /api/lok-sabha-members   -> all Lok Sabha members, cached
//   GET /api/council-of-ministers -> all ministers, cached
//   GET /api/refresh              -> manually force a refresh (for testing)

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*", // tighten this to your actual frontend domain once deployed
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

const PARTY_ABBREV = {
  "Bharatiya Janata Party": "BJP",
  "Indian National Congress": "INC",
  "Samajwadi Party": "SP",
  "All India Trinamool Congress": "TMC",
  "Dravida Munnetra Kazhagam": "DMK",
  "Nationalist Congress Party - Sharadchandra Pawar": "NCP(SP)",
  "Nationalist Congress Party": "NCP (Ajit Pawar)",
  "Shiv Sena": "Shiv Sena (Shinde)",
  "Shiv Sena (Uddhav Balasaheb Thackrey)": "SS(UBT)",
  "Telugu Desam Party": "TDP",
  "Janata Dal (United)": "JD(U)",
  "Janata Dal (United)  ": "JD(U)",
  "Rashtriya Janata Dal": "RJD",
  "Lok Jan Shakti Party (Ram Vilas)": "LJP(RV)",
  "Bharat Adivasi Party": "BAP",
  "Aam Aadmi Party": "AAP",
  "Jammu and Kashmir National Conference": "JKNC",
  "Communist Party of India (Marxist)": "CPI(M)",
  "Communist Party of India": "CPI",
  "Communist Party of India (Marxist-Leninist) Liberation": "CPI(ML)L",
  "Hindustani Awam Morcha (Secular)": "HAM(S)",
  "Janata Dal (Secular)": "JD(S)",
  "Apna Dal (Soneylal)": "AD(S)",
  "Rashtriya Lok Dal": "RLD",
  "Azad Samaj Party (Kanshi Ram)": "ASP(KR)",
  "All India Majlis-E-Ittehadul Muslimeen": "AIMIM",
  "Indian Union Muslim League": "IUML",
  "Indian Union Muslim League ": "IUML",
  "Shiromani Akali Dal": "SAD",
  "Independent": "Independent",
};

function abbreviateParty(fullName) {
  return PARTY_ABBREV[fullName] || fullName;
}

function cleanName(rawTitle) {
  return rawTitle.replace(/^(Shri|Smt\.|Dr\.|Adv\.|Adv|Ms\.|Prof\.|Km\.|Kumari|Mr|Mrs)\s+/, "").trim();
}

async function fetchLokSabhaMembers() {
  const res = await fetch(
    "https://www.india.gov.in/directory/whos-who/lok-sabha-members/service",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ termMatches: [], textquery: "", pageNumber: 1, pageSize: 600 }),
    }
  );
  if (!res.ok) throw new Error(`Upstream error: ${res.status}`);
  const json = await res.json();
  const results = json?.result?.data?.getAllLoksabha?.results;
  if (!results || !results.length) throw new Error("Unexpected response shape from india.gov.in");

  return results.map((r) => ({
    name: cleanName(r.title),
    party: abbreviateParty(r.partyFname),
    constituency: r.constituency,
    state: r.stateName,
    photoUrl: r.photoUrl,
    mpsno: r.mpsno,
  }));
}

async function fetchCouncilOfMinisters() {
  const res = await fetch("https://www.india.gov.in/directory/whos-who/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      dataval: {
        querytype: "getAllWhosWho",
        variables: {
          termMatches: [],
          types: [{ fieldName: "designation", fieldValue: "Council of Ministers" }],
          pageNumber: 1,
          pageSize: 100,
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`Upstream error: ${res.status}`);
  const json = await res.json();
  const results = json?.resultdata?.data?.getAllWhosWho?.results;
  if (!results || !results.length) throw new Error("Unexpected response shape from india.gov.in");

  return results.map((r) => ({
    name: r.title.trim(),
    rank: r.whoswho_type,
    ministries: r.npiMinistryDepartment,
    photoUrl: r.imageUrl,
    house: r.house,
    mpsno: r.mp_code,
  }));
}

async function refreshCache(env) {
  const results = { refreshedAt: new Date().toISOString(), errors: [] };

  try {
    const members = await fetchLokSabhaMembers();
    await env.GOVT_DATA.put("lok-sabha-members", JSON.stringify(members));
    results.lokSabhaCount = members.length;
  } catch (e) {
    results.errors.push(`Lok Sabha fetch failed: ${e.message}`);
  }

  try {
    const ministers = await fetchCouncilOfMinisters();
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

    if (url.pathname === "/api/council-of-ministers") {
      return respondWithCached(env, "council-of-ministers");
    }

    if (url.pathname === "/api/refresh") {
      const result = await refreshCache(env);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { "content-type": "application/json", ...CORS_HEADERS },
      });
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
        endpoints: ["/api/lok-sabha-members", "/api/council-of-ministers", "/api/refresh", "/api/status"],
      }),
      { headers: { "content-type": "application/json", ...CORS_HEADERS } }
    );
  },

  // This runs automatically on the schedule defined in wrangler.toml (daily at 3am UTC)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshCache(env));
  },
};
