require("dotenv").config();
const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploy con address:", deployer.address);

  const ownerUP = process.env.OWNER_UP_ADDRESS;
  const oracle = process.env.ORACLE_ADDRESS;
  const sponsor = process.env.SPONSOR_ADDRESS;

  if (!ownerUP || !oracle || !sponsor) {
    throw new Error("Imposta OWNER_UP_ADDRESS, ORACLE_ADDRESS e SPONSOR_ADDRESS nel .env (valori MAINNET, non testnet!)");
  }

  console.log("Owner UP (mainnet):", ownerUP);
  console.log("Oracle (mainnet):  ", oracle);
  console.log("Sponsor (mainnet): ", sponsor);
  console.log("");
  console.log("⚠️  Questo deploy usa LYX vero. Verifica bene gli indirizzi sopra prima di continuare.");
  console.log("");

  const MatchPredictor = await ethers.getContractFactory("contracts/MatchPredictor-main-v1.sol:MatchPredictor");
  const contract = await MatchPredictor.deploy(
    "MatchPredictor Winners",
    "MPW",
    ownerUP,
    oracle,
    sponsor
  );

  await contract.waitForDeployment();
  const address = await contract.getAddress();

  console.log("✅ MatchPredictor (mainnet) deployato a:", address);
  console.log("Verifica su Blockscout:", `https://explorer.execution.mainnet.lukso.network/address/${address}`);
  console.log("");
  console.log("Prossimi passi:");
  console.log("1. Copia questo indirizzo in CONTRACT_ADDRESS nel .env del backend");
  console.log("2. Aggiorna CONFIG.CONTRACT_ADDRESS in frontend/index.html e frontend/admin.html");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
