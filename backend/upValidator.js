// upValidator.js — verifica che un indirizzo sia una vera Universal Profile (LSP0)
// Interface ID LSP0ERC725Account = 0x24871b3d (da @lukso/lsp0-contracts, LSP0Constants.sol)
const { ethers } = require("ethers");
const { INTERFACE_ID_LSP0 } = require("@lukso/lsp0-contracts");

const provider = new ethers.JsonRpcProvider(process.env.LUKSO_RPC_URL, 42, { staticNetwork: true });
const ERC165_ABI = ["function supportsInterface(bytes4) view returns (bool)"];

/// Valida un indirizzo come Universal Profile: formato, presenza di codice on-chain,
/// e supporto dell'interfaccia LSP0 via ERC-165 (supportsInterface).
/// Ritorna { valid: true, address: <checksummed> } oppure { valid: false, reason: <string> }.
async function validateUPAddress(address) {
  if (!address || !ethers.isAddress(address)) {
    return { valid: false, reason: "invalid_format" };
  }
  const checksummed = ethers.getAddress(address);

  const code = await provider.getCode(checksummed);
  if (code === "0x") {
    return { valid: false, reason: "not_a_contract" };
  }

  try {
    const c = new ethers.Contract(checksummed, ERC165_ABI, provider);
    const isUP = await c.supportsInterface(INTERFACE_ID_LSP0);
    return isUP
      ? { valid: true, address: checksummed }
      : { valid: false, reason: "not_lsp0" };
  } catch {
    return { valid: false, reason: "call_failed" };
  }
}

module.exports = { validateUPAddress };
