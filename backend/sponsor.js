// sponsor.js — chiamate al contratto MatchPredictor v3 via chiave sponsor
// Lo sponsor paga il gas per conto degli utenti registrati via email.
// Non conosce mai i dati degli utenti — riceve solo address e parametri.

const { ethers } = require("ethers");

const RPC_URL = process.env.LUKSO_RPC_URL || "https://rpc.testnet.lukso.network";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const SPONSOR_PRIVATE_KEY = process.env.SPONSOR_PRIVATE_KEY;

const CONTRACT_ABI = [
  "function predictFor(uint256 matchId, uint8 predictedResult, address predictor) external",
  "function predictBatchFor(uint256[] matchIds, uint8[] predictedResults, address predictor) external",
  "function claimFor(uint256 matchId, address winner) external",
  "event PrizeClaimed(uint256 indexed matchId, address indexed winner, bytes32 tokenId)"
];

const Result = { HOME_WIN: 1, DRAW: 2, AWAY_WIN: 3 };

// Ritenta l'attesa della conferma se il controllo stesso fallisce per un
// intoppo di rete (visto oggi: thirdweb risponde male a eth_getTransactionReceipt
// mentre la transazione, già inviata con successo, sta semplicemente aspettando
// conferma). Sicuro da ripetere: non reinvia nulla, controlla solo lo stato di
// una transazione già partita — a differenza di ripetere l'invio, che sarebbe
// pericoloso.
async function waitWithRetry(tx, attempts = 3, delayMs = 2000) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await tx.wait();
    } catch (err) {
      lastErr = err;
      console.error(`Tentativo ${i}/${attempts} di conferma fallito per tx ${tx.hash}: ${err.message}`);
      if (i < attempts) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

function getSponsorContract() {
  const provider = new ethers.JsonRpcProvider(RPC_URL, 42, { staticNetwork: true, batchMaxCount: 1 });
  const wallet = new ethers.Wallet(SPONSOR_PRIVATE_KEY, provider);
  return new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, wallet);
}

/// Registra un singolo pronostico per conto dell'utente.
async function predictFor(matchId, predictedResult, predictorAddress) {
  const contract = getSponsorContract();
  const wallet = contract.runner;
  // Nonce esplicito da "pending", non dal default "latest" di ethers — senza
  // questo, un secondo pronostico inviato prima che il primo si confermi
  // riceverebbe lo stesso nonce del primo (ancora non "latest"), restando
  // bloccato finché quello non si conferma. Stesso principio già in uso per
  // claimForBatch, qui applicato al caso più comune: pronostici consecutivi.
  const nonce = await wallet.getNonce("pending");
  // gasLimit esplicito: alcuni proxy RPC (es. Blockscout) non stimano bene il
  // gas per le transazioni scritte — saltiamo eth_estimateGas del tutto.
  const tx = await contract.predictFor(matchId, predictedResult, predictorAddress, { gasLimit: 300000, nonce });
  const receipt = await waitWithRetry(tx);
  return { txHash: tx.hash, blockNumber: receipt.blockNumber };
}

/// Registra più pronostici per conto dello stesso utente in una sola transazione.
/// matchIds e predictedResults devono avere la stessa lunghezza.
async function predictBatchFor(matchIds, predictedResults, predictorAddress) {
  const contract = getSponsorContract();
  const wallet = contract.runner;
  const nonce = await wallet.getNonce("pending");
  const gasLimit = 100000 + matchIds.length * 120000;
  const tx = await contract.predictBatchFor(matchIds, predictedResults, predictorAddress, { gasLimit, nonce });
  const receipt = await waitWithRetry(tx);
  return { txHash: tx.hash, blockNumber: receipt.blockNumber };
}

/// Minta l'NFT premio per conto del vincitore.
/// Restituisce anche il tokenId dell'NFT mintato.
async function claimFor(matchId, winnerAddress) {
  const contract = getSponsorContract();
  const wallet = contract.runner;
  const nonce = await wallet.getNonce("pending");
  // Il mint LSP8 (con scrittura ERC725Y + notifica universalReceiver al
  // destinatario) è più pesante di una semplice scrittura: margine maggiore.
  const tx = await contract.claimFor(matchId, winnerAddress, { gasLimit: 1000000, nonce });
  const receipt = await waitWithRetry(tx);

  const iface = new ethers.Interface(CONTRACT_ABI);
  const event = receipt.logs
    .map(log => { try { return iface.parseLog(log); } catch { return null; } })
    .find(e => e?.name === "PrizeClaimed");

  const tokenId = event ? event.args.tokenId : null;
  return { txHash: tx.hash, blockNumber: receipt.blockNumber, tokenId };
}

/// Assegna il premio a più vincitori della STESSA partita, in parallelo a
/// gruppi limitati invece che uno alla volta in sequenza — con molti vincitori
/// (partita popolare) l'attesa sequenziale poteva far durare un intero giro
/// dell'oracolo più dei 30 minuti tra un cron e l'altro, rischiando che due
/// esecuzioni si sovrapponessero.
///
/// I nonce vengono assegnati esplicitamente in sequenza PRIMA di inviare le
/// transazioni di un gruppo: chiamare claimFor() più volte in parallelo senza
/// gestione manuale del nonce farebbe leggere a ognuna lo stesso "prossimo
/// nonce disponibile" dalla rete, causando transazioni in conflitto tra loro.
async function claimForBatch(matchId, winnerAddresses, concurrency = 5) {
  const contract = getSponsorContract();
  const wallet = contract.runner;
  const iface = new ethers.Interface(CONTRACT_ABI);
  const results = [];

  for (let i = 0; i < winnerAddresses.length; i += concurrency) {
    const batch = winnerAddresses.slice(i, i + concurrency);
    const startNonce = await wallet.getNonce("pending");

    const sent = await Promise.all(batch.map((winner, idx) =>
      contract.claimFor(matchId, winner, { gasLimit: 1000000, nonce: startNonce + idx })
        .then(tx => ({ winner, tx, error: null }))
        .catch(error => ({ winner, tx: null, error }))
    ));

    const confirmed = await Promise.all(sent.map(async (s) => {
      if (s.error) return { winner: s.winner, error: s.error.message };
      try {
        const receipt = await waitWithRetry(s.tx);
        const event = receipt.logs
          .map(log => { try { return iface.parseLog(log); } catch { return null; } })
          .find(e => e?.name === "PrizeClaimed");
        return {
          winner: s.winner, txHash: s.tx.hash, blockNumber: receipt.blockNumber,
          tokenId: event ? event.args.tokenId : null
        };
      } catch (error) {
        return { winner: s.winner, error: error.message };
      }
    }));

    results.push(...confirmed);
  }

  return results;
}

module.exports = { predictFor, predictBatchFor, claimFor, claimForBatch, Result };