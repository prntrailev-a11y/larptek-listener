const WebSocket = require('ws');
require('dotenv').config();

// Ensure your Environment Variables are set in Render / Local .env
const HELIUS_API_KEY = process.env.HELIUS_API_KEY; 
const BASE44_INGEST_URL = process.env.BASE44_INGEST_URL; 
const INGEST_SECRET = process.env.INGEST_SECRET; 

if (!HELIUS_API_KEY || !BASE44_INGEST_URL || !INGEST_SECRET) {
    console.error("❌ CRITICAL ERROR: Missing required environment variables (HELIUS_API_KEY, BASE44_INGEST_URL, or INGEST_SECRET).");
    process.exit(1);
}

// Fixed endpoint construction to point to mainnet RPC WS cluster instead of the legacy naked atlas URL
const HELIUS_WS_URL = `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const HELIUS_RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const PUMP_FUN_PROGRAM_ID = "6EF8rrecth7Q6z28ba6tDi5Exg1H69Umupg7N6Z47N5f";

let heartbeatInterval;

function connectStream() {
    console.log(`[${new Date().toISOString()}] Connecting directly to Solana via Helius RPC WS...`);
    const ws = new WebSocket(HELIUS_WS_URL);

    ws.on('open', function open() {
        console.log(`✅ Connected to Helius! Subscribing to Pump.fun Program logs...`);
        
        // Subscribe request frame
        const subscriptionRequest = {
            jsonrpc: "2.0",
            id: 1,
            method: "logsSubscribe",
            params: [
                { mentions: [PUMP_FUN_PROGRAM_ID] },
                { commitment: "processed" }
            ]
        };
        ws.send(JSON.stringify(subscriptionRequest));

        // Heartbeat log so you know it's not dead during long silent stretches
        clearInterval(heartbeatInterval);
        heartbeatInterval = setInterval(() => {
            console.log(`[System Check] Listening... Pipe is open. Waiting for a new token launch...`);
        }, 60000); // Prints once a minute
    });

    ws.on('message', async function message(data) {
        try {
            const parsed = JSON.parse(data);
            
            // 1. Ensure data block exists and transaction actually SUCCEEDED on-chain
            if (!parsed.params?.result?.value) return;
            if (parsed.params.result.value.err !== null) return; // Ignores failed or aborted transactions

            const { signature, logs } = parsed.params.result.value;
            if (!logs) return;
            
            // 2. Case-insensitive lookup for the string variations of token creation logs
            const isCreate = logs.some(log => {
                const lowerLog = log.toLowerCase();
                return lowerLog.includes("instruction: create") || lowerLog.includes("program log: create");
            });
            
            if (isCreate) {
                console.log(`[🔥 Helius Detected Launch] New Token Minted! Tx Sig: ${signature}`);
                
                // Safely handle background asynchronous execution without unhandled promise rejections crashing Node
                fetchAndParseTx(signature).catch(err => {
                    console.error(`❌ Background processing error for ${signature}:`, err.message);
                });
            }
        } catch (err) {
            console.error('Error listening to WebSocket frame:', err.message);
        }
    });

    ws.on('error', (err) => console.error('❌ Helius WebSocket Error:', err.message));
    
    ws.on('close', () => {
        clearInterval(heartbeatInterval);
        console.log('⚠️ Helius Connection lost. Reconnecting in 3 seconds...');
        setTimeout(connectStream, 3000);
    });
}

async function fetchAndParseTx(signature) {
    // Fetch the unpacked transaction details directly from Helius RPC
    const response = await fetch(HELIUS_RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: "tx-lookup",
            method: "getTransaction",
            params: [
                signature,
                {
                    encoding: "jsonParsed",
                    maxSupportedTransactionVersion: 0,
                    commitment: "confirmed"
                }
            ]
        })
    });

    const txData = await response.json();
    const tx = txData.result;
    if (!tx || !tx.transaction?.message?.accountKeys) return;

    // Unpack the accounts involved to find the token Mint address
    const accountKeys = tx.transaction.message.accountKeys;
    const mintAddress = typeof accountKeys[0] === 'object' ? accountKeys[0].pubkey : accountKeys[0];

    // Pump.fun mints always end strictly in "pump"
    if (mintAddress && mintAddress.endsWith('pump')) {
        const base44Payload = {
            mint: mintAddress,
            name: "Helius Drop Token", 
            symbol: "PUMP",
            mcap: 4500, // Initial default standard pump.fun starting mcap
            launched: new Date().toISOString(),
            logo: null
        };

        console.log(`[Parsed Success] Token Mint: ${mintAddress}. Forwarding to base44...`);
        await forwardToBase44(base44Payload);
    }
}

async function forwardToBase44(payload) {
    try {
        const response = await fetch(BASE44_INGEST_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-ingest-secret': INGEST_SECRET
            },
            body: JSON.stringify(payload)
        });

        const result = await response.json();
        
        if (response.ok) {
            if (result.skipped) {
                console.log(`[base44 Response] ⚠️ SKIPPED BY ENGINE: ${result.reason}`);
            } else {
                console.log(`[base44 Response] ✅ SUCCESS: Ingested ${payload.mint.slice(0, 6)}... into base44!`);
            }
        } else {
            console.error(`[base44 Response] ❌ Failed Status ${response.status}:`, result.error || 'Unknown Error');
        }
    } catch (fetchError) {
        console.error('Could not transmit data packet to base44 backend:', fetchError.message);
    }
}

// Fire it up!
connectStream();
