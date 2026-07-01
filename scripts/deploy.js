require("dotenv").config();
const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploy con address:", deployer.address);

  const ownerUP = process.env.OWNER_UP_ADDRESS;
  const oracle = process.env.ORACLE_ADDRESS;
  const sponsor = process.env.SPONSOR_ADDRESS;

  if (!ownerUP || !oracle || !sponsor) {
    throw new Error("Imposta OWNER_UP_ADDRESS, ORACLE_ADDRESS e SPONSOR_ADDRESS nel .env");
  }

  console.log("Owner UP:", ownerUP);
  console.log("Oracle:", oracle);
  console.log("Sponsor:", sponsor);

  const MatchPredictor = await ethers.getContractFactory("contracts/MatchPredictor-v3.sol:MatchPredictor");
  const contract = await MatchPredictor.deploy(
    "MatchPredictor Winners",
    "MPW",
    ownerUP,
    oracle,
    sponsor
  );

  await contract.waitForDeployment();
  const address = await contract.getAddress();

  console.log("✅ MatchPredictor deployato a:", address);
  console.log("Verifica su Blockscout:", `https://explorer.execution.testnet.lukso.network/address/${address}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
