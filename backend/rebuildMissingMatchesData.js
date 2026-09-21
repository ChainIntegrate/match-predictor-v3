// rebuildMissingMatchesData.js
// Ricostruisce le entry mancanti in matches-data.json per le partite che
// ESISTONO già on-chain (create con successo da createMatchBatch) ma non
// sono mai arrivate al salvataggio del pannello admin (bug "payload troppo
// grande", ora corretto in server.js).
//
// Come funziona:
//   1. Legge dal contratto tutte le partite on-chain (0..nextMatchId-1) e
//      trova quelle il cui contractMatchId non è in matches-data.json.
//   2. Per ciascuna competizione nota, interroga football-data.org (stessa
//      chiamata usata da /api/upcoming-matches) in una finestra di date
//      abbastanza larga da coprire le partite mancanti.
//   3. Abbina ogni partita on-chain mancante a una partita football-data.org
//      per corrispondenza ESATTA di teamHome+teamAway+kickoff (i valori
//      on-chain sono stati scritti a partire proprio da questi stessi campi
//      dal pannello admin, quindi l'abbinamento è deterministico se la
//      partita non è cambiata su football-data.org nel frattempo).
//   4. Scrive un nuovo file matches-data.rebuilt.json con la cache
//      completa (vecchie + nuove partite) — NON sovrascrive
//      matches-data.json automaticamente: va controllato e poi rinominato
//      a mano, per lo stesso motivo per cui qui si testa sempre prima di
//      mettere in produzione.
//
// Uso (dalla cartella backend/, dove sta .env):
//   node rebuildMissingMatchesData.js [competition1,competition2,...]
// Se non specificato, prova SA,PL,BL1,PD,FL1,DED (tutte tranne WC/CL).

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const RPC_URL = process.env.LUKSO_RPC_URL;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const FOOTBALL_DATA_API_KEY = process.env.FOOTBALL_DATA_API_KEY;

const MATCHES_DATA_PATH = path.join(__dirname, "matches-data.json");
const OUTPUT_PATH = path.join(__dirname, "matches-data.rebuilt.json");

const DEFAULT_COMPETITIONS = ["SA", "PL", "BL1", "PD", "FL1", "DED"];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function withRetry(fn, label, attempts = 3, delayMs = 800) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      console.error(`  -> Tentativo ${i}/${attempts} fallito per ${label}: ${err.message}`);
      if (i < attempts) await sleep(delayMs);
    }
  }
  throw lastErr;
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

async function fetchFootballDataMatches(competition, dateFrom, dateTo) {
  const response = await fetch(
    `https://api.football-data.org/v4/competitions/${competition}/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`,
    { headers: { "X-Auth-Token": FOOTBALL_DATA_API_KEY } }
  );
  if (!response.ok) {
    console.error(`  football-data.org ${competition}: HTTP ${response.status}`);
    return [];
  }
  const data = await response.json();
  return (data.matches || [])
    .filter(m => m.homeTeam?.name && m.awayTeam?.name && m.homeTeam.name !== "TBD")
    .filter(m => !["FINISHED", "IN_PLAY", "PAUSED", "SUSPENDED", "CANCELLED", "AWARDED"].includes(m.status))
    .map(m => ({
      footballDataMatchId: m.id,
      teamHome: m.homeTeam.name,
      teamAway: m.awayTeam.name,
      teamHomeCrest: m.homeTeam.crest || null,
      teamAwayCrest: m.awayTeam.crest || null,
      kickoff: m.utcDate,
      group: m.group || m.stage || "Match",
      competition
    }));
}

