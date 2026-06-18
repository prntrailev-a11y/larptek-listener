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
}

/* ---------------- 1. TRUE PUMP DECODER ---------------- */
function decodePump(tx) {
  const msg = tx.transaction.message;
  const keys = msg.accountKeys || [];

  const meta = tx.meta || {};

  const creator = keys?.[0]?.pubkey || keys?.[0];

  // REAL mint detection via token balances
  let mint = null;

  const postBalances = meta.postTokenBalances || [];

  if (postBalances.length > 0) {
    mint = postBalances[0].mint;
  }

  // fallback heuristic
  if (!mint) {
    mint =
      keys.find(k =>
        typeof k === "object"
          ? k.pubkey?.length > 30
          : typeof k === "string" && k.length > 30
      )?.pubkey || null;
  }

  const bondingCurve =
    keys.slice(2, 8).find(k => k)?.pubkey || null;

  return {
    mint,
    creator,
    bondingCurve,
    launchedAt: tx.blockTime
      ? new Date(tx.blockTime * 1000).toISOString()
      : new Date().toISOString()
  };
}

/* ---------------- 2. METADATA RESOLVER ---------------- */
function resolveMetadata(decoded) {
  // pump.fun tokens often lack metadata at launch
  // so we intentionally keep it safe + minimal

  return {
    name: "Pump Token",
    symbol: "PUMP",
    logo: null
  };
}

/* ---------------- 3. SNIPER DETECTOR ---------------- */
function getSnipers(tx, mint) {
  const meta = tx.meta || {};
  const post = meta.postTokenBalances || [];

  const holders = [];

  for (const p of post) {
    if (p.owner && p.mint === mint) {
      holders.push(p.owner);
    }
  }

  return [...new Set(holders)].slice(0, 10);
}

/* ---------------- 4. RUNNER SCORING ENGINE ---------------- */
function scoreRunner(tx, snipers, decoded) {
  let score = 0;

  // liquidity signal (presence of token balances)
  if (tx.meta?.postTokenBalances?.length > 0) score += 20;

  // early concentration (few snipers = good)
  if (snipers.length <= 3) score += 25;
  else if (snipers.length <= 7) score += 15;
  else score += 5;

  // dev wallet heuristic (creator != top holders)
  const creator = decoded.creator;
  if (!snipers.includes(creator)) score += 15;

  // very early lifecycle bonus
  if (tx.blockTime) {
    const ageMs = Date.now() - tx.blockTime * 1000;
    if (ageMs < 60_000) score += 20; // < 1 min
    else if (ageMs < 300_000) score += 10;
  }

  // cap score
  return Math.min(score, 100);
}

/* ---------------- BASE44 PUSH ---------------- */
async function sendToBase44(payload) {
  await axios.post(BASE44_URL, payload, {
    headers: {
      "Content-Type": "application/json",
      "x-ingest-secret": INGEST_SECRET
    }
  });
}

/* ---------------- MAIN LOOP ---------------- */
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

  ws.on("message", async raw => {
    try {
      const msg = JSON.parse(raw);
      const value = msg?.params?.result?.value;

      if (!value?.signature) return;

      const sig = value.signature;

      if (dedupe(sig)) return;

      const isLaunch = (value.logs || []).some(l =>
        l.toLowerCase().includes("initialize")
      );

      if (!isLaunch) return;

      const tx = await getTx(sig);
      if (!tx) return;

      const decoded = decodePump(tx);
      if (!decoded?.mint) return;

      const meta = resolveMetadata(decoded);
      const snipers = getSnipers(tx, decoded.mint);

      const score = scoreRunner(tx, snipers, decoded);

      console.log(
        `NEW LAUNCH ${decoded.mint} | SCORE: ${score}`
      );

      await sendToBase44({
        mint: decoded.mint,
        name: meta.name,
        symbol: meta.symbol,
        mcap: 0,
        launched: decoded.launchedAt,

        // enrichment
        creator: decoded.creator,
        bondingCurve: decoded.bondingCurve,
        snipers,
        runnerScore: score
      });
    } catch (e) {
      console.error(e.message);
    }
  });

  ws.on("close", () => {
    setTimeout(connect, 5000);
  });

  ws.on("error", e => {
    console.error("ws error:", e.message);
    ws.close();
  });
}

connect();
