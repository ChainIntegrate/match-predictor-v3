/**
 * Oracolo MatchPredictor v3
 * -------------------------
 * Script che fa da ponte tra il mondo reale (risultati calcio via football-data.org)
 * e il contratto MatchPredictor su LUKSO, ed assegna automaticamente i premi ai
 * vincitori dopo la risoluzione.
 *
 * Il mapping matchId -> footballDataMatchId viene letto dinamicamente da
 * backend/matches-data.json (lo stesso file che il pannello admin aggiorna tramite
 * firma owner, senza accesso VPS). Ogni volta che l'owner importa/salva nuove
 * partite dal sito, questo script le conosce automaticamente al prossimo lancio.
 *
 * Rispetto a v1/v2: in v3 nessun utente firma mai direttamente una transazione
 * (accesso solo via email / sponsor relay), quindi non può reclamare da solo il
 * premio con claim(). Dopo aver risolto una partita, questo script rilegge gli
 * eventi PredictionMade on-chain per trovare chi ha pronosticato correttamente, e
 * chiama claimFor() per conto di ciascun vincitore non ancora premiato — anche per
 * partite già risolte in run precedenti, per recuperare eventuali premi rimasti
 * in sospeso (es. se questo script non esisteva ancora quando sono state risolte).
 *
 * Pensato per essere lanciato periodicamente da un cron job.
 *
 * Uso:
 *   node oracle/reportResultBatch.js
 */

const path = require("path");
// Le variabili d'ambiente reali (chiavi, indirizzi, API key) vivono in backend/.env,
// non in questa cartella: le carichiamo esplicitamente da lì, indipendentemente
// dalla working directory da cui viene lanciato lo script (cron vs manuale).
require("dotenv").config({ path: path.join(__dirname, "..", "backend", ".env") });

const { ethers } = require("ethers");
const fs = require("fs");
const { claimFor, claimForBatch } = require("../backend/sponsor");

const RPC_URL = process.env.LUKSO_RPC_URL || "https://rpc.testnet.lukso.network";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const ORACLE_PRIVATE_KEY = process.env.ORACLE_PRIVATE_KEY;
const FOOTBALL_DATA_API_KEY = process.env.FOOTBALL_DATA_API_KEY;
// Blocco di deploy del contratto: limita il range di queryFilter per gli eventi
// PredictionMade. Opzionale — se non impostato si parte da 0 (più lento ma corretto).
const DEPLOY_BLOCK = process.env.CONTRACT_DEPLOY_BLOCK ? Number(process.env.CONTRACT_DEPLOY_BLOCK) : 0;

const MATCHES_DATA_PATH = path.join(__dirname, "..", "backend", "matches-data.json");

// Protezione contro sovrapposizioni: se un giro impiega più dei 30 minuti tra
// un cron e l'altro (es. molti premi da assegnare su partite popolari), il
// prossimo giro non deve partire mentre il precedente sta ancora girando —
// significherebbe due processi che usano la stessa chiave sponsor/oracolo in
// parallelo, con rischio di conflitti di nonce sulle transazioni.
const LOCK_FILE_PATH = path.join(__dirname, ".oracle.lock");
const LOCK_STALE_MS = 55 * 60 * 1000; // oltre questa età, si presume un crash del giro precedente

function acquireLock() {
  if (fs.existsSync(LOCK_FILE_PATH)) {
    const ageMs = Date.now() - fs.statSync(LOCK_FILE_PATH).mtimeMs;
    if (ageMs < LOCK_STALE_MS) {
      console.log(`Un altro giro dell'oracolo risulta già in corso (lock di ${Math.round(ageMs / 60000)} minuti fa) — salto questa esecuzione.`);
      return false;
    }
    console.log("Lock esistente ma troppo vecchio (probabile crash del giro precedente) — lo ignoro e procedo.");
  }
  fs.writeFileSync(LOCK_FILE_PATH, String(process.pid));
  return true;
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE_PATH); } catch {}
}

