import WebSocket from "ws";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const BASE44_URL =
  "https://wooden-smart-coin-track.base44.app/api/functions/ingestRawLaunch";

const INGEST_SECRET = process.env.INGEST_SECRET;

const PUMPFUN_PROGRAM =
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

const RPC_URL =
  `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const seen = new Set();

function dedupe(sig) {
  if (seen.has(sig)) return true;
  seen.add(sig);
  setTimeout(() => seen.delete(sig), 60 * 60 * 1000);
  return false;
}

/**
 * Pull full parsed tx from Helius
 */
async function fetchTx(signature) {
  try {
    const res = await axios.post(RPC_URL, {
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: [
        signature,
        {
          encoding: "jsonParsed",
          maxSupportedTransactionVersion: 0
        }
      ]
    });

    return res.data?.result;
  } catch (e) {
    console.error("TX fetch error:", e.message);
    return null;
  }
}

/**
 * Extract pump.fun launch info
 * NOTE: Pump.fun mints are usually first account created in tx
 */
function extractPumpLaunch(tx) {
  try {
    const msg = tx?.transaction?.message;
    const keys = msg?.accountKeys || [];

    const creator =
      keys?.[0]?.pubkey || keys?.[0] || null;

    const mint =
      keys?.find(k =>
        typeof k === "object" ? k.pubkey : k
      )?.pubkey ||
      keys?.[1]?.pubkey ||
      null;

    const symbol =
      "PUMP"; // placeholder (Base44 requires it)

    const name =
      "Pump Token";

    return {
      mint,
      creator,
      symbol,
      name,
      launched: tx.blockTime
        ? new Date(tx.blockTime * 1000).toISOString()
        : new Date().toISOString()
    };
  } catch (e) {
    console.error("extract error:", e);
    return null;
  }
}

/**
 * Send to Base44 ingestion endpoint
 */
async function sendToBase44(payload) {
  try {
    await axios.post(BASE44_URL, payload, {
      headers: {
        "Content-Type": "application/json",
        "x-ingest-secret": INGEST_SECRET
      }
    });
  } catch (e) {
    console.error(
      "Base44 error:",
      e.response?.data || e.message
    );
  }
}

function connect() {
  console.log("Connecting to Helius...");

  const ws = new WebSocket(
    `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`
  );

  ws.on("open", () => {
    console.log("Connected");

    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "logsSubscribe",
        params: [
          { mentions: [PUMPFUN_PROGRAM] },
          { commitment: "confirmed" }
        ]
      })
    );
  });

  ws.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw);
      const value = msg?.params?.result?.value;

      if (!value?.signature) return;

      const sig = value.signature;

      if (dedupe(sig)) return;

      const logs = value.logs || [];

      const isLaunch = logs.some(l =>
        l.toLowerCase().includes("initialize")
      );

      if (!isLaunch) return;

      console.log("Pump launch:", sig);

      const tx = await fetchTx(sig);
      if (!tx) return;

      const launch = extractPumpLaunch(tx);
      if (!launch?.mint) return;

      await sendToBase44({
        mint: launch.mint,
        name: launch.name,
        symbol: launch.symbol,
        mcap: 0,
        launched: launch.launched
      });

      console.log("Sent to Base44:", launch.mint);
    } catch (e) {
      console.error(e.message);
    }
  });

  ws.on("close", () => {
    console.log("Reconnecting...");
    setTimeout(connect, 5000);
  });

  ws.on("error", (e) => {
    console.error("WS error:", e.message);
    ws.close();
  });
}

connect();
