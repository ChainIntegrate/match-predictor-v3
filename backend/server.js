// server.js — MatchPredictor v3 Backend
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const db = require("./db");
const { generateUserWallet } = require("./keys");
const { validateUPAddress } = require("./upValidator");
const { sendMagicLink, verifyMagicLink, sendNewMatchesNotification, generateAccessToken, generateRefreshToken, rotateRefreshToken, requireAuth } = require("./auth");
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
  const provider = new ethers.JsonRpcProvider(process.env.LUKSO_RPC_URL, 4201, { batchMaxCount: 1, staticNetwork: true });
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

// ── Auth: verifica se email già registrata ────────────────────────────────
// GET /api/auth/check-email?email=xxx
app.get("/api/auth/check-email", (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ success: false, error: "Email richiesta" });
  const user = db.prepare("SELECT id FROM users WHERE email = ?").get(email.toLowerCase().trim());
  res.json({ success: true, exists: !!user });
});

// ── Auth: valida un indirizzo UP (per feedback live nel form di registrazione) ──
// GET /api/auth/validate-up?address=0x...
app.get("/api/auth/validate-up", async (req, res) => {
  const result = await validateUPAddress(req.query.address);
  res.json({ success: true, ...result });
});

// ── Auth: richiedi magic link ─────────────────────────────────────────────
// POST /api/auth/request-link  { email, upAddress? }
app.post("/api/auth/request-link", async (req, res) => {
  const { email, upAddress, marketingConsent } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ success: false, error: "Email non valida" });
  }

  let validatedUP = null;
  if (upAddress) {
    const check = await validateUPAddress(upAddress);
    if (!check.valid) {
      return res.status(400).json({ success: false, error: "Indirizzo UP non valido", reason: check.reason });
    }
    const existing = db.prepare("SELECT id FROM users WHERE address = ?").get(check.address);
    if (existing) {
      return res.status(409).json({ success: false, error: "Indirizzo UP già associato a un altro account" });
    }
    validatedUP = check.address;
  }

  try {
    await sendMagicLink(email.toLowerCase().trim(), validatedUP, !!marketingConsent);
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

  const verified = verifyMagicLink(token);
  if (!verified) return res.status(401).json({ success: false, error: "Link non valido o scaduto" });

  const { email, upAddress, marketingConsent } = verified;
  let user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);

  if (!user) {
    if (upAddress) {
      // Registrazione con UP propria: ri-valida on-chain (difesa in profondità,
      // il link poteva essere generato minuti prima e l'indirizzo nel frattempo
      // essere stato preso da un altro utente o non essere più una UP valida)
      const check = await validateUPAddress(upAddress);
      if (!check.valid) {
        return res.status(400).json({ success: false, error: "L'indirizzo UP non è più valido" });
      }
      const existing = db.prepare("SELECT id FROM users WHERE address = ?").get(check.address);
      if (existing) {
        return res.status(409).json({ success: false, error: "Indirizzo UP già associato a un altro account" });
      }
      db.prepare(
        "INSERT INTO users (email, address, encrypted_private_key, is_up, terms_accepted, marketing_consent) VALUES (?, ?, NULL, 1, 1, ?)"
      ).run(email, check.address, marketingConsent ? 1 : 0);
    } else {
      // Primo accesso senza UP: genera una EOA dedicata
      const { address, encryptedPrivateKey } = generateUserWallet();
      db.prepare(
        "INSERT INTO users (email, address, encrypted_private_key, terms_accepted, marketing_consent) VALUES (?, ?, ?, 1, ?)"
      ).run(email, address, encryptedPrivateKey, marketingConsent ? 1 : 0);
    }
    user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  }

  const accessToken = generateAccessToken(user.id, user.email, user.address);
  const refreshToken = await generateRefreshToken(user.id);

  res.json({
    success: true,
    accessToken,
    refreshToken,
    user: {
      email: user.email,
      address: user.address,
      isUp: !!user.is_up,
      displayName: user.display_name || null,
      isNewUser: !user.terms_accepted
    }
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
  const user = db.prepare("SELECT id, email, address, is_up, display_name, marketing_consent, created_at FROM users WHERE id = ?").get(req.user.userId);
  if (!user) return res.status(404).json({ success: false, error: "Utente non trovato" });
  res.json({ success: true, user });
});

