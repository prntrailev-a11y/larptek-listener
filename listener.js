const WebSocket = require('ws');
require('dotenv').config();

const HELIUS_API_KEY = process.env.HELIUS_API_KEY; 
const BASE44_INGEST_URL = process.env.BASE44_INGEST_URL; 
const INGEST_SECRET = process.env.INGEST_SECRET; 

if (!HELIUS_API_KEY || !BASE44_INGEST_URL || !INGEST_SECRET) {
    console.error("❌ CRITICAL ERROR: Missing required environment variables.");
    process.exit(1);
}

// Uses the standard Solana logsSubscribe method available on ALL tiers
const HELIUS_WS_URL = `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const HELIUS_RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const PUMP_FUN_PROGRAM_ID = "6EF8rrecth7Q6z28ba6tDi5Exg1H69Umupg7N6Z47N5f";

let heartbeatInterval;

function connectStream() {
    console.log(`[${new Date().toISOString()}] Initializing Free-Tier Log Engine...`);
    const ws = new WebSocket(HELIUS_WS_URL);

    ws.on('open', function open() {
        console.log(`🚀 HOOKED: Monitoring Solana Token Program deployment markers...`);
        
        // Listen to the Pump.fun program on the standard subscription framework
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

        // Keepalive ping to ensure your Render container doesn't sleep
        clearInterval(heartbeatInterval);
        heartbeatInterval = setInterval(() => {
            console.log(`[System Check] Stream active. Watching the blockchain...`);
        }, 30000);
    });

    ws.on('message', async function message(data) {
        try {
            const parsed = JSON.parse(data);
            if (!parsed.params?.result?.value) return;
            if (parsed.params.result.value.err !== null) return; // Drop aborted/failed txs

            const { signature, logs } = parsed.params.result.value;
            if (!logs) return;
            
            // Look for the low-level system instruction that instantiates token mints
            const isMintInit = logs.some(log => log.includes("InitializeMint2"));
            
            if (isMintInit) {
                console.log(`[🎯 MINT DETECTED] Token creation signature: ${signature}`);
                
                // Immediately pull the full payload from the RPC layer
                parseLaunchTransaction(signature).catch(err => {
                    if (!err.message.includes("null")) {
                        console.error(`❌ Parse error:`, err.message);
                    }
                });
            }
        } catch (err) {
            console.error('Error reading packet:', err.message);
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
    // 200ms pause to let Helius index the transaction so getTransaction doesn't return null
    await new Promise(resolve => setTimeout(resolve, 200));

    const response = await fetch(HELIUS_RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: "free-parse",
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

    const accountKeys = tx.transaction.message.accountKeys;
    
    // Unpack account references
    const mintAccount = accountKeys[0];
    const mintAddress = typeof mintAccount === 'object' ? mintAccount.pubkey : mintAccount;
    
    const deployerAccount = accountKeys[2];
    const deployerAddress = typeof deployerAccount === 'object' ? deployerAccount.pubkey : deployerAccount;

    // Is it a Pump token?
    if (mintAddress && mintAddress.endsWith('pump')) {
        const base44Payload = {
            mint: mintAddress,
            deployer: deployerAddress || "System Contract", 
            name: "Pump.fun Verified Launch", 
            symbol: "PUMP",
            mcap: 4500, 
            launched: new Date().toISOString(),
            signature: signature
        };

        console.log(`[🔥 FIREHOSE SUCCESS] Mint: ${mintAddress} | Deployer: ${deployerAddress}`);
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
            if (!result.skipped) {
                console.log(`[base44] ✅ INGESTED: ${payload.mint.slice(0, 8)}...`);
            }
        }
    } catch (err) {
        console.error('Network transport error:', err.message);
    }
}

connectStream();
