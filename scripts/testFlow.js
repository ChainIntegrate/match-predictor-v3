require("dotenv").config();
const { ethers } = require("hardhat");

const CONTRACT_ADDRESS = "0xE7EFa63E4923626274fbb18319aC4C57377c7BBf";

const CONTRACT_ABI = [
  "function createMatchBatch(string[] teamHomes, string[] teamAways, uint256[] predictionDeadlines) external returns (uint256[])",
  "function predictFor(uint256 matchId, uint8 predictedResult, address predictor) external",
  "function reportResult(uint256 matchId, uint8 actualResult) external",
  "function claimFor(uint256 matchId, address winner) external",
  "function getMatch(uint256 matchId) external view returns (tuple(string teamHome, string teamAway, uint256 predictionDeadline, bool resolved, uint8 actualResult, bool exists))",
  "function predictions(uint256 matchId, address wallet) external view returns (uint8)",
  "function claimed(uint256 matchId, address wallet) external view returns (bool)",
  "function getDataForTokenId(bytes32 tokenId, bytes32 dataKey) external view returns (bytes memory)",
  "event MatchCreated(uint256 indexed matchId, string teamHome, string teamAway, uint256 predictionDeadline)",
  "event PredictionMade(uint256 indexed matchId, address indexed predictor, uint8 predictedResult)",
  "event PrizeClaimed(uint256 indexed matchId, address indexed winner, bytes32 tokenId)"
];

const TOKEN_STORY_KEY = "0xc345e2857e55742bc896212b499925391cc94c97152776066ccf64e4df74ee09";
const Result = { NONE: 0, HOME_WIN: 1, DRAW: 2, AWAY_WIN: 3 };

async function main() {
  const provider = new ethers.JsonRpcProvider("https://rpc.testnet.lukso.network");

  const oracleWallet = new ethers.Wallet(process.env.ORACLE_PRIVATE_KEY, provider);
  const sponsorWallet = new ethers.Wallet(process.env.SPONSOR_PRIVATE_KEY, provider);
  const ownerWallet = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);

  // Indirizzo utente fittizio (simuliamo un utente registrato via email)
  const fakeUser = ethers.Wallet.createRandom();
  console.log("Utente fittizio (email user):", fakeUser.address);

  const contractAsOwner = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, ownerWallet);
  const contractAsOracle = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, oracleWallet);
  const contractAsSponsor = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, sponsorWallet);

  // --- 1. createMatchBatch ---
  console.log("\n1️⃣  Creazione batch di 2 partite...");
  const now = Math.floor(Date.now() / 1000);
  const deadline = now + 3600; // 1 ora da ora

  const tx1 = await contractAsOwner.createMatchBatch(
    ["Italy", "Spain"],
    ["Brazil", "Germany"],
    [deadline, deadline]
  );
  const receipt1 = await tx1.wait();
  const events = receipt1.logs
    .map(log => { try { return contractAsOwner.interface.parseLog(log); } catch { return null; } })
    .filter(e => e?.name === "MatchCreated");

  const matchId1 = events[0]?.args.matchId;
  const matchId2 = events[1]?.args.matchId;
  console.log(`  ✅ Creati matchId ${matchId1} (Italy vs Brazil) e ${matchId2} (Spain vs Germany)`);

  // --- 2. predictFor ---
  console.log("\n2️⃣  Pronostico per conto dell'utente fittizio...");
  const tx2 = await contractAsSponsor.predictFor(matchId1, Result.HOME_WIN, fakeUser.address);
  await tx2.wait();
  const stored = await contractAsSponsor.predictions(matchId1, fakeUser.address);
  console.log(`  ✅ Pronostico registrato: ${stored} (atteso: ${Result.HOME_WIN} = HOME_WIN)`);

  // --- 3. reportResult ---
  console.log("\n3️⃣  Oracle riporta il risultato (Italy vince)...");
  const tx3 = await contractAsOracle.reportResult(matchId1, Result.HOME_WIN);
  await tx3.wait();
  const match = await contractAsOracle.getMatch(matchId1);
  console.log(`  ✅ Risultato on-chain: ${match.actualResult} (resolved: ${match.resolved})`);

  // --- 4. claimFor ---
  console.log("\n4️⃣  Claim NFT per conto del vincitore...");
  const tx4 = await contractAsSponsor.claimFor(matchId1, fakeUser.address);
  const receipt4 = await tx4.wait();
  const claimEvent = receipt4.logs
    .map(log => { try { return contractAsSponsor.interface.parseLog(log); } catch { return null; } })
    .find(e => e?.name === "PrizeClaimed");

  const tokenId = claimEvent?.args.tokenId;
  console.log(`  ✅ NFT mintato! TokenId: ${tokenId}`);

  // --- 5. Verifica token story on-chain ---
  console.log("\n5️⃣  Lettura token story on-chain...");
  const storyBytes = await contractAsSponsor.getDataForTokenId(tokenId, TOKEN_STORY_KEY);
  const story = ethers.toUtf8String(storyBytes);
  console.log(`  ✅ Token story: "${story}"`);
  console.log(`  Atteso formato: "matchId|teamHome|teamAway|result"`);

  console.log("\n🎉 Test completato con successo!");
}

main().catch(err => {
  console.error("❌ Errore:", err.message);
  process.exitCode = 1;
});
