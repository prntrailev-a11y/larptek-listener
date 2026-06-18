import { Connection } from "@solana/web3.js";

// ===== CONFIG =====
const RPC_URL = process.env.RPC_URL;
const connection = new Connection(RPC_URL, "confirmed");

// Optional: track processed txs to avoid duplicates
const seen = new Set();

// ===== LOG HELPERS =====
function log(...args) {
  console.log(`[LOG]`, ...args);
}

function warn(...args) {
  console.warn(`[WARN]`, ...args);
}

// ===== LAUNCH DETECTOR (FIXED) =====
function isLaunchTx(logs) {
  if (!logs || !Array.isArray(logs)) return false;

  const text = logs.join(" ").toLowerCase();

  const launchKeywords = [
    "initialize",
    "init mint",
    "initialize mint",
    "create",
    "create account",
    "initialize account",
    "mint",
    "bonding curve",
    "curve",
    "liquidity",
    "lp",
    "pool",
    "raydium",
    "openbook",
    "dex",
    "token created",
    "new token"
  ];

  const hasLaunchSignal = launchKeywords.some(k => text.includes(k));

  const isSellHeavy =
    text.includes("instruction: sell") ||
    text.includes("instruction: swap");

  const hasTokenPrograms =
    text.includes("tokenkeg") ||
    text.includes("tokenzq") ||
    text.includes("spl-token");

  const score =
    (hasLaunchSignal ? 2 : 0) +
    (hasTokenPrograms ? 1 : 0) +
    (isSellHeavy ? -2 : 0);

  const decision = score >= 2;

  log("🧠 Launch score:", score, "| decision:", decision);
  log("🧪 Signals:", {
    hasLaunchSignal,
    hasTokenPrograms,
    isSellHeavy,
  });

  return decision;
}

// ===== FETCH TX =====
async function getTx(signature) {
  try {
    const tx = await connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
    });

    if (!tx) {
      warn("No tx returned");
      return null;
    }

    return tx;
  } catch (err) {
    console.error("❌ Error fetching tx:", err.message);
    return null;
  }
}

// ===== PROCESS TX =====
async function processTx(signature) {
  if (seen.has(signature)) return;
  seen.add(signature);

  log("📩 TX RECEIVED:", signature);

  const tx = await getTx(signature);
  if (!tx) return;

  const logs = tx.meta?.logMessages;

  if (!logs) {
    warn("No logs found");
    return;
  }

  log("📜 Logs sample:", logs.slice(0, 8));

  const isLaunch = isLaunchTx(logs);

  if (!isLaunch) {
    log("⛔ Not a launch tx");
    return null;
  }

  log("🚀 LAUNCH DETECTED:", signature);

  // You can plug your bot / sniper logic here
  // e.g. send alert, execute trade, etc.
}

// ===== MOCK STREAM (replace with your websocket/subscription) =====
function startListener() {
  log("🚀 Listener started...");

  // Example: replace with real subscription
  connection.onLogs("all", async (logInfo) => {
    try {
      const signature = logInfo.signature;
      if (!signature) return;

      await processTx(signature);
    } catch (err) {
      console.error("❌ Listener error:", err.message);
    }
  });
}

// ===== START =====
startListener();
