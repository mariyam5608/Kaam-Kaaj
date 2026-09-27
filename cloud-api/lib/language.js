"use strict";

// Urdu / Roman Urdu language helpers. CommonJS, zero dependencies.
//
// Ported from the Baileys version of Kaam Kaaj (mariyam5608/Kaam-Kaaj,
// language.js) with the marketplace-specific bits removed: this backend is a
// free-chat bot, so there is no menu vocabulary, no "apply N" command and no
// hand-picked language. Detection drives a system-prompt directive and the
// model does the actual translation work.

const URDU_SCRIPT = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/;
const DEVANAGARI = /[\u0900-\u097F]/;

// Unambiguous Roman Urdu function words. Score 2 each.
const ROMAN_STRONG = new Set([
  'kya', 'kia', 'kyaa', 'nahi', 'nhi', 'nahin', 'nahee', 'chahiye', 'chahye',
  'chaiye', 'karna', 'krna', 'karta', 'krtay', 'kartay', 'acha', 'accha',
  'achha', 'bohat', 'bht', 'bohut', 'boht', 'zaroorat', 'zrurt', 'shukriya',
  'shukria', 'assalam', 'salam', 'bhai', 'yaar', 'yar', 'aapko', 'apko',
  'mujhe', 'mujy', 'mujhay', 'kaise', 'kesy', 'kaisay', 'kahan', 'kaha',
  'kaun', 'kon', 'kyun', 'kion', 'hoga', 'hogi', 'honge', 'sakta', 'sakti',
  'sakte', 'tha', 'thi', 'thay', 'hain', 'hy', 'hyn', 'theek', 'thik',
  'kaam', 'paise', 'paisay', 'rupay', 'haan', 'walaikum', 'mazdoor',
  'mazdoori', 'darkhwas',
]);

// Short words that are also plausible English or typos. Score 1 each.
const ROMAN_WEAK = new Set([
  'hai', 'aur', 'or', 'mein', 'main', 'mera', 'meri', 'mere', 'tum', 'tumhe',
  'hum', 'woh', 'wo', 'ye', 'yeh', 'se', 'ko', 'ka', 'ki', 'ke', 'liye',
  'leye', 'gaya', 'gayi', 'gaye', 'kab', 'han', 'ji', 'na', 'ab', 'yahan',
  'wahan', 'kam', 'mil', 'karo', 'kar', 'dena', 'do',
]);

// Variant spellings collapsed to one canonical form, so detection scores the
// same no matter how someone types it.
const ROMAN_CANONICAL = {
  kya: ['kia', 'kyaa'],
  nahi: ['nhi', 'nahin', 'nahee', 'nhe'],
  hai: ['hy', 'hae'],
  main: ['mein', 'mn', 'mai'],
  kaam: ['kam', 'kaj', 'kaaj'],
  chahiye: ['chahye', 'chaiye', 'chahie', 'chaheye', 'chy'],
  karna: ['krna', 'karnaa'],
  karta: ['krta'],
  karti: ['krti'],
  acha: ['accha', 'achha', 'achcha'],
  theek: ['thik', 'thk', 'teek'],
  bohat: ['bht', 'bohut', 'boht', 'buhat', 'bohot'],
  kaise: ['kaisay', 'kesy', 'kaisey'],
  kahan: ['kaha', 'kahn'],
  mujhe: ['mujy', 'mujhay', 'muje', 'mje', 'mjhe'],
  tumhe: ['tumhy', 'tumhay', 'tje', 'tjhe'],
  paise: ['paisa', 'paisay', 'rupay', 'rupaye'],
  zaroorat: ['zrurt', 'zarurat'],
  haan: ['han', 'haa'],
  shukriya: ['shukria', 'shukrya'],
  salam: ['assalam', 'aslam', 'slm'],
  ilaqa: ['area', 'mohalla', 'ilaaka'],
  mazdoor: ['mazdoori'],
};

const VARIANT_LOOKUP = new Map();
for (const canonical of Object.keys(ROMAN_CANONICAL)) {
  VARIANT_LOOKUP.set(canonical, canonical);
  for (const v of ROMAN_CANONICAL[canonical]) VARIANT_LOOKUP.set(v, canonical);
}

// Lowercase, strip punctuation, collapse spaces, canonicalise Roman variants.
function normalizeRoman(text) {
  if (typeof text !== 'string') return '';
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => VARIANT_LOOKUP.get(w) ?? w)
    .join(' ');
}

