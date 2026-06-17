import WebSocket from "ws";
import fetch from "node-fetch";

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const INGEST_URL = process.env.INGEST_URL; 
const INGEST_SECRET = process.env.INGEST_SECRET;

// Pump.fun program (critical filter)
const PUMPFUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

// simple in-memory dedupe (prevents spam loops)
const seen = new Set();

console.log("🚀 Larptek Pump.fun Helius Listener Starting...");
console.log("🔌 Connecting to Helius...");

const ws = new WebSocket(
  `wss://atlas-mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`
);

ws.on("open", () => {
  console.log("✅ Connected to Helius");

  const subscribeMsg = {
    jsonrpc: "2.0",
    id: 1,
    method: "logsSubscribe",
    params: [
      {
        mentions: [PUMPFUN_PROGRAM],
      },
      {
        commitment: "confirmed",
      },
    ],
  };

  console.log("📡 Subscribing to pump.fun logs...");
  ws.send(JSON.stringify(subscribeMsg));
});

ws.on("message", async (data) => {
  try {
    const msg = JSON.parse(data.toString());

    if (!msg?.params?.result?.value) return;

    const value = msg.params.result.value;
    const logs = value.logs || [];
    const signature = value.signature;

    if (!signature) return;

    // 🔁 DEDUPE
    if (seen.has(signature)) return;
    seen.add(signature);

    console.log("\n🔥 NEW EVENT");
    console.log("tx:", signature);

    // =========================
    // 1. LAUNCH CLASSIFIER
    // =========================

    const isPumpFunLaunch =
      logs.some(l => l.includes("Instruction: InitializeMint")) ||
      logs.some(l => l.includes("InitializeMint")) ||
      logs.some(l => l.includes("bonding curve")) ||
      logs.some(l => l.includes("Create"));

    if (!isPumpFunLaunch) {
      console.log("⏭ Not a launch event");
      return;
    }

    console.log("🚨 Pump.fun launch candidate detected");

    // =========================
    // 2. MINT EXTRACTION
    // =========================

    let mint = null;

    for (const line of logs) {
      const match = line.match(/Mint: ([A-Za-z0-9]+)/);
      if (match) {
        mint = match[1];
        break;
      }
    }

    // fallback (heuristic extraction)
    if (!mint) {
      const base58 = logs
        .join(" ")
        .match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g);

      if (base58?.length) {
        mint = base58[0];
      }
    }

    if (!mint) {
      console.log("⚠️ No mint found, skipping");
      return;
    }

    console.log("🧬 Mint:", mint);

    // =========================
    // 3. BASIC LAUNCH PAYLOAD
    // =========================

    const payload = {
      mint,
      signature,
      source: "helius_pumpfun_listener",
      logs: logs.slice(0, 10),
      timestamp: new Date().toISOString(),
    };

    // =========================
    // 4. INGEST TO BASE44
    // =========================

    console.log("📤 Sending to ingestRawLaunch...");

    const res = await fetch(INGEST_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-ingest-secret": INGEST_SECRET,
      },
      body: JSON.stringify(payload),
    });

    const text = await res.text();

    console.log("📨 Ingest response:", text);

  } catch (err) {
    console.error("❌ Error processing message:", err.message);
  }
});

ws.on("close", () => {
  console.log("❌ WebSocket closed — reconnect recommended");
});

ws.on("error", (err) => {
  console.error("❌ WebSocket error:", err.message);
});
