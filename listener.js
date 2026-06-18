import { Connection } from "@solana/web3.js";

// ---- ENV SAFE READ ----
const RPC_URL =
  process.env.RPC_URL ||
  process.env.HELIUS_RPC ||
  "https://api.mainnet-beta.solana.com";

// ---- VALIDATION (THIS FIXES YOUR CRASH) ----
if (!RPC_URL.startsWith("http://") && !RPC_URL.startsWith("https://")) {
  console.error("❌ Invalid RPC_URL:", RPC_URL);
  throw new Error("RPC_URL must start with http:// or https://");
}

console.log("✅ Solana listener starting");
console.log("🔗 RPC:", RPC_URL);

// ---- CONNECTION ----
const connection = new Connection(RPC_URL, "confirmed");

// ---- HEARTBEAT LOOP ----
async function printSlot() {
  try {
    const slot = await connection.getSlot();
    console.log("📡 Current slot:", slot);
  } catch (err) {
    console.error("Slot error:", err.message);
  }
}

// ---- MAIN LOOP ----
setInterval(printSlot, 10_000);

// ---- STARTUP ----
printSlot();
