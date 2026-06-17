


import WebSocket from "ws";

const BASE44_URL = process.env.BASE44_URL;
const INGEST_SECRET = process.env.INGEST_SECRET;

function connect() {
  console.log("Connecting to pump feed...");

  const ws = new WebSocket("wss://pumpdev.io/ws");

  ws.on("open", () => {
    console.log("Connected");
  });

  ws.on("message", async (raw) => {
    try {
      const data = JSON.parse(raw.toString());

      if (!data?.mint) return;

      console.log("Launch:", data.symbol);

      await fetch(BASE44_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-ingest-secret": INGEST_SECRET
        },
        body: JSON.stringify({
          mint: data.mint,
          symbol: data.symbol,
          name: data.name,
          launched: new Date().toISOString(),
          logo: data.image || null,
          source: "pumpdev"
        })
      });

    } catch (e) {
      console.error("Error:", e);
    }
  });

  ws.on("close", () => {
    console.log("Disconnected. Reconnecting...");
    setTimeout(connect, 3000);
  });

  ws.on("error", (e) => {
    console.error("WS error", e);
    ws.close();
  });
}

connect();
