"use strict";

const fs = require("fs");
const path = require("path");

// Load .env from cloud-api/.env or root .env
const envPaths = [
  path.resolve(__dirname, "../.env"),
  path.resolve(__dirname, "../../.env"),
];
for (const p of envPaths) {
  if (fs.existsSync(p)) {
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  }
}

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ SUPABASE_URL or SUPABASE_KEY missing in .env");
  process.exit(1);
}

const headers = {
  "Content-Type": "application/json",
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  Prefer: "return=representation",
};

async function getOrCreateUser(rawPhone, userType, createdAt) {
  const phone = String(rawPhone || "")
    .replace(/@lid|@s\.whatsapp\.net/g, "")
    .replace(/[^0-9]/g, "");

  const findRes = await fetch(
    `${SUPABASE_URL}/rest/v1/users?phone_number=eq.${encodeURIComponent(phone)}`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  const existing = await findRes.json();
  if (Array.isArray(existing) && existing.length > 0) {
    return existing[0];
  }

  const createRes = await fetch(`${SUPABASE_URL}/rest/v1/users`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      phone_number: phone,
      user_type: userType,
      created_at: createdAt || new Date().toISOString(),
    }),
  });
  const created = await createRes.json();
  return Array.isArray(created) ? created[0] : created;
}

async function syncJob(job) {
  const user = await getOrCreateUser(job.employerID, "employer", job.timestamp);
  const role = job.data?.Role || "Worker";
  const location = job.data?.Location || "Hyderabad";
  const shift_hours = job.data?.["Working hours"] || job.data?.Hours || "Flexible";

  // Check if job posting already exists for this employer, role and location
  const checkRes = await fetch(
    `${SUPABASE_URL}/rest/v1/job_postings?employer_id=eq.${user.id}&role=eq.${encodeURIComponent(role)}&location=eq.${encodeURIComponent(location)}`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  const existing = await checkRes.json();
  if (Array.isArray(existing) && existing.length > 0) {
    console.log(`⏩ Job "${role}" in ${location} already exists (ID: ${existing[0].id})`);
    return existing[0];
  }

  const insRes = await fetch(`${SUPABASE_URL}/rest/v1/job_postings`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      employer_id: user.id,
      role,
      location,
      shift_hours,
      status: "open",
      created_at: job.timestamp || new Date().toISOString(),
    }),
  });
  const inserted = await insRes.json();
  console.log(`✅ Synced Job: "${role}" in ${location}`);
  return Array.isArray(inserted) ? inserted[0] : inserted;
}

async function syncWorker(worker) {
  const user = await getOrCreateUser(worker.workerID, "worker", worker.timestamp);
  const name = worker.data?.Name || "Worker";
  const location = worker.data?.Location || "Hyderabad";
  const role =
    worker.data?.["Skills/Experience"] ||
    worker.data?.Skills ||
    worker.data?.Role ||
    "General";
  const available_hours =
    worker.data?.["Available hours"] || worker.data?.Hours || "Flexible";

  const checkRes = await fetch(
    `${SUPABASE_URL}/rest/v1/worker_profiles?user_id=eq.${user.id}&name=eq.${encodeURIComponent(name)}`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  const existing = await checkRes.json();
  if (Array.isArray(existing) && existing.length > 0) {
    console.log(`⏩ Worker "${name}" already exists (ID: ${existing[0].id})`);
    return existing[0];
  }

  const insRes = await fetch(`${SUPABASE_URL}/rest/v1/worker_profiles`, {
    method: "POST",
    headers,
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
  console.log(`✅ Synced Worker: "${name}" (${role}) in ${location}`);
  return Array.isArray(inserted) ? inserted[0] : inserted;
}

async function syncAll() {
  const dbPaths = [
    path.resolve(__dirname, "../../database.json"),
    path.resolve(__dirname, "../database.json"),
  ];
  let dbFile = dbPaths.find((p) => fs.existsSync(p));
  if (!dbFile) {
    console.error("❌ database.json not found in root or cloud-api");
    process.exit(1);
  }

  const raw = fs.readFileSync(dbFile, "utf8");
  const db = JSON.parse(raw);
  console.log(`📂 Read ${db.jobs?.length || 0} jobs and ${db.workers?.length || 0} workers from ${dbFile}`);
  console.log(`🌐 Target Supabase: ${SUPABASE_URL}\n`);

  for (const job of db.jobs || []) {
    await syncJob(job);
  }

  for (const worker of db.workers || []) {
    await syncWorker(worker);
  }

  console.log("\n🎉 Database sync completed successfully!");
}

if (require.main === module) {
  syncAll().catch((err) => {
    console.error("❌ Sync failed:", err);
    process.exit(1);
  });
}

module.exports = {
  getOrCreateUser,
  syncJob,
  syncWorker,
  syncAll,
};
