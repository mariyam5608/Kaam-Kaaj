import makeWASocket, { DisconnectReason, useMultiFileAuthState, Browsers, downloadMediaMessage } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import fs from 'fs';
import { Groq } from 'groq-sdk';
import { localeFor, normalizeRoman, parseLanguageChoice, languageDirective, sanitizeForWhatsApp, sanitizeInput, westernDigits, MENU_WORDS, BROWSE_WORDS, APPLY_RE } from './language.js';
import { t, fmt, renderFields, missingKeys } from './messages.js';

// ------------------- CONFIGURATION -------------------
// Tiny .env loader (no dependency): KEY=VALUE lines, # comments. Real
// environment variables always win.
if (fs.existsSync('.env')) {
    for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && process.env[m[1]] === undefined) {
            process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
        }
    }
}

// The key used to be hard-coded in this file, which left it readable by anyone
// who could see the repository. It now comes from the environment only.
const GROQ_API_KEY = process.env.GROQ_API_KEY;
if (!GROQ_API_KEY) {
    console.error('❌ GROQ_API_KEY is not set. Copy .env.example to .env and paste your key, then start the bot again.');
    process.exit(1);
}
const DB_FILE = './database.json';

const groq = new Groq({ apiKey: GROQ_API_KEY });

// Fallback order: the 120B mirrors Urdu script and Roman Urdu most reliably;
// the two smaller models are there for when it rate-limits mid-demo.
const TEXT_MODELS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'];
const AUDIO_MODEL = 'whisper-large-v3-turbo';

// One locale per sender: 'en' | 'roman' | 'ur'. Defaults to Roman Urdu, the
// language this bot has always spoken.
const locales = new Map();
const localeOf = (senderID) => locales.get(senderID) || 'roman';

if (missingKeys().length) {
    console.warn('⚠️  Untranslated message keys:', missingKeys().join(', '));
}
// ------------------------------------------------------

// Local Database Helpers
function loadDB() {
    try {
        if (!fs.existsSync(DB_FILE)) {
            fs.writeFileSync(DB_FILE, JSON.stringify({ jobs: [], workers: [] }, null, 2));
        }
        const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        let modified = false;
        if (Array.isArray(data.jobs)) {
            data.jobs = data.jobs.filter(j => j && j.data && Object.keys(j.data).length > 0);
            data.jobs.forEach((j, i) => {
                if (!j.id) {
                    j.id = i + 1;
                    modified = true;
                }
            });
        }
        if (modified) {
            fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
        }
        return data;
    } catch {
        return { jobs: [], workers: [] };
    }
}

function saveDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// Resilient AI Chat Completion with Auto-Fallback
async function getAIIntent(userPrompt, locale = 'roman') {
    const db = loadDB();
    const activeJobsSummary = (db.jobs || [])
        .map(j => `Job ID #${j.id}: ${j.data.Role || 'Worker'} in ${j.data.Location || 'Hyderabad'}`)
        .join(', ');

    const systemPrompt = `You are an AI assistant for a local labour marketplace in Hyderabad, Sindh. Users write in Urdu script, Roman Urdu, or English.

ACTIVE JOBS IN DATABASE: ${activeJobsSummary || 'None currently'}.

Output ONLY a valid JSON object with these exact keys:
- "intent": "HIRING" | "SEEKING" | "BROWSE" | "CHAT"
- "reply": one short, warm sentence to the user
- "extractedData": object with ONLY these keys, written exactly like this in English regardless of the user's language: Role, Location, Salary, Hours, Name, Age, Skills. Leave a value as "" when the user did not say it. Keep the user's own words and script inside the values.

INTENT RULES:
- If user wants to see jobs, find work, asks for the job list, or writes "list", set "intent": "BROWSE".
- If user wants to hire, post a job, or needs workers, set "intent": "HIRING".
- If user gives their worker profile details (skills, age, looking for job), set "intent": "SEEKING".
- If user asks about a specific job from the list or asks how to apply, set "intent": "CHAT" and in "reply" tell them the exact Job ID (e.g. Job ID #1, Job ID #2) and tell them to type "apply [Job ID]" (e.g. "apply 1" or "#1").

LANGUAGE RULES - these matter more than anything else:
1. MIRROR THE USER. If they wrote Roman Urdu, reply in Roman Urdu. If they wrote اردو, reply in اردو. If they wrote English, reply in English.
2. NEVER write Hindi or Devanagari (काम, चहिए, नमस्ते). This is a Pakistani marketplace: Urdu script only, never Devanagari.
3. Always use Western digits 0-9, never ۰-۹.
4. Keep "reply" under 30 words. No markdown, no bullet points, no headers - this goes into a WhatsApp text message.

Example (user wrote Roman Urdu):
{"intent": "HIRING", "reply": "Job record ho gayi hai!", "extractedData": {"Role": "Loader", "Location": "Qasimabad", "Salary": "1000", "Hours": "", "Name": "", "Age": "", "Skills": ""}}

Example (user wrote اردو):
{"intent": "HIRING", "reply": "آپ کی جاب محفوظ ہو گئی ہے!", "extractedData": {"Role": "مزدور", "Location": "قاسم آباد", "Salary": "1000", "Hours": "", "Name": "", "Age": "", "Skills": ""}}

${languageDirective(locale)}`;

    for (const model of TEXT_MODELS) {
        try {
            const completion = await groq.chat.completions.create({
                model: model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                response_format: { type: "json_object" },
                // Urdu answers run longer than Roman ones; 250 truncated them.
                // Reasoning models also spend part of this budget thinking
                // before they write anything, and 400 came back empty.
                max_tokens: 900,
                ...(model.startsWith('openai/gpt-oss') ? { reasoning_effort: 'low' } : {})
            });

            return JSON.parse(completion.choices[0].message.content);
        } catch (err) {
            console.warn(`[AI Warning] Model ${model} failed/limited. Trying fallback...`);
        }
    }
    // Fail-safe object if AI is entirely unreachable
    return {
        intent: "CHAT",
        reply: t(locale, 'aiUnavailable'),
        extractedData: {}
    };
}

