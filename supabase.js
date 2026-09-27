// Supabase integration for Kaam Kaaj
// Automatically synchronizes jobs, workers, and users with the Supabase PostgreSQL database.

import fs from 'fs';

// Tiny .env loader (runs before anything else in this module)
if (fs.existsSync('.env')) {
    for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && process.env[m[1]] === undefined) {
            process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
        }
    }
}

function getConfig() {
    const url = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
    const key = process.env.SUPABASE_KEY;
    return { url, key, isConfigured: Boolean(url && key) };
}

export function isSupabaseConfigured() {
    return getConfig().isConfigured;
}

function supabaseHeaders(extra = {}) {
    const { key } = getConfig();
    return {
        'Content-Type': 'application/json',
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: 'return=representation',
        ...extra,
    };
}

export async function getOrCreateUser(rawPhone, userType = 'employer', createdAt = null) {
    const { url, key, isConfigured } = getConfig();
    if (!isConfigured) return null;

    const phone = String(rawPhone || '')
        .replace(/@lid|@s\.whatsapp\.net/g, '')
        .replace(/[^0-9]/g, '');

    try {
        const findRes = await fetch(
            `${url}/rest/v1/users?phone_number=eq.${encodeURIComponent(phone)}`,
            { headers: { apikey: key, Authorization: `Bearer ${key}` } }
        );
        const existing = await findRes.json();
        if (Array.isArray(existing) && existing.length > 0) {
            return existing[0];
        }

        const createRes = await fetch(`${url}/rest/v1/users`, {
            method: 'POST',
            headers: supabaseHeaders(),
            body: JSON.stringify({
                phone_number: phone,
                user_type: userType,
                created_at: createdAt || new Date().toISOString(),
            }),
        });
        const created = await createRes.json();
        return Array.isArray(created) ? created[0] : created;
    } catch (err) {
        console.warn('[Supabase Warning] Failed to get/create user:', err.message);
        return null;
    }
}

export async function pushJobToSupabase(job) {
    const { url, key, isConfigured } = getConfig();
    if (!isConfigured) return null;

    try {
        const user = await getOrCreateUser(job.employerID, 'employer', job.timestamp);
        if (!user || !user.id) return null;

        const role = job.data?.Role || 'Worker';
        const location = job.data?.Location || 'Hyderabad';
        const shift_hours = job.data?.['Working hours'] || job.data?.Hours || 'Flexible';

        // Check if job exists to avoid duplicate rows
        const checkRes = await fetch(
            `${url}/rest/v1/job_postings?employer_id=eq.${user.id}&role=eq.${encodeURIComponent(role)}&location=eq.${encodeURIComponent(location)}`,
            { headers: { apikey: key, Authorization: `Bearer ${key}` } }
        );
        const existing = await checkRes.json();
        if (Array.isArray(existing) && existing.length > 0) {
            console.log(`[Supabase] Job already synced: "${role}" in ${location} (ID: ${existing[0].id})`);
            return existing[0];
        }

        const insRes = await fetch(`${url}/rest/v1/job_postings`, {
            method: 'POST',
            headers: supabaseHeaders(),
            body: JSON.stringify({
                employer_id: user.id,
                role,
                location,
                shift_hours,
                status: 'open',
                created_at: job.timestamp || new Date().toISOString(),
            }),
        });
        const inserted = await insRes.json();
        console.log(`[Supabase] Job synced: "${role}" in ${location}`);
        return Array.isArray(inserted) ? inserted[0] : inserted;
    } catch (err) {
        console.warn('[Supabase Warning] Failed to sync job:', err.message);
        return null;
    }
}

