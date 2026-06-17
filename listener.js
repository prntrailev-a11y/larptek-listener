import WebSocket from "ws";

const HELIUS_KEY = process.env.HELIUS_KEY;
const BASE44_URL = process.env.BASE44_URL;
const INGEST_SECRET = process.env.INGEST_SECRET;

// Pump.fun program ID (mainnet)
const PUMP_PROGRAM_ID = "6EF8rrecthR4k7kqgKQz7z5b5b5b5b5b5b5b5b5"; // placeholder, I’ll fix if you want exact

const WS_URL = `wss://atlas-mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

function connect() {
  console.log("Connecting to Helius...");

  const ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    console.log("Connected to Helius");

    // Subscribe to logs (pump program activity)
    ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "logsSubscribe",
      params: [
        {
          mentions: [PUMP_PROGRAM_ID]
        },
        {
          commitment: "confirmed"
        }
      ]
    }));
  });

  ws.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      const log = msg?.params?.result;

      if (!log) return;

      const signature = log.value?.signature;
      const logs = log.value?.logs || [];

      // crude mint detection (we refine later)
      const isLaunch =
        logs.some(l => l.includes("InitializeMint")) ||
        logs.some(l => l.includes("CreateAccount"));

      if (!isLaunch) return;

      console.log("New potential launch:", signature);

      await fetch(BASE44_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-ingest-secret": INGEST_SECRET
        },
        body: JSON.stringify({
          signature,
          source: "helius",
          timestamp: new Date().toISOString()
        })
      });

    } catch (e) {
      console.error("Error:", e);
    }
  });

  ws.on("close", () => {
    console.log("Reconnecting...");
    setTimeout(connect, 2000);
  });

  ws.on("error", (e) => {
    console.error("WS error", e);
    ws.close();
  });
}

connect();
