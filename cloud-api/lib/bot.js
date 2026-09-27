"use strict";

// Everything the bot actually does, with no HTTP framework attached.
// server.js (local + ngrok) and api/webhook.js (Vercel) are thin wrappers
// around this, so the two deployment targets cannot drift apart.

const crypto = require("crypto");

const {
  LANGUAGE_RULES,
  languageDirective,
  localeFor,
  sanitizeForWhatsApp,
} = require("./language");
const { t } = require("./messages");

const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

// Personality / instructions for the bot. Edit this freely via SYSTEM_PROMPT.
const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  "You are a friendly, helpful assistant chatting with a close contact over WhatsApp. Keep replies natural, conversational, and reasonably short (like a real text message), not overly formal.";

// Comma-separated list of allowed numbers, international format without "+".
const ALLOWED_NUMBERS = (process.env.ALLOWED_NUMBERS || "")
  .split(",")
  .map((n) => n.trim())
  .filter(Boolean);

const MAX_HISTORY_MESSAGES = 20; // total messages (user+assistant) kept per number

const GRAPH_VERSION = "v20.0";

// ---- Conversation history ------------------------------------------------
// Serverless instances are frozen between requests, so an in-memory Map cannot
// hold a conversation on Vercel. When Supabase is configured the history lives
// there; otherwise we fall back to memory, which is correct for a single
// long-running local process (the ngrok setup in the README).

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const useDb = Boolean(SUPABASE_URL && SUPABASE_KEY);

const memory = new Map();

function supabaseHeaders(extra) {
  return Object.assign(
    {
      "Content-Type": "application/json",
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
    extra
  );
}

async function dbRead(number) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/conversations?number=eq.${encodeURIComponent(number)}&select=history`,
    { headers: supabaseHeaders() }
  );
  if (!res.ok) throw new Error(`Supabase read ${res.status}: ${await res.text()}`);
  const rows = await res.json();
  return rows[0]?.history ?? [];
}

async function dbWrite(number, history) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/conversations`, {
    method: "POST",
    // PostgREST upserts on the primary key (number) with this preference.
    headers: supabaseHeaders({ Prefer: "resolution=merge-duplicates" }),
    body: JSON.stringify({ number, history, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Supabase write ${res.status}: ${await res.text()}`);
}

async function getHistory(number) {
  if (useDb) {
    try {
      return await dbRead(number);
    } catch (err) {
      // Never let a database hiccup stop the bot from replying.
      console.error("History read failed, continuing without context:", err.message);
    }
  }
  return memory.get(number) || [];
}

async function saveHistory(number, history) {
  const trimmed = history.slice(-MAX_HISTORY_MESSAGES);
  memory.set(number, trimmed);
  if (!useDb) return;
  try {
    await dbWrite(number, trimmed);
  } catch (err) {
    console.error("History write failed:", err.message);
  }
}

// ---- Webhook verification (Meta calls GET /webhook once at setup) ---------

// Returns the hub.challenge string to echo back, or null if the request is not
// a valid verification handshake.
function verifyWebhook(query) {
  const mode = query["hub.mode"];
  const token = query["hub.verify_token"];
  const challenge = query["hub.challenge"];
  // The explicit `token` check matters: without it, a missing VERIFY_TOKEN on
  // both sides would compare undefined === undefined and let anyone verify.
  if (mode === "subscribe" && token && token === process.env.VERIFY_TOKEN) {
    return challenge;
  }
  return null;
}

// ---- Request authenticity ------------------------------------------------

// Meta signs every webhook POST with HMAC-SHA256 of the raw body, keyed on the
// app secret. Without this check, anyone who learns the public URL can forge
// inbound messages and spend the Groq quota. Skipped when no secret is set, so
// local development needs no extra configuration.
function verifySignature(rawBody, signatureHeader) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) return true;
  if (!signatureHeader || !rawBody) return false;

  const expected =
    "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signatureHeader));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- Language ------------------------------------------------------------

// A single message often carries no language signal — a bare emoji, "ok", a
// photo with no caption. Walk back to the last user message that does, so one
// short reply cannot flip the whole conversation into English.
function localeFrom(history, currentText) {
  const now = localeFor(currentText);
  if (now) return now;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role !== "user") continue;
    const found = localeFor(history[i].content);
    if (found) return found;
  }
  return null;
}

// SYSTEM_PROMPT stays exactly what the README says it is: the bot's editable
// personality. The language rules are appended here rather than pasted into
// .env, so nobody can lose them by rewriting the prompt.
function buildSystemPrompt(locale) {
  return SYSTEM_PROMPT + LANGUAGE_RULES + languageDirective(locale);
}

// ---- Groq ----------------------------------------------------------------

async function getAIReply(from, userText) {
  const history = await getHistory(from);
  history.push({ role: "user", content: userText });

  const locale = localeFrom(history, userText);
  const messages = [
    { role: "system", content: buildSystemPrompt(locale) },
    ...history,
  ];

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages,
      temperature: 0.8,
      max_tokens: 400,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error("Groq API error:", response.status, errText);
    return t(locale, "aiUnavailable");
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content?.trim() || "...";

  history.push({ role: "assistant", content: raw });
  await saveHistory(from, history);
  return sanitizeForWhatsApp(raw) || t(locale, "aiUnavailable");
}

// ---- WhatsApp Cloud API --------------------------------------------------

async function sendWhatsAppMessage(to, text) {
  const phoneNumberId = process.env.PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;
  if (!phoneNumberId || !token) {
    // Fail loudly: a silent 401 here looks exactly like "the bot ignored me".
    throw new Error(
      "PHONE_NUMBER_ID or WHATSAPP_TOKEN is not set. Check the names in .env — " +
        "they must match .env.example exactly."
    );
  }

  const response = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text },
      }),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    console.error("WhatsApp send error:", response.status, errText);
  }
}

// ---- One incoming webhook payload ---------------------------------------

// Does the whole job: authorise, call the model, reply. Both HTTP wrappers call
// this and nothing else.
async function handleIncoming(body) {
  const value = body?.entry?.[0]?.changes?.[0]?.value;
  const message = value?.messages?.[0];

  if (!message) return; // a status update (sent/delivered/read), not a message

  const from = message.from; // sender's number, no "+"

  if (!ALLOWED_NUMBERS.includes(from)) {
    console.log(`Ignored message from unauthorized number: ${from}`);
    return;
  }

  if (message.type !== "text") {
    // A voice note or photo carries no text to detect from, so take the
    // language from what this user has already been writing.
    const history = await getHistory(from);
    await sendWhatsAppMessage(
      from,
      sanitizeForWhatsApp(t(localeFrom(history), "textOnlyNotice"))
    );
    return;
  }

  const userText = message.text.body;
  console.log(`Message from ${from}: ${userText}`);

  const reply = await getAIReply(from, userText);
  await sendWhatsAppMessage(from, reply);
}

module.exports = {
  ALLOWED_NUMBERS,
  MAX_HISTORY_MESSAGES,
  buildSystemPrompt,
  getAIReply,
  handleIncoming,
  localeFrom,
  sendWhatsAppMessage,
  usesDatabase: useDb,
  verifySignature,
  verifyWebhook,
};
