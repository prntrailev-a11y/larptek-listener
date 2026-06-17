import WebSocket from "ws";

// -----------------------------
// CONFIG
// -----------------------------
const HELIUS_KEY = process.env.HELIUS_KEY;

// Pump.fun program ID (mainnet)
const PUMP_PROGRAM_ID =
  "6EF8rrecthR5Dkzon8QwB6zQ1e3z1b9Yq8Fq3Y6Q6ZQp";

// RPC endpoints
const RPC_HTTP = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const RPC_WSS = `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

// Deduplication
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
// FETCH TRANSACTION (native fetch)
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

      if (programId === PUMP_PROGRAM_ID) {
        isPump = true;
      }

      const parsed = ix?.parsed;

      if (parsed?.type === "initializeMint") {
        mint = parsed?.info?.mint;
      }

      if (parsed?.type === "mintTo") {
        mint = parsed?.info?.mint;
      }
    }

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
// SAFE INGEST
// -----------------------------
async function ingestSafe(launch) {
  try {
    if (!launch?.mint || !launch?.signature) return;

    await ingestRawLaunch(launch);

    console.log("📦 ingested launch:", launch.mint);
  } catch (err) {
    console.error("❌ ingest error:", err.message);
  }
}

// -----------------------------
// INGEST PLACEHOLDER
// -----------------------------
async function ingestRawLaunch(launch) {
  console.log("➡️ ingestRawLaunch:", launch);
}

// -----------------------------
// RECONNECT
// -----------------------------
ws.on("close", () => {
  console.log("❌ WebSocket closed — restarting...");
  setTimeout(() => process.exit(1), 3000);
});

ws.on("error", (err) => {
  console.error("❌ WebSocket error:", err.message);
});