if (!CONTRACT_ADDRESS || !ORACLE_PRIVATE_KEY || !FOOTBALL_DATA_API_KEY) {
  console.error("Errore: imposta CONTRACT_ADDRESS, ORACLE_PRIVATE_KEY e FOOTBALL_DATA_API_KEY in backend/.env");
  process.exit(1);
}

const CONTRACT_ABI = [
  "function nextMatchId() external view returns (uint256)",
  "function matches(uint256) external view returns (string teamHome, string teamAway, uint256 predictionDeadline, bool resolved, uint8 actualResult, bool exists)",
  "function reportResult(uint256 matchId, uint8 actualResult) external",
  "function claimed(uint256, address) external view returns (bool)",
  "event PredictionMade(uint256 indexed matchId, address indexed predictor, uint8 predictedResult)"
];

const ResultEnum = { NONE: 0, HOME_WIN: 1, DRAW: 2, AWAY_WIN: 3 };

// Tier gratuito football-data.org: max 10 richieste/minuto.
// Una pausa di 7s tra le chiamate tiene il ritmo a ~8.5/minuto, con margine di
// sicurezza anche se il cron job si sovrappone a un'esecuzione precedente ancora
// in corso. Questo limite riguarda SOLO le chiamate a football-data.org: le
// transazioni on-chain (reportResult, claimFor) non lo consumano.
const DELAY_BETWEEN_CALLS_MS = 7000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadMatchIdMapping() {
  if (!fs.existsSync(MATCHES_DATA_PATH)) {
    console.error(`Errore: ${MATCHES_DATA_PATH} non trovato. Salva almeno una volta i dati dal pannello admin.`);
    process.exit(1);
  }
  const raw = fs.readFileSync(MATCHES_DATA_PATH, "utf8");
  const data = JSON.parse(raw);
  return data.matchIdMapping || {};
}

async function fetchMatchResult(footballDataMatchId) {
  const url = `https://api.football-data.org/v4/matches/${footballDataMatchId}`;
  const response = await fetch(url, {
    headers: { "X-Auth-Token": FOOTBALL_DATA_API_KEY }
  });

  if (!response.ok) {
    throw new Error(`football-data.org ha risposto con status ${response.status}`);
  }

  const data = await response.json();

  if (data.status !== "FINISHED") {
    return { finished: false, status: data.status };
  }

  const winner = data.score.winner;
  let result;
  if (winner === "HOME_TEAM") result = ResultEnum.HOME_WIN;
  else if (winner === "AWAY_TEAM") result = ResultEnum.AWAY_WIN;
  else if (winner === "DRAW") result = ResultEnum.DRAW;
  else throw new Error(`Esito non riconosciuto da football-data.org: ${winner}`);

  return {
    finished: true,
    result,
    homeTeam: data.homeTeam.name,
    awayTeam: data.awayTeam.name,
    score: `${data.score.fullTime.home}-${data.score.fullTime.away}`
  };
}

/// Rilegge gli eventi PredictionMade per una partita risolta, individua chi ha
/// pronosticato correttamente e non ha ancora ricevuto il premio, e assegna i
/// premi in parallelo (a gruppi limitati) invece che uno alla volta in
/// sequenza — con molti vincitori, l'attesa sequenziale poteva far durare un
/// intero giro dell'oracolo più dei 30 minuti tra un cron e l'altro.
async function assignPrizes(contract, matchId, actualResult) {
  const filter = contract.filters.PredictionMade(matchId);
  const events = await contract.queryFilter(filter, DEPLOY_BLOCK, "latest");

  const correctPredictors = [...new Set(
    events
      .filter(e => Number(e.args.predictedResult) === Number(actualResult))
      .map(e => e.args.predictor)
  )];

  if (correctPredictors.length === 0) {
    console.log(`  -> Nessun pronostico corretto trovato per il match #${matchId}.`);
    return;
  }

  // Filtra chi ha già ricevuto il premio in un giro precedente
  const toClaim = [];
  for (const predictor of correctPredictors) {
    const alreadyClaimed = await contract.claimed(matchId, predictor);
    if (!alreadyClaimed) toClaim.push(predictor);
  }

  if (toClaim.length === 0) {
    console.log(`  -> Tutti i vincitori del match #${matchId} avevano già ricevuto il premio.`);
    return;
  }

  console.log(`  -> Assegno il premio a ${toClaim.length} vincitori (in parallelo, a gruppi di 5)...`);
  const results = await claimForBatch(matchId, toClaim, 5);

  for (const r of results) {
    if (r.error) {
      console.error(`  -> Errore assegnazione premio a ${r.winner} per match #${matchId}: ${r.error}`);
    } else {
      console.log(`  -> 🏆 Premio assegnato a ${r.winner}: tx ${r.txHash}, tokenId ${r.tokenId}`);
    }
  }
}

