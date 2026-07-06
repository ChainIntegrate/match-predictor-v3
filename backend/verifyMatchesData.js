// verifyMatchesData.js
// Confronta ogni partita salvata in matches-data.json con lo stato attuale
// su football-data.org (kickoff e turno/stage), segnalando eventuali
// disallineamenti — lo stesso tipo di problema trovato a mano su USA-Belgio.
//
// Uso (dalla cartella backend/, dove stanno .env e matches-data.json):
//   node verifyMatchesData.js

require("dotenv").config();
const fs = require("fs");
const path = require("path");

const FOOTBALL_DATA_API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const MATCHES_DATA_PATH = path.join(__dirname, "matches-data.json");

// Stesso limite già rispettato nell'oracolo: tier gratuito football-data.org
// = max 10 richieste/minuto, 7s di pausa tiene un margine di sicurezza.
const DELAY_BETWEEN_CALLS_MS = 7000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchMatch(footballDataId) {
  const url = `https://api.football-data.org/v4/matches/${footballDataId}`;
  const response = await fetch(url, {
    headers: { "X-Auth-Token": FOOTBALL_DATA_API_KEY }
  });
  if (!response.ok) {
    throw new Error(`football-data.org ha risposto con status ${response.status}`);
  }
  return response.json();
}

async function main() {
  if (!FOOTBALL_DATA_API_KEY) {
    console.error("Errore: FOOTBALL_DATA_API_KEY non impostata in .env");
    process.exit(1);
  }
  if (!fs.existsSync(MATCHES_DATA_PATH)) {
    console.error(`Errore: ${MATCHES_DATA_PATH} non trovato.`);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(MATCHES_DATA_PATH, "utf8"));
  const matches = data.matches || [];
  console.log(`Verifico ${matches.length} partite dalla cache contro football-data.org...\n`);
  console.log("=".repeat(70));

  let mismatchCount = 0;
  let isFirstCall = true;

  for (const cached of matches) {
    if (!isFirstCall) await sleep(DELAY_BETWEEN_CALLS_MS);
    isFirstCall = false;

    try {
      const live = await fetchMatch(cached.footballDataMatchId);

      // Le partite già concluse producono confronti poco affidabili (football-data.org
      // sembra normalizzare/riclassificare orario e turno a posteriori in modo non
      // comparabile con quanto salvato al momento dell'importazione) — il controllo
      // ha senso soprattutto sulle partite ancora da giocare.
      if (live.status === "FINISHED") {
        console.log(`⏭️  #${cached.contractMatchId} (${cached.teamHome} vs ${cached.teamAway}) — già conclusa, salto (confronto non affidabile a posteriori).`);
        continue;
      }

      const liveKickoff = live.utcDate;
      const liveLabel = live.stage;
      const liveHome = live.homeTeam?.name;
      const liveAway = live.awayTeam?.name;

      const issues = [];

      // Controllo che il mapping squadre sia ancora quello giusto (paranoia extra,
      // utile perché football-data.org a volte riassegna gli ID tra tornei diversi)
      if (liveHome !== cached.teamHome || liveAway !== cached.teamAway) {
        issues.push(`SQUADRE DIVERSE: cache="${cached.teamHome} vs ${cached.teamAway}" live="${liveHome} vs ${liveAway}"`);
      }
      if (liveKickoff !== cached.kickoff) {
        issues.push(`kickoff: cache="${cached.kickoff}" live="${liveKickoff}"`);
      }
      if (liveLabel !== cached.label) {
        issues.push(`label: cache="${cached.label}" live="${liveLabel}"`);
      }

      if (issues.length > 0) {
        mismatchCount++;
        console.log(`⚠️  #${cached.contractMatchId} (${cached.teamHome} vs ${cached.teamAway}) — status: ${live.status}`);
        issues.forEach(i => console.log(`    ${i}`));
      } else {
        console.log(`✅ #${cached.contractMatchId} (${cached.teamHome} vs ${cached.teamAway}) — tutto allineato`);
      }
    } catch (err) {
      console.log(`❌ #${cached.contractMatchId} (${cached.teamHome} vs ${cached.teamAway}) — errore: ${err.message}`);
    }
  }

  console.log("=".repeat(70));
  console.log(`\nTotale disallineamenti trovati: ${mismatchCount} su ${matches.length} partite.`);
}

main().catch(err => {
  console.error("Errore:", err.message);
  process.exitCode = 1;
});