// ── Utente: aggiorna display name ─────────────────────────────────────────
// POST /api/user/display-name  { displayName }
app.post("/api/user/display-name", requireAuth, (req, res) => {
  const { displayName } = req.body;
  const name = displayName?.trim();

  if (name && name.length > 30) {
    return res.status(400).json({ success: false, error: "Display name troppo lungo (max 30 caratteri)" });
  }

  db.prepare("UPDATE users SET display_name = ? WHERE id = ?").run(name || null, req.user.userId);
  res.json({ success: true, displayName: name || null });
});

// ── Utente: consenso email opzionali (attivabile/disattivabile in ogni momento) ──
// POST /api/user/marketing-consent  { consent: true|false }
app.post("/api/user/marketing-consent", requireAuth, (req, res) => {
  const { consent } = req.body;
  db.prepare("UPDATE users SET marketing_consent = ? WHERE id = ?").run(consent ? 1 : 0, req.user.userId);
  res.json({ success: true, marketingConsent: !!consent });
});

// ── Utente: collega UP ────────────────────────────────────────────────────
// POST /api/user/link-up  { upAddress }
app.post("/api/user/link-up", requireAuth, async (req, res) => {
  const { upAddress } = req.body;
  const check = await validateUPAddress(upAddress);
  if (!check.valid) {
    return res.status(400).json({ success: false, error: "Indirizzo UP non valido", reason: check.reason });
  }

  // Verifica che l'indirizzo non sia già usato da un altro utente
  const existing = db.prepare("SELECT id FROM users WHERE address = ? AND id != ?").get(check.address, req.user.userId);
  if (existing) return res.status(409).json({ success: false, error: "Indirizzo già associato a un altro account" });

  db.prepare(
    "UPDATE users SET address = ?, is_up = 1, encrypted_private_key = NULL WHERE id = ?"
  ).run(check.address, req.user.userId);

  res.json({ success: true, message: "Universal Profile collegata con successo", address: check.address });
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

  // Confronta con i dati precedenti per capire quali partite sono davvero nuove
  // (non tutte quelle nell'array, solo quelle mai viste prima) — solo per quelle
  // ha senso avvisare gli utenti iscritti alle novità.
  const oldData = readMatchesData();
  const oldIds = new Set((oldData.matches || []).map(m => m.contractMatchId));
  const newMatches = matches.filter(m => !oldIds.has(m.contractMatchId));

  writeMatchesData({ matches, matchIdMapping });

  // Non blocchiamo la risposta al pannello admin in attesa dell'invio email
  if (newMatches.length > 0) {
    sendNewMatchesNotification(newMatches).catch(err =>
      console.error("Errore invio notifica nuove partite:", err.message)
    );
  }

  res.json({ success: true, message: "Dati partite aggiornati", newMatchesFound: newMatches.length });
});

