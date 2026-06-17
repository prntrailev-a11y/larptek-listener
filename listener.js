import WebSocket from "ws";
import fetch from "node-fetch";

const HELIUS_KEY = process.env.HELIUS_KEY;

// Pump.fun program ID (mainnet)
const PUMP_PROGRAM_ID =
  "6EF8rrecthR5Dkzon8QwB6zQ1e3z1b9Yq8Fq3Y6Q6ZQp";

// Helius endpoints
const RPC_HTTP = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const RPC_WSS = `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

// Simple dedupe cache (prevents re-processing same tx)
const seenSignatures = new Set();

// -----------------------------
// START
// -----------------------------
console.log("🚀 Larptek Helius Pump.fun Listener Starting...");
console.log("🔌 Connecting to Helius...");

// -----------------------------
// WEBSOCKET
// -----------------------------
const ws = new WebSocket(RPC_WSS);

ws.on("open", () => {
  console.log("✅ WebSocket connected");

  ws.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "logsSubscribe",
      params: [
        {
          mentions: [PUMP_PROGRAM_ID],
        },
        {
          commitment: "processed",
        },
      ],
    })
  );
});

// -----------------------------
// MESSAGE HANDLER
// -----------------------------
ws.on("message", async (data) => {
  try {
    const msg = JSON.parse(data.toString());

    const result = msg?.params?.result;
    if (!result) return;

    const signature = result?.value?.signature;
    if (!signature) return;

    // dedupe
    if (seenSignatures.has(signature)) return;
    seenSignatures.add(signature);

    console.log(`\n🔥 TX: ${signature}`);

    const tx = await fetchTransaction(signature);
    if (!tx) return;

    const launch = extractLaunch(tx, signature);

    if (launch) {
      await ingestSafe(launch);
    }
  } catch (err) {
    console.error("❌ message error:", err.message);
  }
});

// -----------------------------
// FETCH TX
// -----------------------------
async function fetchTransaction(signature) {
  try {
    const res = await fetch(RPC_HTTP, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTransaction",
        params: [
          signature,
          {
            encoding: "jsonParsed",
            commitment: "processed",
            maxSupportedTransactionVersion: 0,
          },
        ],
      }),
    });

    const json = await res.json();
    return json?.result || null;
  } catch (err) {
    console.error("❌ fetchTransaction error:", err.message);
    return null;
  }
}

// -----------------------------
// LAUNCH EXTRACTION
// -----------------------------
function extractLaunch(tx, signature) {
  try {
    const instructions =
      tx?.transaction?.message?.instructions || [];

    let mint = null;
    let isPump = false;

    for (const ix of instructions) {
      const programId = ix?.programId?.toString?.();

      // Only care about pump.fun program
      if (programId === PUMP_PROGRAM_ID) {
        isPump = true;
      }

      // Extract mint from parsed token instructions
      const parsed = ix?.parsed;
      if (parsed?.type === "initializeMint") {
        mint = parsed?.info?.mint;
      }

      if (parsed?.type === "mintTo") {
        mint = parsed?.info?.mint;
      }
    }

    // HARD FILTER: must be pump.fun related
    if (!isPump) return null;

    if (!mint) {
      console.log("⚠️ pump tx but no mint found");
      return null;
    }

    console.log("🧬 mint:", mint);

    return {
      signature,
      mint,
      timestamp: Date.now(),
      source: "pump.fun",
    };
  } catch (err) {
    console.error("❌ extractLaunch error:", err.message);
    return null;
  }
}

// -----------------------------
// INGEST SAFE
// -----------------------------
async function ingestSafe(launch) {
  try {
    if (!launch?.mint || !launch?.signature) return;

    // replace this with your real pipeline
    await ingestRawLaunch(launch);

    console.log("📦 ingested launch:", launch.mint);
  } catch (err) {
    console.error("❌ ingest error:", err.message);
  }
}

// -----------------------------
// PLACEHOLDER INGEST FUNCTION
// -----------------------------
async function ingestRawLaunch(launch) {
  // Replace with DB / queue / API call
  console.log("➡️ ingestRawLaunch:", launch);
}

// -----------------------------
// RECONNECT
// -----------------------------
ws.on("close", () => {
  console.log("❌ WebSocket closed — reconnecting in 3s...");
  setTimeout(() => process.exit(1), 3000);
});

ws.on("error", (err) => {
  console.error("❌ WebSocket error:", err.message);
});
