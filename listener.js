const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

if (!HELIUS_API_KEY) {
  throw new Error("Missing HELIUS_API_KEY");
}

// Pump.fun program id (VERIFY THIS IS CORRECT)
const PUMPFUN_PROGRAM_ID =
  process.env.PUMPFUN_PROGRAM_ID ||
  "6EF8nqHh...REPLACE_WITH_REAL_ID";

// Helius RPC HTTPS endpoint (IMPORTANT)
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

// track last signature so we don’t double process
let lastSignature = null;

async function fetchLatestSignatures() {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getSignaturesForAddress",
      params: [
        PUMPFUN_PROGRAM_ID,
        {
          limit: 20,
        },
      ],
    }),
  });

  const json = await res.json();
  return json.result || [];
}

async function fetchTransaction(signature) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: [
        signature,
        {
          encoding: "jsonParsed",
          maxSupportedTransactionVersion: 0,
        },
      ],
    }),
  });

  const json = await res.json();
  return json.result;
}

async function loop() {
  console.log("🚀 Pump.fun listener (RPC mode) running...");

  setInterval(async () => {
    try {
      const sigs = await fetchLatestSignatures();

      for (const sig of sigs) {
        if (sig.signature === lastSignature) break;

        lastSignature = sig.signature;

        const tx = await fetchTransaction(sig.signature);
        if (!tx) continue;

        const logs = tx?.meta?.logMessages || [];

        // TRUE pump.fun filter (no noise)
        const isPumpFun = logs.some((l) =>
          l.toLowerCase().includes("pump")
        );

        if (!isPumpFun) continue;

        console.log("\n🔥 PUMP.FUN TX:", sig.signature);

        const mint =
          logs.find((l) => l.includes("mint")) ||
          "unknown mint";

        console.log("🧬", mint);
      }
    } catch (err) {
      console.error("loop error:", err.message);
    }
  }, 2000);
}

loop();