// Heuristic tag: 'urdu' | 'roman-urdu' | 'english' | 'hindi' | 'unknown'.
// Used to pick a locale, not as the source of truth — the model is a far
// better detector than any keyword list.
function detectLanguage(text) {
  if (!text || typeof text !== 'string') return 'unknown';
  // Urdu script is unambiguous and always wins, even in a mixed message.
  if (URDU_SCRIPT.test(text)) return 'urdu';
  if (DEVANAGARI.test(text)) return 'hindi';
  // Digits and emoji carry no language signal — "3" must not mean English.
  if (!/\p{L}/u.test(text)) return 'unknown';
  const words = normalizeRoman(text).split(' ').filter(Boolean);
  if (!words.length) return 'unknown';
  let score = 0;
  for (const w of words) {
    if (ROMAN_STRONG.has(w)) score += 2;
    else if (ROMAN_WEAK.has(w)) score += 1;
  }
  // One Latin word proves nothing — "hi" and "ok" are not a language.
  // Need a real sentence, or an actual Roman-Urdu function word.
  if (words.length < 2 && score < 2) return 'unknown';
  return score >= 2 ? 'roman-urdu' : 'english';
}

// Maps a detection result onto the locale keys used by messages.js.
function localeFor(text) {
  const lang = detectLanguage(text);
  if (lang === 'urdu') return 'ur';
  if (lang === 'roman-urdu') return 'roman';
  if (lang === 'english') return 'en';
  return null; // unknown / too short: fall back to the rest of the conversation
}

// The rules appended to SYSTEM_PROMPT on every call. SYSTEM_PROMPT stays the
// user-editable personality the README describes; this is added programmatically
// so nobody has to remember to paste language rules into .env.
const LANGUAGE_RULES =
  '\n\nLANGUAGE RULES - these matter more than anything else above:' +
  '\n1. MIRROR THE USER. If they write Roman Urdu (Urdu words in English letters, ' +
  'like "kya haal hai"), reply in Roman Urdu. If they write Urdu script, reply in ' +
  'Urdu script. If they write English, reply in English. Never move a user into a ' +
  'different script from the one they used.' +
  '\n2. NEVER write Hindi or Devanagari (काम, चहिए, नमस्ते). Roman Urdu and Hindi ' +
  'look alike in Latin letters, but this bot serves Urdu speakers in Hyderabad, ' +
  'Sindh - keep the vocabulary Urdu, not Hindi.' +
  '\n3. Always use Western digits 0-9, never ۰-۹.' +
  '\n4. Do not mix scripts inside one reply. Pick the user\'s script and stay in it.' +
  '\n5. Keep names, phone numbers, place names and amounts exactly as the user wrote them.';

// Appended last, right before the model generates, because models weight the end
// of a prompt more heavily than the middle.
function languageDirective(locale) {
  if (locale === 'ur') {
    return (
      '\n\nFINAL INSTRUCTION: this user is writing in Urdu script. Your whole reply ' +
      'must be in Urdu script (اردو) - not one word in English letters, not one ' +
      'Devanagari character.'
    );
  }
  if (locale === 'roman') {
    return (
      '\n\nFINAL INSTRUCTION: this user is writing in Roman Urdu. Your whole reply ' +
      'must be in Roman Urdu - Urdu words written in English letters, like "ji haan, ' +
      'bilkul". Do not use Urdu script and do not use Devanagari.'
    );
  }
  if (locale === 'en') {
    return '\n\nFINAL INSTRUCTION: this user is writing in English. Reply entirely in English.';
  }
  return '';
}

const EASTERN_DIGITS = /[\u06F0-\u06F9\u0660-\u0669]/g;
const WHATSAPP_TEXT_LIMIT = 4096;

// Models like markdown; WhatsApp is not markdown. Strips the bits that render as
// literal junk, forces Western digits (۵۰۰ -> 500), enforces the 4096 cap.
function sanitizeForWhatsApp(text) {
  if (typeof text !== 'string') return '';
  let out = text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '_$1_')
    .replace(EASTERN_DIGITS, (d) =>
      String(d.charCodeAt(0) - (d >= '\u06F0' ? 0x06f0 : 0x0660))
    )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (out.length > WHATSAPP_TEXT_LIMIT) {
    out = out.slice(0, WHATSAPP_TEXT_LIMIT - 1);
    const lastSpace = out.lastIndexOf(' ');
    if (lastSpace > WHATSAPP_TEXT_LIMIT - 400) out = out.slice(0, lastSpace);
    out += '…';
  }
  return out;
}

module.exports = {
  LANGUAGE_RULES,
  detectLanguage,
  languageDirective,
  localeFor,
  normalizeRoman,
  sanitizeForWhatsApp,
};
