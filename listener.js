import WebSocket from "ws";

const HELIUS_KEY = process.env.HELIUS_KEY;

if (!HELIUS_KEY) {
  console.error("❌ Missing HELIUS_KEY");
  process.exit(1);
}

const WS_URL = `wss://atlas-mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

console.log("🚀 Larptek Helius Listener Starting...");
console.log("🔌 Connecting:", WS_URL);

function connect() {
  const ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    console.log("✅ Connected to Helius");

    /**
     * ✅ VALID HELIUS logsSubscribe FORMAT
     * We MUST provide a real filter structure
     */

    const subscribeMsg = {
      jsonrpc: "2.0",
      id: 1,
      method: "logsSubscribe",
      params: [
        {
          // OPTION 1: all transaction logs (valid)
          mentions: []
        },
        {
          commitment: "confirmed"
        }
      ]
    };

    console.log("📡 Sending logsSubscribe...");
    ws.send(JSON.stringify(subscribeMsg));

    console.log("⏳ Listening for logs...");
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
      console.log("💓 heartbeat alive");
    }
  }, 10000);
}

connect();
