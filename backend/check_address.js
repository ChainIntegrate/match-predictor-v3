require("dotenv").config();
const { ethers } = require("ethers");

const ADDRESS_TO_CHECK = "0x4e310b...0034d5"; // <-- sostituisci con l'indirizzo completo

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.LUKSO_RPC_URL || "https://rpc.testnet.lukso.network");
  const code = await provider.getCode(ADDRESS_TO_CHECK);
  console.log("Indirizzo:", ADDRESS_TO_CHECK);
  console.log("Ha codice (è un contratto/UP)?", code !== "0x");
  console.log("Balance:", ethers.formatEther(await provider.getBalance(ADDRESS_TO_CHECK)), "LYX");
}
main().catch(e => console.error(e.message));
