// Kaam Kaaj — trilingual message table (en / roman / ur). ESM, zero deps.
//
// WHY THIS FILE EXISTS: every string the bot sends used to be hard-coded
// Roman Urdu inside index.js, so an Urdu-script user got Roman replies and an
// English user got Roman too. Localisation is just keeping three copies of
// each string and picking by locale. No translation service, no LLM in the
// middle of the flow.
//
// RULE: only LABELS are translated. A worker's values — name, area, phone,
// fare — are copied through byte-for-byte and must never be rewritten.
//
// {placeholders} are filled by fmt(). Run missingKeys() once at startup (or in
// a test) to catch a string translated in two locales and forgotten in the
// third.

const MESSAGES = {
  en: {
    menu:
      '👋 *Welcome - Local Job Marketplace*\n\n' +
      'What would you like to do?\n\n' +
      '*1️⃣* Post a Job (Need a worker)\n' +
      '*2️⃣* Find Work (Worker profile)\n' +
      '*3️⃣* See Available Jobs 🔍\n\n' +
      '*(Tell us what you need by voice note or text)*\n\n' +
      '_(Change language: type *urdu*, *roman* or *english*)_',
    jobPostedTitle: '✅ *Your Job Has Been Posted!*',
    jobPostedFooter: 'To see active jobs type *3* or *jobs*.',
    workerSavedTitle: '✅ *Your Worker Profile Is Ready!*',
    workerSavedFooter: 'To see jobs and apply, type *3* or *jobs*.',
    browseEmpty: '📭 No active jobs available right now.',
    browseHeader: '📋 *Available Active Jobs:*',
    browseJobHeader: '*Job #{n}*',
    browseFooter: '💬 To apply, type: *apply [Job Number]* (e.g. *apply 1*)',
    applyEmployer:
      '🔔 *New Application!*\n\n' +
      'A worker wants to contact you about your job (*{role}*).\n\n' +
      '📱 Direct WhatsApp Link: wa.me/{num}',
    applyWorker:
      '✅ Your application has been sent to the employer! ' +
      'They will contact you directly on WhatsApp.',
    applyError: '❌ Write a correct job number. Example: *apply 1*',
    voiceError:
      '❌ The audio was not clear. Please send the voice note again or type your message.',
    aiUnavailable:
      'Thanks! Please describe what you need in a little more detail, or send a voice note (e.g. "I need a loader in Qasimabad at 1000/day").',
    langSwitched: 'Got it — English it is from now on 🙂',
  },

  roman: {
    menu:
      '👋 *Khush Amdeed - Local Job Marketplace*\n\n' +
      'Aap kya karna chahte hain?\n\n' +
      '*1️⃣* Job Post Karein (Mazdoor chahiye)\n' +
      '*2️⃣* Kam Dhundhein (Worker profile)\n' +
      '*3️⃣* Available Jobs Dekhein 🔍\n\n' +
      '*(Voice note ya text mein apni zaroorat batayein)*\n\n' +
      '_(Zaban badalne ke liye likhein: *urdu*, *roman* ya *english*)_',
    jobPostedTitle: '✅ *Aap Ki Job Post Ho Gayi!*',
    jobPostedFooter: 'Active jobs dekhne ke liye *3* ya *jobs* likhein.',
    workerSavedTitle: '✅ *Aap Ki Worker Profile Ban Gayi!*',
    workerSavedFooter: 'Jobs dekhne aur apply karne ke liye *3* ya *jobs* likhein.',
    browseEmpty: '📭 Filhal koi active job available nahi hai.',
    browseHeader: '📋 *Available Active Jobs:*',
    browseJobHeader: '*Job #{n}*',
    browseFooter: '💬 Apply karne ke liye likhein: *apply [Job Number]* (e.g. *apply 1*)',
    applyEmployer:
      '🔔 *Nayi Application!*\n\n' +
      'Ek worker aap ki job (*{role}*) ke liye rabta karna chahta hai.\n\n' +
      '📱 Direct WhatsApp Link: wa.me/{num}',
    applyWorker:
      '✅ Aap ki darkhwas employer ko bhej di gayi hai! ' +
      'Wo aapse direct WhatsApp par rabta karein ge.',
    applyError: '❌ Sahi job number likhein. Misal: *apply 1*',
    voiceError:
      '❌ Awaaz saaf nahi aayi. Baraye meherbani dubara voice note bhejein ya text likhein.',
    aiUnavailable:
      'Shukriya! Apni zaroorat tafseel se likhein ya voice note bhejein (misal: "Mujhe Qasimabad mein 1000/day par loader chahiye").',
    langSwitched: 'Theek hai, ab se Roman Urdu mein baat hogi 🙂',
  },

  ur: {
    menu:
      '👋 *خوش آمدید - مقامی روزگار مارکیٹ*\n\n' +
      'آپ کیا کرنا چاہتے ہیں؟\n\n' +
      '*1️⃣* کام لگائیں (مزدور چاہیے)\n' +
      '*2️⃣* کام ڈھونڈیں (ورکر پروفائل)\n' +
      '*3️⃣* دستیاب کام دیکھیں 🔍\n\n' +
      '*(وائس نوٹ یا تحریر میں اپنی ضرورت بتائیں)*\n\n' +
      '_(زبان بدلنے کے لیے لکھیں: *اردو*، *رومن* یا *انگریزی*)_',
    jobPostedTitle: '✅ *آپ کا کام پوسٹ ہو گیا!*',
    jobPostedFooter: 'دستیاب کام دیکھنے کے لیے *3* یا *jobs* لکھیں۔',
    workerSavedTitle: '✅ *آپ کی ورکر پروفائل بن گئی!*',
    workerSavedFooter: 'کام دیکھنے اور درخواست دینے کے لیے *3* یا *jobs* لکھیں۔',
    browseEmpty: '📭 فی الحال کوئی فعال کام دستیاب نہیں ہے۔',
    browseHeader: '📋 *دستیاب فعال کام:*',
    browseJobHeader: '*کام #{n}*',
    browseFooter: '💬 درخواست دینے کے لیے لکھیں: *apply [نمبر]* (مثلاً *apply 1*)',
    applyEmployer:
      '🔔 *نئی درخواست!*\n\n' +
      'ایک ورکر آپ کے کام (*{role}*) کے لیے رابطہ کرنا چاہتا ہے۔\n\n' +
      '📱 Direct WhatsApp Link: wa.me/{num}',
    applyWorker:
      '✅ آپ کی درخواست employer کو بھیج دی گئی ہے! ' +
      'وہ آپ سے براہِ راست WhatsApp پر رابطہ کریں گے۔',
    applyError: '❌ درست job number لکھیں۔ مثال: *apply 1*',
    voiceError:
      '❌ آواز صاف نہیں آئی۔ براہِ کرم دوبارہ وائس نوٹ بھیجیں یا تحریر لکھیں۔',
    aiUnavailable:
      'شکریہ! اپنی ضرورت تفصیل سے لکھیں یا وائس نوٹ بھیجیں (مثلاً: "مجھے قاسم آباد میں 1000 یومیہ پر لوڈر چاہیے")۔',
    langSwitched: 'ٹھیک ہے، اب سے اردو میں بات ہوگی 🙂',
  },
};

