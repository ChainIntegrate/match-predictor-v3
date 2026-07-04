// findOrphanPredictors.js
// Confronta gli indirizzi che hanno effettivamente pronosticato on-chain con
// quelli presenti nella tabella users del DB, e segnala eventuali "orfani":
// indirizzi con pronostici reali che non corrispondono a nessun utente attuale.
//
// Cause innocenti più probabili per un orfano:
//  1) L'utente ha pronosticato con l'EOA auto-generata, poi ha collegato una
//     UP propria (in registrazione o dopo) — il DB sovrascrive l'indirizzo,
//     quello vecchio resta orfano ma i pronostici restano validi on-chain.
//  2) Test manuale dal pannello admin (predictFor con indirizzo a mano).
//
// Uso (dalla cartella backend/, dove stanno .env e matchpredictor.db):
//   node findOrphanPredictors.js

require("dotenv").config();
const { ethers } = require("ethers");
const Database = require("better-sqlite3");

const RPC_URL = process.env.LUKSO_RPC_URL || "https://rpc.testnet.lukso.network";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;

const CONTRACT_ABI = [
  "function nextMatchId() external view returns (uint256)",
  "event PredictionMade(uint256 indexed matchId, address indexed predictor, uint8 predictedResult)"
];

async function main() {
  const db = new Database("matchpredictor.db", { readonly: true });
  const dbUsers = db.prepare("SELECT email, address, is_up, display_name FROM users").all();
  const dbAddressMap = new Map(dbUsers.map(u => [u.address.toLowerCase(), u]));

  console.log(`Utenti nel DB: ${dbUsers.length}\n`);

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, provider);

  const events = await contract.queryFilter(contract.filters.PredictionMade(), 0, "latest");
  console.log(`Eventi PredictionMade trovati on-chain: ${events.length}\n`);

  // Raggruppa per indirizzo predictor
  const byAddress = new Map();
  for (const ev of events) {
    const addr = ev.args.predictor.toLowerCase();
    if (!byAddress.has(addr)) byAddress.set(addr, []);
    byAddress.get(addr).push({
      matchId: Number(ev.args.matchId),
      result: Number(ev.args.predictedResult),
      block: ev.blockNumber,
      tx: ev.transactionHash
    });
  }

  console.log(`Indirizzi unici che hanno pronosticato: ${byAddress.size}\n`);
  console.log("=".repeat(60));

  let orphanCount = 0;
  for (const [addr, preds] of byAddress.entries()) {
    const user = dbAddressMap.get(addr);
    if (user) {
      console.log(`✅ ${addr} — ${user.email} (${preds.length} pronostici)`);
    } else {
      orphanCount++;
      const code = await provider.getCode(addr);
      console.log(`⚠️  ORFANO: ${addr}`);
      console.log(`    Tipo: ${code !== "0x" ? "Universal Profile (contratto)" : "EOA semplice"}`);
      console.log(`    Pronostici: ${preds.length}`);
      preds.forEach(p => console.log(`      match #${p.matchId}, blocco ${p.block}, tx ${p.tx}`));
    }
  }

  console.log("=".repeat(60));
  console.log(`\nTotale indirizzi orfani: ${orphanCount}`);

  db.close();
}

main().catch(err => {
  console.error("Errore:", err.message);
  process.exitCode = 1;
});
