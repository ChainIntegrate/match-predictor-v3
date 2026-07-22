// checkPredictionCount.js
// Verifica se il conteggio "X pronostici" mostrato sul sito per una singola
// partita è corretto, o se il filtro per matchId non viene rispettato
// dall'RPC (Blockscout), restituendo eventi di TUTTE le partite invece che
// solo di quella richiesta.
//
// Uso (dalla cartella backend/, dove sta .env):
//   node checkPredictionCount.js <matchId>

require("dotenv").config();
const { ethers } = require("ethers");

const RPC_URL = process.env.LUKSO_RPC_URL;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;

const ABI = [
  "event PredictionMade(uint256 indexed matchId, address indexed predictor, uint8 predictedResult)",
  "function getMatch(uint256 matchId) external view returns (tuple(string teamHome, string teamAway, uint256 predictionDeadline, bool resolved, uint8 actualResult, bool exists))"
];

async function main() {
  const matchId = Number(process.argv[2]);
  if (Number.isNaN(matchId)) {
    console.error("Uso: node checkPredictionCount.js <matchId>");
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL, 4201, { staticNetwork: true });
  const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);

  const m = await contract.getMatch(matchId);
  console.log(`Partita #${matchId}: ${m.teamHome} vs ${m.teamAway}\n`);

  // Query FILTRATA per questo matchId (quello che fa davvero il sito)
  const filtered = await contract.queryFilter(contract.filters.PredictionMade(matchId), 0, "latest");
  console.log(`Eventi restituiti dalla query filtrata per matchId=${matchId}: ${filtered.length}`);

  const wrongMatchIds = filtered.filter(e => Number(e.args.matchId) !== matchId);
  if (wrongMatchIds.length > 0) {
    console.log(`⚠️  ${wrongMatchIds.length} di questi eventi NON appartengono a questa partita!`);
    console.log("   matchId trovati per errore:", [...new Set(wrongMatchIds.map(e => Number(e.args.matchId)))]);
  } else {
    console.log("✅ Tutti gli eventi restituiti appartengono davvero a questa partita.");
  }

  // Per confronto: query SENZA filtro (tutte le partite), per capire se il
  // numero "sbagliato" visto sul sito corrisponde al totale generale
  const all = await contract.queryFilter(contract.filters.PredictionMade(), 0, "latest");
  console.log(`\nPer confronto — eventi PredictionMade su TUTTE le partite: ${all.length}`);

  const predictorsForThisMatch = new Set(filtered.map(e => e.predictor ?? e.args.predictor));
  console.log(`\nPronostici unici (indirizzi distinti) per questa partita: ${predictorsForThisMatch.size}`);
}

main().catch(err => {
  console.error("Errore:", err.message);
  process.exitCode = 1;
});
