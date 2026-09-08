// checkMatchesDataVsChain.js
// Confronta matches-data.json (cache locale, usata dal filtro "già importate"
// del pannello admin) con lo stato REALE del contratto on-chain — per trovare
// partite registrate nella cache che non esistono davvero sulla chain.
//
// Uso (dalla cartella backend/, dove sta .env):
//   node checkMatchesDataVsChain.js

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const RPC_URL = process.env.LUKSO_RPC_URL;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL, 42, { staticNetwork: true, batchMaxCount: 1 });
  const abi = ["function nextMatchId() external view returns (uint256)"];
  const contract = new ethers.Contract(CONTRACT_ADDRESS, abi, provider);

  const nextMatchId = await contract.nextMatchId();
  const totalOnChain = Number(nextMatchId);
  console.log(`Partite realmente sul contratto: ${totalOnChain} (id validi: 0 a ${totalOnChain - 1})`);

  const matchesDataPath = path.join(__dirname, "matches-data.json");
  if (!fs.existsSync(matchesDataPath)) {
    console.error("matches-data.json non trovato in questa cartella.");
    process.exit(1);
  }
  const matchesData = JSON.parse(fs.readFileSync(matchesDataPath, "utf8"));
  const cached = matchesData.matches || [];
  console.log(`Partite nella cache (matches-data.json): ${cached.length}`);

  // Partite nella cache il cui contractMatchId punta a un id che il
  // contratto non conosce affatto (mai creato davvero, o oltre l'ultimo id valido)
  const ghosts = cached.filter(m => m.contractMatchId === undefined || m.contractMatchId === null || m.contractMatchId >= totalOnChain);

  console.log(`\nPartite "fantasma" nella cache (contractMatchId assente o >= ${totalOnChain}): ${ghosts.length}`);
  if (ghosts.length > 0) {
    console.log("Le prime 10:");
    ghosts.slice(0, 10).forEach(m => {
      console.log(`  contractMatchId=${m.contractMatchId} — footballDataMatchId=${m.footballDataMatchId} — competition=${m.competition} — vs match reale sconosciuto`);
    });
  } else {
    console.log("Nessuna partita fantasma trovata — la cache combacia con la chain.");
  }
}

main().catch(err => {
  console.error("Errore:", err.message);
  process.exit(1);
});
