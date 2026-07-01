// keys.js — generazione EOA e cifratura/decifratura AES-256-GCM
// Le chiavi private degli utenti non vengono mai salvate in chiaro:
// vengono cifrate con AES-256-GCM usando una master key dal .env,
// e salvate come stringa "iv:authTag:ciphertext" nel database.

const crypto = require("crypto");
const { ethers } = require("ethers");

const ALGORITHM = "aes-256-gcm";
const MASTER_KEY = Buffer.from(process.env.ENCRYPTION_KEY, "hex"); // 32 byte hex

if (MASTER_KEY.length !== 32) {
  throw new Error("ENCRYPTION_KEY deve essere una stringa hex di 64 caratteri (32 byte).");
}

/// Genera una nuova EOA casuale e restituisce address e chiave privata cifrata.
function generateUserWallet() {
  const wallet = ethers.Wallet.createRandom();
  return {
    address: wallet.address,
    encryptedPrivateKey: encrypt(wallet.privateKey)
  };
}

/// Cifra una stringa con AES-256-GCM. Ritorna "iv:authTag:ciphertext" in hex.
function encrypt(plaintext) {
  const iv = crypto.randomBytes(12); // 96 bit IV per GCM
  const cipher = crypto.createCipheriv(ALGORITHM, MASTER_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, encrypted].map(b => b.toString("hex")).join(":");
}

/// Decifra una stringa cifrata con encrypt(). Lancia errore se il dato è corrotto.
function decrypt(encryptedData) {
  const [ivHex, authTagHex, ciphertextHex] = encryptedData.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");

  const decipher = crypto.createDecipheriv(ALGORITHM, MASTER_KEY, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/// Restituisce un ethers.Wallet pronto a firmare, dato l'encryptedPrivateKey dal DB.
function getWalletFromEncrypted(encryptedPrivateKey, provider) {
  const privateKey = decrypt(encryptedPrivateKey);
  return new ethers.Wallet(privateKey, provider);
}

/// Genera una ENCRYPTION_KEY casuale sicura (da usare una sola volta per crearla).
function generateEncryptionKey() {
  return crypto.randomBytes(32).toString("hex");
}

module.exports = { generateUserWallet, encrypt, decrypt, getWalletFromEncrypted, generateEncryptionKey };
