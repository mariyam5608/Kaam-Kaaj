-- Kaamkaaj WhatsApp bot: conversation history.
--
-- Why this exists: on Vercel a function instance is frozen between requests, so
-- the in-memory Map in lib/bot.js cannot carry a conversation. This table gives
-- each phone number a durable 20-message window.
--
-- Run it once in the Supabase dashboard -> SQL Editor -> New query -> Run.
-- Until it exists the bot still works; it just loses context whenever a cold
-- instance handles the message.

create table if not exists public.conversations (
  -- The sender's WhatsApp number in international format without "+",
  -- exactly as Meta sends it in message.from.
  number      text primary key,
  -- [{ "role": "user" | "assistant", "content": "..." }, ...]
  history     jsonb not null default '[]'::jsonb,
  updated_at  timestamptz not null default now()
);

-- The server talks to PostgREST with the service_role key, which bypasses RLS.
-- RLS is still enabled with no policies so that an anon key can never read
-- these rows: this table holds phone numbers and the full text of private
-- conversations.
alter table public.conversations enable row level security;

-- lib/bot.js upserts with Prefer: resolution=merge-duplicates, which needs the
-- primary key above. Nothing else to create.
