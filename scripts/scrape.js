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

// Some government fields (education, older career-timeline entries) come back with
// raw HTML embedded (<body>, <br>, <sup> tags) rather than plain text. Strip it.
function stripHtml(text) {
  if (!text) return null;
  const stripped = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return stripped.length ? stripped : null;
}

async function fetchOneMinisterProfile(mpsno, name) {
  const profile = {
    mpsno,
    placeBirth: null,
    dateBirth: null,
    education: null,
    profession: null,
    careerTimeline: [],
    attendanceCurrentTerm: null,
    attendanceLoksabha: null,
    errors: [],
  };

  // 1. Birth info, education, profession, career timeline — all from Wikidata/Wikipedia,
  // matched by name with a confidence check (occupation/nationality) since we no longer
  // have government data to cross-verify against.
  try {
    const wiki = await fetchWikipediaProfile(name);
    if (wiki) {
      profile.dateBirth = wiki.dateBirth;
      profile.placeBirth = wiki.placeBirth;
      profile.education = wiki.education;
      profile.profession = wiki.profession;
      profile.careerTimeline = wiki.careerTimeline;
      profile.wikipediaSummary = wiki.summary;
      profile.dataSource = "wikipedia";
    } else {
      profile.errors.push("No confident Wikipedia/Wikidata match found");
    }
  } catch (e) {
    profile.errors.push(`wikipedia profile: ${e.message}`);
  }

  // 3 & 4. Attendance for the CURRENT Lok Sabha term only, excluding "Not Required"
  // days entirely. Ministers often show 100% NR since they aren't tracked on the same
  // signing register as regular members — in that case we deliberately omit the stat
  // rather than show a misleading 0%.
  try {
    const res = await fetch(`https://sansad.in/api_ls/member/members-loksabha-session?mpCode=${mpsno}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const sessionsData = await res.json();
    if (!Array.isArray(sessionsData) || !sessionsData.length) throw new Error("Unexpected response shape");

    // Only the highest (most recent) Lok Sabha number — i.e. the current term.
    const currentTermEntry = sessionsData.reduce((latest, entry) =>
      !latest || entry.loksabha > latest.loksabha ? entry : latest, null);
    const currentLoksabha = currentTermEntry?.loksabha;
    const sessionNumbers = (currentTermEntry?.sessions || [])
      .map((s) => s.sessionNo)
      .filter((n) => n != null);

    if (currentLoksabha != null && sessionNumbers.length) {
      let present = 0;
      let absent = 0;
      let sessionFailures = 0;
      for (const sessionNo of sessionNumbers) {
        try {
          const attRes = await fetch(
            `https://sansad.in/api_ls/member/getMemberAttendanceByMpsno?loksabha=${currentLoksabha}&session=${sessionNo}&mpsno=${mpsno}`
          );
          if (!attRes.ok) {
            sessionFailures++;
            continue;
          }
          const attData = await attRes.json();
          for (const bucket of attData) {
            const count = (bucket.dates || []).length;
            if (["S", "S*", "S#"].includes(bucket.attendanceType)) present += count;
            else if (["NS", "NS@"].includes(bucket.attendanceType)) absent += count;
            // NR (Not Required) is deliberately excluded from both counts.
          }
        } catch {
          sessionFailures++;
        }
        // Small pacing delay to avoid hammering the endpoint with rapid-fire requests.
        await new Promise((r) => setTimeout(r, 150));
      }
      if (sessionFailures > 0) {
        profile.errors.push(`attendance: ${sessionFailures}/${sessionNumbers.length} session requests failed`);
      }
      const total = present + absent;
      profile.attendanceCurrentTerm = total > 0 ? Math.round((present / total) * 1000) / 10 : null;
      profile.attendanceLoksabha = currentLoksabha;
    }
  } catch (e) {
    profile.errors.push(`attendance: ${e.message}`);
  }

  return profile;
}

async function fetchMinisterProfiles(ministers) {
  const profiles = [];
  for (const m of ministers) {
    if (!m.mpsno) continue;
    try {
      const profile = await fetchOneMinisterProfile(m.mpsno, m.name);
      profiles.push(profile);
    } catch (e) {
      profiles.push({ mpsno: m.mpsno, errors: [`total failure: ${e.message}`] });
    }
  }
  return profiles;
}

