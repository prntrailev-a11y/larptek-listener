import WebSocket from "ws";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

console.log("🔥 LISTENER BOOTED");

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const INGEST_SECRET = process.env.INGEST_SECRET;

const BASE44_URL =
  "https://wooden-smart-coin-track.base44.app/api/functions/ingestRawLaunch";

const PUMPFUN_PROGRAM =
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

const RPC_URL =
  `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const seen = new Set();

/* ---------------- DEDUPE ---------------- */
function dedupe(sig) {
  if (seen.has(sig)) return true;
  seen.add(sig);
  setTimeout(() => seen.delete(sig), 60 * 60 * 1000);
  return false;
}

/* ---------------- FETCH TX ---------------- */
async function getTx(signature) {
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
  } catch (err) {
    console.error("❌ getTx error:", err.message);
    return null;
  }
}

/* ---------------- TRUE MINT EXTRACTOR ---------------- */
function extractMint(tx) {
  let mint = null;

  const post = tx?.meta?.postTokenBalances || [];
  const pre = tx?.meta?.preTokenBalances || [];

  // 1. strongest signal
  if (post.length > 0) {
    mint = post[0].mint;
  }

  // 2. fallback diff scan
  if (!mint) {
    const all = [...pre, ...post];
    mint = all.find(x => x?.mint)?.mint || null;
  }

  return mint;
}

/* ---------------- SNIPER DETECTION ---------------- */
function getSnipers(tx, mint) {
  const post = tx?.meta?.postTokenBalances || [];

  const holders = [];

  for (const p of post) {
    if (p.mint === mint && p.owner) {
      holders.push(p.owner);
    }
  }

  return [...new Set(holders)].slice(0, 10);
}

/* ---------------- SCORING ENGINE ---------------- */
function scoreRunner(tx, snipers, decoded) {
  let score = 0;

  if (tx.meta?.postTokenBalances?.length > 0) score += 20;

  if (snipers.length <= 3) score += 25;
  else if (snipers.length <= 7) score += 15;
  else score += 5;

  const creator = decoded.creator;
  if (!snipers.includes(creator)) score += 15;

  if (tx.blockTime) {
    const age = Date.now() - tx.blockTime * 1000;

    if (age < 60_000) score += 20;
    else if (age < 300_000) score += 10;
  }

  return Math.min(score, 100);
}

/* ---------------- BASE44 PUSH ---------------- */
async function sendToBase44(payload) {
  try {
    await axios.post(BASE44_URL, payload, {
      headers: {
        "Content-Type": "application/json",
        "x-ingest-secret": INGEST_SECRET
      }
    });

    console.log("📤 Sent to Base44");
  } catch (err) {
    console.error("❌ Base44 error:", err.response?.data || err.message);
  }
}

/* ---------------- MAIN ---------------- */
function connect() {
  console.log("🌐 Connecting to Helius...");

  const ws = new WebSocket(
    `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`
  );

  ws.on("open", () => {
    console.log("🟢 WS CONNECTED");

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

    console.log("📡 logsSubscribe sent");
  });

  ws.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw);
      const value = msg?.params?.result?.value;

      if (!value?.signature) return;

      const sig = value.signature;

      console.log("📩 TX RECEIVED:", sig);

      if (dedupe(sig)) return;

      console.log("📜 LOGS:", value.logs);

      const tx = await getTx(sig);
      if (!tx) return;

      const mint = extractMint(tx);

      if (!mint) {
        console.log("⚠️ No mint found, skipping");
        return;
      }

      const snipers = getSnipers(tx, mint);

      const decoded = {
        mint,
        creator: tx.transaction.message.accountKeys?.[0] || null
      };

      const score = scoreRunner(tx, snipers, decoded);

      console.log(`🚀 NEW LAUNCH ${mint} | SCORE: ${score}`);

      await sendToBase44({
        mint,
        name: "Pump Token",
        symbol: "PUMP",
        mcap: 0,
        launched: new Date().toISOString(),
        creator: decoded.creator,
        snipers,
        runnerScore: score
      });
    } catch (err) {
      console.error("❌ message error:", err.message);
    }
  });

  ws.on("close", () => {
    console.log("🔁 Reconnecting...");
    setTimeout(connect, 5000);
  });

  ws.on("error", (err) => {
    console.error("❌ WS error:", err.message);
    ws.close();
  });
}

connect();
