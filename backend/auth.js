// auth.js — magic link, JWT access token e refresh token
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const { v4: uuidv4 } = require("uuid");
const nodemailer = require("nodemailer");
const db = require("./db");

const JWT_SECRET = process.env.JWT_SECRET;
const ACCESS_TOKEN_EXPIRY = "7d";
const REFRESH_TOKEN_EXPIRY_DAYS = 90;
const MAGIC_LINK_EXPIRY_MINUTES = 15;
const BCRYPT_ROUNDS = 10;

// ── Email transporter ─────────────────────────────────────────────────────

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || "587"),
  secure: process.env.SMTP_SECURE === "true",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// ── Magic link ────────────────────────────────────────────────────────────

/// Genera un magic link, lo salva nel DB e lo invia via email.
/// Se upAddress è presente (già validata come LSP0 dal chiamante), viene
/// salvata sul magic link e usata in fase di verify per creare l'utente
/// senza generare una EOA dedicata.
async function sendMagicLink(email, upAddress = null, marketingConsent = false) {
  // Cancella eventuali link precedenti non usati per questa email
  db.prepare("DELETE FROM magic_links WHERE email = ? AND used = 0").run(email);

  const token = uuidv4().replace(/-/g, "") + crypto.randomBytes(16).toString("hex");
  const expiresAt = Math.floor(Date.now() / 1000) + MAGIC_LINK_EXPIRY_MINUTES * 60;

  db.prepare(
    "INSERT INTO magic_links (email, token, expires_at, up_address, marketing_consent) VALUES (?, ?, ?, ?, ?)"
  ).run(email, token, expiresAt, upAddress, marketingConsent ? 1 : 0);

  const link = `${process.env.FRONTEND_URL}/auth?token=${token}`;

  await transporter.sendMail({
    from: `"MatchPredictor" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
    to: email,
    subject: "Il tuo link di accesso a MatchPredictor / Your MatchPredictor login link",
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h2>Accedi a MatchPredictor</h2>
        <p>Clicca il link qui sotto per accedere. Valido per ${MAGIC_LINK_EXPIRY_MINUTES} minuti.</p>
        <a href="${link}" style="
          display: inline-block;
          background: #3498db;
          color: white;
          padding: 12px 24px;
          border-radius: 8px;
          text-decoration: none;
          font-weight: bold;
          margin: 16px 0;
        ">Accedi ora</a>
        <p style="color: #666; font-size: 13px;">
          Se non hai richiesto tu questo link, ignoralo.
        </p>

        <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;">

        <h2>Sign in to MatchPredictor</h2>
        <p>Click the link below to sign in. Valid for ${MAGIC_LINK_EXPIRY_MINUTES} minutes.</p>
        <a href="${link}" style="
          display: inline-block;
          background: #3498db;
          color: white;
          padding: 12px 24px;
          border-radius: 8px;
          text-decoration: none;
          font-weight: bold;
          margin: 16px 0;
        ">Sign in now</a>
        <p style="color: #666; font-size: 13px;">
          If you didn't request this link, just ignore this email.
        </p>
      </div>
    `
  });

  return token; // restituito solo per i test, non esporlo al client
}

/// Verifica un magic link e restituisce { email, upAddress } se valido, null altrimenti.
/// upAddress è null se l'utente si è registrato con generazione automatica di EOA.
function verifyMagicLink(token) {
  const row = db.prepare(
    "SELECT * FROM magic_links WHERE token = ? AND used = 0 AND expires_at > unixepoch()"
  ).get(token);

  if (!row) return null;

  // Marca come usato (monouso)
  db.prepare("UPDATE magic_links SET used = 1 WHERE id = ?").run(row.id);

  return { email: row.email, upAddress: row.up_address || null, marketingConsent: !!row.marketing_consent };
}

