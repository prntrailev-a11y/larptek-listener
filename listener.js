import WebSocket from "ws";

const HELIUS_KEY = process.env.HELIUS_KEY;

if (!HELIUS_KEY) {
  console.error("❌ Missing HELIUS_KEY in environment variables");
  process.exit(1);
}

const WS_URL = `wss://atlas-mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

console.log("🚀 Starting Helius debug listener...");
console.log("🔌 Connecting to:", WS_URL);

function connect() {
  const ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    console.log("✅ WebSocket connected");

    const subscribeMsg = {
      jsonrpc: "2.0",
      id: 1,
      method: "logsSubscribe",
      params: [
        {
          // FIREHOSE MODE (no filters)
          mentions: []
        },
        {
          commitment: "confirmed"
        }
      ]
    };

    console.log("📡 Sending subscription:");
    console.log(JSON.stringify(subscribeMsg, null, 2));

    ws.send(JSON.stringify(subscribeMsg));

    console.log("⏳ Listening for messages...");
  });

  ws.on("message", (raw) => {
    try {
      const msg = raw.toString();

      console.log("\n🔥 RAW MESSAGE RECEIVED:");
      console.log(msg.slice(0, 1000));

      // Try parse (optional safety)
      try {
        const parsed = JSON.parse(msg);

        if (parsed?.params?.result) {
          console.log("\n📦 PARSED EVENT:");
          console.log(JSON.stringify(parsed.params.result, null, 2));
        }
      } catch (e) {
        // ignore JSON parse errors
      }

    } catch (err) {
      console.error("❌ Message handling error:", err);
    }
  });

  ws.on("close", () => {
    console.log("⚠️ WebSocket closed. Reconnecting in 2s...");
    setTimeout(connect, 2000);
  });

  ws.on("error", (err) => {
    console.error("❌ WebSocket error:", err.message);
    ws.close();
  });

  // heartbeat (detect silent failure)
  const interval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      console.log("💓 heartbeat: ws alive");
    } else {
      console.log("⚠️ heartbeat: ws not open");
    }
  }, 10000);

  ws.on("close", () => clearInterval(interval));
}

connect();
