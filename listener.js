import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// endpoint Render will keep alive
app.get("/", (req, res) => {
  res.send("listener alive");
});

// main webhook receiver
app.post("/helius", async (req, res) => {
  try {
    const events = req.body;

    for (const event of events) {
      const txType = detectType(event);

      if (txType === "LP_ADD" || txType === "PUMP_LAUNCH") {
        await forwardToBase44(event);
      }
    }

    res.status(200).send("ok");
  } catch (err) {
    console.error(err);
    res.status(500).send("error");
  }
});

function detectType(event) {
  const desc = event.description?.toLowerCase() || "";

  if (desc.includes("initialize") || desc.includes("create")) {
    return "PUMP_LAUNCH";
  }

  if (desc.includes("add liquidity") || desc.includes("raydium")) {
    return "LP_ADD";
  }

  return "IGNORE";
}

async function forwardToBase44(event) {
  await axios.post(process.env.BASE44_WEBHOOK_URL, {
    source: "listener",
    data: event
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("listener running on", PORT));
