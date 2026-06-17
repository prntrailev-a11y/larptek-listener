import { Connection, PublicKey } from "@solana/web3.js";

// =====================
// ENV CHECK
// =====================
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

if (!HELIUS_API_KEY) {
  throw new Error("Missing HELIUS_API_KEY");
}

// =====================
// CONFIG
// =====================
const HELIUS_WSS = `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

// Pump.fun program (commonly used ID)
const PUMPFUN_PROGRAM_ID = new PublicKey(
  "6EF8rrecthX6a2L1F8qKpK7R7p3z6c3w1vG6v6V8pump"
);

// SPL Token Program (for mint detection)
const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);

// =====================
// CONNECTION
// =====================
const connection = new Connection(HELIUS_WSS, {
  commitment: "confirmed",
});

console.log("🚀 Pump.fun listener (true activity mode) running...");
console.log("🔌 Connecting to Helius...");

// =====================
// HELPERS
// =====================
function isMintLog(logs) {
  return logs.some((log) =>
    log.includes("InitializeMint") ||
    log.includes("initializeMint")
  );
}

function isPumpFunLog(logs) {
  return logs.some((log) =>
    log.toLowerCase().includes("pump") ||
    log.toLowerCase().includes("mint")
  );
}

// =====================
// MAIN LISTENERS
// =====================

// 1. Pump.fun program activity
connection.onLogs(
  PUMPFUN_PROGRAM_ID,
  (logInfo) => {
    console.log("🔥 Pump.fun activity detected");
    console.log(logInfo.signature);
  },
  "confirmed"
);

// 2. Global mint detection (SPL Token Program)
connection.onLogs(
  TOKEN_PROGRAM_ID,
  (logInfo) => {
    const logs = logInfo.logs || [];

    if (isMintLog(logs)) {
      console.log("🪙 New mint detected");
      console.log("📊 Log match: initializeMint");
      console.log(logInfo.signature);
    }
  },
  "confirmed"
);

// 3. Backup broad filter (catches weird Pump.fun variants)
connection.onLogs(
  "all",
  (logInfo) => {
    const logs = logInfo.logs || [];

    if (isPumpFunLog(logs)) {
      console.log("🔥 Pump.fun activity detected");
      console.log(logInfo.signature);
    }
  },
  "confirmed"
);

// =====================
// CONNECTION STATUS
// =====================
connection._rpcWebSocket.on("open", () => {
  console.log("✅ WebSocket connected");
});

connection._rpcWebSocket.on("error", (err) => {
  console.error("❌ WebSocket error:", err);
});

connection._rpcWebSocket.on("close", () => {
  console.log("⚠️ WebSocket closed — reconnect recommended");
});
