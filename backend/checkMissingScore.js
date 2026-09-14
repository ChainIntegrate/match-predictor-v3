// checkMissingScore.js
// Diagnosi mirata: per un dato contractMatchId, verifica se manca il
// footballDataMatchId nella cache, e se presente, cosa risponde davvero
// football-data.org per quell'id — per capire quale dei due punti deboli
// del sito (footballDataMatchId assente, o esito non "FINISHED" secondo
// loro) sta causando l'assenza del punteggio a schermo.
//
// Uso (dalla cartella backend/, dove stanno .env e matches-data.json):
//   node checkMissingScore.js <contractMatchId>

require("dotenv").config();
const fs = require("fs");
const path = require("path");

async function main() {
  const contractMatchId = Number(process.argv[2]);
  if (!Number.isInteger(contractMatchId)) {
    console.error("Uso: node checkMissingScore.js <contractMatchId>");
    process.exit(1);
  }

  const matchesDataPath = path.join(__dirname, "matches-data.json");
  const matchesData = JSON.parse(fs.readFileSync(matchesDataPath, "utf8"));
  const entry = matchesData.matches.find(m => m.contractMatchId === contractMatchId);

  if (!entry) {
    console.log(`Match #${contractMatchId}: NON trovato in matches-data.json — la card non avrebbe nemmeno squadre/orario corretti, problema più ampio.`);
    return;
  }

  console.log("Voce trovata nella cache:");
  console.log(JSON.stringify(entry, null, 2));

  if (!entry.footballDataMatchId) {
    console.log("\n❌ CAUSA TROVATA: footballDataMatchId assente o vuoto in questa voce.");
    console.log("Il sito non prova nemmeno a chiedere il punteggio — il riquadro non viene creato.");
    return;
  }

  console.log(`\nfootballDataMatchId presente: ${entry.footballDataMatchId}. Controllo cosa dice football-data.org per questo id...`);

  const response = await fetch(`https://api.football-data.org/v4/matches/${entry.footballDataMatchId}`, {
    headers: { "X-Auth-Token": process.env.FOOTBALL_DATA_API_KEY }
  });

  if (!response.ok) {
    console.log(`\n❌ football-data.org ha risposto con status ${response.status} per questo id.`);
    return;
  }

  const data = await response.json();
  console.log(`\nStatus reale secondo football-data.org: ${data.status}`);
  console.log(`Squadre secondo loro: ${data.homeTeam?.name} vs ${data.awayTeam?.name}`);
  console.log(`Squadre secondo la nostra cache: ${entry.teamHome} vs ${entry.teamAway}`);

  if (data.status !== "FINISHED") {
    console.log(`\n❌ CAUSA TROVATA: per football-data.org questa partita non è "FINISHED" (è "${data.status}") — il sito rimuove il riquadro punteggio quando succede, anche se il nostro contratto la considera già risolta.`);
  } else if (data.homeTeam?.name !== entry.teamHome || data.awayTeam?.name !== entry.teamAway) {
    console.log(`\n⚠️  Lo status è FINISHED, ma le squadre non combaciano — il footballDataMatchId salvato punta probabilmente alla partita SBAGLIATA.`);
  } else {
    console.log(`\n✅ Tutto combacia (FINISHED, squadre corrette) — il punteggio dovrebbe mostrarsi. Se non si vede comunque, il problema è un'altra cosa (es. cache del browser, o un errore di rete momentaneo).`);
    console.log(`Punteggio reale: ${data.score?.fullTime?.home} - ${data.score?.fullTime?.away}`);
  }
}

main().catch(err => {
  console.error("Errore:", err.message);
  process.exit(1);
});
