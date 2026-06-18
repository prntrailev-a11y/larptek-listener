const WebSocket = require('ws');
require('dotenv').config();

const HELIUS_API_KEY = process.env.HELIUS_API_KEY; 
const BASE44_INGEST_URL = process.env.BASE44_INGEST_URL; 
const INGEST_SECRET = process.env.INGEST_SECRET; 

if (!HELIUS_API_KEY || !BASE44_INGEST_URL || !INGEST_SECRET) {
    console.error("❌ CRITICAL ERROR: Missing required environment variables.");
    process.exit(1);
}

const HELIUS_WS_URL = `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const HELIUS_RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const PUMP_FUN_PROGRAM_ID = "6EF8rrecth7Q6z28ba6tDi5Exg1H69Umupg7N6Z47N5f";

let heartbeatInterval;

function connectStream() {
    console.log(`[${new Date().toISOString()}] Initializing Firehose Stream via Helius...`);
    const ws = new WebSocket(HELIUS_WS_URL);

    ws.on('open', function open() {
        console.log(`🚀 STREAM LIVE: Connected to Helius RPC WS. Monitoring all Pump.fun deployments...`);
        
        const subscriptionRequest = {
            jsonrpc: "2.0",
            id: 1,
            method: "logsSubscribe",
            params: [
                { mentions: [PUMP_FUN_PROGRAM_ID] },
                { commitment: "processed" } // Maximum velocity streaming state
            ]
        };
        ws.send(JSON.stringify(subscriptionRequest));

        clearInterval(heartbeatInterval);
        heartbeatInterval = setInterval(() => {
            console.log(`[Heartbeat] Stream healthy. Listening for next Pump.fun deployment block...`);
        }, 30000);
    });

    ws.on('message', async function message(data) {
        try {
            const parsed = JSON.parse(data);
            if (!parsed.params?.result?.value) return;
            
            // Instantly skip failed runtime execution to optimize performance
            if (parsed.params.result.value.err !== null) return; 

            const { signature, logs } = parsed.params.result.value;
            if (!logs) return;
            
            // Dual verification checking text blocks for instruction roots
            const logString = logs.join(" ").toLowerCase();
            const isCreationTx = logString.includes("create") || 
                                 logString.includes("initialize") || 
                                 logString.includes("instruction: create");
            
            if (isCreationTx) {
                // Instantly pass off to parser without blocking the WS loop
                parseLaunchTransaction(signature).catch(err => {
                    // Suppress standard log noise if transaction isn't fully confirmed yet
                    if (!err.message.includes("null")) {
                        console.error(`❌ Parse error for tx ${signature.slice(0,8)}:`, err.message);
                    }
                });
            }
        } catch (err) {
            console.error('Error reading WebSocket packet:', err.message);
        }
    });

    ws.on('error', (err) => console.error('❌ Helius WS Stream Error:', err.message));
    
    ws.on('close', () => {
        clearInterval(heartbeatInterval);
        console.log('⚠️ Stream disconnected. Reconnecting in 3 seconds...');
        setTimeout(connectStream, 3000);
    });
}

async function parseLaunchTransaction(signature) {
    // Small propagation delay window (200ms) to ensure RPC has indexed the transaction data
    await new Promise(resolve => setTimeout(resolve, 200));

    const response = await fetch(HELIUS_RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: "pump-parse",
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
    
    // Safety exit clause if transaction fetch yields temporary blank state
    if (!tx || !tx.transaction?.message?.accountKeys) return;

    const accountKeys = tx.transaction.message.accountKeys;
    
    // Extract the primary dynamic address keys from structural indexing arrays
    const mintAccount = accountKeys[0];
    const mintAddress = typeof mintAccount === 'object' ? mintAccount.pubkey : mintAccount;
    
    const deployerAccount = accountKeys[2];
    const deployerAddress = typeof deployerAccount === 'object' ? deployerAccount.pubkey : deployerAccount;

    // Hard verification rule: Token mint must possess standard Pump layout parameters
    if (mintAddress && mintAddress.endsWith('pump')) {
        
        const base44Payload = {
            mint: mintAddress,
            deployer: deployerAddress || "Unknown Creator", 
            name: "Pump.fun Verified Launch", 
            symbol: "PUMP",
            mcap: 4500, 
            launched: new Date().toISOString(),
            signature: signature
        };

        console.log(`[🔥 NEW LAUNCH DETECTED] Mint: ${mintAddress} | Creator: ${deployerAddress || 'Bundler/Contract'}`);
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
                console.log(`[base44] ⚠️ Filtered/Skipped: ${result.reason}`);
            } else {
                console.log(`[base44] ✅ SUCCESS: Ingested token ${payload.mint.slice(0, 8)}...`);
            }
        } else {
            console.error(`[base44] ❌ Ingest Error Status ${response.status}:`, result.error || 'Unknown Error');
        }
    } catch (err) {
        console.error('Network transport error to base44 backend:', err.message);
    }
}

// Fire it up
connectStream();
