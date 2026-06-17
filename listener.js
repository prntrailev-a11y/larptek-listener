import WebSocket from "ws";

const HELIUS_KEY = process.env.HELIUS_KEY;

if (!HELIUS_KEY) {
  console.error("❌ Missing HELIUS_KEY");
  process.exit(1);
}

// Helius WS endpoint
const WS_URL = `wss://atlas-mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

console.log("🚀 Starting Larptek Helius Listener...");
console.log("🔌 Connecting:", WS_URL);

function connect() {
  const ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    console.log("✅ WebSocket connected");

    /**
     * VALID HELIUS SUBSCRIPTION:
     * We use transactionsSubscribe with broad filters
     */
    const subscribeMsg = {
      jsonrpc: "2.0",
      id: 1,
      method: "transactionsSubscribe",
      params: [
        {
          vote: false,
          failed: false,
          accountInclude: [] // empty = all accounts (firehose mode)
        },
        {
          commitment: "confirmed",
          encoding: "jsonParsed",
          transactionDetails: "full",
          showRewards: false,
          maxSupportedTransactionVersion: 0
        }
      ]
    };

    console.log("📡 Sending subscription...");
    console.log(JSON.stringify(subscribeMsg, null, 2));

    ws.send(JSON.stringify(subscribeMsg));

    console.log("⏳ Listening for Solana transactions...");
  });

  ws.on("message", (raw) => {
    try {
      const msg = raw.toString();

      console.log("\n🔥 RAW EVENT RECEIVED:");
      console.log(msg.slice(0, 1500));

      try {
        const parsed = JSON.parse(msg);

        if (parsed?.params?.result) {
          console.log("\n📦 TRANSACTION DATA:");
          console.log(JSON.stringify(parsed.params.result, null, 2));
        }
      } catch (e) {
        // ignore parse errors
      }

    } catch (err) {
      console.error("❌ Error handling message:", err);
    }
  });

  ws.on("close", () => {
    console.log("⚠️ WS closed → reconnecting...");
    setTimeout(connect, 2000);
  });

  ws.on("error", (err) => {
    console.error("❌ WS error:", err.message);
    ws.close();
  });

  // heartbeat
  setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      console.log("💓 heartbeat: alive");
    } else {
      console.log("⚠️ heartbeat: not connected");
    }
  }, 10000);
}

connect();