async function main() {
  console.log(`\n=== Giro avviato: ${new Date().toISOString()} ===`);
  const matchIdMapping = loadMatchIdMapping();
  console.log(`Mapping caricato da matches-data.json: ${Object.keys(matchIdMapping).length} partite conosciute.`);

  const provider = new ethers.JsonRpcProvider(RPC_URL, 4201, { staticNetwork: true });
  const oracleWallet = new ethers.Wallet(ORACLE_PRIVATE_KEY, provider);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, oracleWallet);

  const nextMatchId = await contract.nextMatchId();
  console.log(`Totale match sul contratto: ${nextMatchId} (id 0 a ${Number(nextMatchId) - 1})`);

  let isFirstApiCall = true;

  for (let matchId = 0; matchId < Number(nextMatchId); matchId++) {
    const onChainMatch = await contract.matches(matchId);

    if (!onChainMatch.exists) {
      continue;
    }

    if (onChainMatch.resolved) {
      // Già risolta: nessuna chiamata a football-data.org necessaria, ma
      // controlliamo comunque eventuali premi rimasti in sospeso.
      console.log(`Match #${matchId} (${onChainMatch.teamHome} vs ${onChainMatch.teamAway}): già risolto, controllo premi in sospeso.`);
      await assignPrizes(contract, matchId, onChainMatch.actualResult);
      continue;
    }

    const footballDataId = matchIdMapping[String(matchId)];
    if (!footballDataId) {
      console.log(`Match #${matchId} (${onChainMatch.teamHome} vs ${onChainMatch.teamAway}): nessun mapping football-data.org configurato, salto.`);
      continue;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec < Number(onChainMatch.predictionDeadline)) {
      // La partita non è nemmeno iniziata: nessun risultato può esistere,
      // quindi non ha senso interrogare football-data.org. Fondamentale su
      // scala campionato (48+ partite mappate con settimane di anticipo).
      console.log(`Match #${matchId} (${onChainMatch.teamHome} vs ${onChainMatch.teamAway}): deadline non ancora raggiunta, salto (nessuna chiamata API).`);
      continue;
    }

    if (!isFirstApiCall) {
      await sleep(DELAY_BETWEEN_CALLS_MS);
    }
    isFirstApiCall = false;

    console.log(`Match #${matchId} (${onChainMatch.teamHome} vs ${onChainMatch.teamAway}): controllo football-data.org #${footballDataId}...`);

    try {
      const matchInfo = await fetchMatchResult(footballDataId);

      if (!matchInfo.finished) {
        console.log(`  -> Non ancora conclusa (status: ${matchInfo.status}).`);
        continue;
      }

      console.log(`  -> Risultato finale: ${matchInfo.homeTeam} ${matchInfo.score} ${matchInfo.awayTeam}`);

      const tx = await contract.reportResult(matchId, matchInfo.result, { gasLimit: 200000 });
      console.log(`  -> Transazione reportResult inviata: ${tx.hash}`);

      const receipt = await tx.wait();
      console.log(`  -> ✅ Confermata nel blocco ${receipt.blockNumber}`);

      await assignPrizes(contract, matchId, matchInfo.result);
    } catch (err) {
      console.error(`  -> Errore per match #${matchId}: ${err.message}`);
    }
  }

  console.log(`Ciclo completato: ${new Date().toISOString()}`);
}

if (acquireLock()) {
  main()
    .catch((error) => {
      console.error(`Errore generale [${new Date().toISOString()}]:`, error.message);
      process.exitCode = 1;
    })
    .finally(() => {
      releaseLock();
    });
}