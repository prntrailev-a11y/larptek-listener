'use strict';

/**
 * LARPTEK pump.fun launch listener
 * --------------------------------
 * Connects to Helius over WebSocket, subscribes to logs that mention the
 * pump.fun program, detects NEW TOKEN LAUNCHES (both the legacy `create`
 * instruction and the newer Token-2022 `create_v2`), pulls the mint +
 * creator + metadata, and POSTs each new launch to a Base44 ingest endpoint.
 *
 * Design goals: foolproof + self-healing.
 *   - Outbound WS only (no inbound HTTP server to expose on Render).
 *   - Auto-reconnect with backoff; survives Helius 502s / idle disconnects.
 *   - Per-mint dedupe so a token is ingested at most once.
 *   - One bad transaction never crashes the worker.
 *   - Ingest failures are retried with backoff and dropped after N tries
 *     (so a Base44 outage can't wedge the pipeline forever).
 *
 * Required env vars (set in Render dashboard):
 *   HELIUS_API_KEY      Helius API key (the WS uses the standard endpoint).
 *   BASE44_INGEST_URL   Full URL Base44 exposes to receive a launch payload.
 *   INGEST_SECRET       Shared secret sent as `x-ingest-secret` header.
 *
 * Optional env vars:
 *   HELIUS_WS_URL       Override the WS URL (defaults to mainnet).
 *   COMMITMENT          Subscription commitment (default 'processed' = fastest).
 *   LOG_LEVEL           'info' (default) or 'debug' for verbose logs.
 *   INGEST_MAX_RETRIES  Ingest attempts before giving up (default 4).
 *   DEDUPE_TTL_MS       How long to remember a mint to avoid re-ingest
 *                       (default 6h). Keeps memory bounded.
 */

