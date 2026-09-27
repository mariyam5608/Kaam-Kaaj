const { waitUntil } = require("@vercel/functions");
const bot = require("../lib/bot");

// Ask the platform not to pre-parse the body: Meta's signature covers the raw
// bytes, so hashing a re-serialised object would not match.
module.exports = async function handler(req, res) {
  if (req.method === "GET") {
    const challenge = bot.verifyWebhook(req.query || {});
    if (challenge === null) return res.status(403).send("Forbidden");
    console.log("Webhook verified successfully.");
    return res.status(200).send(challenge);
  }

  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  const { raw, json } = await readBody(req);

  if (!bot.verifySignature(raw, req.headers["x-hub-signature-256"])) {
    console.warn("Rejected webhook with a bad X-Hub-Signature-256.");
    return res.status(401).send("Invalid signature");
  }

  // A serverless instance is frozen the moment the response is sent, so the
  // "reply 200 then do the work" pattern from server.js would silently drop
  // every message here. waitUntil keeps the invocation alive until the Groq
  // call and the WhatsApp send have finished.
  res.status(200).send("ok");
  waitUntil(
    bot.handleIncoming(json).catch((err) => {
      console.error("Error handling incoming message:", err);
    })
  );
};

module.exports.config = { api: { bodyParser: false } };

// Works whether or not the platform honoured the bodyParser config above.
async function readBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
    const raw = Buffer.from(JSON.stringify(req.body));
    return { raw, json: req.body };
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks);

  let json = {};
  if (raw.length) {
    try {
      json = JSON.parse(raw.toString("utf8"));
    } catch {
      console.warn("Webhook body was not valid JSON.");
    }
  }
  return { raw, json };
}
