// checkOracleStats.js
// Riassume quanti giri dell'oracolo sono stati eseguiti e quanti sono falliti,
// in una finestra di tempo recente — usa i timestamp aggiunti ai log
// (Giro avviato / Errore generale), niente più conteggio a mano con grep/tail.
//
// Uso (dalla cartella backend/ o oracle/, indifferente):
//   node checkOracleStats.js        -> ultime 24 ore
//   node checkOracleStats.js 10     -> ultime 10 ore

const fs = require("fs");

const LOG_PATH = "/var/log/matchpredictor-v3-oracle.log";
const hoursBack = Number(process.argv[2]) || 24;
const cutoff = Date.now() - hoursBack * 60 * 60 * 1000;

function main() {
  if (!fs.existsSync(LOG_PATH)) {
    console.error(`File di log non trovato: ${LOG_PATH}`);
    process.exit(1);
  }

  const lines = fs.readFileSync(LOG_PATH, "utf8").split("\n");

  let totalRuns = 0;
  let failedRuns = 0;
  let firstTimestamp = null;
  let lastTimestamp = null;

  for (const line of lines) {
    const startMatch = line.match(/=== Giro avviato: (.+?) ===/);
    if (startMatch) {
      const ts = new Date(startMatch[1]).getTime();
      if (ts >= cutoff) {
        totalRuns++;
        if (!firstTimestamp) firstTimestamp = startMatch[1];
        lastTimestamp = startMatch[1];
      }
      continue;
    }
    const errMatch = line.match(/Errore generale \[(.+?)\]:/);
    if (errMatch) {
      const ts = new Date(errMatch[1]).getTime();
      if (ts >= cutoff) failedRuns++;
    }
  }

  console.log(`Finestra analizzata: ultime ${hoursBack} ore`);
  console.log(`Giri totali:   ${totalRuns}`);
  console.log(`Giri falliti:  ${failedRuns}`);
  if (totalRuns > 0) {
    const pct = ((failedRuns / totalRuns) * 100).toFixed(1);
    console.log(`Tasso di fallimento: ${pct}%`);
  } else {
    console.log("Nessun giro trovato in questa finestra — o l'oracolo non gira da così tanto, o serve allargare le ore (es. node checkOracleStats.js 48).");
  }
  if (firstTimestamp) console.log(`\nDal: ${firstTimestamp}`);
  if (lastTimestamp) console.log(`Al:  ${lastTimestamp}`);
}

main();
