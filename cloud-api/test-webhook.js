"use strict";

// End-to-end smoke test for the webhook layer. Run with: npm test
//
// Every credential below is fake. The assignments must come BEFORE lib/bot is
// required, because bot.js reads its environment once at module load. The last
// check requires server.js, which calls dotenv.config() — dotenv never
// overrides a variable that is already set, so the fakes stay in control and
// the real .env cannot leak into these assertions.
//
// Nothing here reaches the network: global.fetch is replaced with a recorder
// that captures what would have been sent to Groq and to the WhatsApp Cloud API.

process.env.GROQ_API_KEY = "fake-groq-key";
process.env.PHONE_NUMBER_ID = "1234567890";
process.env.WHATSAPP_TOKEN = "fake-wa-token";
process.env.VERIFY_TOKEN = "fake-verify";
process.env.WHATSAPP_APP_SECRET = "fake-app-secret";
process.env.ALLOWED_NUMBERS =
  "923000000001,923000000002,923000000003,923000000004,923000000005,923000000006,923000000007,923000000008,923000000009";
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_KEY;
delete process.env.SYSTEM_PROMPT;
delete process.env.GROQ_MODEL;

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const bot = require("./lib/bot");

// ---- fake network ---------------------------------------------------------

let groqCalls = [];
let waCalls = [];
let groqReplies = [];
let groqFails = false;

global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes("api.groq.com")) {
    groqCalls.push(JSON.parse(opts.body));
    if (groqFails) return { ok: false, status: 429, text: async () => "rate limited" };
    const content = groqReplies.shift() ?? "canned reply";
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content } }] }),
      text: async () => "",
    };
  }
  if (u.includes("graph.facebook.com")) {
    waCalls.push({ url: u, body: JSON.parse(opts.body) });
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
  }
  throw new Error(`unexpected fetch to ${u}`);
};

const reset = () => {
  groqCalls = [];
  waCalls = [];
  groqReplies = [];
  groqFails = false;
};

const textMsg = (from, body) => ({
  entry: [{ changes: [{ value: { messages: [{ from, type: "text", text: { body } }] } }] }],
});

const sysPromptOf = (i = 0) => groqCalls[i].messages[0].content;
const sentText = (i = 0) => waCalls[i].body.text.body;

