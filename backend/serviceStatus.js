// serviceStatus.js — interruttori di servizio letti dal .env.
//
// Default "chiuso": se la variabile non è impostata a "true", le iscrizioni
// di nuovi utenti sono chiuse e nessuna chiamata RPC verso il nodo LUKSO
// viene fatta (né dal backend, né dal proxy /api/rpc, né dall'oracolo).
// Per riaprire basta impostare nel backend/.env:
//   REGISTRATIONS_OPEN=true
//   RPC_ENABLED=true
// e riavviare il backend.

function flag(name) {
  return String(process.env[name] || "").trim().toLowerCase() === "true";
}

function registrationsOpen() {
  return flag("REGISTRATIONS_OPEN");
}

function rpcEnabled() {
  return flag("RPC_ENABLED");
}

class RpcDisabledError extends Error {
  constructor() {
    super("Chiamate RPC disabilitate (RPC_ENABLED non attivo)");
    this.code = "RPC_DISABLED";
  }
}

function assertRpcEnabled() {
  if (!rpcEnabled()) throw new RpcDisabledError();
}

module.exports = { registrationsOpen, rpcEnabled, assertRpcEnabled, RpcDisabledError };
