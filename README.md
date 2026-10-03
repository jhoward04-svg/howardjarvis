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
