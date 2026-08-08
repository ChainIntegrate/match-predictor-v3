// analyzeOracleHistory.js
// Analisi completa dello storico del log oracolo: giri totali/falliti per
// giorno, più i tipi di errore distinti visti in ciascun giorno — per capire
// sia QUANDO sia COSA è cambiato nel tempo, non solo un numero aggregato.
//
// Uso: node analyzeOracleHistory.js [percorso_log]
//   (default: /var/log/matchpredictor-v3-oracle.log)

const fs = require("fs");

const LOG_PATH = process.argv[2] || "/var/log/matchpredictor-v3-oracle.log";

function main() {
  if (!fs.existsSync(LOG_PATH)) {
    console.error(`File di log non trovato: ${LOG_PATH}`);
    process.exit(1);
  }

  const lines = fs.readFileSync(LOG_PATH, "utf8").split("\n");

  // giorno (YYYY-MM-DD) -> { total, failed, errorTypes: Map<firma, count> }
  const byDay = {};

  function dayBucket(isoTimestamp) {
    const day = isoTimestamp.slice(0, 10); // YYYY-MM-DD
    if (!byDay[day]) byDay[day] = { total: 0, failed: 0, errorTypes: new Map() };
    return byDay[day];
  }

  // Firma breve di un messaggio d'errore, per raggruppare varianti simili
  // (stesso tipo di errore, indirizzi/dati diversi) invece di contare ogni
  // riga come un tipo a parte.
  function errorSignature(message) {
    if (message.includes("missing revert data")) return "missing revert data (RPC/nodo)";
    if (message.includes("could not coalesce error")) return "could not coalesce error (RPC)";
    if (message.includes("invalid chain id")) return "invalid chain id";
    if (message.includes("TIMEOUT") || message.includes("timeout")) return "timeout";
    if (message.includes("SERVER_ERROR") || message.includes("500")) return "errore server RPC (500)";
    if (message.includes("429") || message.includes("rate limit") || message.includes("Too Many")) return "rate limit (429)";
    if (message.includes("insufficient funds")) return "fondi insufficienti (wallet scarico)";
    if (message.includes("nonce")) return "conflitto nonce";
    // Fallback: prime parole del messaggio, per non perdere errori non previsti
    return message.split(/[:({]/)[0].trim().slice(0, 60);
  }

  for (const line of lines) {
    const startMatch = line.match(/=== Giro avviato: (.+?) ===/);
    if (startMatch) {
      dayBucket(startMatch[1]).total++;
      continue;
    }
    const errMatch = line.match(/Errore generale \[(.+?)\]:\s*(.*)/);
    if (errMatch) {
      const bucket = dayBucket(errMatch[1]);
      bucket.failed++;
      const sig = errorSignature(errMatch[2] || "");
      bucket.errorTypes.set(sig, (bucket.errorTypes.get(sig) || 0) + 1);
    }
  }

  const days = Object.keys(byDay).sort();
  if (days.length === 0) {
    console.log("Nessun dato trovato nel log (mancano i timestamp — file troppo vecchio?).");
    return;
  }

  console.log(`Analisi completa: ${days.length} giorni, dal ${days[0]} al ${days[days.length - 1]}\n`);
  console.log("Giorno       | Giri | Falliti | Tasso   | Tipi di errore visti quel giorno");
  console.log("-------------|------|---------|---------|----------------------------------");

  for (const day of days) {
    const d = byDay[day];
    const rate = d.total > 0 ? ((d.failed / d.total) * 100).toFixed(1) + "%" : "-";
    const errorSummary = [...d.errorTypes.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([sig, count]) => `${sig} (×${count})`)
      .join("; ") || "-";
    console.log(`${day} | ${String(d.total).padStart(4)} | ${String(d.failed).padStart(7)} | ${rate.padStart(7)} | ${errorSummary}`);
  }

  // Riepilogo totale in fondo
  const totalRuns = days.reduce((s, d) => s + byDay[d].total, 0);
  const totalFailed = days.reduce((s, d) => s + byDay[d].failed, 0);
  console.log(`\nTotale complessivo: ${totalRuns} giri, ${totalFailed} falliti (${((totalFailed / totalRuns) * 100).toFixed(1)}%)`);
}

main();
