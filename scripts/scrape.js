// Know Your Government — scraper script
//
// Runs in a plain Node.js environment (via GitHub Actions, on a schedule).
// Fetches live data from india.gov.in server-to-server — no CORS applies here,
// since this isn't a browser. Writes results as versioned JSON files in /data,
// so every scrape is a real git commit with a timestamp and diff history.
//
// This is intentionally separate from backend/src/index.js (the Cloudflare Worker).
// The Worker is the fast, always-on API the frontend talks to. This script is the
// scheduled data-refresh job. Later, if a source needs a real headless browser
// (Playwright) instead of a clean JSON API, it plugs in here the same way.

import { writeFile, mkdir } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");

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
  "Pattali Makkal Katchi": "PMK",
  "Bharat Rashtra Samithi": "BRS",
  "Jharkhand Mukti Morcha": "JMM",
  "J&K National Conference": "JKNC",
  "Kerala Congress (M)": "KC(M)",
  "Mizo National Front": "MNF",
  "National Peoples Party": "NPP",
  "Nationalist Congress Party-SHARADCHANDRA PAWAR": "NCP(SP)",
  "Republican Party of India (ATHAWALE)": "RPI(A)",
  "Rashtriya Lok Morcha": "RLM",
  "Shiv Sena-Uddhav Balasaheb Thackeray": "SS(UBT)",
  "Desiya Murpokku Dravida Kazhagam": "DMDK",
  "Makkal Needhi Maiam": "MNM",
  "UNITED PEOPLES PARTY (LIBERAL)": "UPPL",
  "Independent & Others": "Independent",
  "Biju Janata Dal": "BJD",
  "Bahujan Samaj Party": "BSP",
  "Asom Gana Parishad": "AGP",
  "All India Anna Dravida Munnetra Kazhagam": "AIADMK",
  "Yuvajana Sramika Rythu Congress Party": "YSRCP",
  "Janasena Party": "JnP",
  "Nominated": "Nominated",
  "Shiromani Akali Dal": "SAD",
  "Independent": "Independent",
};

function abbreviateParty(fullName) {
  return PARTY_ABBREV[fullName] || fullName;
}

function cleanName(rawTitle) {
  return rawTitle.replace(/^(Shri|Smt\.|Dr\.|Adv\.|Adv|Ms\.|Prof\.|Km\.|Kumari|Mr|Mrs)\s+/, "").trim();
}

async function fetchRajyaSabhaMembers() {
  const res = await fetch(
    "https://www.india.gov.in/directory/whos-who/rajya-sabha-members/service",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ termMatches: [], textquery: "", pageNumber: 1, pageSize: 300 }),
    }
  );
  if (!res.ok) throw new Error(`Upstream error: ${res.status}`);
  const json = await res.json();
  const results = json?.result?.data?.getAllRajysabha?.results;
  if (!results || !results.length) throw new Error("Unexpected response shape from india.gov.in");

  // Note: this source doesn't include photos (every record's `photo` field is null).
  // The frontend cross-checks against minister data for anyone who's also a minister;
  // everyone else falls back to initials.
  return results.map((r) => ({
    name: cleanName(r.title),
    party: abbreviateParty(r.partyName),
    state: r.stateName,
    mpCode: r.mpCode,
  }));
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

// Which alliance each party belongs to. Unlike seat counts, this genuinely can't
// be fetched live — Parliament doesn't track "alliances" as an official category,
// it's a political grouping. This stays manually maintained, but changes far less
// often than headcounts do.
const BLOC_BY_PARTY = {
  "BJP": "NDA", "JD(U)": "NDA", "TDP": "NDA", "Shiv Sena (Shinde)": "NDA",
  "LJP(RV)": "NDA", "RLD": "NDA", "AD(S)": "NDA", "NCP (Ajit Pawar)": "NDA", "HAM(S)": "NDA",
  "AGP": "NDA", "JnP": "NDA", "JD(S)": "NDA", "SKM": "NDA", "UPPL": "NDA",
  "INC": "INDIA", "SP": "INDIA", "TMC": "INDIA", "SS(UBT)": "INDIA", "NCP(SP)": "INDIA",
  "RJD": "INDIA", "CPI(ML)L": "INDIA", "DMK": "INDIA", "CPI": "INDIA", "CPI(M)": "INDIA",
  "IUML": "INDIA", "JKNC": "INDIA", "JMM": "INDIA", "MDMK": "INDIA", "RSP": "INDIA", "VCK": "INDIA",
  "Independent": "Others", "AIMIM": "Others", "ASP(KR)": "Others",
};

