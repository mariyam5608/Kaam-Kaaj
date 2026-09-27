# Kaam Kaaj

A WhatsApp bot that gets people in Hyderabad, Sindh work — without asking any of them to write a CV.

Built for [Imaginathon](https://www.banao.pk/imaginathon/) by banao.pk. Team **HM^2**.

---

## Why we built this

Hyderabad's biggest problem is jobs. And the people who most need one are usually
the ones a job portal can't help — no formal qualifications, no CV, no email
address, sometimes not much literacy in English. But they are not unskilled.
They can load a truck, stitch, drive, clean, mind a shop, stand a shift at a
wedding. They just have no way to say so.

Employers feel the other half of the same problem. Someone needs two men to move
furniture on Sunday, and there is no sensible way to find them. So they ask
around, and the work goes to whoever happened to be within earshot.

Kaam Kaaj meets both of them where they already are — WhatsApp — and asks
neither of them for paperwork. An employer fills in five fields and the job is
posted. A worker fills in five fields and they are on the list. Someone applies,
both sides get each other's number, and the conversation moves to a phone call,
which is how this was always going to end anyway.

Small gigs, mostly. Closer to paid volunteering than to a career. That is the
point: it is the rung at the bottom of the ladder, and right now Hyderabad does
not have one.

## The part we are proudest of: it speaks the way people actually speak

Nobody in Hyderabad types in English. They type in Roman Urdu — `mujhe ek din ka
mazdoor chahiye` — or they switch to Urdu script when their phone's keyboard is
already set to it, often mid-conversation.

Most bots handle this by offering a language menu. We tried that and it felt
wrong immediately. Nobody should have to declare their language before asking
for work.

So the bot just mirrors you. Write Roman Urdu, get Roman Urdu. Write اردو, get
اردو. Write English, get English. No setting, no prompt, no announcement.

This is harder than it sounds, and the failure mode is embarrassing: ask a small
language model for Urdu and it will happily hand you Hindi in Devanagari script
— काम, चहिए — which looks almost right at a glance and is completely wrong to
anyone who reads it. We spent most of our time on exactly that. The fixes were
a model large enough to hold the distinction (we are on `openai/gpt-oss-120b`
today — Groq retired the `llama-3.3-70b-versatile` we started on, and the small
models drift), an explicit ban on Devanagari in the prompt, and putting the
language instruction *last* in the system prompt, where models weight it most
heavily.

Two details we would not have thought of on day one:

**A short message carries no language.** If someone replies `ok` or 👍, there is
nothing to detect — and a naive reading calls that English, flipping the whole
conversation out of Urdu. The bot walks back through the thread to the last
message that actually said something, and keeps that language.

**Labels get translated, values never do.** A name, an area, a phone number and
a fare have to survive the trip byte-for-byte. `Tankhwah: 1500` and
`تنخواہ: 1500` are the same fact; `1۵۰۰` is not, so Eastern digits are converted
on the way out. Filled-in forms never go near the model at all.

## The repo: two backends, and why

There are two working WhatsApp integrations here. They are not two attempts at
the same thing — they connect to WhatsApp in genuinely different ways, and
neither can replace the other.

| | Root (`/`) | `cloud-api/` |
|---|---|---|
| **Uses** | [Baileys](https://github.com/WhiskeySockets/Baileys) — the unofficial library | Meta's official WhatsApp Cloud API |
| **Connects by** | Scanning a QR code, like WhatsApp Web | A webhook URL Meta sends messages to |
| **Needs** | An always-on process | Nothing running — it is serverless |
| **Runs on Vercel?** | No | **Yes — this is what is deployed** |
| **Uses a real number?** | Yes, it owns the session | No, it uses Meta's test line |

The Baileys bot holds a persistent WebSocket open. Serverless hosting freezes a
function the instant it sends a response, so the socket dies and the session
drops — it fundamentally cannot run on Vercel. It needs Render, Railway, Fly or
a small VPS.

The Cloud API bot is a plain HTTP endpoint with no state of its own, so it
deploys cleanly. **It is live at
[`kaamkaaj-whatsapp.vercel.app`](https://kaamkaaj-whatsapp.vercel.app)** and the
webhook Meta calls is `/webhook`.

Both speak all three languages. They share the detection *approach*, not the
code — the root pair is ESM and carries the marketplace vocabulary (menus,
`apply 3`), while `cloud-api/` is CommonJS and needs none of it, so it drives
the model with a prompt directive instead.

## What is actually finished

- Job posting through a short conversation — role, area, hours and pay — and
  worker registration with name, age and skills. No forms, no CV, no account.
- Browse and apply. When someone applies, the employer is told in *their* own
  language and the worker gets a confirmation, and both sides end up with each
  other's number.
- Urdu, Roman Urdu and English, mirrored automatically, including spelling
  variants (`chahye` / `chaiye` / `chy` all read the same)
- Voice notes, in the Baileys backend — transcribed with Whisper before the
  message enters the flow
- Free-text messages the flow does not recognise are handed to the model with
  the fields it should fill in extracted
- Cloud API bot deployed on Vercel, with HMAC signature verification built in
  and switched on by setting one environment variable
- 74 automated tests — 25 in the Baileys bot, 49 in `cloud-api/`. `npm test` in
  either folder.

## What is not finished

Being straight about this, because it was built in days and not months:

- **No matching.** Applying is a person scrolling a list. Nothing ranks a
  worker against a job, and nothing suggests a job to a worker. This is the
  biggest gap and the first thing we would build next.
- **No persistence in production.** Conversation memory lives in the serverless
  instance, so it resets on a cold start. The Supabase schema and the code path
  are written (`cloud-api/supabase/schema.sql`) but not switched on yet.
- **No voice notes in the deployed backend.** Voice is the natural input for a
  lot of the people this is for, and the Baileys bot already transcribes it with
  Whisper. But the backend that is actually live on Vercel politely refuses
  anything that is not text, so the one feature that matters most to the least
  literate users is the one that is not in production.
- **Five recipients.** Meta's test number can only message five verified
  numbers. A real launch needs an approved business number, which needs business
  verification — weeks of process, not code.
- **No moderation.** Job postings are not screened. In a real deployment this
  is a safety problem, not a nice-to-have.
- **Hyderabad only, and untested there.** The city was assigned to us by the
  organisers. We have not put this in front of actual workers or employers yet,
  so everything above the line is our reasoning, not evidence.

## Running it

The Cloud API backend is the one that deploys:

```bash
cd cloud-api
npm install
cp .env.example .env      # then fill in your keys
npm test                  # 49 checks, no network, no credentials needed
npm start                 # local, expose with: ngrok http 3000
```

Environment variables are documented in `cloud-api/.env.example` — what each one
is, where to get it, and which model choices break Urdu. `.env` is gitignored
and was never committed.

For the Baileys bot, run `npm install && npm start` at the repo root and scan
the QR code with the phone that will own the number.

## Team

**HM^2** — Hasan Shahir, Hadeeqa,  Marrium Burhan and Minahil

Built for Imaginathon by banao.pk. Our city was assigned by the organisers:
Hyderabad.