async function main() {
  if (!FOOTBALL_DATA_API_KEY) {
    console.error("FOOTBALL_DATA_API_KEY mancante in .env — impossibile interrogare football-data.org.");
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL, 42, { staticNetwork: true, batchMaxCount: 1 });
  const abi = [
    "function nextMatchId() external view returns (uint256)",
    "function getMatch(uint256) external view returns (tuple(string teamHome, string teamAway, uint256 predictionDeadline, bool resolved, uint8 actualResult, bool exists))"
  ];
  const contract = new ethers.Contract(CONTRACT_ADDRESS, abi, provider);

  const nextMatchId = await withRetry(() => contract.nextMatchId(), "nextMatchId()");
  const totalOnChain = Number(nextMatchId);

  const matchesData = fs.existsSync(MATCHES_DATA_PATH)
    ? JSON.parse(fs.readFileSync(MATCHES_DATA_PATH, "utf8"))
    : { matches: [], matchIdMapping: {} };
  const cachedIds = new Set((matchesData.matches || []).map(m => m.contractMatchId));

  const missingIds = [];
  for (let id = 0; id < totalOnChain; id++) {
    if (!cachedIds.has(id)) missingIds.push(id);
  }

  console.log(`Partite on-chain assenti dal json: ${missingIds.length}`);
  if (missingIds.length === 0) {
    console.log("Niente da ricostruire — la cache è già completa.");
    return;
  }

  console.log("Lettura dettagli on-chain delle partite mancanti...");
  const onChainMissing = [];
  for (const id of missingIds) {
    const m = await withRetry(() => contract.getMatch(id), `getMatch(${id})`);
    onChainMissing.push({
      contractMatchId: id,
      teamHome: m.teamHome,
      teamAway: m.teamAway,
      deadlineMs: Number(m.predictionDeadline) * 1000
    });
    await sleep(100);
  }

  // Finestra di date per l'interrogazione a football-data.org: dal giorno
  // prima della deadline più vicina al giorno dopo quella più lontana.
  const deadlines = onChainMissing.map(m => m.deadlineMs);
  const dateFrom = fmtDate(new Date(Math.min(...deadlines) - 2 * 86400000));
  const dateTo = fmtDate(new Date(Math.max(...deadlines) + 2 * 86400000));
  console.log(`Finestra di ricerca football-data.org: ${dateFrom} → ${dateTo}`);

  const competitions = (process.argv[2] ? process.argv[2].split(",") : DEFAULT_COMPETITIONS)
    .map(c => c.trim().toUpperCase());

  let candidates = [];
  for (const comp of competitions) {
    console.log(`Interrogo football-data.org per ${comp}...`);
    const found = await fetchFootballDataMatches(comp, dateFrom, dateTo);
    console.log(`  ${found.length} partite trovate`);
    candidates = candidates.concat(found);
    await sleep(300); // rispetto del rate limit di football-data.org
  }

  const newMatches = [];
  const unmatched = [];
  const usedCandidateIds = new Set();

  for (const oc of onChainMissing) {
    const match = candidates.find(c =>
      !usedCandidateIds.has(c.footballDataMatchId) &&
      c.teamHome === oc.teamHome &&
      c.teamAway === oc.teamAway &&
      Math.abs(new Date(c.kickoff).getTime() - oc.deadlineMs) < 5 * 60 * 1000 // tolleranza 5 minuti
    );

    if (!match) {
      unmatched.push(oc);
      continue;
    }
    usedCandidateIds.add(match.footballDataMatchId);

    const competitionNames = {
      WC: "FIFA World Cup 2026", SA: "Serie A", PL: "Premier League",
      BL1: "Bundesliga", PD: "La Liga", FL1: "Ligue 1",
      DED: "Eredivisie", CL: "UEFA Champions League"
    };

    newMatches.push({
      contractMatchId: oc.contractMatchId,
      teamHome: match.teamHome,
      teamAway: match.teamAway,
      teamHomeCrest: match.teamHomeCrest,
      teamAwayCrest: match.teamAwayCrest,
      label: match.group,
      kickoff: match.kickoff,
      venue: competitionNames[match.competition] || match.competition,
      competition: match.competition,
      footballDataMatchId: match.footballDataMatchId
    });
  }

  console.log(`\nAbbinate correttamente: ${newMatches.length}/${onChainMissing.length}`);
  if (unmatched.length > 0) {
    console.log(`\nNON abbinate (nessuna corrispondenza esatta su football-data.org) — vanno sistemate a mano:`);
    unmatched.forEach(m => {
      console.log(`  #${m.contractMatchId}: ${m.teamHome} vs ${m.teamAway} — deadline ${new Date(m.deadlineMs).toISOString()}`);
    });
  }

  const merged = {
    matches: [...matchesData.matches, ...newMatches].sort((a, b) => a.contractMatchId - b.contractMatchId),
    matchIdMapping: { ...matchesData.matchIdMapping }
  };
  newMatches.forEach(m => {
    merged.matchIdMapping[m.contractMatchId] = m.footballDataMatchId;
  });

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(merged, null, 2));
  console.log(`\nScritto ${OUTPUT_PATH} — ${merged.matches.length} partite totali.`);
  console.log(`Controllalo, poi se va bene:`);
  console.log(`  mv matches-data.json matches-data.json.bak`);
  console.log(`  mv matches-data.rebuilt.json matches-data.json`);
}

main().catch(err => {
  console.error("Errore:", err.message);
  process.exit(1);
});
