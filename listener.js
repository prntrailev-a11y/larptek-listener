import WebSocket from "ws";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

console.log("🔥 SCRIPT BOOTING...");

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const INGEST_SECRET = process.env.INGEST_SECRET;

if (!HELIUS_API_KEY) console.error("❌ Missing HELIUS_API_KEY");
if (!INGEST_SECRET) console.error("❌ Missing INGEST_SECRET");

const BASE44_URL =
  "https://wooden-smart-coin-track.base44.app/api/functions/ingestRawLaunch";

const PUMPFUN_PROGRAM =
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

/* ---------------- CONFIG ---------------- */
const MIN_SCORE_TO_SEND = 65;
const MAX_CONCURRENCY = 3;

/* ---------------- STATE ---------------- */
const seen = new Set();
let activeRequests = 0;
const queue = [];

/* ---------------- LOG HELPERS ---------------- */
const log = (...args) => console.log("[LOG]", ...args);
const warn = (...args) => console.warn("[WARN]", ...args);
const err = (...args) => console.error("[ERR]", ...args);

/* ---------------- DEDUPE ---------------- */
function dedupe(sig) {
  if (seen.has(sig)) return true;
  seen.add(sig);
  setTimeout(() => seen.delete(sig), 60 * 60 * 1000);
  return false;
}

/* ---------------- RPC ---------------- */
async function getTx(signature) {
  try {
    const res = await axios.post(
      RPC_URL,
      {
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
      },
      { timeout: 10000 }
    );

    return res.data?.result;
  } catch (e) {
    err("getTx failed:", e.message);
    return null;
  }
}

/* ---------------- DECODER ---------------- */
function decodePump(tx) {
  try {
    const msg = tx?.transaction?.message;
    const keys = msg?.accountKeys || [];
    const meta = tx?.meta || {};

    if (meta.err) {
      warn("TX failed (meta.err)");
      return null;
    }

    const post = meta.postTokenBalances || [];
    if (!post.length) {
      warn("No postTokenBalances");
      return null;
    }

    const mint = post.find(p => p?.mint)?.mint;
    if (!mint) {
      warn("No mint found");
      return null;
    }

    const creator = keys?.[0]?.pubkey || keys?.[0];

    return {
      mint,
      creator,
      launchedAt: tx.blockTime
        ? new Date(tx.blockTime * 1000).toISOString()
        : new Date().toISOString()
    };
  } catch (e) {
    err("decodePump error:", e.message);
    return null;
  }
}

/* ---------------- SNIPERS ---------------- */
function getSnipers(tx, mint) {
  const post = tx?.meta?.postTokenBalances || [];
  const holders = new Set();

  for (const p of post) {
    if (p?.mint === mint && p?.owner) {
      holders.add(p.owner);
    }
  }

  return [...holders];
}

/* ---------------- SCORING ---------------- */
function scoreRunner(tx, snipers, decoded) {
  let score = 0;

  if (tx?.meta?.postTokenBalances?.length) score += 20;

  if (snipers.length <= 3) score += 25;
  else if (snipers.length <= 7) score += 15;
  else score += 5;

  if (decoded?.creator && !snipers.includes(decoded.creator)) {
    score += 15;
  }

  if (tx.blockTime) {
    const age = Date.now() - tx.blockTime * 1000;
    if (age < 60_000) score += 20;
    else if (age < 300_000) score += 10;
  }

  return Math.min(score, 100);
}

/* ---------------- BASE44 ---------------- */
async function sendToBase44(payload) {
  try {
    log("📤 Sending to Base44:", payload.mint);

    await axios.post(BASE44_URL, payload, {
      headers: {
        "Content-Type": "application/json",
        "x-ingest-secret": INGEST_SECRET
      },
      timeout: 10000
    });

    log("✅ Base44 success");
  } catch (e) {
    err("Base44 failed:", e.message);
  }
}

/* ---------------- PROCESSOR ---------------- */
async function processJob(sig, logs) {
  log("🔎 Processing signature:", sig);

  if (dedupe(sig)) {
    log("⛔ Duplicate skipped");
    return;
  }

  log("📜 Logs sample:", logs?.slice(0, 3));

  const isLaunch = logs?.some(l =>
    l.toLowerCase().includes("initialize")
  );

  if (!isLaunch) {
    log("⛔ Not a launch tx");
    return;
  }

  const tx = await getTx(sig);
  if (!tx) {
    warn("No tx returned");
    return;
  }

  const decoded = decodePump(tx);
  if (!decoded?.mint) {
    warn("No mint decoded");
    return;
  }

  const snipers = getSnipers(tx, decoded.mint);
  const score = scoreRunner(tx, snipers, decoded);

  log(`📊 SCORE: ${score} | SNIPERS: ${snipers.length}`);

  if (score < MIN_SCORE_TO_SEND) {
    log("⛔ Filtered out (low score)");
    return;
  }

  log("🚀 PASS FILTER:", decoded.mint);

  await sendToBase44({
    mint: decoded.mint,
    creator: decoded.creator,
    snipers,
    runnerScore: score,
    launched: decoded.launchedAt,
    mcap: 0
  });
}

/* ---------------- QUEUE ---------------- */
function enqueue(job) {
  queue.push(job);
  drain();
}

async function drain() {
  if (activeRequests >= MAX_CONCURRENCY) return;

  const job = queue.shift();
  if (!job) return;

  activeRequests++;

  try {
    await processJob(job.sig, job.logs);
  } finally {
    activeRequests--;
    drain();
  }
}

/* ---------------- WS CONNECT ---------------- */
function connect() {
  log("🚀 Connecting WS...");

  const ws = new WebSocket(
    `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`
  );

  ws.on("open", () => {
    log("🟢 WS CONNECTED");

    const sub = {
      jsonrpc: "2.0",
      id: 1,
      method: "logsSubscribe",
      params: [
        { mentions: [PUMPFUN_PROGRAM] },
        { commitment: "confirmed" }
      ]
    };

    log("📡 Subscribing...");
    ws.send(JSON.stringify(sub));
  });

  ws.on("message", raw => {
    try {
      const msg = JSON.parse(raw);

      const value = msg?.params?.result?.value;

      if (!value?.signature) {
        log("📩 Non-signature message:", msg.method || "unknown");
        return;
      }

      log("📩 TX RECEIVED:", value.signature);

      enqueue({
        sig: value.signature,
        logs: value.logs || []
      });
    } catch (e) {
      err("WS parse error:", e.message);
    }
  });

  ws.on("close", () => {
    warn("🔁 WS closed — reconnecting...");
    setTimeout(connect, 3000);
  });

  ws.on("error", e => {
    err("WS error:", e.message);
    ws.close();
  });
}

connect();
