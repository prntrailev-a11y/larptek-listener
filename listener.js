import { Connection, clusterApiUrl } from "@solana/web3.js";

const connection =
  new Connection(process.env.RPC_URL || clusterApiUrl("mainnet-beta"), "confirmed");

// prevent duplicates
const processed = new Set();

// track first buys per mint/curve
const seenFirstBuy = new Set();

// adjust these if you already know your programs
const PROGRAMS = {
  RAYDIUM_LAUNCH: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  PUMP_FUN: "GMgnVFR8Jb39LoXsEVzb3DvBy3ywCmdmJquHUy1Lrkqb",
  TOKEN_PROGRAM: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  ASSOCIATED_TOKEN: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
};

// ---------------- utils ----------------

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

async function getTx(signature, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const tx = await connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
      if (tx) return tx;
    } catch (e) {
      console.log(`[WARN] RPC retry ${i + 1}:`, e.message);
    }
    await sleep(120 * (i + 1));
  }
  return null;
}

// ---------------- extraction helpers ----------------

function getPrograms(tx) {
  const keys = new Set();

  const msg = tx?.transaction?.message;

  if (msg?.accountKeys) {
    for (const k of msg.accountKeys) {
      keys.add(k.toString());
    }
  }

  const loaded = tx?.meta?.loadedAddresses;
  if (loaded?.writable) loaded.writable.forEach((a) => keys.add(a.toString()));
  if (loaded?.readonly) loaded.readonly.forEach((a) => keys.add(a.toString()));

  return [...keys];
}

function getLogs(tx) {
  return tx?.meta?.logMessages || [];
}

function hasLog(logs, str) {
  return logs.some((l) => l.includes(str));
}

// ---------------- EVENT DETECTORS ----------------

// 1. Curve initialization (bonding curve / state account created)
function isCurveInit(tx, logs) {
  return (
    hasLog(logs, "Initialize") &&
    (hasLog(logs, "bonding") ||
      hasLog(logs, "curve") ||
      hasLog(logs, "Create") ||
      hasLog(logs, PROGRAMS.PUMP_FUN))
  );
}

// 2. Buy instruction detection
function isBuy(tx, logs) {
  return hasLog(logs, "Instruction: Buy") || hasLog(logs, "Buy");
}

// 3. Token account creation
function isAccountCreation(tx, logs) {
  return (
    hasLog(logs, "InitializeAccount") ||
    hasLog(logs, "CreateAccount") ||
    hasLog(logs, PROGRAMS.ASSOCIATED_TOKEN)
  );
}

// ---------------- CORE CLASSIFICATION ----------------

function classifyEvent(tx, logs, signature) {
  const isInit = isCurveInit(tx, logs);
  const isBuyTx = isBuy(tx, logs);
  const isCreate = isAccountCreation(tx, logs);

  // CASE 1: Curve initialized
  if (isInit) {
    return {
      type: "curve_init",
      priority: 3,
    };
  }

  // CASE 2: account creation + buy in same tx = "launch entry"
  if (isCreate && isBuyTx) {
    return {
      type: "account_create_and_buy",
      priority: 2,
    };
  }

  // CASE 3: first buy only (critical signal)
  if (isBuyTx) {
    const key = signature; // optionally replace with mint address if you extract it
    if (!seenFirstBuy.has(key)) {
      seenFirstBuy.add(key);
      return {
        type: "first_buy",
        priority: 1,
      };
    }
  }

  return null;
}

// ---------------- MAIN HANDLER ----------------

export async function handleSignature(signature) {
  if (processed.has(signature)) return;
  processed.add(signature);

  const tx = await getTx(signature);
  if (!tx) return;

  const logs = getLogs(tx);

  console.log(`[LOG] TX: ${signature}`);
  console.log(`[LOG] Sample logs:`, logs.slice(0, 8));

  const event = classifyEvent(tx, logs, signature);

  if (!event) return;

  console.log(`\n🚨 EVENT DETECTED: ${event.type}`);
  console.log(`TX: ${signature}`);
  console.log(`Priority: ${event.priority}`);

  // 👉 hook your alert system here
  // await sendWebhook({ signature, ...event, logs });
}
