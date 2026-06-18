const WebSocket = require('ws');
require('dotenv').config();

// Ensure your Environment Variables are set in Render
const HELIUS_API_KEY = process.env.HELIUS_API_KEY; // e.g., "abcd-1234-efgh"
const BASE44_INGEST_URL = process.env.BASE44_INGEST_URL; 
const INGEST_SECRET = process.env.INGEST_SECRET; 

if (!HELIUS_API_KEY || !BASE44_INGEST_URL || !INGEST_SECRET) {
    console.error("❌ CRITICAL ERROR: Missing required environment variables (HELIUS_API_KEY, BASE44_INGEST_URL, or INGEST_SECRET).");
    process.exit(1);
}

const HELIUS_WS_URL = `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const HELIUS_RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const PUMP_FUN_PROGRAM_ID = "6EF8rrecth7Q6z28ba6tDi5Exg1H69Umupg7N6Z47N5f";

function connectStream() {
    console.log(`[${new Date().toISOString()}] Connecting directly to Solana via Helius Atlas WS...`);
    const ws = new WebSocket(process.env.HELIUS_WEBSOCKET_URL);

    ws.on('open', function open() {
        console.log(`✅ Connected to Helius! Subscribing to Pump.fun Program logs...`);
        
        // Subscribe to all transactions involving the Pump.fun program
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
    });

    ws.on('message', async function message(data) {
        try {
            const parsed = JSON.parse(data);
            if (!parsed.params?.result?.value) return;

            const { signature, logs } = parsed.params.result.value;
            
            // Check if this log is a token creation event
            const isCreate = logs.some(log => log.includes("Program log: Instruction: Create"));
            
            if (isCreate) {
                console.log(`[Helius Detected Launch] Tx Found! Sig: ${signature}`);
                // Execute the secondary lookup to grab the token metadata
                fetchAndParseTx(signature);
            }
        } catch (err) {
            console.error('Error listening to WebSocket frame:', err.message);
        }
    });

    ws.on('error', (err) => console.error('❌ Helius WebSocket Error:', err.message));
    ws.on('close', () => {
        console.log('⚠️ Helius Connection lost. Reconnecting in 3 seconds...');
        setTimeout(connectStream, 3000);
    });
}

async function fetchAndParseTx(signature) {
    try {
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
        if (!tx) return;

        // Unpack the accounts involved to find the token Mint address
        // In a Pump.fun "Create" instruction, Account Index 0 is the Mint
        const accountKeys = tx.transaction.message.accountKeys;
        const mintAddress = typeof accountKeys[0] === 'object' ? accountKeys[0].pubkey : accountKeys[0];

        // Safely extract token names from inner logs or set standard fallbacks
        // (Pump.fun mints always end strictly in "pump")
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
            forwardToBase44(base44Payload);
        }
    } catch (err) {
        console.error(`❌ Failed parsing transaction lookup for ${signature}:`, err.message);
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
