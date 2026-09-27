// Kaam Kaaj — Urdu / Roman Urdu language helpers. ESM, zero dependencies.
//
// The model does the real language detection (see the system prompt in
// index.js). These helpers cover everything around it: tagging a message for
// analytics and locale choice, letting a user force a language, and cleaning
// model output so it renders correctly on WhatsApp.

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
  'mazdoori', 'darkhwas', 'zaroorat',
]);

// Short words that are also plausible English or typos. Score 1 each.
const ROMAN_WEAK = new Set([
  'hai', 'aur', 'or', 'mein', 'main', 'mera', 'meri', 'mere', 'tum', 'tumhe',
  'hum', 'woh', 'wo', 'ye', 'yeh', 'se', 'ko', 'ka', 'ki', 'ke', 'liye',
  'leye', 'gaya', 'gayi', 'gaye', 'kab', 'han', 'ji', 'na', 'ab', 'yahan',
  'wahan', 'kam', 'mil', 'karo', 'kar', 'dena', 'do', 'chahiye',
]);

// Variant spellings collapsed to one canonical form, so keyword rules match no
// matter how someone types it. Add to this as real messages arrive.
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
  mazdoor: ['mazdoori', 'mazdoor'],
};

const VARIANT_LOOKUP = new Map();
for (const canonical of Object.keys(ROMAN_CANONICAL)) {
  VARIANT_LOOKUP.set(canonical, canonical);
  for (const v of ROMAN_CANONICAL[canonical]) VARIANT_LOOKUP.set(v, canonical);
}

// Lowercase, strip punctuation, collapse spaces, canonicalise Roman variants.
export function normalizeRoman(text) {
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
// Use it for locale choice and analytics, not as the source of truth — the
// model is a far better detector than any keyword list.
export function detectLanguage(text) {
  if (!text || typeof text !== 'string') return 'unknown';
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
  // One Latin word proves nothing — "jobs" and "browse" are menu commands, not
  // a language. Need a real sentence, or an actual Roman-Urdu function word.
  if (words.length < 2 && score < 2) return 'unknown';
  return score >= 2 ? 'roman-urdu' : 'english';
}

// Maps a detection result onto the locale keys used by messages.js.
export function localeFor(text) {
  const lang = detectLanguage(text);
  if (lang === 'urdu') return 'ur';
  if (lang === 'roman-urdu') return 'roman';
  if (lang === 'english') return 'en';
  return null; // unknown / too short: keep whatever locale we already had
}

// Command vocabulary. Matched after normalizeRoman() so "salam", "assalam",
// "aslam" and "slm" all land on the same entry.
export const MENU_WORDS = new Set([
  'hi', 'hello', 'menu', 'start', '0', 'salam', 'assalam o alaikum',
  'aoa', 'adaab', 'مینو', 'السلام علیکم', 'آداب',
].map(normalizeRoman));

export const BROWSE_WORDS = new Set(['3', 'jobs', 'browse', 'نوکریاں'].map(normalizeRoman));

// "apply 1" / "darkhwas 2" / "درخواست 3" — run westernDigits() on the message
// first or Urdu-script numerals will never match.
export const APPLY_RE = /^(?:apply|darkhwas|درخواست)\s*(\d*)/;

// Explicit language choice by word. Deliberately does NOT use 1/2/3 — those
// are the marketplace menu in this bot and must stay free.
const LANGUAGE_WORDS = {
  ur: ['urdu', 'اردو', 'urdu mein', 'اردو میں'],
  roman: ['roman', 'roman urdu', 'رومن', 'رومن اردو'],
  en: ['english', 'angrezi', 'انگریزی'],
};

export function parseLanguageChoice(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim().toLowerCase();
  for (const locale of Object.keys(LANGUAGE_WORDS)) {
    if (LANGUAGE_WORDS[locale].some((c) => t === c.toLowerCase())) return locale;
  }
  return null;
}

// Appended to the system prompt once a user has picked a language by hand.
export function languageDirective(locale) {
  if (locale === 'ur') {
    return (
      '\n\nLANGUAGE LOCK: This user chose Urdu. Reply ONLY in Urdu script (اردو) ' +
      'from now on, even if they write in Roman letters or English. Never write ' +
      'Urdu words in Latin letters.'
    );
  }
  if (locale === 'roman') {
    return (
      '\n\nLANGUAGE LOCK: This user chose Roman Urdu. Reply ONLY in Roman Urdu — ' +
      'Urdu words written in English letters — even if they write in Urdu script ' +
      'or English. Never use Urdu script.'
    );
  }
  if (locale === 'en') {
    return '\n\nLANGUAGE LOCK: This user chose English. Reply ONLY in English.';
  }
  return '';
}

const EASTERN_DIGITS = /[\u06F0-\u06F9\u0660-\u0669]/g;
const WHATSAPP_TEXT_LIMIT = 4096;

// Models like markdown; WhatsApp is not markdown. Strips the bits that render
// as literal junk, forces Western digits (۵۰ -> 500), enforces the 4096 cap.
export function sanitizeForWhatsApp(text) {
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

// "apply ۲" -> "apply 2". Used before parseInt on user-typed numbers.
export function westernDigits(text) {
  if (typeof text !== 'string') return text;
  return text.replace(EASTERN_DIGITS, (d) =>
    String(d.charCodeAt(0) - (d >= '\u06F0' ? 0x06f0 : 0x0660))
  );
}
