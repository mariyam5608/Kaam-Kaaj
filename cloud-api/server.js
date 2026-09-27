require("dotenv").config();
const express = require("express");
const bot = require("./lib/bot");

const app = express();

// `verify` stashes the unparsed bytes so the Meta signature can be checked —
// once express.json() has run, the original body is gone.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// ---- 1. Webhook verification (Meta calls this once when you set up the webhook) ----
app.get("/webhook", (req, res) => {
  const challenge = bot.verifyWebhook(req.query);
  if (challenge === null) return res.sendStatus(403);
  console.log("Webhook verified successfully.");
  return res.status(200).send(challenge);
});

// ---- 2. Incoming messages ----
app.post("/webhook", async (req, res) => {
  if (!bot.verifySignature(req.rawBody, req.get("X-Hub-Signature-256"))) {
    console.warn("Rejected webhook with a bad X-Hub-Signature-256.");
    return res.sendStatus(401);
  }

  // Respond to Meta immediately; do the AI work after. Safe here because this
  // is a long-running process. On Vercel the same trick needs waitUntil — see
  // api/webhook.js.
  res.sendStatus(200);

  try {
    await bot.handleIncoming(req.body);
  } catch (err) {
    console.error("Error handling incoming message:", err);
  }
});

// Health check, handy for confirming a deployment is alive.
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    webhook: "/webhook",
    allowedNumbers: bot.ALLOWED_NUMBERS.length,
    persistentHistory: bot.usesDatabase,
  });
});

const PORT = process.env.PORT || 3000;

// Only bind a port when run directly (`npm start`). Vercel imports this module
// for its Express app and provides its own listener.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Webhook endpoint: http://localhost:${PORT}/webhook`);
    console.log(`Allowed numbers: ${bot.ALLOWED_NUMBERS.join(", ") || "(none set!)"}`);
    console.log(
      bot.usesDatabase
        ? "Conversation history: Supabase (survives restarts)"
        : "Conversation history: in memory (resets on restart — set SUPABASE_URL and SUPABASE_KEY to persist)"
    );
  });
}

module.exports = app;