/// Notifica via email gli utenti che hanno dato il consenso quando vengono
/// aggiunte nuove partite (solo quelle davvero nuove, non l'intero elenco).
async function sendNewMatchesNotification(newMatches) {
  if (!newMatches || newMatches.length === 0) return;

  const users = db.prepare("SELECT email FROM users WHERE marketing_consent = 1").all();
  if (users.length === 0) return;

  const matchListHtml = newMatches.map(m => `${m.teamHome} vs ${m.teamAway}`).join("<br>");
  const link = process.env.FRONTEND_URL;

  for (const user of users) {
    try {
      await transporter.sendMail({
        from: `"MatchPredictor" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
        to: user.email,
        subject: "Nuove partite da pronosticare su MatchPredictor / New matches to predict",
        html: `
          <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
            <h2>Nuove partite disponibili</h2>
            <p>Sono state aggiunte queste nuove partite:</p>
            <p>${matchListHtml}</p>
            <a href="${link}" style="
              display: inline-block;
              background: #3498db;
              color: white;
              padding: 12px 24px;
              border-radius: 8px;
              text-decoration: none;
              font-weight: bold;
              margin: 16px 0;
            ">Vai a MatchPredictor</a>
            <p style="color: #666; font-size: 12px;">
              Ricevi questa email perché hai scelto di essere avvisato di novità.
              Puoi disattivarlo in qualsiasi momento dal tuo profilo.
            </p>

            <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;">

            <h2>New matches available</h2>
            <p>These new matches have just been added:</p>
            <p>${matchListHtml}</p>
            <a href="${link}" style="
              display: inline-block;
              background: #3498db;
              color: white;
              padding: 12px 24px;
              border-radius: 8px;
              text-decoration: none;
              font-weight: bold;
              margin: 16px 0;
            ">Go to MatchPredictor</a>
            <p style="color: #666; font-size: 12px;">
              You're getting this because you opted in to update emails.
              You can turn it off anytime from your account bar on the site.
            </p>
          </div>
        `
      });
    } catch (err) {
      console.error(`Errore invio notifica nuove partite a ${user.email}:`, err.message);
    }
  }
}

// ── JWT access token ──────────────────────────────────────────────────────

function generateAccessToken(userId, email, address) {
  return jwt.sign({ userId, email, address }, JWT_SECRET, {
    expiresIn: ACCESS_TOKEN_EXPIRY
  });
}

function verifyAccessToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// ── Refresh token ─────────────────────────────────────────────────────────

/// Genera un refresh token, lo salva hashato nel DB, restituisce il token in chiaro.
async function generateRefreshToken(userId) {
  const token = crypto.randomBytes(48).toString("hex");
  const tokenHash = await bcrypt.hash(token, BCRYPT_ROUNDS);
  const expiresAt = Math.floor(Date.now() / 1000) + REFRESH_TOKEN_EXPIRY_DAYS * 86400;

  db.prepare(
    "INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)"
  ).run(userId, tokenHash, expiresAt);

  return token;
}

/// Verifica un refresh token e, se valido, emette nuovi access + refresh token.
/// Ruota il refresh token ad ogni uso (token rotation).
async function rotateRefreshToken(incomingToken) {
  // Cerca tutti i refresh token non scaduti per verificare l'incoming
  const rows = db.prepare(
    "SELECT * FROM refresh_tokens WHERE expires_at > unixepoch()"
  ).all();

  let matchedRow = null;
  for (const row of rows) {
    if (await bcrypt.compare(incomingToken, row.token_hash)) {
      matchedRow = row;
      break;
    }
  }

  if (!matchedRow) return null;

  // Recupera l'utente
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(matchedRow.user_id);
  if (!user) return null;

  // Invalida il vecchio refresh token (rotation)
  db.prepare("DELETE FROM refresh_tokens WHERE id = ?").run(matchedRow.id);

  // Genera nuovi token
  const newAccessToken = generateAccessToken(user.id, user.email, user.address);
  const newRefreshToken = await generateRefreshToken(user.id);

  return { accessToken: newAccessToken, refreshToken: newRefreshToken, user };
}

/// Middleware Express: verifica il JWT nell'header Authorization.
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, error: "Token mancante" });
  }

  const token = authHeader.slice(7);
  const payload = verifyAccessToken(token);

  if (!payload) {
    return res.status(401).json({ success: false, error: "Token non valido o scaduto" });
  }

  req.user = payload;
  next();
}

module.exports = {
  sendMagicLink,
  verifyMagicLink,
  sendNewMatchesNotification,
  generateAccessToken,
  generateRefreshToken,
  rotateRefreshToken,
  requireAuth
};