// Display labels for the fields the AI extracts / the old template stored.
// Keys stay canonical English in database.json; only the display changes.
const FIELD_LABELS = {
  en: {
    Role: 'Role', Location: 'Location', Salary: 'Salary', Hours: 'Hours',
    Name: 'Name', Age: 'Age', Skills: 'Skills',
    'Working hours': 'Working hours', 'Salary/Fare': 'Salary/Fare',
    'Special requirements': 'Special requirements',
    'Available hours': 'Available hours', 'Skills/Experience': 'Skills/Experience',
  },
  roman: {
    Role: 'Kaam', Location: 'Ilaqa', Salary: 'Tankhwah', Hours: 'Auqat',
    Name: 'Naam', Age: 'Umar', Skills: 'Hunar',
    'Working hours': 'Kaam ke auqat', 'Salary/Fare': 'Tankhwah / kiraya',
    'Special requirements': 'Khaas shartein',
    'Available hours': 'Dastiyab auqat', 'Skills/Experience': 'Hunar / tajurba',
  },
  ur: {
    Role: 'کام', Location: 'علاقہ', Salary: 'تنخواہ', Hours: 'اوقات',
    Name: 'نام', Age: 'عمر', Skills: 'ہنر',
    'Working hours': 'کام کے اوقات', 'Salary/Fare': 'تنخواہ / کرایہ',
    'Special requirements': 'خاص شرائط',
    'Available hours': 'دستیاب اوقات', 'Skills/Experience': 'ہنر / تجربہ',
  },
};

export function t(locale, key) {
  const table = MESSAGES[locale] || MESSAGES.roman;
  return table[key] || MESSAGES.roman[key] || '';
}

export function fieldLabel(locale, key) {
  const table = FIELD_LABELS[locale] || FIELD_LABELS.roman;
  return table[key] || key;
}

export function fmt(template, vars) {
  return template.replace(/\{(\w+)\}/g, (m, k) =>
    vars[k] === undefined || vars[k] === null ? '' : String(vars[k])
  );
}

// Renders a stored job/worker data object as bullet lines in the locale.
// Values are passed through untouched.
export function renderFields(locale, data) {
  return Object.entries(data)
    .filter(([, v]) => v !== '' && v !== null && v !== undefined)
    .map(([k, v]) => `• *${fieldLabel(locale, k)}*: ${v}`)
    .join('\n');
}

export function missingKeys() {
  const missing = [];
  for (const locale of Object.keys(MESSAGES)) {
    for (const key of Object.keys(MESSAGES.roman)) {
      if (!MESSAGES[locale][key]) missing.push(locale + '.' + key);
    }
  }
  return missing;
}
