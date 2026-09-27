"use strict";

// Self-test for the language layer. Run with: npm test
//
// Nothing here touches WhatsApp or Groq. bot.js is required directly and does
// not load dotenv, so this never reads the real .env.

const assert = require("node:assert/strict");

const {
  detectLanguage,
  localeFor,
  normalizeRoman,
  sanitizeForWhatsApp,
} = require("./lib/language");
const { LOCALES, missingKeys, t } = require("./lib/messages");
const bot = require("./lib/bot");

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

console.log("\nMessage table");
check("every locale has every key", () => {
  assert.deepEqual(missingKeys(), []);
  assert.deepEqual(LOCALES, ["en", "roman", "ur"]);
});
check("the three locales are actually three different languages", () => {
  assert.match(t("en", "textOnlyNotice"), /plain text/);
  assert.match(t("roman", "textOnlyNotice"), /parh sakta hoon/);
  assert.match(t("ur", "textOnlyNotice"), /پڑھ سکتا ہوں/);
});
// Unknown locale must fall back to English here, not Roman Urdu: this bot has
// no hand-picked language, so "could not tell" means "behave exactly as before".
check("unknown locale falls back to English", () => {
  assert.equal(t("fr", "aiUnavailable"), t("en", "aiUnavailable"));
  assert.equal(t(null, "aiUnavailable"), t("en", "aiUnavailable"));
});
// Regression guard: localising must not quietly reword the English path.
check("English strings are unchanged from the original bot", () => {
  assert.equal(
    t("en", "textOnlyNotice"),
    "I can only read text messages right now — try sending that as plain text!"
  );
  assert.equal(
    t("en", "aiUnavailable"),
    "Sorry, I'm having trouble thinking right now. Try again in a bit."
  );
});
check("a missing key returns the key, not undefined", () => {
  assert.equal(t("ur", "noSuchKey"), "noSuchKey");
});

console.log("\nLanguage detection");
check("Urdu script -> ur", () => {
  assert.equal(localeFor("مجھے قاسم آباد میں کام چاہیے"), "ur");
});
check("Roman Urdu -> roman", () => {
  assert.equal(localeFor("mujhe qasimabad mein loader chahiye"), "roman");
  assert.equal(localeFor("kya haal hai bhai"), "roman");
});
check("English -> en", () => {
  assert.equal(localeFor("I need a plumber for two days"), "en");
});
check("Roman spelling variants all land on the same locale", () => {
  for (const msg of [
    "mujhe kam chahiye",
    "mujhay kaam chahye",
    "mjhe kaj chy",
  ]) {
    assert.equal(localeFor(msg), "roman", `failed: ${msg}`);
  }
});
check("Urdu script wins in a mixed-script message", () => {
  assert.equal(localeFor("please mujhe یہ کام chahiye"), "ur");
});
check("digits and emoji carry no language signal", () => {
  assert.equal(localeFor("3"), null);
  assert.equal(detectLanguage("👍"), "unknown");
  assert.equal(detectLanguage(""), "unknown");
});
check("Devanagari is flagged as Hindi, never mistaken for Urdu", () => {
  assert.equal(detectLanguage("काम चाहिए"), "hindi");
  assert.equal(localeFor("काम चाहिए"), null);
});
check("one Latin word proves nothing", () => {
  assert.equal(localeFor("a"), null);
  assert.equal(localeFor("ok"), null);
  assert.equal(localeFor("hi"), null);
});
check("normalizeRoman collapses variants and punctuation", () => {
  assert.equal(normalizeRoman("Kya?? Haal hy!"), "kya haal hai");
});

console.log("\nLocale carry-over");
check("the current message decides the locale", () => {
  const history = [{ role: "user", content: "I need a plumber for two days" }];
  assert.equal(bot.localeFrom(history, "مجھے کام چاہیے"), "ur");
});
check("a language-less reply inherits the user's last real language", () => {
  const history = [
    { role: "user", content: "mujhe ek mazdoor chahiye" },
    { role: "assistant", content: "Sure, I can help with that." },
  ];
  assert.equal(bot.localeFrom(history, "ok"), "roman");
});
check("assistant messages are ignored when scanning back", () => {
  const history = [
    { role: "user", content: "مجھے کام چاہیے" },
    { role: "assistant", content: "Here are three options for you." },
    { role: "user", content: "👍" },
  ];
  assert.equal(bot.localeFrom(history, ""), "ur");
});
check("no history and no signal means no locale", () => {
  assert.equal(bot.localeFrom([], "ok"), null);
});

console.log("\nSystem prompt assembly");
check("the editable personality stays first and intact", () => {
  const prompt = bot.buildSystemPrompt(null);
  assert.match(prompt, /^You are a friendly, helpful assistant/);
  assert.ok(prompt.indexOf("LANGUAGE RULES") > prompt.indexOf("friendly"));
});
check("the mirroring rules are always present", () => {
  const prompt = bot.buildSystemPrompt(null);
  assert.match(prompt, /MIRROR THE USER/);
  assert.match(prompt, /NEVER write Hindi or Devanagari/);
  assert.match(prompt, /Western digits 0-9/);
});
check("each detected locale gets its directive at the very end", () => {
  const ur = bot.buildSystemPrompt("ur");
  assert.ok(ur.endsWith("Devanagari character."), "ur directive is not last");
  assert.match(ur, /FINAL INSTRUCTION: this user is writing in Urdu script/);

  const roman = bot.buildSystemPrompt("roman");
  assert.match(roman, /FINAL INSTRUCTION: this user is writing in Roman Urdu/);
  assert.ok(roman.endsWith("do not use Devanagari."));

  const en = bot.buildSystemPrompt("en");
  assert.ok(en.endsWith("Reply entirely in English."));
});
check("no locale means no directive — the .env prompt governs alone", () => {
  assert.ok(!bot.buildSystemPrompt(null).includes("FINAL INSTRUCTION"));
});

console.log("\nWhatsApp output");
check("markdown is stripped and digits are normalised", () => {
  const out = sanitizeForWhatsApp("**Bold** heading\n# Title\n۵۰۰ rupees");
  assert.match(out, /\*Bold\*/);
  assert.match(out, /500 rupees/);
  assert.ok(!out.includes("**"));
  assert.ok(!out.includes("#"));
});
check("Arabic-Indic digits are converted too", () => {
  assert.match(sanitizeForWhatsApp("١٠٠٠ روپے"), /1000 روپے/);
});
check("long output is cut at the 4096 character WhatsApp limit", () => {
  assert.ok(sanitizeForWhatsApp("x".repeat(9000)).length <= 4096);
});
check("non-strings do not throw", () => {
  assert.equal(sanitizeForWhatsApp(undefined), "");
  assert.equal(sanitizeForWhatsApp(null), "");
});

console.log(`\n✅ ${passed} checks passed\n`);
