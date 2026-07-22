// Riprova la stessa chiamata in sola lettura (eth_call, non estimateGas)
// per vedere se il nodo restituisce un messaggio di revert più chiaro.
require("dotenv").config();
const { ethers } = require("ethers");

const RPC_URL = process.env.LUKSO_RPC_URL;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;

const ABI = [
  "function predictFor(uint256 matchId, uint8 predictedResult, address predictor) external",
  "function nextMatchId() external view returns (uint256)",
  "function getMatch(uint256 matchId) external view returns (tuple(string teamHome, string teamAway, uint256 predictionDeadline, bool resolved, uint8 actualResult, bool exists))"
];

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, {});
  const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);

  let matchId = process.argv[2];
  if (matchId === "") matchId = undefined;

  if (matchId === undefined) {
    // Nessun ID passato: cerca per nome squadra (case-insensitive, match parziale)
    const searchTerm = (process.argv[3] || "france").toLowerCase();
    const total = Number(await contract.nextMatchId());
    console.log(`Nessun ID fornito, cerco una partita con "${searchTerm}" tra ${total} partite...`);

    for (let i = 0; i < total; i++) {
      const m = await contract.getMatch(i);
      if (!m.exists) continue;
      if (m.teamHome.toLowerCase().includes(searchTerm) || m.teamAway.toLowerCase().includes(searchTerm)) {
        console.log(`Trovata: #${i} — ${m.teamHome} vs ${m.teamAway}`);
        matchId = i;
        break;
      }
    }
    if (matchId === undefined) {
      console.error(`Nessuna partita trovata con "${searchTerm}".`);
      process.exit(1);
    }
  }

  const m = await contract.getMatch(matchId);
  console.log("Partita:", m.teamHome, "vs", m.teamAway);
  console.log("Deadline:", new Date(Number(m.predictionDeadline) * 1000).toISOString());
  console.log("Ora attuale:", new Date().toISOString());
  console.log("Deadline già passata?", Date.now() > Number(m.predictionDeadline) * 1000);
  console.log("Già risolta?", m.resolved);
  console.log("Esiste?", m.exists);

  try {
    await contract.predictFor.staticCall(matchId, 1, "0x000000000000000000000000000000000000dEaD", {
      from: new ethers.Wallet(process.env.SPONSOR_PRIVATE_KEY).address
    });
    console.log("predictFor: la chiamata simulata NON fallisce (il problema è altrove)");
  } catch (err) {
    console.log("predictFor fallisce con:", err.reason || err.shortMessage || err.message);
  }
}
main().catch(e => console.error(e));