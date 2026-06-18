import 'dotenv/config';
import { Connection } from "@solana/web3.js";

// ---- ENV SAFETY CHECKS ----
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const HELIUS_RPC_URL = process.env.HELIUS_RPC_URL;

// hard fail with clear message
if (!HELIUS_API_KEY) {
  throw new Error("Missing HELIUS_API_KEY in environment variables");
}

// If you provide full RPC URL, use it.
// Otherwise build it from API key.
let rpcUrl = HELIUS_RPC_URL;

if (!rpcUrl) {
  rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
}

// validate URL
if (!rpcUrl.startsWith("http://") && !rpcUrl.startsWith("https://")) {
  throw new Error(`Invalid RPC URL: ${rpcUrl}`);
}

console.log("Using RPC:", rpcUrl);

// ---- SOLANA CONNECTION ----
const connection = new Connection(rpcUrl, "confirmed");

// ---- BASIC KEEP-ALIVE TEST ----
async function testConnection() {
  try {
    const slot = await connection.getSlot();
    console.log("Connected. Current slot:", slot);
  } catch (err) {
    console.error("RPC connection failed:", err);
  }
}

testConnection();

// ---- YOUR LISTENER LOGIC BELOW ----
// (keep your existing logic, just paste it under this)
