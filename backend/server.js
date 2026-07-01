// server.js — MatchPredictor v3 Backend
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const db = require("./db");
const { generateUserWallet } = require("./keys");
const { sendMagicLink, verifyMagicLink, generateAccessToken, generateRefreshToken, rotateRefreshToken, requireAuth } = require("./auth");
const { predictFor, predictBatchFor, claimFor } = require("./sponsor");
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3007;

const MATCHES_DATA_PATH = path.join(__dirname, "matches-data.json");

// ── Middleware ────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || "*",
  credentials: true
}));
app.use(express.json());

// ── Helper ────────────────────────────────────────────────────────────────
function readMatchesData() {
  try {
    if (!fs.existsSync(MATCHES_DATA_PATH)) return { matches: [], matchIdMapping: {} };
    return JSON.parse(fs.readFileSync(MATCHES_DATA_PATH, "utf8"));
  } catch { return { matches: [], matchIdMapping: {} }; }
}

function writeMatchesData(data) {
  fs.writeFileSync(MATCHES_DATA_PATH, JSON.stringify(data, null, 2), "utf8");
}

// Verifica firma owner (ERC-1271) per endpoint admin sensibili
async function verifyOwnerSignature(message, signature) {
  const provider = new ethers.JsonRpcProvider(process.env.LUKSO_RPC_URL);
  const upAbi = ["function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4)"];
  const up = new ethers.Contract(process.env.OWNER_UP_ADDRESS, upAbi, provider);
  const messageHash = ethers.hashMessage(message);
  try {
    const result = await up.isValidSignature(messageHash, signature);
    return result.toLowerCase() === "0x1626ba7e";
  } catch { return false; }
}

// ── Health ────────────────────────────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({ success: true, status: "online", service: "matchpredictor-v3" });
});

// ── Auth: richiedi magic link ─────────────────────────────────────────────
// POST /api/auth/request-link  { email }
app.post("/api/auth/request-link", async (req, res) => {
  const { email } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ success: false, error: "Email non valida" });
  }

  try {
    await sendMagicLink(email.toLowerCase().trim());
    res.json({ success: true, message: "Link inviato. Controlla la tua email." });
  } catch (err) {
    console.error("Errore invio magic link:", err.message);
    res.status(500).json({ success: false, error: "Errore invio email" });
  }
});

// ── Auth: verifica magic link ─────────────────────────────────────────────
// GET /api/auth/verify?token=xxx
app.get("/api/auth/verify", async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ success: false, error: "Token mancante" });

  const email = verifyMagicLink(token);
  if (!email) return res.status(401).json({ success: false, error: "Link non valido o scaduto" });

  // Trova o crea l'utente
  let user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);

  if (!user) {
    // Primo accesso: genera una EOA dedicata
    const { address, encryptedPrivateKey } = generateUserWallet();
    db.prepare(
      "INSERT INTO users (email, address, encrypted_private_key) VALUES (?, ?, ?)"
    ).run(email, address, encryptedPrivateKey);
    user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  }

  // Genera access token + refresh token
  const accessToken = generateAccessToken(user.id, user.email, user.address);
  const refreshToken = await generateRefreshToken(user.id);

  res.json({
    success: true,
    accessToken,
    refreshToken,
    user: { email: user.email, address: user.address, isUp: !!user.is_up }
  });
});

// ── Auth: rinnova token ───────────────────────────────────────────────────
// POST /api/auth/refresh  { refreshToken }
app.post("/api/auth/refresh", async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ success: false, error: "Refresh token mancante" });

  const result = await rotateRefreshToken(refreshToken);
  if (!result) return res.status(401).json({ success: false, error: "Refresh token non valido o scaduto" });

  res.json({
    success: true,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    user: { email: result.user.email, address: result.user.address, isUp: !!result.user.is_up }
  });
});

// ── Utente: profilo ───────────────────────────────────────────────────────
// GET /api/user/profile
app.get("/api/user/profile", requireAuth, (req, res) => {
  const user = db.prepare("SELECT id, email, address, is_up, created_at FROM users WHERE id = ?").get(req.user.userId);
  if (!user) return res.status(404).json({ success: false, error: "Utente non trovato" });
  res.json({ success: true, user });
});

// ── Utente: collega UP ────────────────────────────────────────────────────
// POST /api/user/link-up  { upAddress }
app.post("/api/user/link-up", requireAuth, (req, res) => {
  const { upAddress } = req.body;
  if (!upAddress || !ethers.isAddress(upAddress)) {
    return res.status(400).json({ success: false, error: "Indirizzo UP non valido" });
  }

  // Verifica che l'indirizzo non sia già usato da un altro utente
  const existing = db.prepare("SELECT id FROM users WHERE address = ? AND id != ?").get(upAddress, req.user.userId);
  if (existing) return res.status(409).json({ success: false, error: "Indirizzo già associato a un altro account" });

  db.prepare(
    "UPDATE users SET address = ?, is_up = 1, encrypted_private_key = NULL WHERE id = ?"
  ).run(upAddress, req.user.userId);

  res.json({ success: true, message: "Universal Profile collegata con successo", address: upAddress });
});