async function sendBrowseJobs(sock, senderID, db, locale) {
    const validJobs = (db.jobs || []).filter(j => j && j.data && Object.keys(j.data).length > 0);
    if (validJobs.length === 0) {
        await sock.sendMessage(senderID, { text: t(locale, 'browseEmpty') });
        return;
    }
    let response = `${t(locale, 'browseHeader')}\n\n`;
    validJobs.forEach((job, index) => {
        const jobId = job.id || (index + 1);
        response += `${fmt(t(locale, 'browseJobHeader'), { n: jobId })}\n`;
        response += `${renderFields(locale, job.data)}\n`;
        response += `-------------------\n`;
    });
    response += `\n${t(locale, 'browseFooter')}`;
    await sock.sendMessage(senderID, { text: response });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startWhatsAppGateway() {
    console.log('⚡ Starting Fast & Reliable WhatsApp Marketplace Bot...');
    await delay(2000);

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: Browsers.windows('Desktop'),
        syncFullHistory: false,
        markOnlineOnConnect: false,
        connectTimeoutMs: 60000,
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log('\n--- SCAN THIS QR CODE WITH WHATSAPP ---');
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error instanceof Boom) ? lastDisconnect?.error?.output?.statusCode : null;
            if (statusCode !== DisconnectReason.loggedOut) {
                console.log('🔄 Reconnecting automatically in 3s...');
                setTimeout(startWhatsAppGateway, 3000);
            } else {
                console.log('Logged out. Delete auth_info_baileys folder and restart.');
            }
        } else if (connection === 'open') {
            console.log('✅ BOT RUNNING SUCCESSFULLY & READY FOR MESSAGES!');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const senderID = m.key.remoteJid;
        let messageText = '';

        // 1. Process Text Input
        if (m.message.conversation || m.message.extendedTextMessage) {
            messageText = sanitizeInput(m.message.conversation || m.message.extendedTextMessage?.text || '');
        } 
        // 2. Process Voice Note Input
        else if (m.message.audioMessage) {
            console.log(`🎙️ Voice note received from ${senderID}...`);
            const tempFilePath = `./temp_${Date.now()}.ogg`;
            try {
                const buffer = await downloadMediaMessage(m, 'buffer', {});
                fs.writeFileSync(tempFilePath, buffer);

                const transcription = await groq.audio.transcriptions.create({
                    file: fs.createReadStream(tempFilePath),
                    model: AUDIO_MODEL,
                    language: 'ur'
                });

                messageText = sanitizeInput(transcription.text);
                console.log(`🗣️ Transcribed Voice Note: "${messageText}"`);
            } catch (err) {
                console.error('Audio Transcription Error:', err.message);
                await sock.sendMessage(senderID, { text: t(localeOf(senderID), 'voiceError') });
                return;
            } finally {
                if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); // Prevent disk space accumulation
            }
        }

        if (!messageText) return;
        console.log(`📩 Message from ${senderID}: "${messageText}"`);
        const db = loadDB();
        // Westernise first: "apply ۱" and "درخواست ۱" must both parse as job 1.
        const lowerText = westernDigits(messageText.toLowerCase().trim());
        const norm = normalizeRoman(lowerText);

        // ⚡ INSTANT RULE SHORT-CIRCUITS (Bypasses AI API for instant speed & zero quota waste)

        // Command: force a language. Words only — 1/2/3 belong to the menu.
        const chosen = parseLanguageChoice(messageText);
        if (chosen) {
            locales.set(senderID, chosen);
            await sock.sendMessage(senderID, { text: t(chosen, 'langSwitched') });
            return;
        }

        const isCommand = MENU_WORDS.has(norm) || BROWSE_WORDS.has(norm) || APPLY_RE.test(lowerText);
        const detected = localeFor(messageText);
        // Commands are short and look English ("3", "jobs", "apply 1"), so they
        // must not flip a user's language. Urdu script is unambiguous, so it
        // always wins even inside a command.
        if (detected && (detected === 'ur' || !isCommand)) locales.set(senderID, detected);
        const locale = localeOf(senderID);

        // Command: Menu / Greetings / Reset
        if (MENU_WORDS.has(norm)) {
            await sock.sendMessage(senderID, { text: t(locale, 'menu') });
            return;
        }

        // Command: Apply to Job (e.g., "apply 1" / "apply #3" / "#3" / "job 2" / "درخواست 1")
        const applyMatch = lowerText.match(APPLY_RE);
        if (applyMatch) {
            const rawId = applyMatch[1] ?? applyMatch[2] ?? '';
            const targetId = parseInt(rawId, 10);

            // Match by permanent Job ID first, then fallback to index
            const targetJob = !isNaN(targetId) && (db.jobs.find(j => j.id === targetId) || db.jobs[targetId - 1]);

            if (targetJob && targetJob.data && Object.keys(targetJob.data).length > 0) {
                const jobId = targetJob.id || targetId;
                const role = targetJob.data['Role'] || 'Job';

                // Notify Employer — in the employer's own language, not the applicant's
                await sock.sendMessage(targetJob.employerID, {
                    text: fmt(t(localeOf(targetJob.employerID), 'applyEmployer'), {
                        role,
                        id: jobId,
                        num: senderID.split('@')[0],
                    })
                });

                // Confirm Worker
                await sock.sendMessage(senderID, {
                    text: fmt(t(locale, 'applyWorker'), {
                        role,
                        id: jobId,
                    })
                });
            } else {
                await sock.sendMessage(senderID, { text: t(locale, 'applyError') });
            }
            return;
        }

        // Command: Explicit Browse Jobs
        if (BROWSE_WORDS.has(norm)) {
            await sendBrowseJobs(sock, senderID, db, locale);
            return;
        }

        // 🧠 INTELLECTUAL AI PARSING (Only runs for freeform text or voice messages)
        const aiResult = await getAIIntent(messageText, locale);
        console.log('🤖 AI Extracted Result:', aiResult);

        // The model returns "" for fields the user never mentioned. Storing those
        // blanks is what filled database.json with empty bullets.
        const cleaned = Object.fromEntries(
            Object.entries(aiResult.extractedData || {})
                .map(([k, v]) => [
                    sanitizeInput(String(k ?? ''), 50),
                    sanitizeForWhatsApp(sanitizeInput(String(v ?? ''), 200))
                ])
                .filter(([k, v]) => k !== '' && v !== '')
        );

        if (aiResult.intent === 'HIRING' && Object.keys(cleaned).length > 0) {
            const nextId = db.jobs.reduce((max, j) => Math.max(max, j.id || 0), 0) + 1;
            db.jobs.push({ id: nextId, employerID: senderID, data: cleaned, timestamp: new Date().toISOString() });
            saveDB(db);
            await sock.sendMessage(senderID, {
                text: `${fmt(t(locale, 'jobPostedTitle'), { id: nextId })}\n\n` +
                      `${renderFields(locale, cleaned)}\n\n` +
                      t(locale, 'jobPostedFooter')
            });
        }
        else if (aiResult.intent === 'SEEKING' && Object.keys(cleaned).length > 0) {
            db.workers.push({ workerID: senderID, data: cleaned, timestamp: new Date().toISOString() });
            saveDB(db);
            await sock.sendMessage(senderID, {
                text: `${t(locale, 'workerSavedTitle')}\n\n` +
                      `${renderFields(locale, cleaned)}\n\n` +
                      t(locale, 'workerSavedFooter')
            });
        }
        else if (aiResult.intent === 'BROWSE') {
            await sendBrowseJobs(sock, senderID, db, locale);
        }
        else {
            // Friendly fallback response from AI
            await sock.sendMessage(senderID, { text: sanitizeForWhatsApp(aiResult.reply) || t(locale, 'aiUnavailable') });
        }
    });
}

startWhatsAppGateway();