// Full profile from Wikidata (structured facts) + Wikipedia (prose summary), matched
// by name with a confidence check. Since we're no longer cross-verifying against a
// government source, the confidence check relies on the Wikidata entity's own
// description containing "politician" or "india" — not foolproof, but a reasonable
// safeguard against matching an unrelated namesake.
async function fetchWikipediaProfile(name) {
  if (!name) return null;

  const searchRes = await fetch(
    `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(
      name + " Indian politician"
    )}&language=en&format=json&limit=1`
  );
  if (!searchRes.ok) return null;
  const searchData = await searchRes.json();
  const entityId = searchData?.search?.[0]?.id;
  const description = (searchData?.search?.[0]?.description || "").toLowerCase();
  if (!entityId || !(description.includes("politician") || description.includes("india"))) {
    return null;
  }

  const entityRes = await fetch(`https://www.wikidata.org/wiki/Special:EntityData/${entityId}.json`);
  if (!entityRes.ok) return null;
  const entityData = await entityRes.json();
  const entity = entityData?.entities?.[entityId];
  const claims = entity?.claims || {};

  const resolveLabel = async (id) => {
    try {
      await new Promise((r) => setTimeout(r, 100));
      const res = await fetch(`https://www.wikidata.org/wiki/Special:EntityData/${id}.json`);
      const data = await res.json();
      return data?.entities?.[id]?.labels?.en?.value || null;
    } catch {
      return null;
    }
  };

  const formatWikidataDate = (raw) => {
    if (!raw) return null;
    // Wikidata dates look like "+1964-10-22T00:00:00Z"
    const match = raw.match(/^\+?(\d{4})-(\d{2})-(\d{2})/);
    return match ? `${match[3]}-${match[2]}-${match[1]}` : null;
  };

  // Date of birth (P569)
  const dateBirth = formatWikidataDate(claims.P569?.[0]?.mainsnak?.datavalue?.value?.time);

  // Place of birth (P19)
  let placeBirth = null;
  const pobId = claims.P19?.[0]?.mainsnak?.datavalue?.value?.id;
  if (pobId) placeBirth = await resolveLabel(pobId);

  // Education (P69), can be multiple institutions
  let education = null;
  const eduIds = (claims.P69 || []).map((c) => c.mainsnak?.datavalue?.value?.id).filter(Boolean);
  if (eduIds.length) {
    const labels = [];
    for (const id of eduIds) labels.push(await resolveLabel(id));
    education = labels.filter(Boolean).join(", ") || null;
  }

  // Occupation/profession (P106)
  let profession = null;
  const occId = claims.P106?.[0]?.mainsnak?.datavalue?.value?.id;
  if (occId) profession = await resolveLabel(occId);

  // Career timeline from "position held" (P39), with start/end date qualifiers.
  // Note: this is typically less complete than a government-sourced timeline would be —
  // Wikidata's political-office records for Indian politicians are often partial.
  const careerTimeline = [];
  const positions = (claims.P39 || []).slice(0, 15); // cap to avoid excessive label lookups
  for (const p of positions) {
    const posId = p.mainsnak?.datavalue?.value?.id;
    if (!posId) continue;
    const posLabel = await resolveLabel(posId);
    if (!posLabel) continue;
    const start = formatWikidataDate(p.qualifiers?.P580?.[0]?.datavalue?.value?.time);
    const end = formatWikidataDate(p.qualifiers?.P582?.[0]?.datavalue?.value?.time);
    careerTimeline.push({ period: `${start || "?"} - ${end || "present"}`, position: posLabel });
  }

  // Prose summary from Wikipedia itself, for a "life before power"-style narrative.
  let summary = null;
  const wikiTitle = entity?.sitelinks?.enwiki?.title;
  if (wikiTitle) {
    try {
      const sumRes = await fetch(
        `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(wikiTitle)}`
      );
      if (sumRes.ok) {
        const sumData = await sumRes.json();
        summary = sumData.extract || null;
      }
    } catch {
      // Non-fatal; summary just stays null.
    }
  }

  return { dateBirth, placeBirth, education, profession, careerTimeline, summary };
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

    try {
      const profiles = await fetchMinisterProfiles(ministers);
      await writeFile(
        join(DATA_DIR, "minister-profiles.json"),
        JSON.stringify(profiles, null, 2)
      );
      const succeeded = profiles.filter((p) => !p.errors || p.errors.length === 0).length;
      runLog.results.ministerProfiles = `${succeeded}/${profiles.length} fully succeeded`;
      console.log(`Minister profiles: ${succeeded}/${profiles.length} fully succeeded`);
      profiles.filter((p) => p.errors && p.errors.length > 0).forEach((p) => {
        console.error(`  mpsno ${p.mpsno}: ${p.errors.join("; ")}`);
      });
    } catch (e) {
      runLog.errors.push(`Minister profiles fetch failed: ${e.message}`);
      console.error("Minister profiles fetch failed:", e.message);
    }
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
