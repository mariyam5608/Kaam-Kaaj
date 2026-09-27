import makeWASocket, { DisconnectReason, useMultiFileAuthState, Browsers, downloadMediaMessage } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import fs from 'fs';
import { Groq } from 'groq-sdk';

// ------------------- CONFIGURATION -------------------
const GROQ_API_KEY = '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'; 
const DB_FILE = './database.json';

const groq = new Groq({ apiKey: GROQ_API_KEY });

// Active fallback models order
const TEXT_MODELS = ['openai/gpt-oss-20b', 'qwen/qwen3.8-27b'];
const AUDIO_MODEL = 'whisper-large-v3-turbo';
// ------------------------------------------------------

// Local Database Helpers
function loadDB() {
    try {
        if (!fs.existsSync(DB_FILE)) {
            fs.writeFileSync(DB_FILE, JSON.stringify({ jobs: [], workers: [] }, null, 2));
        }
        return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch {
        return { jobs: [], workers: [] };
    }
}

function saveDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// Resilient AI Chat Completion with Auto-Fallback
async function getAIIntent(userPrompt) {
    for (const model of TEXT_MODELS) {
        try {
            const completion = await groq.chat.completions.create({
                model: model,
                messages: [
                    {
                        role: 'system',
                        content: `You are an AI assistant for a local labor marketplace in Pakistan. You understand Urdu, Roman Urdu, and English.
Analyze user input and output ONLY a valid JSON object with these exact keys:
- "intent": "HIRING" | "SEEKING" | "BROWSE" | "CHAT"
- "reply": Short friendly response in Roman Urdu
- "extractedData": Object containing extracted fields (Role, Location, Salary, Hours, Name, Age, Skills)

Example output:
{"intent": "HIRING", "reply": "Job record ho gayi hai!", "extractedData": {"Role": "Loader", "Location": "Qasimabad", "Salary": "1000"}}`
                    },
                    { role: 'user', content: userPrompt }
                ],
                response_format: { type: "json_object" },
                max_tokens: 250 // Hard limit to prevent 429 RateLimit Errors
            });

            return JSON.parse(completion.choices[0].message.content);
        } catch (err) {
            console.warn(`[AI Warning] Model ${model} failed/limited. Trying fallback...`);
        }
    }
    // Fail-safe object if AI is entirely unreachable
    return {
        intent: "CHAT",
        reply: "Shukriya! Apni zaroorat tafseel se likhein ya voice note bhejein (e.g., 'Mujhe Qasimabad mein 1000/day par loader chahiye').",
        extractedData: {}
    };
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
            messageText = (m.message.conversation || m.message.extendedTextMessage?.text || '').trim();
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

                messageText = transcription.text;
                console.log(`🗣️ Transcribed Voice Note: "${messageText}"`);
            } catch (err) {
                console.error('Audio Transcription Error:', err.message);
                await sock.sendMessage(senderID, { text: `❌ Awaaz saaf nahi aayi. Baraye meherbani dubara voice note bhejein ya text likhein.` });
                return;
            } finally {
                if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); // Prevent disk space accumulation
            }
        }

        if (!messageText) return;
        console.log(`📩 Message from ${senderID}: "${messageText}"`);
        const db = loadDB();
        const lowerText = messageText.toLowerCase();

        // ⚡ INSTANT RULE SHORT-CIRCUITS (Bypasses AI API for instant speed & zero quota waste)

        // Command: Menu / Greetings / Reset
        if (['hi', 'hello', 'menu', 'start', '0', 'salam', 'assalam o alaikum'].includes(lowerText)) {
            await sock.sendMessage(senderID, { 
                text: `👋 *Khush Amdeed - Local Job Marketplace*\n\nAap kya karna chahte hain?\n\n*1️⃣* Job Post Karein (Mazdoor chahiye)\n*2️⃣* Kam Dhundhein (Worker profile)\n*3️⃣* Available Jobs Dekhein 🔍\n\n*(Voice note ya text mein apni zaroorat batayein)*` 
            });
            return;
        }

        // Command: Apply to Job (e.g., "apply 1")
        if (lowerText.startsWith('apply')) {
            const parts = lowerText.split(' ');
            const jobIndex = parseInt(parts[1]) - 1;
            
            if (!isNaN(jobIndex) && db.jobs[jobIndex]) {
                const targetJob = db.jobs[jobIndex];
                
                // Notify Employer
                await sock.sendMessage(targetJob.employerID, {
                    text: `🔔 *Nayi Application!*\n\nEk worker aap ki job (*${targetJob.data['Role'] || 'Job'}*) ke liye rabta karna chahta hai.\n\n📱 Direct WhatsApp Link: wa.me/${senderID.split('@')[0]}`
                });

                // Confirm Worker
                await sock.sendMessage(senderID, { 
                    text: `✅ Aap ki darkhwas employer ko bhej di gayi hai! Wo aapse direct WhatsApp par rabta karein ge.` 
                });
            } else {
                await sock.sendMessage(senderID, { text: `❌ Sahi job number likhein. Misal: *apply 1*` });
            }
            return;
        }

        // Command: Explicit Browse Jobs
        if (lowerText === '3' || lowerText === 'jobs' || lowerText === 'browse') {
            if (db.jobs.length === 0) {
                await sock.sendMessage(senderID, { text: `📭 Filhal koi active job available nahi hai.` });
                return;
            }
            let response = `📋 *Available Active Jobs:*\n\n`;
            db.jobs.forEach((job, index) => {
                response += `*Job #${index + 1}*\n`;
                for (const [k, v] of Object.entries(job.data)) {
                    response += `• *${k}*: ${v}\n`;
                }
                response += `-------------------\n`;
            });
            response += `\n💬 Apply karne ke liye likhein: *apply [Job Number]* (e.g. *apply 1*)`;
            await sock.sendMessage(senderID, { text: response });
            return;
        }

        // 🧠 INTELLECTUAL AI PARSING (Only runs for freeform text or voice messages)
        const aiResult = await getAIIntent(messageText);
        console.log('🤖 AI Extracted Result:', aiResult);

        if (aiResult.intent === 'HIRING' && Object.keys(aiResult.extractedData || {}).length > 0) {
            db.jobs.push({ employerID: senderID, data: aiResult.extractedData, timestamp: new Date().toISOString() });
            saveDB(db);
            await sock.sendMessage(senderID, { 
                text: `✅ *Aap Ki Job Post Ho Gayi!*\n\n` + 
                      Object.entries(aiResult.extractedData).map(([k, v]) => `• *${k}*: ${v}`).join('\n') + 
                      `\n\nActive jobs dekhne ke liye *3* ya *jobs* likhein.` 
            });
        } 
        else if (aiResult.intent === 'SEEKING' && Object.keys(aiResult.extractedData || {}).length > 0) {
            db.workers.push({ workerID: senderID, data: aiResult.extractedData, timestamp: new Date().toISOString() });
            saveDB(db);
            await sock.sendMessage(senderID, { 
                text: `✅ *Aap Ki Worker Profile Ban Gayi!*\n\n` + 
                      Object.entries(aiResult.extractedData).map(([k, v]) => `• *${k}*: ${v}`).join('\n') + 
                      `\n\nJobs dekhne aur apply karne ke liye *3* ya *jobs* likhein.` 
            });
        } 
        else {
            // Friendly fallback response from AI
            await sock.sendMessage(senderID, { text: aiResult.reply });
        }
    });
}

startWhatsAppGateway();