// ── Pronostici: registra uno ──────────────────────────────────────────────
// POST /api/predict  { matchId, predictedResult }
app.post("/api/predict", requireAuth, async (req, res) => {
  const { matchId, predictedResult } = req.body;
  if (matchId === undefined || !predictedResult) {
    return res.status(400).json({ success: false, error: "matchId e predictedResult richiesti" });
  }
  if (![1, 2, 3].includes(Number(predictedResult))) {
    return res.status(400).json({ success: false, error: "predictedResult deve essere 1 (Home), 2 (Draw) o 3 (Away)" });
  }

  try {
    const result = await predictFor(Number(matchId), Number(predictedResult), req.user.address);
    res.json({ success: true, ...result });
  } catch (err) {
    const msg = err.message || "";
    if (msg.includes("AlreadyPredicted")) return res.status(409).json({ success: false, error: "Hai già pronosticato per questa partita" });
    if (msg.includes("PredictionWindowClosed")) return res.status(400).json({ success: false, error: "La finestra di pronostici è chiusa" });
    if (msg.includes("MatchDoesNotExist")) return res.status(404).json({ success: false, error: "Partita non trovata" });
    console.error("Errore predictFor:", err.message);
    res.status(500).json({ success: false, error: "Errore blockchain: " + msg });
  }
});

// ── Pronostici: registra batch ────────────────────────────────────────────
// POST /api/predict/batch  { predictions: [{ matchId, predictedResult }] }
app.post("/api/predict/batch", requireAuth, async (req, res) => {
  const { predictions } = req.body;
  if (!Array.isArray(predictions) || predictions.length === 0) {
    return res.status(400).json({ success: false, error: "Array di pronostici mancante o vuoto" });
  }

  const matchIds = predictions.map(p => Number(p.matchId));
  const results = predictions.map(p => Number(p.predictedResult));

  try {
    const result = await predictBatchFor(matchIds, results, req.user.address);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error("Errore predictBatchFor:", err.message);
    res.status(500).json({ success: false, error: "Errore blockchain: " + err.message });
  }
});

// ── Claim: richiedi NFT ───────────────────────────────────────────────────
// POST /api/claim  { matchId }
app.post("/api/claim", requireAuth, async (req, res) => {
  const { matchId } = req.body;
  if (matchId === undefined) return res.status(400).json({ success: false, error: "matchId richiesto" });

  try {
    const result = await claimFor(Number(matchId), req.user.address);
    res.json({ success: true, ...result });
  } catch (err) {
    const msg = err.message || "";
    if (msg.includes("AlreadyClaimed")) return res.status(409).json({ success: false, error: "NFT già riscattato" });
    if (msg.includes("PredictionWasIncorrect")) return res.status(400).json({ success: false, error: "Il tuo pronostico non era corretto" });
    if (msg.includes("MatchNotResolvedYet")) return res.status(400).json({ success: false, error: "Il risultato non è ancora stato riportato" });
    console.error("Errore claimFor:", err.message);
    res.status(500).json({ success: false, error: "Errore blockchain: " + msg });
  }
});

// ── Trasferimento NFT: richiesta ──────────────────────────────────────────
// POST /api/transfer-request  { targetAddress, tokenIds }
app.post("/api/transfer-request", requireAuth, (req, res) => {
  const { targetAddress, tokenIds } = req.body;
  if (!targetAddress || !ethers.isAddress(targetAddress)) {
    return res.status(400).json({ success: false, error: "Indirizzo destinatario non valido" });
  }
  if (!Array.isArray(tokenIds) || tokenIds.length === 0) {
    return res.status(400).json({ success: false, error: "Lista tokenId mancante o vuota" });
  }

  // Verifica che non ci sia già una richiesta pending per questo utente
  const existing = db.prepare(
    "SELECT id FROM transfer_requests WHERE user_id = ? AND status = 'pending'"
  ).get(req.user.userId);
  if (existing) return res.status(409).json({ success: false, error: "Hai già una richiesta di trasferimento in attesa" });

  db.prepare(
    "INSERT INTO transfer_requests (user_id, target_address, token_ids) VALUES (?, ?, ?)"
  ).run(req.user.userId, targetAddress, JSON.stringify(tokenIds));

  res.json({ success: true, message: "Richiesta inviata. Sarà processata manualmente dall'admin." });
});

// ── Partite: lista pubblica ───────────────────────────────────────────────
// GET /api/matches-data
app.get("/api/matches-data", (req, res) => {
  res.json({ success: true, data: readMatchesData() });
});

