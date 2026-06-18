const WebSocket = require('ws');
require('dotenv').config();

// Configuration from Environment
const BASE44_INGEST_URL = process.env.BASE44_INGEST_URL; 
const INGEST_SECRET = process.env.INGEST_SECRET; // Must match base44's env

if (!BASE44_INGEST_URL || !INGEST_SECRET) {
    console.error("❌ CRITICAL ERROR: BASE44_INGEST_URL and INGEST_SECRET must be set in your environment variables.");
    process.exit(1);
}

const PUMP_WS_URL = 'wss://pumpportal.fun/api/data'; 
let reconnectInterval = 1000;
const MAX_RECONNECT_INTERVAL = 30000;

// SOL price tracking placeholder to calculate USD market cap if needed
// (PumpPortal usually provides USD mcap estimates or marketCapSol)
let currentSolPriceUsd = 160; 

function connectStream() {
    console.log(`[${new Date().toISOString()}] Connecting to Pump.fun stream...`);
    const ws = new WebSocket(PUMP_WS_URL);

    ws.on('open', function open() {
        console.log(`[${new Date().toISOString()}] Connected! Subscribing to new token launches...`);
        reconnectInterval = 1000; 

        // Subscribe to token creations
        ws.send(JSON.stringify({ method: "subscribeNewToken" }));
    });

    ws.on('message', async function message(data) {
        try {
            const parsedData = JSON.parse(data);
            
            // Validate it's a creation event
            if (parsedData.txType === 'create' || parsedData.mint) {
                
                // Calculate USD Market Cap from the stream data
                // PumpPortal sends marketCapSol. If not present, default to a standard launch mcap (~$4,500)
                let calculatedMcap = 4500;
                if (parsedData.marketCapSol) {
                    calculatedMcap = Math.round(parsedData.marketCapSol * currentSolPriceUsd);
                }

                // Map exactly to your base44 Deno schema: { mint, name, symbol, mcap, launched, logo }
                const base44Payload = {
                    mint: parsedData.mint,
                    name: parsedData.name,
                    symbol: parsedData.symbol,
                    mcap: calculatedMcap,
                    launched: new Date().toISOString(), // Use current time as fallback
                    logo: parsedData.image || parsedData.uri || null // Pass uri/image metadata if available
                };

                console.log(`[Launch] ${base44Payload.symbol} detected. Sending to base44 (Est. MC: $${base44Payload.mcap})...`);
                
                // Fire and forget to keep the websocket frame ticking loop clear
                forwardToBase44(base44Payload);
            }
        } catch (err) {
            console.error('Parsing/Processing Error:', err.message);
        }
    });

    ws.on('error', function error(err) {
        console.error('WebSocket Error:', err.message);
    });

    ws.on('close', function close() {
        console.log(`Socket disconnected. Reconnecting in ${reconnectInterval / 1000} seconds...`);
        setTimeout(() => {
            reconnectInterval = Math.min(reconnectInterval * 2, MAX_RECONNECT_INTERVAL);
            connectStream();
        }, reconnectInterval);
    });
}

async function forwardToBase44(payload) {
    try {
        const response = await fetch(BASE44_INGEST_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-ingest-secret': INGEST_SECRET // Matches your Deno req.headers.get('x-ingest-secret')
            },
            body: JSON.stringify(payload)
        });

        const result = await response.json();
        
        if (response.ok) {
            if (result.skipped) {
                console.log(`[base44 Response] ⚠️ SKIPPED: ${result.reason}`);
            } else {
                console.log(`[base44 Response] ✅ Ingested successfully: ${payload.symbol}`);
            }
        } else {
            console.error(`[base44 Response] ❌ Failed Status ${response.status}:`, result.error || 'Unknown Error');
        }
    } catch (fetchError) {
        console.error('Could not transmit data packet to base44 backend:', fetchError.message);
    }
}

// Dynamically refresh SOL price every 10 minutes to keep MCAP mappings highly accurate
async function updateSolPrice() {
    try {
        const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
        const data = await res.json();
        if (data.solana?.usd) {
            currentSolPriceUsd = data.solana.usd;
        }
    } catch (e) {
        // Fallback silently to previous price state if API rates limits us
    }
}
setInterval(updateSolPrice, 600000);
updateSolPrice().then(() => connectStream());
