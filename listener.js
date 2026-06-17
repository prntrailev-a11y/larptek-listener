import WebSocket from "ws";

const HELIUS_KEY = process.env.HELIUS_KEY;

if (!HELIUS_KEY) {
  console.error("❌ Missing HELIUS_KEY");
  process.exit(1);
}

const WS_URL = `wss://atlas-mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

console.log("🚀 Larptek Listener Starting...");
console.log("🔌 Connecting:", WS_URL);

function connect() {
  const ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    console.log("✅ Connected to Helius");

    /**
     * ✅ VALID HELIUS FORMAT
     * We must use a SINGLE ADDRESS filter OR program filter
     *
     * For debugging, we use SYSTEM PROGRAM (always active)
     */

    const subscribeMsg = {
      jsonrpc: "2.0",
      id: 1,
      method: "logsSubscribe",
      params: [
        {
          mentions: [
            "11111111111111111111111111111111"
          ]
        },
        {
          commitment: "confirmed"
        }
      ]
    };

    console.log("📡 Subscribing to system program logs...");
    ws.send(JSON.stringify(subscribeMsg));

    console.log("⏳ Listening...");
  });

  ws.on("message", (raw) => {
    const msg = raw.toString();

    console.log("\n🔥 RAW EVENT:");
    console.log(msg.slice(0, 1500));
  });

  ws.on("close", () => {
    console.log("⚠️ Disconnected → reconnecting...");
    setTimeout(connect, 2000);
  });

  ws.on("error", (err) => {
    console.error("❌ WS error:", err.message);
    ws.close();
  });

  setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      console.log("💓 alive");
    }
  }, 10000);
}

connect();
