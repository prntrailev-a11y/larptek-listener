import WebSocket from "ws";

// ================= CONFIG =================
const HELIUS_KEY = process.env.HELIUS_KEY;
const INGEST_URL = process.env.INGEST_URL;
const INGEST_SECRET = process.env.INGEST_SECRET;

// pump.fun program id
const PUMP_FUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

// ================= HELPERS =================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parse(msg) {
  try {
    return JSON.parse(msg);
  } catch {
    return null;
  }
}

// extract mint-like base58 string from logs
function extractMint(logs = []) {
  for (const l of logs) {
    const match = l.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
    if (match) return match[0];
  }
  return null;
}

// simple signal scoring
function classify(logs = []) {
  const text = logs.join(" ").toLowerCase();

  let score = 0;
  if (text.includes("initialize")) score += 2;
  if (text.includes("mint")) score += 2;
  if (text.includes("create")) score += 1;
  if (text.includes("buy")) score += 3;

  return score >= 5;
}

// send to base44
async function ingest(payload) {
  try {
    await fetch(INGEST_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-ingest-secret": INGEST_SECRET,
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.log("ingest error:", e.message);
  }
}

// ================= MAIN =================
function start() {
  console.log("🚀 Starting Larptek Helius Listener...");

  const ws = new WebSocket(
    `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`
  );

  ws.on("open", () => {
    console.log("✅ Connected to Helius");

    // ✅ CORRECT logsSubscribe format (THIS FIXES YOUR ERRORS)
    const subscribeMsg = {
      jsonrpc: "2.0",
      id: 1,
      method: "logsSubscribe",
      params: [
        {
          mentions: [PUMP_FUN_PROGRAM]
        },
        {
          commitment: "confirmed"
        }
      ]
    };

    console.log("📡 Subscribing to pump.fun logs...");
    ws.send(JSON.stringify(subscribeMsg));
  });

  ws.on("message", async (data) => {
    const msg = parse(data.toString());
    if (!msg?.params?.result?.value) return;

    const value = msg.params.result.value;
    const logs = value.logs || [];
    const signature = value.signature;

    console.log("\n🔥 TX:", signature);

    const isLaunch = classify(logs);
    if (!isLaunch) return;

    const mint = extractMint(logs);

    console.log("🧬 mint:", mint);

    await ingest({
      mint,
      signature,
      logs,
      detected_at: new Date().toISOString(),
      source: "helius_pump_listener"
    });
  });

  ws.on("close", async () => {
    console.log("❌ WS closed — reconnecting...");
    await sleep(3000);
    start();
  });

  ws.on("error", (err) => {
    console.log("❌ WS error:", err.message);
  });
}

start();