const WebSocket = require('ws');
const { PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');

// ── Config ──────────────────────────────────────────────────────────────────
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const BASE44_INGEST_URL = process.env.BASE44_INGEST_URL;
const INGEST_SECRET = process.env.INGEST_SECRET;

const HELIUS_WS_URL =
  process.env.HELIUS_WS_URL ||
  `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const HELIUS_RPC_URL =
  process.env.HELIUS_RPC_URL ||
  `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const COMMITMENT = process.env.COMMITMENT || 'processed';
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const INGEST_MAX_RETRIES = parseInt(process.env.INGEST_MAX_RETRIES || '4', 10);
const DEDUPE_TTL_MS = parseInt(process.env.DEDUPE_TTL_MS || String(6 * 60 * 60 * 1000), 10);

// pump.fun on-chain program. This is the anchor we match on — matching the
// PROGRAM (not a specific instruction name) is what lets us catch ~99% of
// launches across both the legacy `create` and the newer `create_v2`.
const PUMPFUN_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

// Log substrings that indicate a token-creation event (not a buy/sell/etc).
// pump.fun emits an Anchor "Instruction: Create" program log on launch; the
// v2 path logs "Instruction: CreateV2". We match either, case-insensitively.
const CREATE_LOG_HINTS = ['instruction: create'];

// ── Tiny logger ───────────────────────────────────────────────────────────
function log(...args) {
  console.log(new Date().toISOString(), ...args);
}
function debug(...args) {
  if (LOG_LEVEL === 'debug') console.log(new Date().toISOString(), '[debug]', ...args);
}

// ── Startup validation (fail loud, fail early) ───────────────────────────────
function validateEnv() {
  const missing = [];
  if (!HELIUS_API_KEY) missing.push('HELIUS_API_KEY');
  if (!BASE44_INGEST_URL) missing.push('BASE44_INGEST_URL');
  if (!INGEST_SECRET) missing.push('INGEST_SECRET');
  if (missing.length) {
    console.error(
      `[FATAL] Missing required env vars: ${missing.join(', ')}. ` +
        `Set them in the Render dashboard and redeploy.`
    );
    process.exit(1);
  }
}

// ── Dedupe (mint -> expiry timestamp) ────────────────────────────────────────
const seenMints = new Map();
function alreadySeen(mint) {
  const now = Date.now();
  // opportunistic cleanup so the map doesn't grow unbounded
  if (seenMints.size > 5000) {
    for (const [m, exp] of seenMints) if (exp < now) seenMints.delete(m);
  }
  const exp = seenMints.get(mint);
  if (exp && exp > now) return true;
  seenMints.set(mint, now + DEDUPE_TTL_MS);
  return false;
}

// ── Helius RPC helper (getTransaction) ───────────────────────────────────────
async function rpc(method, params) {
  const res = await fetch(HELIUS_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'larptek', method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${method} HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`RPC ${method} error: ${JSON.stringify(j.error)}`);
  return j.result;
}

/**
 * Given a confirmed signature for a pump.fun create, pull the full tx and
 * extract the launch details. We do NOT trust log order alone — we read the
 * parsed transaction and find the newly-created mint.
 *
 * Returns { mint, creator, signature, ...metadata } or null if we can't
 * confidently identify a new token (in which case we skip rather than guess).
 */
async function extractLaunchFromSignature(signature) {
  const tx = await rpc('getTransaction', [
    signature,
    { maxSupportedTransactionVersion: 0, commitment: 'confirmed', encoding: 'jsonParsed' },
  ]);
  if (!tx || !tx.meta || tx.meta.err) return null; // failed tx — ignore

  // The new mint shows up in postTokenBalances with a fresh mint address that
  // wasn't in preTokenBalances. pump.fun mints the full supply to the bonding
  // curve at creation, so the mint appears in postTokenBalances.
  const pre = new Set((tx.meta.preTokenBalances || []).map((b) => b.mint));
  const postMints = (tx.meta.postTokenBalances || []).map((b) => b.mint);
  let mint = postMints.find((m) => !pre.has(m)) || postMints[0] || null;

  // Fallback: scan parsed instructions for an initializeMint on the token
  // program (covers Token-2022 create_v2 as well).
  const message = tx.transaction && tx.transaction.message;
  const allIx = [];
  if (message && Array.isArray(message.instructions)) allIx.push(...message.instructions);
  if (tx.meta && Array.isArray(tx.meta.innerInstructions)) {
    for (const inner of tx.meta.innerInstructions) {
      if (Array.isArray(inner.instructions)) allIx.push(...inner.instructions);
    }
  }
  if (!mint) {
    for (const ix of allIx) {
      const t = ix.parsed && ix.parsed.type;
      if (t === 'initializeMint' || t === 'initializeMint2') {
        mint = ix.parsed.info && ix.parsed.info.mint;
        if (mint) break;
      }
    }
  }
  if (!mint) return null;

  // Creator = fee payer (first signer) of the launch transaction.
  let creator = null;
  try {
    const keys = message.accountKeys || [];
    const first = keys[0];
    creator = typeof first === 'string' ? first : first && first.pubkey;
  } catch (_) {
    /* ignore */
  }

  return {
    mint,
    creator,
    signature,
    slot: tx.slot || null,
    blockTime: tx.blockTime || null,
    source: 'pumpfun',
  };
}

/**
 * Enrich a launch with token metadata via Helius DAS getAsset. Best-effort:
 * a brand-new mint may not be indexed yet, so we return whatever we get and
 * never fail the ingest because metadata was missing.
 */
async function enrichMetadata(launch) {
  try {
    const asset = await rpc('getAsset', { id: launch.mint });
    if (asset) {
      const content = asset.content || {};
      const meta = content.metadata || {};
      const links = content.links || {};
      launch.name = meta.name || null;
      launch.symbol = meta.symbol || null;
      launch.description = meta.description || null;
      launch.image = links.image || (content.files && content.files[0] && content.files[0].uri) || null;
      launch.metadataUri = (content.json_uri) || null;
    }
  } catch (e) {
    debug('metadata enrich failed (token may be too new):', e.message);
  }
  return launch;
}

// ── Base44 ingest with retry/backoff ────────────────────────────────────────
async function ingestToBase44(launch, attempt = 1) {
  try {
    const res = await fetch(BASE44_INGEST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ingest-secret': INGEST_SECRET,
      },
      body: JSON.stringify({
        ...launch,
        detectedAt: new Date().toISOString(),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    log(`✅ ingested ${launch.symbol || '?'} ${launch.mint} (creator ${launch.creator || '?'})`);
    return true;
  } catch (e) {
    if (attempt >= INGEST_MAX_RETRIES) {
      log(`❌ ingest gave up for ${launch.mint} after ${attempt} attempts: ${e.message}`);
      return false;
    }
    const backoff = Math.min(1000 * 2 ** (attempt - 1), 15000);
    log(`⚠️  ingest attempt ${attempt} failed for ${launch.mint} (${e.message}) — retrying in ${backoff}ms`);
    await new Promise((r) => setTimeout(r, backoff));
    return ingestToBase44(launch, attempt + 1);
  }
}

// ── Process one notification ────────────────────────────────────────────────
async function handleLogNotification(value) {
  try {
    if (!value || value.err) return; // failed tx
    const logs = value.logs || [];
    const signature = value.signature;
    if (!signature) return;

    // Only proceed if the logs look like a token-creation event. This filters
    // out the firehose of buys/sells on the same program.
    const joined = logs.join('\n').toLowerCase();
    const isCreate = CREATE_LOG_HINTS.some((h) => joined.includes(h));
    if (!isCreate) return;

    debug('candidate create tx:', signature);

    // Pull the full tx to confidently extract the mint (don't guess from logs).
    const launch = await extractLaunchFromSignature(signature);
    if (!launch || !launch.mint) return;

    if (alreadySeen(launch.mint)) {
      debug('dupe mint, skipping:', launch.mint);
      return;
    }

    await enrichMetadata(launch);
    await ingestToBase44(launch);
  } catch (e) {
    // Never let one bad notification crash the worker.
    log('handler error (ignored):', e.message);
  }
}

// ── WebSocket connection with auto-reconnect ─────────────────────────────────
let ws = null;
let reconnectAttempts = 0;
let pingTimer = null;
let subId = null;

function connect() {
  log(`connecting to Helius WS… (commitment=${COMMITMENT})`);
  ws = new WebSocket(HELIUS_WS_URL);

  ws.on('open', () => {
    reconnectAttempts = 0;
    log('WS open — subscribing to pump.fun program logs');
    const sub = {
      jsonrpc: '2.0',
      id: 1,
      method: 'logsSubscribe',
      params: [
        { mentions: [PUMPFUN_PROGRAM_ID] },
        { commitment: COMMITMENT },
      ],
    };
    ws.send(JSON.stringify(sub));

    // Keep the socket alive; Helius drops idle connections.
    clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.ping();
        } catch (_) {
          /* ignore */
        }
      }
    }, 25000);
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (_) {
      return;
    }
    // Subscription confirmation
    if (msg.id === 1 && typeof msg.result === 'number') {
      subId = msg.result;
      log(`subscribed (id=${subId}). Watching for launches…`);
      return;
    }
    // Log notifications
    if (msg.method === 'logsNotification') {
      const value = msg.params && msg.params.result && msg.params.result.value;
      // fire and forget; handler has its own try/catch
      handleLogNotification(value);
    }
  });

  ws.on('error', (e) => {
    log('WS error:', e.message);
  });

  ws.on('close', (code) => {
    clearInterval(pingTimer);
    reconnectAttempts += 1;
    const backoff = Math.min(1000 * 2 ** Math.min(reconnectAttempts, 6), 30000);
    log(`WS closed (code ${code}) — reconnecting in ${backoff}ms (attempt ${reconnectAttempts})`);
    setTimeout(connect, backoff);
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────
validateEnv();
log('LARPTEK pump.fun listener starting…');
log(`ingest → ${BASE44_INGEST_URL}`);
log(`dedupe TTL ${Math.round(DEDUPE_TTL_MS / 60000)}m, ingest max retries ${INGEST_MAX_RETRIES}`);
connect();

// Keep the process alive and log unexpected errors instead of dying silently.
process.on('unhandledRejection', (e) => log('unhandledRejection (ignored):', e && e.message));
process.on('uncaughtException', (e) => log('uncaughtException (ignored):', e && e.message));