let passed = 0;
async function check(name, fn) {
  reset();
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const sign = (raw) =>
  "sha256=" +
  crypto.createHmac("sha256", process.env.WHATSAPP_APP_SECRET).update(raw).digest("hex");

// ---- tests ----------------------------------------------------------------

(async () => {
  console.log("\nWebhook handshake");
  await check("correct verify token echoes the challenge", () => {
    assert.equal(
      bot.verifyWebhook({
        "hub.mode": "subscribe",
        "hub.verify_token": "fake-verify",
        "hub.challenge": "1975",
      }),
      "1975"
    );
  });
  await check("wrong verify token is rejected", () => {
    assert.equal(
      bot.verifyWebhook({
        "hub.mode": "subscribe",
        "hub.verify_token": "nope",
        "hub.challenge": "1975",
      }),
      null
    );
  });
  await check("a missing VERIFY_TOKEN on our side cannot verify anything", () => {
    const saved = process.env.VERIFY_TOKEN;
    delete process.env.VERIFY_TOKEN;
    assert.equal(
      bot.verifyWebhook({ "hub.mode": "subscribe", "hub.challenge": "1975" }),
      null
    );
    process.env.VERIFY_TOKEN = saved;
  });

  console.log("\nRequest authenticity");
  await check("a correctly signed body passes", () => {
    const raw = Buffer.from('{"hello":"world"}');
    assert.equal(bot.verifySignature(raw, sign(raw)), true);
  });
  await check("a forged signature is rejected", () => {
    const raw = Buffer.from('{"hello":"world"}');
    assert.equal(bot.verifySignature(raw, "sha256=" + "0".repeat(64)), false);
  });
  await check("a tampered body is rejected", () => {
    assert.equal(bot.verifySignature(Buffer.from('{"a":2}'), sign(Buffer.from('{"a":1}'))), false);
  });
  await check("no signature at all is rejected when a secret is configured", () => {
    assert.equal(bot.verifySignature(Buffer.from("{}"), undefined), false);
  });

  console.log("\nAuthorisation");
  await check("an unauthorised number gets no reply and no Groq call", async () => {
    await bot.handleIncoming(textMsg("15550009999", "hello there"));
    assert.equal(groqCalls.length, 0);
    assert.equal(waCalls.length, 0);
  });
  await check("a delivery-status update is a no-op", async () => {
    await bot.handleIncoming({
      entry: [{ changes: [{ value: { statuses: [{ id: "wamid.X", status: "read" }] } }] }],
    });
    assert.equal(groqCalls.length, 0);
    assert.equal(waCalls.length, 0);
  });

  console.log("\nLanguage mirroring");
  await check("an Urdu-script message gets an Urdu directive last in the prompt", async () => {
    groqReplies.push("جی ہاں، میں آپ کی مدد کر سکتا ہوں۔");
    await bot.handleIncoming(textMsg("923000000001", "مجھے ایک مزدور چاہیے"));
    const p = sysPromptOf();
    assert.match(p, /^You are a friendly, helpful assistant/);
    assert.match(p, /MIRROR THE USER/);
    assert.match(p, /FINAL INSTRUCTION: this user is writing in Urdu script/);
    assert.ok(p.endsWith("Devanagari character."));
    assert.equal(sentText(), "جی ہاں، میں آپ کی مدد کر سکتا ہوں۔");
  });
  await check("a Roman Urdu message gets a Roman Urdu directive", async () => {
    await bot.handleIncoming(textMsg("923000000002", "kya haal hai bhai"));
    assert.match(sysPromptOf(), /FINAL INSTRUCTION: this user is writing in Roman Urdu/);
  });
  await check("an English message still gets an English directive", async () => {
    await bot.handleIncoming(textMsg("923000000003", "I need a plumber for two days"));
    const p = sysPromptOf();
    assert.ok(p.endsWith("Reply entirely in English."));
  });
  await check("a short reply keeps the language already established", async () => {
    await bot.handleIncoming(textMsg("923000000004", "mujhe ek mazdoor chahiye"));
    assert.match(sysPromptOf(), /Roman Urdu/);
    reset();
    await bot.handleIncoming(textMsg("923000000004", "ok"));
    assert.match(sysPromptOf(), /FINAL INSTRUCTION: this user is writing in Roman Urdu/);
  });

  console.log("\nOutput handling");
  await check("model markdown and Urdu numerals are cleaned before sending", async () => {
    groqReplies.push("**Zaroor!** Aap ko ۵۰۰ rupees milenge.\n# Heading\n- pehla");
    await bot.handleIncoming(textMsg("923000000005", "kitne paise milenge"));
    const out = sentText();
    assert.match(out, /\*Zaroor!\*/);
    assert.match(out, /500 rupees/);
    assert.ok(!out.includes("**"));
    assert.ok(!out.includes("#"));
    assert.ok(!out.includes("- pehla"));
  });
  await check("conversation history accumulates across turns", async () => {
    await bot.handleIncoming(textMsg("923000000006", "salam"));
    reset();
    await bot.handleIncoming(textMsg("923000000006", "kaise ho"));
    assert.equal(
      groqCalls[0].messages.map((m) => m.role).join(","),
      "system,user,assistant,user"
    );
  });
  await check("a Groq failure apologises in the user's own language", async () => {
    groqFails = true;
    await bot.handleIncoming(textMsg("923000000007", "مجھے کام چاہیے"));
    assert.equal(sentText(), "معذرت، ابھی مجھے سوچنے میں مسئلہ ہو رہا ہے۔ تھوڑی دیر بعد دوبارہ کوشش کریں۔");
  });
  await check("an English Groq failure is unchanged from the original bot", async () => {
    groqFails = true;
    await bot.handleIncoming(textMsg("923000000008", "I need a plumber for two days"));
    assert.equal(
      sentText(),
      "Sorry, I'm having trouble thinking right now. Try again in a bit."
    );
  });

  console.log("\nNon-text messages");
  await check("a voice note is refused in the language the user has been using", async () => {
    await bot.handleIncoming(textMsg("923000000001", "مجھے ایک مزدور چاہیے"));
    reset();
    await bot.handleIncoming({
      entry: [{ changes: [{ value: { messages: [{ from: "923000000001", type: "audio", audio: {} }] } }] }],
    });
    assert.equal(groqCalls.length, 0);
    assert.match(sentText(), /پڑھ سکتا ہوں/);
  });
  await check("a voice note from a brand-new user is refused in English", async () => {
    await bot.handleIncoming({
      entry: [{ changes: [{ value: { messages: [{ from: "923000000009", type: "image", image: {} }] } }] }],
    });
    assert.match(sentText(), /plain text/);
  });

  console.log("\nConfiguration failures");
  await check("a missing PHONE_NUMBER_ID fails loudly instead of calling graph/undefined", async () => {
    const saved = process.env.PHONE_NUMBER_ID;
    delete process.env.PHONE_NUMBER_ID;
    await assert.rejects(
      () => bot.sendWhatsAppMessage("923000000001", "hi"),
      /PHONE_NUMBER_ID or WHATSAPP_TOKEN is not set/
    );
    process.env.PHONE_NUMBER_ID = saved;
    assert.equal(waCalls.length, 0);
  });
  await check("Supabase is off, so history lives in memory", () => {
    assert.equal(bot.usesDatabase, false);
  });

  console.log("\nEntry points");
  await check("api/webhook.js exports a handler with bodyParser disabled", () => {
    const fn = require("./api/webhook.js");
    assert.equal(typeof fn, "function");
    assert.equal(fn.config.api.bodyParser, false);
  });
  await check("server.js exports an Express app and does not listen on require", () => {
    const app = require("./server.js");
    assert.equal(typeof app, "function");
    assert.equal(typeof app.use, "function");
  });

  console.log(`\n✅ ${passed} checks passed\n`);
})().catch((err) => {
  console.error("\n❌ FAILED:", err.message);
  process.exit(1);
});
