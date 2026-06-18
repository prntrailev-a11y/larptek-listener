import 'dotenv/config';
import { Connection } from "@solana/web3.js";

// ======================
// CONFIG
// ======================

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const PUMPFUN_PROGRAM_ID = process.env.PUMPFUN_PROGRAM_ID;

const RPC_URL =
  process.env.RPC_URL ||
  (HELIUS_API_KEY
    ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`
    : null);

if (!RPC_URL || !RPC_URL.startsWith("http")) {
  throw new Error("Missing or invalid RPC_URL / HELIUS_API_KEY");
}

const connection = new Connection(RPC_URL, {
  commitment: "confirmed",
});

console.log("✅ Level 2 Pump.fun Listener Started");
console.log("🔗 RPC connected");

// ======================
// HELPERS
// ======================

function isPumpLaunch(logs) {
  const text = logs.join(" ").toLowerCase();

  // heuristic pattern detection (this is the “edge” logic)
  const patterns = [
    "initialize",
    "mint",
    "create",
    "initialize mint",
    "initializeaccount",
    "spl token",
    "create account",
  ];

  return patterns.some(p => text.includes(p));
}

function scoreEvent(logs) {
  const text = logs.join(" ").toLowerCase();

  let score = 0;

  if (text.includes("initialize")) score += 3;
  if (text.includes("mint")) score += 3;
  if (text.includes("create")) score += 2;
  if (text.includes("spl")) score += 1;

  // noise reduction penalty
  if (text.includes("error")) score -= 5;

  return score;
}

// ======================
// HEARTBEAT
// ======================

setInterval(async () => {
  try {
    const slot = await connection.getSlot();
    console.log("📡 Slot:", slot);
  } catch (e) {
    console.error("slot error:", e.message);
  }
}, 10000);

// ======================
// MAIN LISTENER
// ======================

function handleLog(logInfo) {
  const logs = logInfo.logs || [];

  if (!logs.length) return;

  const signature = logInfo.signature;
  const text = logs.join(" ");

  const isLaunch = isPumpLaunch(logs);
  const score = scoreEvent(logs);

  if (score >= 3 || isLaunch) {
    console.log("\n🚨🚨 POSSIBLE NEW TOKEN LAUNCH");
    console.log("Signature:", signature);
    console.log("Score:", score);
    console.log("Preview logs:", logs.slice(0, 6));

    // optional: future hook (send to API / Discord / bot)
    // sendSignal({ signature, score, logs });
  }
}

// ======================
// MODE 1: Pump.fun program tracking
// ======================

if (PUMPFUN_PROGRAM_ID) {
  console.log("🚀 Tracking Pump.fun Program:", PUMPFUN_PROGRAM_ID);

  connection.onLogs(
    PUMPFUN_PROGRAM_ID,
    (logInfo) => handleLog(logInfo),
    "confirmed"
  );
}

// ======================
// MODE 2: GLOBAL fallback scan
// ======================

else {
  console.log("⚠️ No program ID set — using global scan mode");

  connection.onLogs(
    "all",
    (logInfo) => handleLog(logInfo),
    "confirmed"
  );
}
