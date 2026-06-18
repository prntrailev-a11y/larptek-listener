const WebSocket = require('ws');
require('dotenv').config();

// Configuration
const BASE44_INGEST_URL = process.env.BASE44_INGEST_URL || 'http://localhost:5000/api/ingest';
const PUMP_WS_URL = 'wss://pumpportal.fun/api/data'; 

let reconnectInterval = 1000;
const MAX_RECONNECT_INTERVAL = 30000;

function connectStream() {
    console.log(`[${new Date().toISOString()}] Connecting to Pump.fun stream...`);
    const ws = new WebSocket(PUMP_WS_URL);

    ws.on('open', function open() {
        console.log(`[${new Date().toISOString()}] Connected! Subscribing to new token launches...`);
        
        // Reset reconnect timer on a successful connection
        reconnectInterval = 1000; 

        // Send subscription payload for token creation events
        const payload = {
            method: "subscribeNewToken"
        };
        ws.send(JSON.stringify(payload));
    });

    ws.on('message', async function message(data) {
        try {
            const parsedData = JSON.parse(data);
            
            // Filter for token creation events specifically
            if (parsedData.txType === 'create' || parsedData.mint) {
                console.log(`[Launch Detected] ${parsedData.name} (${parsedData.symbol}) | Mint: ${parsedData.mint}`);
                
                // Ship raw packet immediately over to your recursive base44 engine
                forwardToBase44(parsedData);
            }
        } catch (err) {
            console.error('Error parsing block packet:', err.message);
        }
    });

    ws.on('error', function error(err) {
        console.error('WebSocket Error:', err.message);
    });

    ws.on('close', function close() {
        console.log(`Socket closed. Reconnecting in ${reconnectInterval / 1000} seconds...`);
        setTimeout(() => {
            // Exponential backoff so you don't spam the server if it's down
            reconnectInterval = Math.min(reconnectInterval * 2, MAX_RECONNECT_INTERVAL);
            connectStream();
        }, reconnectInterval);
    });
}

// Push to your recursive processing backend
async function forwardToBase44(tokenPayload) {
    try {
        const response = await fetch(BASE44_INGEST_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                // 'Authorization': `Bearer ${process.env.BASE44_API_KEY}` // Uncomment if base44 requires auth
            },
            body: JSON.stringify({
                source: 'pump_fun_stream',
                timestamp: Date.now(),
                data: tokenPayload
            })
        });

        if (!response.ok) {
            console.error(`base44 Ingest failed with status: ${response.status}`);
        }
    } catch (fetchError) {
        console.error('Failed to pipe data packet to base44 engine:', fetchError.message);
    }
}

// Fire up the background listener
connectStream();
