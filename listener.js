import WebSocket from "ws";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const BASE44_WEBHOOK_URL = process.env.BASE44_WEBHOOK_URL;

const PUMPFUN_PROGRAM =
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

const RPC_URL =
  `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const seen = new Set();

function isDuplicate(signature) {
  if (seen.has(signature)) return true;

  seen.add(signature);

  setTimeout(() => {
    seen.delete(signature);
  }, 60 * 60 * 1000);

  return false;
}

async function getParsedTransaction(signature) {
  try {
    const response = await axios.post(RPC_URL, {
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

    return response.data?.result || null;
  } catch (err) {
    console.error("getTransaction failed:", err.message);
    return null;
  }
}

function extractLaunchData(tx) {
  try {
    const message = tx.transaction?.message;

    if (!message) return null;

    const accounts = message.accountKeys || [];

    const creator =
      accounts?.[0]?.pubkey ||
      accounts?.[0] ||
      null;

    let mint = null;
    let bondingCurve = null;

    for (const acct of accounts) {
      const key = acct.pubkey || acct;

      if (!mint) {
        mint = key;
        continue;
      }

      if (!bondingCurve) {
        bondingCurve = key;
      }

      if (mint && bondingCurve) break;
    }

    return {
      mint,
      creator,
      bondingCurve,
      launchTimestamp:
        tx.blockTime
          ? tx.blockTime * 1000
          : Date.now()
    };
  } catch (err) {
    console.error("extractLaunchData failed:", err);
    return null;
  }
}

async function sendToBase44(payload) {
  try {
    await axios.post(BASE44_WEBHOOK_URL, payload);
  } catch (err) {
    console.error(
      "Base44 webhook failed:",
      err.response?.data || err.message
    );
  }
}

function connect() {
  console.log("Connecting to Helius...");

  const ws = new WebSocket(
    `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`
  );

  ws.on("open", () => {
    console.log("Connected.");

    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "logsSubscribe",
        params: [
          {
            mentions: [PUMPFUN_PROGRAM]
          },
          {
            commitment: "confirmed"
          }
        ]
      })
    );
  });

  ws.on("message", async raw => {
    try {
      const msg = JSON.parse(raw);

      if (!msg.params?.result?.value) return;

      const value = msg.params.result.value;

      const signature = value.signature;

      if (!signature) return;

      if (isDuplicate(signature)) return;

      console.log("Pump transaction:", signature);

      const tx = await getParsedTransaction(signature);

      if (!tx) return;

      const launch = extractLaunchData(tx);

      if (!launch) return;

      const payload = {
        source: "pumpfun",
        signature,
        mint: launch.mint,
        creator: launch.creator,
        bondingCurve: launch.bondingCurve,
        launchTimestamp: launch.launchTimestamp,
        receivedAt: Date.now()
      };

      console.log(
        `Launch detected: ${launch.mint}`
      );

      await sendToBase44(payload);
    } catch (err) {
      console.error(err.message);
    }
  });

  ws.on("close", () => {
    console.log("Disconnected. Reconnecting...");
    setTimeout(connect, 5000);
  });

  ws.on("error", err => {
    console.error("WebSocket Error:", err.message);
    ws.close();
  });
}

connect();