async function fetchAllianceRollup(partyRepList) {
  const rollup = {
    NDA: { seats: 0, parties: [] },
    INDIA: { seats: 0, parties: [] },
    Others: { seats: 0, parties: [] },
  };
  for (const p of partyRepList) {
    const bloc = BLOC_BY_PARTY[p.abbrev] || "Others";
    rollup[bloc].seats += p.seats;
    rollup[bloc].parties.push({ party: p.abbrev, seats: p.seats });
  }
  for (const bloc of Object.values(rollup)) {
    bloc.parties.sort((a, b) => b.seats - a.seats);
  }
  return rollup;
}

async function fetchPartyRepresentation() {
  const res = await fetch(
    "https://sansad.in/api_ls/member/partyWiseRepresentation?loksabha=18&locale=en"
  );
  if (!res.ok) throw new Error(`Upstream error: ${res.status}`);
  const results = await res.json();
  if (!results || !results.length) throw new Error("Unexpected response shape from sansad.in");

  // This endpoint returns every party ever tracked, including long-defunct ones at count 0.
  // Only keep parties that currently hold at least one seat.
  return results
    .filter((p) => p.count > 0)
    .map((p) => ({
      party: p.partyFname.trim(),
      abbrev: p.partySname.trim(),
      seats: p.count,
    }))
    .sort((a, b) => b.seats - a.seats);
}

// Unlike every other scraper function here, this one parses rendered HTML rather
// than a clean JSON API — sansad.in's officer pages don't expose a discoverable
// JSON endpoint the way their member/party data does. This is more fragile by
// nature: if the page's markup changes, parsing could silently misfire. To guard
// against that, each role fails loudly (throws, logged, skipped) rather than
// guessing at a wrong name if the expected pattern isn't found.
const LEADERSHIP_PAGES = [
  { role: "Speaker", url: "https://sansad.in/ls/about/speaker" },
  { role: "Deputy Speaker", url: "https://sansad.in/ls/about/deputy-speaker" },
  { role: "Leader of the House", url: "https://sansad.in/ls/about/leader-of-the-house" },
  { role: "Leader of the Opposition", url: "https://sansad.in/ls/about/leader-of-opposition" },
];