// ── Partite: salva (solo owner, firma ERC-1271) ───────────────────────────
// POST /api/matches-data  { message, signature, matches, matchIdMapping }
app.post("/api/matches-data", async (req, res) => {
  const { message, signature, matches, matchIdMapping } = req.body;
  if (!message || !signature || !Array.isArray(matches) || typeof matchIdMapping !== "object") {
    return res.status(400).json({ success: false, error: "Body non valido" });
  }

  const timestampMatch = message.match(/(\d{13})/);
  if (!timestampMatch) return res.status(400).json({ success: false, error: "Timestamp mancante nel messaggio" });
  const ageMs = Date.now() - parseInt(timestampMatch[1], 10);
  if (ageMs > 5 * 60 * 1000 || ageMs < -60 * 1000) {
    return res.status(401).json({ success: false, error: "Firma scaduta" });
  }

  const isValid = await verifyOwnerSignature(message, signature);
  if (!isValid) return res.status(403).json({ success: false, error: "Firma non autorizzata" });

  writeMatchesData({ matches, matchIdMapping });
  res.json({ success: true, message: "Dati partite aggiornati" });
});

// ── Proxy punteggio partita ───────────────────────────────────────────────
// GET /api/match-score/:footballDataMatchId
const scoreCache = new Map();
app.get("/api/match-score/:id", async (req, res) => {
  const id = req.params.id;
  if (!/^\d+$/.test(id)) return res.status(400).json({ success: false, error: "ID non valido" });

  if (scoreCache.has(id)) return res.json({ success: true, data: scoreCache.get(id) });

  try {
    const response = await fetch(`https://api.football-data.org/v4/matches/${id}`, {
      headers: { "X-Auth-Token": process.env.FOOTBALL_DATA_API_KEY }
    });
    if (!response.ok) return res.status(502).json({ success: false, error: `football-data.org: ${response.status}` });

    const data = await response.json();
    if (data.status !== "FINISHED") return res.json({ success: true, data: { finished: false, status: data.status } });

    const result = {
      finished: true, status: data.status,
      homeTeam: data.homeTeam.name, awayTeam: data.awayTeam.name,
      homeScore: data.score.fullTime.home, awayScore: data.score.fullTime.away
    };
    scoreCache.set(id, result);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Proxy partite programmate ─────────────────────────────────────────────
// GET /api/upcoming-matches?dateFrom=&dateTo=
app.get("/api/upcoming-matches", async (req, res) => {
  const { dateFrom, dateTo } = req.query;
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateFrom || !dateTo || !dateRegex.test(dateFrom) || !dateRegex.test(dateTo)) {
    return res.status(400).json({ success: false, error: "dateFrom e dateTo richiesti (YYYY-MM-DD)" });
  }

  try {
    const response = await fetch(
      `https://api.football-data.org/v4/competitions/WC/matches?dateFrom=${dateFrom}&dateTo=${dateTo}&status=SCHEDULED`,
      { headers: { "X-Auth-Token": process.env.FOOTBALL_DATA_API_KEY } }
    );
    if (!response.ok) return res.status(502).json({ success: false, error: `football-data.org: ${response.status}` });

    const data = await response.json();
    const known = (data.matches || [])
      .filter(m => m.homeTeam?.name && m.awayTeam?.name && m.homeTeam.name !== "TBD")
      .map(m => ({
        footballDataMatchId: m.id,
        teamHome: m.homeTeam.name,
        teamAway: m.awayTeam.name,
        kickoff: m.utcDate,
        group: m.group || m.stage || "Match"
      }));

    res.json({ success: true, data: known });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Admin: lista utenti ───────────────────────────────────────────────────
// GET /api/admin/users  (richiede firma owner nell'header)
app.get("/api/admin/users", async (req, res) => {
  const { message, signature } = req.headers;
  if (!message || !signature) return res.status(401).json({ success: false, error: "Firma richiesta" });

  const isValid = await verifyOwnerSignature(message, signature);
  if (!isValid) return res.status(403).json({ success: false, error: "Non autorizzato" });

  const users = db.prepare(
    "SELECT id, email, address, is_up, created_at FROM users ORDER BY created_at DESC"
  ).all();
  res.json({ success: true, data: users });
});

// ── Admin: lista richieste trasferimento ──────────────────────────────────
// GET /api/admin/transfer-requests
app.get("/api/admin/transfer-requests", async (req, res) => {
  const { message, signature } = req.headers;
  if (!message || !signature) return res.status(401).json({ success: false, error: "Firma richiesta" });

  const isValid = await verifyOwnerSignature(message, signature);
  if (!isValid) return res.status(403).json({ success: false, error: "Non autorizzato" });

  const requests = db.prepare(`
    SELECT tr.*, u.email, u.address as from_address
    FROM transfer_requests tr
    JOIN users u ON tr.user_id = u.id
    WHERE tr.status = 'pending'
    ORDER BY tr.created_at ASC
  `).all();
  res.json({ success: true, data: requests });
});

// ── Avvio ─────────────────────────────────────────────────────────────────
app.listen(PORT, "127.0.0.1", () => {
  console.log("═══════════════════════════════════════");
  console.log("  MatchPredictor v3 Backend");
  console.log("═══════════════════════════════════════");
  console.log(`  Porta:    ${PORT}`);
  console.log(`  Contratto: ${process.env.CONTRACT_ADDRESS}`);
  console.log("═══════════════════════════════════════");
});
