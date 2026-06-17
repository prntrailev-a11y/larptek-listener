import WebSocket from "ws";

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const INGEST_URL = process.env.INGEST_URL;
const INGEST_SECRET = process.env.INGEST_SECRET;

// Pump.fun program ID (primary filter)
const PUMPFUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

// basic dedupe layer (prevents duplicate processing from WS retries)
const seen = new Set();

console.log("🚀 Larptek Helius Pump.fun Listener Starting...");
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

    const value = msg?.params?.result?.value;
    if (!value) return;

    const logs = value.logs || [];
    const signature = value.signature;

    if (!signature) return;

    // dedupe
    if (seen.has(signature)) return;
    seen.add(signature);

    console.log("\n🔥 EVENT");
    console.log("tx:", signature);

    // -----------------------------
    // 1. LAUNCH CLASSIFIER
    // -----------------------------

    const isLaunch =
      logs.some(l => l.includes("InitializeMint")) ||
      logs.some(l => l.includes("Initialize mint")) ||
      logs.some(l => l.includes("bonding curve")) ||
      logs.some(l => l.includes("Create")) ||
      logs.some(l => l.includes("create"));

    if (!isLaunch) {
      console.log("⏭ Not a launch event");
      return;
    }

    console.log("🚨 Pump.fun launch detected");

    // -----------------------------
    // 2. MINT EXTRACTION
    // -----------------------------

    let mint = null;

    // explicit mint pattern
    for (const line of logs) {
      const match = line.match(/Mint: ([A-Za-z0-9]+)/);
      if (match) {
        mint = match[1];
        break;
      }
    }

    // fallback heuristic extraction
    if (!mint) {
      const matches = logs
        .join(" ")
        .match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g);

      if (matches?.length) {
        mint = matches[0];
      }
    }

    if (!mint) {
      console.log("⚠️ No mint found — skipping");
      return;
    }

    console.log("🧬 Mint:", mint);

    // -----------------------------
    // 3. PAYLOAD BUILD
    // -----------------------------

    const payload = {
      mint,
      signature,
      source: "helius_pumpfun_listener",
      logs: logs.slice(0, 15),
      timestamp: new Date().toISOString(),
    };

    // -----------------------------
    // 4. INGEST TO BASE44
    // -----------------------------

    console.log("📤 Sending to Base44 ingest...");

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
    console.error("❌ Listener error:", err.message);
  }
});

ws.on("close", () => {
  console.log("❌ WebSocket closed — consider auto-reconnect");
});

ws.on("error", (err) => {
  console.error("❌ WebSocket error:", err.message);
});
