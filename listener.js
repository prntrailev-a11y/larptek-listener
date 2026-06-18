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
    console.error("tx error:", e.message);
    return null;
  }
}

/* ---------------- CORE DECODER ---------------- */
function decodePumpLaunch(tx) {
  try {
    const msg = tx.transaction.message;
    const keys = msg.accountKeys || [];

    // CREATOR (usually fee payer)
    const creator =
      keys?.[0]?.pubkey || keys?.[0] || null;

    // MINT detection (SPL token mint = first new mint account in tx)
    const mint =
      keys.find(k =>
        typeof k === "object"
          ? k.pubkey?.toString().length > 30
          : typeof k === "string" && k.length > 30
      )?.pubkey ||
      keys?.[1]?.pubkey ||
      null;

    // BONDCURVE heuristic (pump.fun uses PDA-like account near mint)
    const bondingCurve =
      keys?.slice(2, 6)
        .find(k =>
          typeof k === "object"
            ? k.pubkey
            : k
        )?.pubkey || null;

    return {
      mint,
      creator,
      bondingCurve,
      launchedAt: tx.blockTime
        ? new Date(tx.blockTime * 1000).toISOString()
        : new Date().toISOString()
    };
  } catch (e) {
    console.error("decode error:", e);
    return null;
  }
}

/* ---------------- SNIPER DETECTOR ---------------- */
function extractSnipers(tx, mint) {
  try {
    const instructions =
      tx.transaction.message.instructions || [];

    const buyers = [];

    for (const ix of instructions) {
      const accounts = ix.accounts || [];

      for (const acc of accounts) {
        if (
          acc &&
          typeof acc === "string" &&
          acc.length > 30 &&
          acc !== mint
        ) {
          buyers.push(acc);
        }
      }
    }

    // unique + first 10
    return [...new Set(buyers)].slice(0, 10);
  } catch (e) {
    return [];
  }
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
  } catch (e) {
    console.error(
      "base44 error:",
      e.response?.data || e.message
    );
  }
}

/* ---------------- MAIN LOOP ---------------- */
function connect() {
  console.log("Connecting...");

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

      const tx = await getTx(sig);
      if (!tx) return;

      const decoded = decodePumpLaunch(tx);
      if (!decoded?.mint) return;

      const snipers = extractSnipers(tx, decoded.mint);

      console.log("NEW PUMP LAUNCH:", decoded.mint);

      await sendToBase44({
        mint: decoded.mint,
        name: "Pump Token",
        symbol: "PUMP",
        mcap: 0,
        launched: decoded.launchedAt,

        // enrichment fields (Base44 will ignore unknowns safely)
        creator: decoded.creator,
        bondingCurve: decoded.bondingCurve,
        snipers
      });
    } catch (e) {
      console.error(e.message);
    }
  });

  ws.on("close", () => {
    console.log("Reconnect...");
    setTimeout(connect, 5000);
  });

  ws.on("error", (e) => {
    console.error("ws error:", e.message);
    ws.close();
  });
}

connect();
