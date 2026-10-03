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