export async function pushWorkerToSupabase(worker) {
    const { url, key, isConfigured } = getConfig();
    if (!isConfigured) return null;

    try {
        const user = await getOrCreateUser(worker.workerID, 'worker', worker.timestamp);
        if (!user || !user.id) return null;

        const name = worker.data?.Name || 'Worker';
        const location = worker.data?.Location || 'Hyderabad';
        const role =
            worker.data?.['Skills/Experience'] ||
            worker.data?.Skills ||
            worker.data?.Role ||
            'General';
        const available_hours =
            worker.data?.['Available hours'] || worker.data?.Hours || 'Flexible';

        const checkRes = await fetch(
            `${url}/rest/v1/worker_profiles?user_id=eq.${user.id}&name=eq.${encodeURIComponent(name)}`,
            { headers: { apikey: key, Authorization: `Bearer ${key}` } }
        );
        const existing = await checkRes.json();
        if (Array.isArray(existing) && existing.length > 0) {
            console.log(`[Supabase] Worker profile already synced: "${name}" (ID: ${existing[0].id})`);
            return existing[0];
        }

        const insRes = await fetch(`${url}/rest/v1/worker_profiles`, {
            method: 'POST',
            headers: supabaseHeaders(),
            body: JSON.stringify({
                user_id: user.id,
                name,
                location,
                role,
                available_hours,
                created_at: worker.timestamp || new Date().toISOString(),
            }),
        });
        const inserted = await insRes.json();
        console.log(`[Supabase] Worker profile synced: "${name}" (${role})`);
        return Array.isArray(inserted) ? inserted[0] : inserted;
    } catch (err) {
        console.warn('[Supabase Warning] Failed to sync worker:', err.message);
        return null;
    }
}

export async function syncDatabaseToSupabase(db) {
    if (!isSupabaseConfigured()) {
        console.log('[Supabase] SUPABASE_URL or SUPABASE_KEY not configured. Skipping sync.');
        return;
    }

    for (const job of db.jobs || []) {
        await pushJobToSupabase(job);
    }
    for (const worker of db.workers || []) {
        await pushWorkerToSupabase(worker);
    }
}

export async function recordMatchToSupabase(rawWorkerPhone, job) {
    const { url, key, isConfigured } = getConfig();
    if (!isConfigured) return null;

    try {
        const workerPhone = String(rawWorkerPhone || '')
            .replace(/@lid|@s\.whatsapp\.net/g, '')
            .replace(/[^0-9]/g, '');

        const workerUser = await getOrCreateUser(workerPhone, 'worker');
        if (!workerUser || !workerUser.id) return null;

        // Find or create worker profile
        let workerProfileId = null;
        const wpRes = await fetch(
            `${url}/rest/v1/worker_profiles?user_id=eq.${workerUser.id}`,
            { headers: { apikey: key, Authorization: `Bearer ${key}` } }
        );
        const wps = await wpRes.json();
        if (Array.isArray(wps) && wps.length > 0) {
            workerProfileId = wps[0].id;
        } else {
            const newWp = await fetch(`${url}/rest/v1/worker_profiles`, {
                method: 'POST',
                headers: supabaseHeaders(),
                body: JSON.stringify({
                    user_id: workerUser.id,
                    name: `Applicant ${workerPhone.slice(-4)}`,
                    location: job.data?.Location || 'Hyderabad',
                    role: job.data?.Role || 'Worker',
                    available_hours: 'Flexible',
                    created_at: new Date().toISOString(),
                }),
            });
            const createdWp = await newWp.json();
            workerProfileId = Array.isArray(createdWp) ? createdWp[0]?.id : createdWp?.id;
        }

        // Find job_posting id in Supabase
        const role = job.data?.Role || 'Worker';
        const loc = job.data?.Location || 'Hyderabad';
        const jpRes = await fetch(
            `${url}/rest/v1/job_postings?role=eq.${encodeURIComponent(role)}&location=eq.${encodeURIComponent(loc)}&limit=1`,
            { headers: { apikey: key, Authorization: `Bearer ${key}` } }
        );
        const jps = await jpRes.json();
        const jobId = Array.isArray(jps) && jps.length > 0 ? jps[0].id : null;

        if (jobId && workerProfileId) {
            const mRes = await fetch(`${url}/rest/v1/matches`, {
                method: 'POST',
                headers: supabaseHeaders(),
                body: JSON.stringify({
                    job_id: jobId,
                    worker_id: workerProfileId,
                    matched_at: new Date().toISOString(),
                }),
            });
            const mData = await mRes.json();
            console.log(`[Supabase] Match recorded for Job #${job.id}:`, mData);
            return mData;
        }
    } catch (err) {
        console.warn('[Supabase Warning] Failed to record match:', err.message);
    }
    return null;
}

