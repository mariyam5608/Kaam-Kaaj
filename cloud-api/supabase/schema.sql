-- Kaam Kaaj: Supabase Database Schema
-- Project: uptxfjaujmsvkkyykhex
--
-- This file defines the tables used by the Kaam Kaaj WhatsApp marketplace
-- and conversational bot.
--
-- Tables:
-- 1. users: Phone numbers, user types (employer/worker), and identifiers.
-- 2. job_postings: Active and completed job listings posted by employers.
-- 3. worker_profiles: Worker details (name, skills/role, location, availability).
-- 4. matches: Connections made when a worker applies to a job.
-- 5. conversations: Ephemeral conversation history for the serverless bot.

-- --------------------------------------------------------------------------
-- 1. Users
-- --------------------------------------------------------------------------
create table if not exists public.users (
  id           uuid primary key default gen_random_uuid(),
  phone_number varchar(20) not null,
  user_type    varchar(10), -- 'employer' | 'worker'
  created_at   timestamptz not null default now()
);

alter table public.users enable row level security;

-- --------------------------------------------------------------------------
-- 2. Job Postings
-- --------------------------------------------------------------------------
create table if not exists public.job_postings (
  id           uuid primary key default gen_random_uuid(),
  employer_id  uuid references public.users(id) on delete set null,
  role         varchar(100) not null,
  location     varchar(100) not null,
  shift_hours  varchar(100) not null default 'Flexible',
  status       varchar(10) not null default 'open', -- 'open' | 'closed'
  created_at   timestamptz not null default now()
);

alter table public.job_postings enable row level security;

-- --------------------------------------------------------------------------
-- 3. Worker Profiles
-- --------------------------------------------------------------------------
create table if not exists public.worker_profiles (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references public.users(id) on delete set null,
  name            varchar(100) not null,
  location        varchar(100) not null,
  role            varchar(100) not null,
  available_hours varchar(100) not null default 'Flexible',
  created_at      timestamptz not null default now()
);

alter table public.worker_profiles enable row level security;

-- --------------------------------------------------------------------------
-- 4. Matches
-- --------------------------------------------------------------------------
create table if not exists public.matches (
  id         uuid primary key default gen_random_uuid(),
  job_id     uuid references public.job_postings(id) on delete cascade,
  worker_id  uuid references public.worker_profiles(id) on delete cascade,
  matched_at timestamptz not null default now()
);

alter table public.matches enable row level security;

-- --------------------------------------------------------------------------
-- 5. Conversations (Serverless WhatsApp Bot Window)
-- --------------------------------------------------------------------------
create table if not exists public.conversations (
  -- The sender's WhatsApp number in international format without "+",
  -- exactly as Meta sends it in message.from.
  number      text primary key,
  -- [{ "role": "user" | "assistant", "content": "..." }, ...]
  history     jsonb not null default '[]'::jsonb,
  updated_at  timestamptz not null default now()
);

alter table public.conversations enable row level security;
