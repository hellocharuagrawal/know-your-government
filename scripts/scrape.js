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