async function fetchOneLeadershipRole(role, url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();

  // Note: a bare "vacant" check is too broad — the site's shared navigation menu
// includes a "Vacant Constituencies" link present on every page, which falsely
// matched every role as vacant. This requires the actual vacancy statement phrasing.
  if (/has\s+been\s+vacant\s+since/i.test(html)) {
    return { role, status: "vacant", name: null, photoUrl: null };
  }

  // The official photo URL is a distinctive, stable pattern regardless of
  // surrounding markup changes: sansad.in/getFile/mpimage/photo/{id}.jpg
  const photoMatch = html.match(/https:\/\/sansad\.in\/getFile\/mpimage\/photo\/\d+\.jpg[^"'\s)]*/);
  // Name appears as "Shri X", "Smt. X", "Dr. X" etc. — same honorific pattern
  // used throughout the member data we already parse elsewhere.
  const nameMatch = html.match(/>(Shri|Smt\.|Dr\.|Kumari)\s+[A-Za-z.\s]+?</);

  if (!nameMatch) {
    throw new Error("Could not confidently find a name on the page — skipping rather than guessing");
  }

  return {
    role,
    status: "occupied",
    name: nameMatch[1] + " " + nameMatch[0].slice(nameMatch[1].length + 1, -1).trim(),
    photoUrl: photoMatch ? photoMatch[0] : null,
  };
}

async function fetchLeadershipRoles() {
  const results = [];
  for (const page of LEADERSHIP_PAGES) {
    try {
      const result = await fetchOneLeadershipRole(page.role, page.url);
      results.push(result);
    } catch (e) {
      results.push({ role: page.role, status: "error", error: e.message, name: null, photoUrl: null });
    }
  }
  return results;
}

async function fetchChiefs() {
  const res = await fetch("https://www.india.gov.in/directory/whos-who/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      dataval: {
        querytype: "getAllWhosWho",
        variables: {
          termMatches: [],
          types: [
            { fieldName: "designation", fieldValue: "President" },
            { fieldName: "designation", fieldValue: "Vice-President" },
          ],
          pageNumber: 1,
          pageSize: 10,
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`Upstream error: ${res.status}`);
  const json = await res.json();
  const results = json?.resultdata?.data?.getAllWhosWho?.results;
  if (!results || !results.length) throw new Error("Unexpected response shape from india.gov.in");

  return results.map((r) => ({
    name: cleanName(r.title),
    designation: r.designation,
    photoUrl: r.imageUrl,
    npiAlias: r.npiAlias,
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

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  const runLog = { ranAt: new Date().toISOString(), results: {}, errors: [] };

  try {
    const partyRep = await fetchPartyRepresentation();
    await writeFile(
      join(DATA_DIR, "party-representation.json"),
      JSON.stringify(partyRep, null, 2)
    );
    runLog.results.partyRepresentation = partyRep.length;
    console.log(`Party representation: wrote ${partyRep.length} parties`);

    const alliances = await fetchAllianceRollup(partyRep);
    await writeFile(
      join(DATA_DIR, "alliances.json"),
      JSON.stringify(alliances, null, 2)
    );
    runLog.results.allianceSeats = {
      NDA: alliances.NDA.seats,
      INDIA: alliances.INDIA.seats,
      Others: alliances.Others.seats,
    };
    console.log(`Alliances: NDA ${alliances.NDA.seats}, INDIA ${alliances.INDIA.seats}, Others ${alliances.Others.seats}`);
  } catch (e) {
    runLog.errors.push(`Party representation fetch failed: ${e.message}`);
    console.error("Party representation fetch failed:", e.message);
  }

  try {
    const leadershipRoles = await fetchLeadershipRoles();
    await writeFile(
      join(DATA_DIR, "leadership-roles.json"),
      JSON.stringify(leadershipRoles, null, 2)
    );
    const succeeded = leadershipRoles.filter((r) => r.status !== "error").length;
    runLog.results.leadershipRoles = `${succeeded}/${leadershipRoles.length} parsed`;
    console.log(`Leadership roles: ${succeeded}/${leadershipRoles.length} parsed successfully`);
    leadershipRoles.filter((r) => r.status === "error").forEach((r) => {
      console.error(`  ${r.role}: ${r.error}`);
    });
  } catch (e) {
    runLog.errors.push(`Leadership roles fetch failed: ${e.message}`);
    console.error("Leadership roles fetch failed:", e.message);
  }

  try {
    const chiefs = await fetchChiefs();
    await writeFile(
      join(DATA_DIR, "chiefs.json"),
      JSON.stringify(chiefs, null, 2)
    );
    runLog.results.chiefs = chiefs.length;
    console.log(`Chiefs: wrote ${chiefs.length} records`);
  } catch (e) {
    runLog.errors.push(`Chiefs fetch failed: ${e.message}`);
    console.error("Chiefs fetch failed:", e.message);
  }

  try {
    const rajyaSabha = await fetchRajyaSabhaMembers();
    await writeFile(
      join(DATA_DIR, "rajya-sabha-members.json"),
      JSON.stringify(rajyaSabha, null, 2)
    );
    runLog.results.rajyaSabhaMembers = rajyaSabha.length;
    console.log(`Rajya Sabha members: wrote ${rajyaSabha.length} records`);
  } catch (e) {
    runLog.errors.push(`Rajya Sabha fetch failed: ${e.message}`);
    console.error("Rajya Sabha fetch failed:", e.message);
  }

  try {
    const members = await fetchLokSabhaMembers();
    await writeFile(
      join(DATA_DIR, "lok-sabha-members.json"),
      JSON.stringify(members, null, 2)
    );
    runLog.results.lokSabhaMembers = members.length;
    console.log(`Lok Sabha members: wrote ${members.length} records`);
  } catch (e) {
    runLog.errors.push(`Lok Sabha fetch failed: ${e.message}`);
    console.error("Lok Sabha fetch failed:", e.message);
  }

  try {
    const ministers = await fetchCouncilOfMinisters();
    await writeFile(
      join(DATA_DIR, "council-of-ministers.json"),
      JSON.stringify(ministers, null, 2)
    );
    runLog.results.councilOfMinisters = ministers.length;
    console.log(`Council of Ministers: wrote ${ministers.length} records`);
  } catch (e) {
    runLog.errors.push(`Ministers fetch failed: ${e.message}`);
    console.error("Ministers fetch failed:", e.message);
  }

  await writeFile(join(DATA_DIR, "last-run.json"), JSON.stringify(runLog, null, 2));

  if (runLog.errors.length > 0) {
    console.error(`Completed with ${runLog.errors.length} error(s). See last-run.json.`);
    process.exitCode = 1;
  } else {
    console.log("Scrape completed successfully.");
  }
}

main();
