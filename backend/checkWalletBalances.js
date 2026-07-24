// checkWalletBalances.js
// Controlla i saldi LYX (testnet) dei wallet sponsor e oracle, derivando
// l'indirizzo dalle chiavi private già presenti in backend/.env — nessun dato
// sensibile viene stampato, solo indirizzo pubblico e saldo.
//
// Uso (dalla cartella backend/, dove sta il .env):
//   node checkWalletBalances.js

require("dotenv").config();
const { ethers } = require("ethers");

const RPC_URL = process.env.LUKSO_RPC_URL || "https://rpc.testnet.lukso.network";

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL, 42, { staticNetwork: true });

  const wallets = {
    SPONSOR: process.env.SPONSOR_PRIVATE_KEY,
    ORACLE: process.env.ORACLE_PRIVATE_KEY
  };

  console.log(`RPC: ${RPC_URL}\n`);

  for (const [label, key] of Object.entries(wallets)) {
    if (!key) {
      console.log(`${label}: chiave non impostata in .env, salto.`);
      continue;
    }
    const wallet = new ethers.Wallet(key);
    const balanceWei = await provider.getBalance(wallet.address);
    const balanceLYX = ethers.formatEther(balanceWei);
    console.log(`${label}`);
    console.log(`  address: ${wallet.address}`);
    console.log(`  balance: ${balanceLYX} LYX`);
    if (Number(balanceLYX) < 1) {
      console.log(`  ⚠️  Saldo basso — considera di rifornirlo dal faucet LUKSO testnet.`);
    }
    console.log("");
  }
}

main().catch((err) => {
  console.error("Errore:", err.message);
  process.exitCode = 1;
});
