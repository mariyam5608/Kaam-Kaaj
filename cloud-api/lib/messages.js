"use strict";

// The only strings this bot writes itself. Everything else comes from the model.
//
// English entries are byte-identical to the originals in server.js, so an
// English-speaking user sees exactly the bot Marrium shipped.

const MESSAGES = {
  en: {
    textOnlyNotice:
      'I can only read text messages right now — try sending that as plain text!',
    aiUnavailable:
      "Sorry, I'm having trouble thinking right now. Try again in a bit.",
  },
  roman: {
    textOnlyNotice:
      'Abhi main sirf text messages parh sakta hoon — wo baat saaday likh kar bhejein!',
    aiUnavailable:
      'Maazrat, abhi mujhe sochne mein masla ho raha hai. Thori der baad dobara koshish karein.',
  },
  ur: {
    textOnlyNotice:
      'ابھی میں صرف ٹیکسٹ پیغام پڑھ سکتا ہوں — وہ بات سادہ لکھ کر بھیجیں!',
    aiUnavailable:
      'معذرت، ابھی مجھے سوچنے میں مسئلہ ہو رہا ہے۔ تھوڑی دیر بعد دوبارہ کوشش کریں۔',
  },
};

const LOCALES = Object.keys(MESSAGES);

// Unknown locale falls back to English, not Roman Urdu: this bot has no
// hand-picked language, so "we could not tell" means "behave as before".
function resolve(locale) {
  return MESSAGES[locale] ? locale : 'en';
}

function t(locale, key) {
  const table = MESSAGES[resolve(locale)];
  return table[key] ?? MESSAGES.en[key] ?? key;
}

// Every locale must carry every key. Returns ["ur.aiUnavailable", ...] when one
// is missing, so a typo surfaces in tests instead of as a raw key on WhatsApp.
function missingKeys() {
  const out = [];
  for (const locale of LOCALES) {
    for (const key of Object.keys(MESSAGES.en)) {
      if (MESSAGES[locale][key] === undefined) out.push(`${locale}.${key}`);
    }
  }
  return out;
}

module.exports = { LOCALES, MESSAGES, missingKeys, t };
