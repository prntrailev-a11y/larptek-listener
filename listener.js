import WebSocket from "ws";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const INGEST_SECRET = process.env.INGEST_SECRET;

const BASE44_URL =
  "https://wooden-smart-coin-track.base44.app/api/functions/ingestRawLaunch";

const PUMPFUN_PROGRAM =
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

/* ---------------- CONFIG (PRO FILTERS) ---------------- */
const MIN_SCORE_TO_SEND = 65;
const MAX_CONCURRENCY = 5;
const MAX_RETRIES = 3;

/* ---------------- STATE ---------------- */
const seen = new Set();
const mintCooldown = new Map();
let activeRequests = 0;
const queue = [];

/* ---------------- UTILS ---------------- */
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function dedupe(sig) {
  if (seen.has(sig)) return true;
  seen.add(sig);
  setTimeout(() => seen.delete(sig), 60 * 60 * 1000);
  return false;
}

function inCooldown(mint) {
  const last = mintCooldown.get(mint);
  if (!last) return false;
  return Date.now() - last < 5 * 60 * 1000; // 5 min cooldown
}

function setCooldown(mint) {
  mintCooldown.set(mint, Date.now());
}

/* ---------------- RPC (WITH RETRY + 429 HANDLING) ---------------- */
async function getTx(signature, attempt = 0) {
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
      { timeout: 8000 }
    );

    return res.data?.result;
  } catch (e) {
    const status = e?.response?.status;

    if (status === 429 && attempt < MAX_RETRIES) {
      await sleep(500 * Math.pow(2, attempt));
      return getTx(signature, attempt + 1);
    }

    console.error("❌ getTx failed:", e.message);
    return null;
  }
}

/* ---------------- 1. DECODER (IMPROVED) ---------------- */
function decodePump(tx) {
  const msg = tx?.transaction?.message;
  const keys = msg?.accountKeys || [];
  const meta = tx?.meta || {};

  if (meta.err) return null;

  const creator = keys?.[0]?.pubkey || keys?.[0] || null;

  const post = meta.postTokenBalances || [];
  if (!post.length) return null;

  // extract unique mint
  const mint = post.find(p => p?.mint)?.mint || null;
  if (!mint) return null;

  const bondingCurve =
    keys.slice(2, 10).find(k => k)?.pubkey || null;

  return {
    mint,
    creator,
    bondingCurve,
    launchedAt: tx.blockTime
      ? new Date(tx.blockTime * 1000).toISOString()
      : new Date().toISOString()
  };
}

/* ---------------- 2. SNIPERS ---------------- */
function getSnipers(tx, mint) {
  const post = tx?.meta?.postTokenBalances || [];
  const holders = new Set();

  for (const p of post) {
    if (p?.mint === mint && p?.owner) {
      holders.add(p.owner);
    }
  }

  return [...holders].slice(0, 10);
}

/* ---------------- 3. SCORING (TIGHTENED FILTER) ---------------- */
function scoreRunner(tx, snipers, decoded) {
  let score = 0;

  if (tx?.meta?.postTokenBalances?.length > 0) score += 20;

  if (snipers.length <= 3) score += 25;
  else if (snipers.length <= 7) score += 15;
  else score += 5;

  if (decoded.creator && !snipers.includes(decoded.creator)) {
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
    await axios.post(BASE44_URL, payload, {
      headers: {
        "Content-Type": "application/json",
        "x-ingest-secret": INGEST_SECRET
      },
      timeout: 8000
    });
  } catch (e) {
    console.error("❌ ingest failed:", e.message);
  }
}

/* ---------------- PROCESSOR QUEUE ---------------- */
async function processJob(sig, logs) {
  if (dedupe(sig)) return;

  const isLaunch = logs?.some(l =>
    l.toLowerCase().includes("initialize")
  );

  if (!isLaunch) return;

  const tx = await getTx(sig);
  if (!tx) return;

  const decoded = decodePump(tx);
  if (!decoded?.mint) return;

  if (inCooldown(decoded.mint)) return;

  const snipers = getSnipers(tx, decoded.mint);
  const score = scoreRunner(tx, snipers, decoded);

  if (score < MIN_SCORE_TO_SEND) return;

  setCooldown(decoded.mint);

  console.log(
    `🚀 LAUNCH ${decoded.mint} | SCORE ${score}`
  );

  await sendToBase44({
    mint: decoded.mint,
    creator: decoded.creator,
    bondingCurve: decoded.bondingCurve,
    snipers,
    runnerScore: score,
    launched: decoded.launchedAt,
    mcap: 0
  });
}

/* ---------------- WORKER CONTROL ---------------- */
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

/* ---------------- WS ---------------- */
function connect() {
  const ws = new WebSocket(
    `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`
  );

  ws.on("open", () => {
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

  ws.on("message", raw => {
    try {
      const msg = JSON.parse(raw);
      const value = msg?.params?.result?.value;

      if (!value?.signature) return;

      enqueue({
        sig: value.signature,
        logs: value.logs || []
      });
    } catch {}
  });

  ws.on("close", () => {
    console.log("🔁 reconnecting...");
    setTimeout(connect, 3000);
  });

  ws.on("error", e => {
    console.error("ws error:", e.message);
    ws.close();
  });
}

connect();
