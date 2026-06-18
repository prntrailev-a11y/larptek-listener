import dotenv from "dotenv";
dotenv.config();

import { Connection } from "@solana/web3.js";

// ---------- RPC FIX ----------
const RPC_URL =
  process.env.RPC_URL ||
  process.env.HELIUS_RPC ||
  "https://api.mainnet-beta.solana.com";

console.log("🔗 RPC RAW VALUE:", RPC_URL);

// prevent silent bad URLs
if (!RPC_URL.startsWith("http")) {
  throw new Error("RPC_URL invalid or missing http/https prefix");
}

const connection = new Connection(RPC_URL, "confirmed");

// ---------- START ----------
console.log("✅ Solana listener starting");

async function printSlot() {
  try {
    const slot = await connection.getSlot();
    console.log("📡 Current slot:", slot);
  } catch (err) {
    console.error("Slot error:", err);
  }
}

// loop
setInterval(printSlot, 10000);
printSlot();
