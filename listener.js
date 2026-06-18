
import { Connection } from "@solana/web3.js";

// ---------- ENV SAFETY ----------
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const RPC_URL = process.env.RPC_URL;

// Fail fast with clear message
if (!HELIUS_API_KEY) {
  throw new Error("Missing HELIUS_API_KEY (set it in Render env vars)");
}

// If you are using Helius, build RPC properly
// (THIS fixes your "http/https" error)
const endpoint =
  RPC_URL ||
  `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

if (!endpoint.startsWith("http://") && !endpoint.startsWith("https://")) {
  throw new Error(`Bad RPC endpoint: ${endpoint}`);
}

// ---------- SOLANA CONNECTION ----------
const connection = new Connection(endpoint, "confirmed");

console.log("✅ Solana listener started");
console.log("🔗 RPC:", endpoint);

// ---------- SIMPLE KEEP-ALIVE TEST ----------
async function ping() {
  try {
    const slot = await connection.getSlot();
    console.log("📡 Current slot:", slot);
  } catch (err) {
    console.error("❌ RPC error:", err.message);
  }
}

// run every 10s
setInterval(ping, 10000);
ping();
