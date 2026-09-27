// Self-test for the language layer. Run with: npm test
//
// Nothing here touches WhatsApp or Groq — it only checks that the three locales
// stay in sync and that detection, commands and formatting behave. Add a case
// whenever a real message exposes a bug.

import assert from 'node:assert/strict';
import {
  localeFor, detectLanguage, parseLanguageChoice, sanitizeForWhatsApp,
  westernDigits, normalizeRoman, MENU_WORDS, BROWSE_WORDS, APPLY_RE,
  isProceedOrAffirmation, findMatchingJob,
} from './language.js';
import { t, fmt, renderFields, missingKeys } from './messages.js';

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

console.log('\nMessage table');
check('every locale has every key', () => {
  assert.deepEqual(missingKeys(), []);
});
check('menus are actually in three different languages', () => {
  assert.match(t('en', 'menu'), /Welcome/);
  assert.match(t('roman', 'menu'), /Khush Amdeed/);
  assert.match(t('ur', 'menu'), /خوش آمدید/);
});
check('unknown locale falls back to Roman Urdu, not to nothing', () => {
  assert.equal(t('fr', 'menu'), t('roman', 'menu'));
});
check('placeholders are filled', () => {
  const msg = fmt(t('roman', 'applyEmployer'), { role: 'Loader', num: '923001234567' });
  assert.match(msg, /\(\*Loader\*\)/);
  assert.match(msg, /wa\.me\/923001234567/);
});
check('the menu tells users how to switch language', () => {
  for (const locale of ['en', 'roman', 'ur']) {
    assert.match(t(locale, 'menu'), /urdu|اردو/i);
  }
});

console.log('\nField rendering');
check('labels are translated, values are left alone', () => {
  assert.equal(renderFields('roman', { Role: 'Loader' }), '• *Kaam*: Loader');
  assert.equal(renderFields('ur', { Role: 'مزدور' }), '• *کام*: مزدور');
});
check('empty fields are dropped instead of printed as blank bullets', () => {
  const out = renderFields('ur', { Role: 'مزدور', Location: '', Salary: '1000', Hours: null });
  assert.equal(out, '• *کام*: مزدور\n• *تنخواہ*: 1000');
});
check('unknown keys still print, using the raw key as the label', () => {
  assert.equal(renderFields('en', { Nickname: 'Bilal' }), '• *Nickname*: Bilal');
});

console.log('\nLanguage detection');
check('Urdu script -> ur', () => {
  assert.equal(localeFor('مجھے قاسم آباد میں لوڈر چاہیے'), 'ur');
});
check('Roman Urdu -> roman', () => {
  assert.equal(localeFor('mujhe qasimabad mein loader chahiye'), 'roman');
});
check('English -> en', () => {
  assert.equal(localeFor('I need a plumber for two days'), 'en');
});
check('a bare menu number carries no language signal', () => {
  assert.equal(localeFor('3'), null);
  assert.equal(detectLanguage('0'), 'unknown');
});
check('Devanagari is flagged as Hindi, never mistaken for Urdu', () => {
  assert.equal(detectLanguage('काम चाहिए'), 'hindi');
});
check('one Latin word proves nothing — short commands keep the current locale', () => {
  assert.equal(localeFor('a'), null);
  assert.equal(localeFor('jobs'), null);
  assert.equal(localeFor('browse'), null);
});

