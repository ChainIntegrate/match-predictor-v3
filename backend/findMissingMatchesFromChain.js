// findMissingMatchesFromChain.js
// Direzione opposta di checkMatchesDataVsChain.js: qui cerchiamo le partite
// che ESISTONO davvero sul contratto (0..nextMatchId-1) ma il cui
// contractMatchId non compare in matches-data.json — cioè partite create
// on-chain (via createMatchBatch) ma mai arrivate nel salvataggio del
// pannello admin (es. per il bug del "payload troppo grande" o per un
// salvataggio interrotto a metà).
//
// Per ciascuna partita mancante interroga il contratto (getMatch) per
// squadre/deadline/stato, così puoi vedere subito di quale partita si tratta
// e reimportarla dal pannello admin.
//
// Uso (dalla cartella backend/, dove sta .env):
//   node findMissingMatchesFromChain.js

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const RPC_URL = process.env.LUKSO_RPC_URL;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;

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

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL, 42, { staticNetwork: true, batchMaxCount: 1 });
  // getMatch ritorna uno struct (Match memory), non una tupla piatta: uno
  // struct con campi dinamici (le string) viene incapsulato con una parola
  // di offset in più. Va dichiarato come tuple(...), altrimenti ethers
  // decodifica tutto sfalsato di una parola e produce dati illeggibili.
  const abi = [
    "function nextMatchId() external view returns (uint256)",
    "function getMatch(uint256) external view returns (tuple(string teamHome, string teamAway, uint256 predictionDeadline, bool resolved, uint8 actualResult, bool exists))"
  ];
  const contract = new ethers.Contract(CONTRACT_ADDRESS, abi, provider);

  const nextMatchId = await withRetry(() => contract.nextMatchId(), "nextMatchId()");
  const totalOnChain = Number(nextMatchId);
  console.log(`Partite realmente sul contratto: ${totalOnChain} (id validi: 0 a ${totalOnChain - 1})`);

  const matchesDataPath = path.join(__dirname, "matches-data.json");
  const matchesData = fs.existsSync(matchesDataPath)
    ? JSON.parse(fs.readFileSync(matchesDataPath, "utf8"))
    : { matches: [] };
  const cachedIds = new Set((matchesData.matches || []).map(m => m.contractMatchId));
  console.log(`Partite nella cache (matches-data.json): ${cachedIds.size}`);

  const missingIds = [];
  for (let id = 0; id < totalOnChain; id++) {
    if (!cachedIds.has(id)) missingIds.push(id);
  }

  console.log(`\nPartite on-chain assenti dal json: ${missingIds.length}`);
  if (missingIds.length === 0) {
    console.log("Nessuna — la cache copre tutti gli id esistenti sul contratto.");
    return;
  }

  for (const id of missingIds) {
    try {
      const m = await withRetry(() => contract.getMatch(id), `getMatch(${id})`);
      const deadline = new Date(Number(m.predictionDeadline) * 1000).toISOString();
      console.log(`  #${id}: ${m.teamHome} vs ${m.teamAway} — deadline ${deadline} — resolved=${m.resolved} — exists=${m.exists}`);
    } catch (err) {
      console.log(`  #${id}: errore lettura on-chain dopo i retry (${err.message})`);
    }
    await sleep(150); // piccola pausa tra una chiamata e l'altra, per non stressare il nodo
  }
}

main().catch(err => {
  console.error("Errore:", err.message);
  process.exit(1);
});