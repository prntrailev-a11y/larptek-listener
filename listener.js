import { Connection, clusterApiUrl } from "@solana/web3.js";

const connection = new Connection(process.env.RPC_URL || clusterApiUrl("mainnet-beta"), "confirmed");

// prevent duplicates
const processed = new Set();

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

async function getTxWithRetry(signature, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const tx = await connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });

      if (tx) return tx;
    } catch (e) {
      console.log(`[WARN] RPC error retry ${i + 1}:`, e.message);
    }

    await sleep(150 * (i + 1));
  }
  return null;
}

function isLaunchTx(logs = []) {
  if (!logs || !logs.length) return false;

  const text = logs.join(" ");

  const signals = [
    "Instruction: Sell",
    "Instruction: Buy",
    "TransferChecked",
    "GetFees",
    "pfee",
    "GMgn",
    "6EF8",
    "token program",
  ];

  let score = 0;

  for (const s of signals) {
    if (text.includes(s)) score++;
  }

  // require at least 2 signals for confidence
  return score >= 2;
}

function classifyTx(logs = []) {
  const text = logs.join(" ");

  if (text.includes("Instruction: Sell")) return "sell";
  if (text.includes("Instruction: Buy")) return "buy";
  if (text.includes("TransferChecked")) return "transfer";
  return "unknown";
}

// MAIN LISTENER
export async function handleSignature(signature) {
  if (processed.has(signature)) return;
  processed.add(signature);

  console.log(`[LOG] 🔎 Processing signature: ${signature}`);

  const tx = await getTxWithRetry(signature);

  if (!tx) {
    console.log("[WARN] No tx returned after retries");
    return;
  }

  const logs = tx?.meta?.logMessages || [];

  console.log("[LOG] 📜 Logs sample:", logs.slice(0, 10));

  if (!isLaunchTx(logs)) {
    console.log("[LOG] ⛔ Not a launch tx");
    return;
  }

  const type = classifyTx(logs);

  console.log(`[LOG] 🚀 LAUNCH DETECTED | Type: ${type}`);
  console.log(`[LOG] TX: ${signature}`);

  // 👉 PLACE YOUR ALERT / WEBHOOK HERE
  // await sendAlert({ signature, type, logs });
}
