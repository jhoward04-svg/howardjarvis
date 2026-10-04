# howardjarvis.app

Personal Jarvis — a single-owner assistant (chat with Claude, tasks, notes). Separate Worker
and D1 database from the Legacy Card Vault shop in the parent directory; shares nothing at runtime.

- `src/worker.js` — `/api/*`: password login (HMAC-signed cookie, lockout after 5 bad tries),
  tasks, notes, and `/api/chat`, where Claude can call `add_task`, `complete_task`, `add_note`.
- `public/index.html` — the whole UI (login, chat, tasks, notes). No build step.
- `migrations/` — D1 schema.

## First-time setup

Run from this directory (`howardjarvis/`) after `npm install`:

```
npx wrangler d1 create howardjarvis          # paste the id into wrangler.jsonc
npm run migrate
npx wrangler secret put JARVIS_PASSWORD
npx wrangler secret put SESSION_SECRET       # any long random string
npx wrangler secret put ANTHROPIC_API_KEY
npm run deploy
```

`howardjarvis.app` must be an active zone on the Cloudflare account; `wrangler.jsonc` attaches it
(and `www`, which redirects to the apex) as custom domains on deploy.

## Local dev

Create `.dev.vars` with `JARVIS_PASSWORD`, `SESSION_SECRET`, `ANTHROPIC_API_KEY`, then
`npm run migrate:local && npm run dev`. Tests: `npm test`.

## Photos

The 📷 button opens the phone camera (🖼 picks from the gallery; on desktop both open a file
picker; you can also paste an image into the message box). The browser shrinks the photo to
1568 px / JPEG before upload; the Worker re-validates it and sends it to Claude for that one
turn. Photos are **not** stored — the history keeps only a "📷 [photo]" text marker.

## Install on a phone (PWA)

`manifest.webmanifest` + `sw.js` + icons make the site installable. Android/Chrome: Install
button in the top bar (or menu ⋮ → Install app). iPhone/Safari: Share → Add to Home Screen.
The service worker caches only the app shell; `/api/*` is never cached, and the page itself is
network-first so deploys show up immediately.

## Briefings, reminders and notifications

`src/notify.js`, driven by a cron trigger (`*/10 * * * *` in `wrangler.jsonc`). In the owner's time
zone it sends, at most once a day each: a **morning briefing** (overdue / due today / coming up,
written by Claude with a plain-text fallback) and a **reminder** for tasks still due today.
Both are written into the conversation (`messages`) and pushed to subscribed devices.
Settings screen: times, notifications on/off, Brief-me-now, test push, voice picker.

Web Push uses VAPID keys the Worker generates on first use and stores in the `settings` table
(never returned by any API). Pushes carry **no payload** — the service worker fetches the text
from `/api/notice` (cookie-authenticated), so briefing text never passes through Google/Apple.
iPhone/iPad need the app installed to the Home Screen (iOS 16.4+) before notifications work.

Migration `0002_notifications.sql` must be applied (`npm run migrate`) before deploying.

## Defaults on load

Conversation mode (mic), spoken replies and the wake word are on by default; turning one off is
remembered (`localStorage`). The conversation panel starts clean — greeting plus today's briefing;
full history is in the Conversations view. Browsers won't speak until the first tap/keypress, so
that first interaction unlocks the voice.

## Intelligence

`src/brain.js` runs each chat turn:

- **Models** — normal questions use `CLAUDE_MODEL` (default `claude-sonnet-5-5`, effort `medium`); the 🧠 *Deep think* button uses
  `CLAUDE_DEEP_MODEL` (default `claude-opus-5-5`, effort `high`, 6000-token budget; `DEEP_DAILY_LIMIT`, default 40/day).
  Set `CLAUDE_DEEP_MODEL=claude-fable-5-1` for the most capable (and priciest) option.
- **Web** — Claude's server-side `web_search` and `web_fetch` tools (toggle in Settings). Answers carry source links.
- **Tools we run** — tasks, notes, `remember`/`forget` (long-term memory), `search_library`/`save_document`
  (FTS5 document library, PDFs are transcribed by Claude), `get_calendar` (private .ics feed, `src/ics.js` handles
  time zones, repeating events, exceptions), and an exact `calculate` (`src/calc.js`, no `eval`).
- **Long answers** are formatted on screen; a final `SPOKEN:` line gives a short version for the voice.
- **Safety net** — requests go out with every feature first; if the API rejects that shape (400/404/422) the Worker retries in a
  plain shape and remembers that for 10 minutes, so chat never goes silent. Server tools' turns are replayed unchanged.

Migration `0003_intelligence.sql` (memories, documents, `doc_fts`) must be applied before deploying.
`ANTHROPIC_BASE_URL` (optional) points the Worker at another API host — used by the local end-to-end tests.

## OpenAI voice

Natural spoken replies and listening that works where the browser has no speech recognition (the installed iPhone app).
Needs one secret: `OPENAI_API_KEY` (Worker → Settings → Variables and Secrets). Without it everything falls back to device voices.

- `src/voice.js` proxies `POST /api/voice/speak` (text → MP3, `gpt-4o-mini-tts`, fixed British-butler instructions, voice chosen from a
  whitelist) and `POST /api/voice/transcribe` (clip → text, `gpt-transcribe`, retried with `gpt-4o-mini-transcribe` if refused).
  The key never reaches the browser. Daily ceilings: `VOICE_DAILY_CHARS` (default 60 000) and `VOICE_DAILY_STT` (default 500).
  Optional overrides: `OPENAI_TTS_MODEL`, `OPENAI_STT_MODEL`, `OPENAI_BASE_URL` (tests).
- Browser: `CloudRec` records with `MediaRecorder`, detects the end of speech, uploads, and presents the same interface as
  `SpeechRecognition`, so conversation mode and the wake word work unchanged. The microphone is released before anything speaks.
- Playback uses one persistent `<audio>` element, unlocked by a silent clip on the first tap (iOS rule). Any failure falls back to
  the device voice. Settings → Voice picks the engines and the OpenAI voice. The UI states that the voice is AI-generated.
- With OpenAI listening, every clip of detected speech is sent to OpenAI — including while waiting for the wake word.

## Spending dashboard

The **Spending** view shows what Jarvis costs: this month's total (Claude, web search, voice), a 14-day chart, and a per-model breakdown. Set a **monthly budget** there; once it is reached, Deep think and OpenAI voice step aside (ordinary chat keeps working, and device voice remains free). Prices live in `src/usage.js` and are estimates — your provider dashboards are authoritative. Usage is stored in the `usage` D1 table (migration `0004_usage.sql`).

## Backups

Settings → **Backup & restore**:

- **Download** a JSON file of tasks, notes, memories, library documents, conversation and preferences. The calendar link is only included if you opt in; push keys and secrets never are.
- **Restore** from a file or snapshot. *Merge* adds what is missing; *Replace* swaps everything and asks for confirmation. The file is validated before anything changes, and a `before-restore` snapshot is taken first.
- **Weekly snapshots** are written to the R2 bucket `howardjarvis-backups` (binding `BACKUPS`) after 03:00 local time, keeping the latest 12.

## Wake word

`public/wake.js` decides when Jarvis is being addressed. "Jarvis" counts at the start of a sentence (optionally after "hey/ok…") or at the very end, tolerates common mishearings, and ignores the name mid-sentence ("I told Jarvis…"). "Thanks, that's all" or "stop listening" stands him down; filler such as "um" is ignored while engaged.
