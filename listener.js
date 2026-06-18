const WebSocket = require('ws');
require('dotenv').config();

const BASE44_INGEST_URL = process.env.BASE44_INGEST_URL;
const INGEST_SECRET = process.env.INGEST_SECRET;
// Your Helius WSS URL containing your API Key
const HELIUS_WS_URL = `wss://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;

if (!BASE44_INGEST_URL || !INGEST_SECRET || !process.env.HELIUS_API_KEY) {
    console.error("❌ Missing environment variables (HELIUS_API_KEY, BASE44_INGEST_URL, or INGEST_SECRET)");
    process.exit(1);
}

const PUMP_FUN_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

function connectHeliusStream() {
    console.log("Connecting directly to Solana via Helius WS...");
    const ws = new WebSocket(HELIUS_WS_URL);

    ws.on('open', function open() {
        console.log("Connected to Helius. Subscribing to Pump.fun Program logs...");
        
        // Tell Helius to listen to the Pump.fun program account
        ws.send(JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "logsSubscribe",
            params: [
                { mentions: [PUMP_FUN_PROGRAM_ID] },
                { commitment: "processed" } // "processed" is the fastest speed possible on Solana
            ]
        }));
    });

    ws.on('message', function message(data) {
        try {
            const response = JSON.parse(data);
            
            // Check if it's a log notification
            if (response.method === 'logsNotification') {
                const logs = response.params.result.value.logs;
                const signature = response.params.result.value.signature;
                
                // Search the raw logs to see if this transaction was a "Create" (Token Launch)
                const isCreate = logs.some(log => log.includes('Instruction: Create'));
                
                if (isCreate) {
                    console.log(`[Helius Detected Launch] Tx Sig: ${signature}`);
                    
                    // Note: Raw logs give you the transaction signature. 
                    // To get the token name, symbol, and mint address, you instantly 
                    // request the full transaction data from Helius or construct the predictable mint layout.
                    fetchAndParseTx(signature);
                }
            }
        } catch (err) {
            console.error('Error handling Helius log event:', err.message);
        }
    });

    ws.on('close', () => setTimeout(connectHeliusStream, 1000));
}

async function fetchAndParseTx(signature) {
    try {
        // Use Helius HTTP RPC to pull the fully resolved transaction details
        const response = await fetch(`https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: "parse-tx",
                method: "getTransaction",
                params: [signature, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }]
            })
        });
        
        const txData = await response.json();
        
        // Extract the mint public key and metadata from the token balances array
        const tokenBalances = txData.result?.meta?.postTokenBalances;
        if (tokenBalances && tokenBalances.length > 0) {
            const mint = tokenBalances[0].mint;
            
            // Re-construct the clean package your base44 endpoint expects
            const base44Payload = {
                mint: mint,
                name: "Unknown (RPC Fetch)", // To get names/symbols from raw RPC, you parse the metadata account layout
                symbol: "UNKNOWN",
                mcap: 4500, // Standard starting market cap fallback
                launched: new Date().toISOString()
            };
            
            forwardToBase44(base44Payload);
        }
    } catch (err) {
        console.error("Failed parsing transaction via Helius HTTP:", err.message);
    }
}

// ... include your forwardToBase44 function below ...
connectHeliusStream();