// ── Admin: elenco utenti registrati (solo owner, firma ERC-1271) ──────────
// POST /api/admin/users  { message, signature }
app.post("/api/admin/users", async (req, res) => {
  const { message, signature } = req.body;
  if (!message || !signature) {
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

  const users = db.prepare(
    "SELECT email, address, is_up, display_name, created_at FROM users ORDER BY created_at DESC"
  ).all();

  res.json({ success: true, users, total: users.length });
});

// ── Admin: pin JSON su IPFS via Pinata (solo owner, firma ERC-1271) ───────
// POST /api/admin/pin-json  { message, signature, json, name }
// Usato dal pannello admin per caricare i metadata LSP4 (collezione e per-token)
// senza esporre la chiave Pinata nel browser.
app.post("/api/admin/pin-json", async (req, res) => {
  const { message, signature, json, name } = req.body;
  if (!message || !signature || !json || typeof json !== "object") {
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

  if (!process.env.PINATA_JWT) {
    return res.status(500).json({ success: false, error: "PINATA_JWT non configurata sul server" });
  }

  try {
    const pinataRes = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.PINATA_JWT}`
      },
      body: JSON.stringify({
        pinataContent: json,
        pinataMetadata: { name: name || "metadata.json" },
        pinataOptions: { cidVersion: 1 }
      })
    });

    if (!pinataRes.ok) {
      const errText = await pinataRes.text();
      return res.status(502).json({ success: false, error: `Pinata: ${pinataRes.status} ${errText}` });
    }

    const pinataData = await pinataRes.json();
    res.json({ success: true, cid: pinataData.IpfsHash });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
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

// ── Utenti: display names pubblici ───────────────────────────────────────
// GET /api/users/display-names?addresses=0x...,0x...
app.get("/api/users/display-names", (req, res) => {
  const { addresses } = req.query;
  if (!addresses) return res.json({ success: true, data: {} });

  const addrs = addresses.split(",").map(a => a.toLowerCase().trim()).filter(a => a.startsWith("0x"));
  if (addrs.length === 0) return res.json({ success: true, data: {} });

  const placeholders = addrs.map(() => "?").join(",");
  const users = db.prepare(
    `SELECT address, display_name FROM users WHERE LOWER(address) IN (${placeholders})`
  ).all(...addrs);

  const map = {};
  users.forEach(u => { map[u.address.toLowerCase()] = u.display_name; });
  res.json({ success: true, data: map });
});

// ── Gruppi ────────────────────────────────────────────────────────────────

const MAX_GROUPS_CREATED = 3;
const MAX_GROUPS_JOINED = 5;

function generateInviteCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

// POST /api/groups — crea un nuovo gruppo
app.post("/api/groups", requireAuth, (req, res) => {
  const { name, description, maxMembers, excludedMatchIds } = req.body;
  if (!name?.trim()) return res.status(400).json({ success: false, error: "Nome gruppo richiesto" });

  // Verifica limite gruppi creati (i gruppi congelati non contano più)
  const created = db.prepare("SELECT COUNT(*) as count FROM groups WHERE created_by = ? AND frozen_at IS NULL").get(req.user.userId);
  if (created.count >= MAX_GROUPS_CREATED) {
    return res.status(403).json({ success: false, error: `Puoi creare al massimo ${MAX_GROUPS_CREATED} gruppi` });
  }

  // Verifica limite gruppi a cui partecipa (idem, i congelati non contano)
  const joined = db.prepare(`
    SELECT COUNT(*) as count FROM group_members gm
    JOIN groups g ON gm.group_id = g.id
    WHERE gm.user_id = ? AND g.frozen_at IS NULL
  `).get(req.user.userId);
  if (joined.count >= MAX_GROUPS_JOINED) {
    return res.status(403).json({ success: false, error: `Puoi partecipare a massimo ${MAX_GROUPS_JOINED} gruppi` });
  }

  // Genera invite code univoco
  let inviteCode;
  do { inviteCode = generateInviteCode(); }
  while (db.prepare("SELECT id FROM groups WHERE invite_code = ?").get(inviteCode));

  const result = db.prepare(
    "INSERT INTO groups (name, description, created_by, invite_code, max_members) VALUES (?, ?, ?, ?, ?)"
  ).run(name.trim(), description?.trim() || null, req.user.userId, inviteCode, maxMembers || 50);

  // Aggiunge il creatore come membro
  db.prepare("INSERT INTO group_members (group_id, user_id) VALUES (?, ?)").run(result.lastInsertRowid, req.user.userId);

  // Partite deselezionate alla creazione (il frontend manda la lista di ESCLUSE,
  // non quella di incluse — di default un gruppo include tutte le partite)
  if (Array.isArray(excludedMatchIds)) {
    const insertExcluded = db.prepare(
      "INSERT OR IGNORE INTO group_excluded_matches (group_id, contract_match_id) VALUES (?, ?)"
    );
    for (const rawId of excludedMatchIds) {
      const matchId = Number(rawId);
      if (Number.isInteger(matchId) && matchId >= 0) {
        insertExcluded.run(result.lastInsertRowid, matchId);
      }
    }
  }

  const group = db.prepare("SELECT * FROM groups WHERE id = ?").get(result.lastInsertRowid);
  res.json({ success: true, group, inviteUrl: `${process.env.FRONTEND_URL}/join/${inviteCode}` });
});

// GET /api/groups — lista gruppi dell'utente
app.get("/api/groups", requireAuth, (req, res) => {
  const groups = db.prepare(`
    SELECT g.*, 
           (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as member_count,
           (g.created_by = ?) as is_admin
    FROM groups g
    JOIN group_members gm ON g.id = gm.group_id
    WHERE gm.user_id = ?
    ORDER BY gm.joined_at DESC
  `).all(req.user.userId, req.user.userId);

  res.json({ success: true, data: groups });
});

// GET /api/groups/:inviteCode — info gruppo da link invito (senza auth)
app.get("/api/groups/:inviteCode", (req, res) => {
  const group = db.prepare(`
    SELECT g.id, g.name, g.description, g.invite_code, g.max_members,
           (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as member_count
    FROM groups g WHERE g.invite_code = ?
  `).get(req.params.inviteCode.toUpperCase());

  if (!group) return res.status(404).json({ success: false, error: "Gruppo non trovato" });
  res.json({ success: true, group });
});

// POST /api/groups/:inviteCode/join — entra in un gruppo
app.post("/api/groups/:inviteCode/join", requireAuth, (req, res) => {
  const group = db.prepare("SELECT * FROM groups WHERE invite_code = ?").get(req.params.inviteCode.toUpperCase());
  if (!group) return res.status(404).json({ success: false, error: "Gruppo non trovato" });

  // Verifica se già membro
  const alreadyMember = db.prepare("SELECT id FROM group_members WHERE group_id = ? AND user_id = ?").get(group.id, req.user.userId);
  if (alreadyMember) return res.status(409).json({ success: false, error: "Sei già membro di questo gruppo" });

  // Verifica limite gruppi a cui partecipa (i gruppi congelati non contano)
  const joined = db.prepare(`
    SELECT COUNT(*) as count FROM group_members gm
    JOIN groups g ON gm.group_id = g.id
    WHERE gm.user_id = ? AND g.frozen_at IS NULL
  `).get(req.user.userId);
  if (joined.count >= MAX_GROUPS_JOINED) {
    return res.status(403).json({ success: false, error: `Puoi partecipare a massimo ${MAX_GROUPS_JOINED} gruppi` });
  }

  // Verifica limite membri del gruppo
  const memberCount = db.prepare("SELECT COUNT(*) as count FROM group_members WHERE group_id = ?").get(group.id);
  if (memberCount.count >= group.max_members) {
    return res.status(403).json({ success: false, error: "Il gruppo ha raggiunto il numero massimo di membri" });
  }

  db.prepare("INSERT INTO group_members (group_id, user_id) VALUES (?, ?)").run(group.id, req.user.userId);
  res.json({ success: true, message: `Benvenuto nel gruppo "${group.name}"!` });
});

// GET /api/groups/:inviteCode/leaderboard — classifica del gruppo
app.get("/api/groups/:inviteCode/leaderboard", requireAuth, (req, res) => {
  const group = db.prepare("SELECT * FROM groups WHERE invite_code = ?").get(req.params.inviteCode.toUpperCase());
  if (!group) return res.status(404).json({ success: false, error: "Gruppo non trovato" });

  const isMember = db.prepare("SELECT id FROM group_members WHERE group_id = ? AND user_id = ?").get(group.id, req.user.userId);
  if (!isMember) return res.status(403).json({ success: false, error: "Non sei membro di questo gruppo" });

  const members = db.prepare(`
    SELECT u.id, u.email, u.address, u.is_up, u.display_name, gm.joined_at
    FROM group_members gm
    JOIN users u ON gm.user_id = u.id
    WHERE gm.group_id = ?
    ORDER BY gm.joined_at ASC
  `).all(group.id);

  const excluded = db.prepare(
    "SELECT contract_match_id FROM group_excluded_matches WHERE group_id = ?"
  ).all(group.id).map(r => r.contract_match_id);

  res.json({ success: true, group, members, excludedMatches: excluded });
});

// GET /api/groups/:inviteCode/predictions — pronostici di tutti i membri per ogni partita
// La classifica con i punti viene calcolata on-chain lato frontend (legge eventi PredictionMade)
// Questo endpoint serve solo a sapere quali address sono membri, per filtrare gli eventi
app.get("/api/groups/:inviteCode/members", requireAuth, (req, res) => {
  const group = db.prepare("SELECT * FROM groups WHERE invite_code = ?").get(req.params.inviteCode.toUpperCase());
  if (!group) return res.status(404).json({ success: false, error: "Gruppo non trovato" });

  const isMember = db.prepare("SELECT id FROM group_members WHERE group_id = ? AND user_id = ?").get(group.id, req.user.userId);
  if (!isMember) return res.status(403).json({ success: false, error: "Non sei membro di questo gruppo" });

  const members = db.prepare(`
    SELECT u.id, u.address, u.display_name, u.is_up,
           (u.id = ?) as is_me
    FROM group_members gm
    JOIN users u ON gm.user_id = u.id
    WHERE gm.group_id = ?
    ORDER BY gm.joined_at ASC
  `).all(req.user.userId, group.id);

  res.json({ success: true, group, members });
});

// PUT /api/groups/:inviteCode/matches — aggiorna le partite escluse (solo creatore)
app.put("/api/groups/:inviteCode/matches", requireAuth, (req, res) => {
  const { excludedMatchIds } = req.body;
  const group = db.prepare("SELECT * FROM groups WHERE invite_code = ?").get(req.params.inviteCode.toUpperCase());
  if (!group) return res.status(404).json({ success: false, error: "Gruppo non trovato" });
  if (group.created_by !== req.user.userId) {
    return res.status(403).json({ success: false, error: "Solo il creatore può modificare le partite del gruppo" });
  }
  if (!Array.isArray(excludedMatchIds)) {
    return res.status(400).json({ success: false, error: "excludedMatchIds deve essere un array" });
  }

  const tx = db.transaction(() => {
    db.prepare("DELETE FROM group_excluded_matches WHERE group_id = ?").run(group.id);
    const insertExcluded = db.prepare(
      "INSERT OR IGNORE INTO group_excluded_matches (group_id, contract_match_id) VALUES (?, ?)"
    );
    for (const rawId of excludedMatchIds) {
      const matchId = Number(rawId);
      if (Number.isInteger(matchId) && matchId >= 0) {
        insertExcluded.run(group.id, matchId);
      }
    }
  });
  tx();

  res.json({ success: true, message: "Partite del gruppo aggiornate" });
});

// POST /api/groups/:inviteCode/freeze — congela l'INSIEME delle partite (solo creatore)
// Importante: si fissa QUALI matchId contano da qui in avanti (niente più
// nuove partite aggiunte), NON i risultati. Se una di queste partite non è
// ancora risolta al momento del congelamento, il frontend continuerà a
// leggerne il risultato dal vivo finché non viene giocata — altrimenti una
// partita in corso resterebbe "congelata" a un conteggio sbagliato per sempre.
app.post("/api/groups/:inviteCode/freeze", requireAuth, (req, res) => {
  const { matchIds } = req.body;
  const group = db.prepare("SELECT * FROM groups WHERE invite_code = ?").get(req.params.inviteCode.toUpperCase());
  if (!group) return res.status(404).json({ success: false, error: "Gruppo non trovato" });
  if (group.created_by !== req.user.userId) {
    return res.status(403).json({ success: false, error: "Solo il creatore può congelare il gruppo" });
  }
  if (group.frozen_at) {
    return res.status(409).json({ success: false, error: "Il gruppo è già congelato" });
  }
  if (!Array.isArray(matchIds)) {
    return res.status(400).json({ success: false, error: "matchIds deve essere un array" });
  }

  db.prepare("UPDATE groups SET frozen_at = unixepoch(), frozen_match_ids = ? WHERE id = ?")
    .run(JSON.stringify(matchIds), group.id);

  res.json({ success: true, message: "Gruppo congelato" });
});

// DELETE /api/groups/:inviteCode/leave — abbandona un gruppo
app.delete("/api/groups/:inviteCode/leave", requireAuth, (req, res) => {
  const group = db.prepare("SELECT * FROM groups WHERE invite_code = ?").get(req.params.inviteCode.toUpperCase());
  if (!group) return res.status(404).json({ success: false, error: "Gruppo non trovato" });

  if (group.created_by === req.user.userId) {
    return res.status(400).json({ success: false, error: "Il creatore non può abbandonare il gruppo. Eliminalo invece." });
  }

  db.prepare("DELETE FROM group_members WHERE group_id = ? AND user_id = ?").run(group.id, req.user.userId);
  res.json({ success: true, message: "Hai abbandonato il gruppo" });
});

// DELETE /api/groups/:inviteCode — elimina gruppo (solo creatore)
app.delete("/api/groups/:inviteCode", requireAuth, (req, res) => {
  const group = db.prepare("SELECT * FROM groups WHERE invite_code = ?").get(req.params.inviteCode.toUpperCase());
  if (!group) return res.status(404).json({ success: false, error: "Gruppo non trovato" });
  if (group.created_by !== req.user.userId) return res.status(403).json({ success: false, error: "Solo il creatore può eliminare il gruppo" });

  db.prepare("DELETE FROM groups WHERE id = ?").run(group.id);
  res.json({ success: true, message: "Gruppo eliminato" });
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
