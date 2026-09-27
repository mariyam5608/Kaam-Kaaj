// Run directly: node sync-database.js
import fs from 'fs';
import { syncDatabaseToSupabase, isSupabaseConfigured } from './supabase.js';

// Tiny .env loader
if (fs.existsSync('.env')) {
    for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && process.env[m[1]] === undefined) {
            process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
        }
    }
}

const DB_FILE = './database.json';

async function main() {
    if (!fs.existsSync(DB_FILE)) {
        console.error(`❌ ${DB_FILE} not found.`);
        process.exit(1);
    }

    if (!isSupabaseConfigured()) {
        console.error('❌ SUPABASE_URL or SUPABASE_KEY is missing in .env');
        process.exit(1);
    }

    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    console.log(`📡 Starting Supabase sync from ${DB_FILE}...`);
    console.log(`Jobs: ${db.jobs?.length || 0}, Workers: ${db.workers?.length || 0}`);

    await syncDatabaseToSupabase(db);
    console.log('✅ Supabase sync finished!');
}

main().catch(err => {
    console.error('❌ Error during sync:', err);
    process.exit(1);
});
