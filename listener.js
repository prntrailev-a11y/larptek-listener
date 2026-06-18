const WebSocket = require('ws');
require('dotenv').config();

const HELIUS_WS_URL = `wss://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
const PUMP_FUN_PROGRAM_ID = "6EF8rrecth7Q6z28ba6tDi5Exg1H69Umupg7N6Z47N5f";

function connectStream() {
    const ws = new WebSocket(HELIUS_WS_URL);

    ws.on('open', () => {
        console.log("🎯 Connected to Helius LaserStream. Activating Transaction Firehose...");
        
        // Step 1: Subscribe using Helius's transactionSubscribe filter
        const request = {
            jsonrpc: "2.0",
            id: 1,
            method: "transactionSubscribe",
            params: [
                {
                    accountInclude: [PUMP_FUN_PROGRAM_ID],
                    failed: false, // Drop failed transactions natively at the RPC level
                    vote: false    // Exclude validator voting spam
                },
                {
                    commitment: "confirmed",
                    encoding: "jsonParsed",
                    transactionDetails: "full",
                    maxSupportedTransactionVersion: 0
                }
            ]
        };
        ws.send(JSON.stringify(request));
    });

    ws.on('message', (data) => {
        try {
            const payload = JSON.parse(data);
            if (!payload.params?.result?.transaction) return;

            const txInfo = payload.params.result.transaction;
            const logs = txInfo.meta?.logMessages || [];
            
            // Step 2: The Exact Launch Detection Rules
            const isInitializeMint = logs.some(log => log.includes("InitializeMint2"));
            
            if (isInitializeMint) {
                const accountKeys = txInfo.transaction.message.accountKeys;
                
                // Extract keys safely out of the parsed structural array
                const accounts = accountKeys.map(k => typeof k === 'object' ? k.pubkey : k);
                
                // In a true Pump.fun create sequence: 
                // Index 0 is the creator/deployer, Index 1 is the Mint address
                const creator = accounts[0];
                const tokenMint = accounts[1];

                if (tokenMint && tokenMint.endsWith('pump')) {
                    console.log(`\n[🔥 GENUINE LAUNCH] Mint: ${tokenMint} | Creator: ${creator}`);
                    
                    // Trigger your tracking pipeline for the first buyers here
                    startFirstBuyerTracking(tokenMint);
                }
            }
        } catch (err) {
            console.error("Payload read error:", err.message);
        }
    });
}

connectStream();
