import makeWASocket, { DisconnectReason, useMultiFileAuthState, Browsers, downloadMediaMessage } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import fs from 'fs';
import { Groq } from 'groq-sdk';
import { 
    localeFor, normalizeRoman, parseLanguageChoice, languageDirective, 
    sanitizeForWhatsApp, sanitizeInput, westernDigits, MENU_WORDS, BROWSE_WORDS, 
    APPLY_RE, isProceedOrAffirmation, findMatchingJob 
} from './language.js';
import { t, fmt, renderFields, missingKeys } from './messages.js';
import { pushJobToSupabase, pushWorkerToSupabase, recordMatchToSupabase } from './supabase.js';

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

// In-memory conversation session tracking per sender (keeps context alive)
const userSessions = new Map();

function getSession(senderID) {
    if (!userSessions.has(senderID)) {
        userSessions.set(senderID, {
            lastViewedJobId: null,
            lastAction: null,
            history: [] // [{ role: 'user' | 'assistant', content: string }]
        });
    }
    return userSessions.get(senderID);
}

function addToHistory(senderID, role, content) {
    if (!content) return;
    const session = getSession(senderID);
    session.history.push({ role, content });
    if (session.history.length > 14) {
        session.history = session.history.slice(-14);
    }
}

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

// Resilient AI Chat Completion with Multi-turn Memory & First-class Intent Parsing
async function getAIIntent(userPrompt, locale = 'roman', history = []) {
    const db = loadDB();
    const activeJobsList = (db.jobs || [])
        .filter(j => j && j.data && Object.keys(j.data).length > 0)
        .map(j => {
            const role = j.data.Role || 'Worker';
            const loc = j.data.Location || 'Hyderabad';
            const sal = j.data['Salary/Fare'] || j.data.Salary || '';
            const hrs = j.data['Working hours'] || j.data.Hours || '';
            return `- Job ID #${j.id}: ${role} in ${loc}${sal ? ' (' + sal + ')' : ''}${hrs ? ' [' + hrs + ']' : ''}`;
        })
        .join('\n');

    const systemPrompt = `You are an intelligent, empathetic conversational AI assistant for a local labour marketplace in Hyderabad, Sindh (Sindh, Pakistan). Users write in Urdu script (اردو), Roman Urdu, or English.

ACTIVE JOBS IN MARKETPLACE:
${activeJobsList || 'None currently available'}

Output ONLY a valid JSON object with these exact keys:
- "intent": "HIRING" | "SEEKING" | "BROWSE" | "APPLY" | "CHAT"
- "targetJobId": integer ID of the job the user wants to apply to (e.g. 1, 2, 3), or null if not applying to a specific job
- "reply": one short, warm sentence to the user in their language (under 30 words, WhatsApp friendly, no markdown bullets)
- "extractedData": object with ONLY these keys, written in English: Role, Location, Salary, Hours, Name, Age, Skills. Leave a value as "" when the user did not say it. Keep the user's own words and script inside the values.

INTENT RULES:
1. "APPLY":
   - User wants to apply to a specific job, mentions a job from the active list (e.g. "loader in qasimabad", "job id 1", "is job k liye apply krna hai", "id like to proceed", "apply karo", "darkhwast deni hai", "is pe apply karna hai", "pehli job").
   - Set "targetJobId" to the integer ID of that job. If user says "proceed", "yes", or "is job pe" and a job was discussed in conversation history, set "targetJobId" to that job's ID.
2. "BROWSE":
   - User wants to see available jobs, asks what work is available, or says "mein job k liye apply krna chahta hn", "jobs dikhao", "kya kaam hai", "show jobs", "list", "kaam chahiye" without naming a specific job yet.
3. "HIRING":
   - User wants to hire or post a job, e.g. "mazdoor chahiye", "need a painter in Hyderabad", "loader required".
4. "SEEKING":
   - User gives their own worker profile details to register for finding work (e.g. "mera naam Bilal hai, electrician ka kaam janta hoon").
5. "CHAT":
   - General greetings, questions, or clarification.

LANGUAGE RULES - these matter more than anything else:
1. MIRROR THE USER: If they wrote Roman Urdu, reply in Roman Urdu. If they wrote اردو, reply in اردو. If they wrote English, reply in English.
2. NEVER write Hindi or Devanagari (काम, चहिए, नमस्ते). This is a Pakistani marketplace: Urdu script only, never Devanagari.
3. Always use Western digits 0-9, never ۰-۹.
4. Keep "reply" under 30 words. No markdown, no bullet points, no headers - this goes into a WhatsApp text message.
5. PAKISTANI CURRENCY & LOCAL TERMS:
   - All amounts and fares MUST be in Pakistani Rupees (Rs. or روپے). E.g. "Rs. 1000/dihari" or "1000 روپے دیہاڑی" or "Rs. 1500/day". Never use foreign symbols or Indian phrasing.
   - Understand authentic Pakistani labour terminology: dihari / دیہاڑی (daily wage), mazdoor / مزدور (labourer), karigar / کاریگر (skilled artisan), mistri / مستری (mason/technician), thekedar / ٹھیکیدار (contractor), tankhwah / تنخواہ / ujrat / اجرت (wages), beldar (helper), rang saaz (painter), chowkidar (guard).
   - Understand Hyderabad localities: Qasimabad, Latifabad, Saddar, Kotri, Auto Bhan, Heerabad, Kohsar, Phuleli, etc.

${languageDirective(locale)}`;

    const groqMessages = [
        { role: 'system', content: systemPrompt },
        ...(Array.isArray(history) ? history.slice(-8) : []),
        { role: 'user', content: userPrompt }
    ];

    for (const model of TEXT_MODELS) {
        try {
            const completion = await groq.chat.completions.create({
                model: model,
                messages: groqMessages,
                response_format: { type: "json_object" },
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
        targetJobId: null,
        reply: t(locale, 'aiUnavailable'),
        extractedData: {}
    };
}

async function sendBrowseJobs(sock, senderID, db, locale) {
    const validJobs = (db.jobs || []).filter(j => j && j.data && Object.keys(j.data).length > 0);
    if (validJobs.length === 0) {
        const emptyMsg = t(locale, 'browseEmpty');
        addToHistory(senderID, 'assistant', emptyMsg);
        await sock.sendMessage(senderID, { text: emptyMsg });
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

    const session = getSession(senderID);
    session.lastAction = 'BROWSE';
    if (validJobs.length === 1) {
        session.lastViewedJobId = validJobs[0].id;
    }
    addToHistory(senderID, 'assistant', response);
    await sock.sendMessage(senderID, { text: response });
}

// Executes a job application: notifies employer, confirms to worker, records in Supabase
async function executeApplication(sock, senderID, targetJob, locale) {
    if (!targetJob || !targetJob.data || Object.keys(targetJob.data).length === 0) {
        await sock.sendMessage(senderID, { text: t(locale, 'applyError') });
        return false;
    }

    const jobId = targetJob.id;
    const role = targetJob.data['Role'] || targetJob.data['role'] || 'Job';
    const applicantPhone = senderID.split('@')[0];

    // 1. Notify Employer — in the employer's own language, not applicant's
    if (targetJob.employerID) {
        try {
            await sock.sendMessage(targetJob.employerID, {
                text: fmt(t(localeOf(targetJob.employerID), 'applyEmployer'), {
                    role,
                    id: jobId,
                    num: applicantPhone,
                })
            });
        } catch (err) {
            console.warn('[WhatsApp Warning] Could not notify employer:', err.message);
        }
    }

    // 2. Confirm to Worker
    const confirmationText = fmt(t(locale, 'applyWorker'), {
        role,
        id: jobId,
    });
    await sock.sendMessage(senderID, { text: confirmationText });

    // 3. Record Match to Supabase asynchronously
    try {
        recordMatchToSupabase(senderID, targetJob).catch(err => {
            console.warn('[Supabase Warning] Match record failed:', err?.message);
        });
    } catch (err) {
        console.warn('[Supabase Warning] Match record call error:', err?.message);
    }

    // 4. Update session
    const session = getSession(senderID);
    session.lastViewedJobId = jobId;
    session.lastAction = 'APPLIED';
    addToHistory(senderID, 'assistant', confirmationText);

    return true;
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
        const session = getSession(senderID);
        addToHistory(senderID, 'user', messageText);

        // ⚡ INSTANT RULE SHORT-CIRCUITS (Bypasses AI API for instant speed & zero quota waste)

        // Command: force a language. Words only — 1/2/3 belong to the menu.
        const chosen = parseLanguageChoice(messageText);
        if (chosen) {
            locales.set(senderID, chosen);
            const reply = t(chosen, 'langSwitched');
            addToHistory(senderID, 'assistant', reply);
            await sock.sendMessage(senderID, { text: reply });
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
            session.lastAction = 'MENU';
            const menuReply = t(locale, 'menu');
            addToHistory(senderID, 'assistant', menuReply);
            await sock.sendMessage(senderID, { text: menuReply });
            return;
        }

        // Command: Apply to Job (e.g., "apply 1" / "apply #3" / "#3" / "job 2" / "job id 1" / "درخواست 1")
        const applyMatch = lowerText.match(APPLY_RE);
        if (applyMatch) {
            const rawId = applyMatch[1] ?? applyMatch[2] ?? '';
            const targetId = parseInt(rawId, 10);
            if (!isNaN(targetId)) {
                const targetJob = db.jobs.find(j => j.id === targetId) || db.jobs[targetId - 1];
                await executeApplication(sock, senderID, targetJob, locale);
                return;
            }
        }

        // Contextual Affirmation / Proceed (e.g., "jee mujhe is job k liye apply krna hai", "id like to proceed", "theek hai")
        if (session.lastViewedJobId && isProceedOrAffirmation(messageText)) {
            const targetJob = db.jobs.find(j => j.id === session.lastViewedJobId);
            if (targetJob) {
                await executeApplication(sock, senderID, targetJob, locale);
                return;
            }
        }

        // Direct Job Reference / Selection (e.g., user typed "loader in qasimabad" or "loader")
        const matchedJob = findMatchingJob(messageText, db.jobs);
        if (matchedJob) {
            session.lastViewedJobId = matchedJob.id;
            const lowerClean = lowerText.toLowerCase();
            const wantsToApplyDirectly = lowerClean.includes('apply') || lowerClean.includes('darkhwas') || 
                                         lowerClean.includes('chahiye') || lowerClean.includes('krna hai') || 
                                         lowerClean.includes('karna hai') || isProceedOrAffirmation(messageText);

            if (wantsToApplyDirectly) {
                await executeApplication(sock, senderID, matchedJob, locale);
                return;
            } else {
                const role = matchedJob.data['Role'] || 'Job';
                const location = matchedJob.data['Location'] || 'Hyderabad';
                const fare = matchedJob.data['Salary/Fare'] || matchedJob.data['Salary'] || 'Rs. 1000/dihari';
                const promptMsg = fmt(t(locale, 'jobSelectedPrompt'), {
                    role,
                    location,
                    id: matchedJob.id,
                    fare
                });
                session.lastAction = 'JOB_SELECTED';
                addToHistory(senderID, 'assistant', promptMsg);
                await sock.sendMessage(senderID, { text: promptMsg });
                return;
            }
        }

        // Command: Explicit Browse Jobs
        if (BROWSE_WORDS.has(norm)) {
            await sendBrowseJobs(sock, senderID, db, locale);
            return;
        }

        // Bare number 1, 2, 3 selection right after browsing
        if (session.lastAction === 'BROWSE' && ['1', '2', '3'].includes(norm)) {
            const targetId = parseInt(norm, 10);
            const targetJob = db.jobs.find(j => j.id === targetId) || db.jobs[targetId - 1];
            if (targetJob) {
                await executeApplication(sock, senderID, targetJob, locale);
                return;
            }
        }

        // 🧠 INTELLECTUAL AI PARSING (With multi-turn conversation memory)
        const aiResult = await getAIIntent(messageText, locale, session.history);
        console.log('🤖 AI Extracted Result:', aiResult);

        // Handle first-class APPLY intent from AI
        if (aiResult.intent === 'APPLY') {
            const targetId = aiResult.targetJobId || session.lastViewedJobId || (db.jobs[0]?.id);
            const targetJob = targetId ? (db.jobs.find(j => j.id === targetId) || db.jobs[targetId - 1]) : null;
            if (targetJob) {
                await executeApplication(sock, senderID, targetJob, locale);
                return;
            }
        }

        // Handle BROWSE intent from AI (e.g. user said "mein job k liye apply krna chahta hn" or "jobs dikhao")
        if (aiResult.intent === 'BROWSE') {
            await sendBrowseJobs(sock, senderID, db, locale);
            return;
        }

        // The model returns "" for fields the user never mentioned. Storing those
        // blanks is what filled database.json with empty bullets.
        const cleaned = Object.fromEntries(
            Object.entries(aiResult.extractedData || {})
                .map(([k, v]) => {
                    let val = sanitizeForWhatsApp(sanitizeInput(String(v ?? ''), 200));
                    if (k === 'Salary' && /^\d+(\s*\/\s*\w+)?$/.test(val.trim())) {
                        val = `Rs. ${val.trim()}`;
                    }
                    return [
                        sanitizeInput(String(k ?? ''), 50),
                        val
                    ];
                })
                .filter(([k, v]) => k !== '' && v !== '')
        );

        if (aiResult.intent === 'HIRING' && Object.keys(cleaned).length > 0) {
            const nextId = db.jobs.reduce((max, j) => Math.max(max, j.id || 0), 0) + 1;
            const newJob = { id: nextId, employerID: senderID, data: cleaned, timestamp: new Date().toISOString() };
            db.jobs.push(newJob);
            saveDB(db);
            pushJobToSupabase(newJob).catch(() => {});
            const msg = `${fmt(t(locale, 'jobPostedTitle'), { id: nextId })}\n\n` +
                        `${renderFields(locale, cleaned)}\n\n` +
                        t(locale, 'jobPostedFooter');
            session.lastAction = 'JOB_POSTED';
            addToHistory(senderID, 'assistant', msg);
            await sock.sendMessage(senderID, { text: msg });
        }
        else if (aiResult.intent === 'SEEKING' && Object.keys(cleaned).length > 0) {
            const newWorker = { workerID: senderID, data: cleaned, timestamp: new Date().toISOString() };
            db.workers.push(newWorker);
            saveDB(db);
            pushWorkerToSupabase(newWorker).catch(() => {});
            const msg = `${t(locale, 'workerSavedTitle')}\n\n` +
                        `${renderFields(locale, cleaned)}\n\n` +
                        t(locale, 'workerSavedFooter');
            session.lastAction = 'WORKER_SAVED';
            addToHistory(senderID, 'assistant', msg);
            await sock.sendMessage(senderID, { text: msg });
        }
        else {
            // Friendly fallback response from AI
            const reply = sanitizeForWhatsApp(aiResult.reply) || t(locale, 'aiUnavailable');
            session.lastAction = 'CHAT';
            addToHistory(senderID, 'assistant', reply);
            await sock.sendMessage(senderID, { text: reply });
        }
    });
}

startWhatsAppGateway();