console.log('\nCommands');
check('greetings in all three scripts open the menu', () => {
  for (const word of ['hi', 'menu', 'salam', 'assalam', 'aoa', 'مینو', 'السلام علیکم']) {
    assert.ok(MENU_WORDS.has(normalizeRoman(word.toLowerCase())), `menu word failed: ${word}`);
  }
});
check('browse accepts English and Urdu', () => {
  for (const word of ['3', 'jobs', 'browse', 'نوکریاں']) {
    assert.ok(BROWSE_WORDS.has(normalizeRoman(word.toLowerCase())), `browse word failed: ${word}`);
  }
});
check('apply parses a job number in English, Roman Urdu and Urdu script', () => {
  assert.equal('apply 1'.match(APPLY_RE)[1], '1');
  assert.equal('darkhwas 2'.match(APPLY_RE)[1], '2');
  assert.equal(westernDigits('درخواست ۳').match(APPLY_RE)[1], '3');
});
check('apply with no number matches but yields no index', () => {
  assert.equal('apply'.match(APPLY_RE)[1], '');
  assert.ok(Number.isNaN(parseInt('', 10)));
});
check('a normal sentence is not mistaken for a command', () => {
  assert.equal('i applied for a job last week'.match(APPLY_RE), null);
});
check('isProceedOrAffirmation recognizes natural confirmation in all styles', () => {
  assert.ok(isProceedOrAffirmation('jee mujhe is job k liye apply krna hai'));
  assert.ok(isProceedOrAffirmation('id like to proceed'));
  assert.ok(isProceedOrAffirmation('proceed'));
  assert.ok(isProceedOrAffirmation('theek hai'));
  assert.ok(isProceedOrAffirmation('haan apply kar do'));
  assert.ok(isProceedOrAffirmation('is job pe apply karna hai'));
  assert.ok(!isProceedOrAffirmation('kya aap mujhe jobs dikha sktay hain'));
  assert.ok(!isProceedOrAffirmation('i applied for a job last week'));
});
check('findMatchingJob matches job by ID, role and location', () => {
  const sampleJobs = [
    { id: 1, data: { Role: 'loader', Location: 'qasimabad' } },
    { id: 2, data: { Role: 'labourer', Location: 'Karachi' } },
    { id: 3, data: { Role: 'Painter', Location: 'Hyderabad' } }
  ];
  assert.equal(findMatchingJob('loader in qasimabad', sampleJobs)?.id, 1);
  assert.equal(findMatchingJob('job id 1', sampleJobs)?.id, 1);
  assert.equal(findMatchingJob('apply 1', sampleJobs)?.id, 1);
  assert.equal(findMatchingJob('#3', sampleJobs)?.id, 3);
  assert.equal(findMatchingJob('painter', sampleJobs)?.id, 3);
  assert.equal(findMatchingJob('hello', sampleJobs), null);
});
check('language words never collide with the 1/2/3 marketplace menu', () => {
  assert.equal(parseLanguageChoice('3'), null);
  assert.equal(parseLanguageChoice('menu'), null);
  assert.equal(parseLanguageChoice('urdu'), 'ur');
  assert.equal(parseLanguageChoice('اردو'), 'ur');
  assert.equal(parseLanguageChoice('roman'), 'roman');
  assert.equal(parseLanguageChoice('رومن'), 'roman');
  assert.equal(parseLanguageChoice('english'), 'en');
  assert.equal(parseLanguageChoice('انگریزی'), 'en');
});
check('a real Roman Urdu sentence is what actually switches the locale', () => {
  assert.equal(localeFor('mujhe ek din ka mazdoor chahiye'), 'roman');
});

console.log('\nWhatsApp output');
check('Urdu numerals become Western ones', () => {
  assert.equal(westernDigits('۱۰۰۰ روپے'), '1000 روپے');
  assert.equal(westernDigits('١٠٠٠'), '1000');
});
check('markdown is stripped and digits are normalised', () => {
  const out = sanitizeForWhatsApp('**Bold** heading\n# Title\n۵۰۰ rupees');
  assert.match(out, /\*Bold\*/);
  assert.match(out, /500 rupees/);
  assert.ok(!out.includes('**'));
  assert.ok(!out.includes('#'));
});
check('long output is cut at the 4096 character WhatsApp limit', () => {
  assert.ok(sanitizeForWhatsApp('x'.repeat(9000)).length <= 4096);
});
check('non-strings do not throw', () => {
  assert.equal(sanitizeForWhatsApp(undefined), '');
  assert.equal(sanitizeForWhatsApp(null), '');
});

console.log(`\n✅ ${passed} checks passed\n`);
