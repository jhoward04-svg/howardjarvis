// howardjarvis.app — a personal assistant for one owner. Single password
// (env.JARVIS_PASSWORD) -> HMAC-signed session cookie (env.SESSION_SECRET), so
// no session table is needed. Data lives in D1: tasks, notes, chat history.
// Static UI is served from public/ via the ASSETS binding; only /api/* hits this.

import { handleNotifyApi, runTick } from "./notify.js";
import { clean, listTasks, addTask, setTaskDone, listNotes, addNote, listMemories, addMemory, deleteMemory } from "./data.js";
import { parseImage, buildUserContent, buildSystemPrompt, runChat, PHOTO_PROMPT, extractPdfText, validPdfBase64 } from "./brain.js";
import { addDocument, listDocuments, deleteDocument, libraryCount } from "./library.js";
import { getSettings } from "./notify.js";
import { getCalendar } from "./calendar.js";
import { speak, transcribe, TTS_VOICES } from "./voice.js";
import { usageReport, budgetState, resetSpendCache } from "./usage.js";
import { exportBackup, restoreBackup, snapshot, listSnapshots, getSnapshot } from "./backup.js";

export { parseImage, buildUserContent, buildSystemPrompt };

const COOKIE = "hj_session";
const SESSION_DAYS = 30;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

const enc = new TextEncoder();

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });

function withSecurityHeaders(res) {
  const r = new Response(res.body, res);
  r.headers.set("x-content-type-options", "nosniff");
  r.headers.set("x-frame-options", "DENY");
  r.headers.set("referrer-policy", "same-origin");
  return r;
}

// ---------- auth ----------

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function makeSessionToken(secret, now = Date.now()) {
  const exp = now + SESSION_DAYS * 86400_000;
  return `${exp}.${await hmac(secret, String(exp))}`;
}

export async function verifySessionToken(secret, token, now = Date.now()) {
  if (!secret || typeof token !== "string") return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < now) return false;
  return safeEqual(sig, await hmac(secret, exp));
}

function getCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

async function isAuthed(request, env) {
  return verifySessionToken(env.SESSION_SECRET, getCookie(request, COOKIE));
}

async function login(request, env) {
  if (!env.JARVIS_PASSWORD || !env.SESSION_SECRET) {
    return json({ error: "not configured: set JARVIS_PASSWORD and SESSION_SECRET" }, 503);
  }
  const row = await env.DB.prepare("SELECT failed, locked_until FROM login_attempts WHERE id = 'default'").first();
  if (row?.locked_until && row.locked_until > new Date().toISOString()) {
    return json({ error: "too many attempts — try again later" }, 429);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  const given = typeof body.password === "string" ? body.password : "";
  // Compare HMACs so length differences don't leak.
  const ok = safeEqual(await hmac("cmp", given), await hmac("cmp", env.JARVIS_PASSWORD));
  if (!ok) {
    const failed = (row?.failed || 0) + 1;
    const lock = failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString() : null;
    await env.DB.prepare("UPDATE login_attempts SET failed = ?, locked_until = ? WHERE id = 'default'")
      .bind(lock ? 0 : failed, lock)
      .run();
    return json({ error: "wrong password" }, 401);
  }
  await env.DB.prepare("UPDATE login_attempts SET failed = 0, locked_until = NULL WHERE id = 'default'").run();
  const token = await makeSessionToken(env.SESSION_SECRET);
  return json({ ok: true }, 200, {
    "set-cookie": `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}`,
  });
}

// ---------- chat ----------

const DEEP_DAILY_LIMIT = 40;          // deep answers cost more; a plain daily ceiling keeps a runaway tab from running up the bill

async function takeDeepAllowance(env) {
  const day = new Date().toISOString().slice(0, 10);
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'deep_count'").first();
  let n = 0;
  if (row) { try { const v = JSON.parse(row.value); if (v.day === day) n = v.n; } catch {} }
  const limit = Number(env.DEEP_DAILY_LIMIT) || DEEP_DAILY_LIMIT;
  if (n >= limit) return false;
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('deep_count', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(JSON.stringify({ day, n: n + 1 })).run();
  return true;
}

async function chat(request, env) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: "chat isn't configured: set ANTHROPIC_API_KEY" }, 503);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  const text = clean(body.message, 4000);
  const image = body.image == null ? null : parseImage(body.image);
  if (body.image != null && !image) return json({ error: "that image can't be used — send a JPEG, PNG, WebP or GIF under 4 MB" }, 400);
  if (!text && !image) return json({ error: "message is required" }, 400);

  const settings = await getSettings(env);
  let deep = body.deep === true;
  let deepNote = "";
  if (deep) {
    if ((await budgetState(env, settings.monthly_budget)).exceeded) { deep = false; deepNote = "\n\n(This month's budget is reached, Sir, so that was a standard answer.)"; }
    else if (!(await takeDeepAllowance(env))) { deep = false; deepNote = "\n\n(Today's deep-think allowance is used up, Sir, so that was a standard answer.)"; }
  }

  try {
    const { results: past } = await env.DB.prepare("SELECT role, content FROM messages ORDER BY id DESC LIMIT 20").all();
    const [tasks, notes, memories, docs] = await Promise.all([listTasks(env), listNotes(env), listMemories(env, 60), libraryCount(env)]);
    const ctx = {
      tasks: tasks.filter((t) => !t.done_at), notes, today: new Date().toISOString().slice(0, 10),
      extra: { memories, libraryDocs: docs, calendar: !!settings.ics_url, search: settings.web_search !== "0" },
    };
    const r = await runChat(env, { prompt: text || PHOTO_PROMPT, image, deep, history: past.reverse(), ctx });
    const answer = r.answer + deepNote;
    const stored = answer + (r.sources.length ? "\n\nSources:\n" + r.sources.map((x) => `- ${x.title} ${x.url}`).join("\n") : "");
    await env.DB.batch([
      env.DB.prepare("INSERT INTO messages (role, content) VALUES ('user', ?)").bind(image ? `📷 [photo] ${text}`.trim() : text),
      env.DB.prepare("INSERT INTO messages (role, content) VALUES ('assistant', ?)").bind(stored),
    ]);
    return json({ answer, spoken: r.spoken, sources: r.sources, refresh: r.refresh, degraded: r.degraded, deep: r.deep });
  } catch (err) {
    console.error("chat failed", err);
    return json({ error: "temporarily unavailable — try again in a moment" }, 502);
  }
}

// ---------- routing ----------

async function handleApi(request, env, url) {
  const { pathname } = url;
  const method = request.method;

  if (pathname === "/api/login" && method === "POST") return login(request, env);
  if (pathname === "/api/logout" && method === "POST") {
    return json({ ok: true }, 200, { "set-cookie": `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0` });
  }
  if (!(await isAuthed(request, env))) return json({ error: "unauthorized" }, 401);

  // Cookie auth + state-changing requests: require same-origin to block CSRF.
  if (method !== "GET") {
    const origin = request.headers.get("origin");
    if (origin && origin !== url.origin) return json({ error: "bad origin" }, 403);
  }

  if (pathname === "/api/me") return json({ ok: true });
  if (pathname === "/api/tasks" && method === "GET") return json({ tasks: await listTasks(env) });
  if (pathname === "/api/tasks" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const r = await addTask(env, body);
    return json(r, r.error ? 400 : 201);
  }
  if (pathname === "/api/tasks/done" && method === "DELETE") {          // "Clear finished"
    const r = await env.DB.prepare("DELETE FROM tasks WHERE done_at IS NOT NULL").run();
    return json({ ok: true, removed: r.meta.changes || 0 });
  }
  const taskMatch = pathname.match(/^\/api\/tasks\/([\w-]+)$/);
  if (taskMatch && method === "PATCH") {
    const body = await request.json().catch(() => ({}));
    const r = await setTaskDone(env, taskMatch[1], body.done !== false);
    return json(r, r.error ? 404 : 200);
  }
  if (taskMatch && method === "DELETE") {
    await env.DB.prepare("DELETE FROM tasks WHERE id = ?").bind(taskMatch[1]).run();
    return json({ ok: true });
  }
  if (pathname === "/api/notes" && method === "GET") return json({ notes: await listNotes(env) });
  if (pathname === "/api/notes" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const r = await addNote(env, body);
    return json(r, r.error ? 400 : 201);
  }
  const noteMatch = pathname.match(/^\/api\/notes\/([\w-]+)$/);
  if (noteMatch && method === "DELETE") {
    await env.DB.prepare("DELETE FROM notes WHERE id = ?").bind(noteMatch[1]).run();
    return json({ ok: true });
  }
  if (pathname === "/api/messages" && method === "GET") {
    const { results } = await env.DB.prepare("SELECT role, content FROM messages ORDER BY id DESC LIMIT 50").all();
    return json({ messages: results.reverse() });
  }
  if (pathname === "/api/chat" && method === "POST") return chat(request, env);
  // memories
  if (pathname === "/api/memories" && method === "GET") return json({ memories: await listMemories(env, 200) });
  if (pathname === "/api/memories" && method === "POST") {
    const r = await addMemory(env, { fact: (await request.json().catch(() => ({}))).text });
    return json(r, r.error ? 400 : 201);
  }
  const memMatch = pathname.match(/^\/api\/memories\/([\w-]+)$/);
  if (memMatch && method === "DELETE") return json(await deleteMemory(env, memMatch[1]));

  // document library
  if (pathname === "/api/library" && method === "GET") return json({ documents: await listDocuments(env) });
  if (pathname === "/api/library" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const r = await addDocument(env, { title: b.title, text: b.text, source: "text" });
    return json(r, r.error ? 400 : 201);
  }
  if (pathname === "/api/library/pdf" && method === "POST") {
    if (!env.ANTHROPIC_API_KEY) return json({ error: "not configured: set ANTHROPIC_API_KEY" }, 503);
    const b = await request.json().catch(() => ({}));
    if (!validPdfBase64(b.data)) return json({ error: "that PDF can't be used — send a PDF under 4 MB" }, 400);
    try {
      const text = await extractPdfText(env, b.data);
      const r = await addDocument(env, { title: clean(b.name, 200).replace(/\.pdf$/i, "") || "PDF", text, source: "pdf" });
      return json(r, r.error ? 400 : 201);
    } catch (err) {
      console.error("pdf extract failed", err);
      return json({ error: "couldn't read that PDF — it may be scanned, protected or too long (about 10 pages is the limit)" }, 502);
    }
  }
  const docMatch = pathname.match(/^\/api\/library\/([\w-]+)$/);
  if (docMatch && method === "DELETE") return json(await deleteDocument(env, docMatch[1]));

  // spending dashboard
  if (pathname === "/api/usage" && method === "GET") {
    return json(await usageReport(env, Number(url.searchParams.get("days")) || 30, await getSettings(env)));
  }

  // backups
  if (pathname === "/api/backup" && method === "GET") {
    const data = await exportBackup(env, { secrets: url.searchParams.get("secrets") === "1" });
    return new Response(JSON.stringify(data), { headers: { "content-type": "application/json", "cache-control": "no-store", "content-disposition": `attachment; filename="jarvis-backup-${new Date().toISOString().slice(0, 10)}.json"` } });
  }
  if (pathname === "/api/backup/status" && method === "GET") {
    const st = await getSettings(env);
    return json({ storage: !!env.BACKUPS, last_automatic: st.last_backup || "", snapshots: (await listSnapshots(env)).slice(0, 12) });
  }
  if (pathname === "/api/backup/snapshot" && method === "POST") {
    const r = await snapshot(env, "manual");
    return json(r, r.error ? 503 : 200);
  }
  if (pathname === "/api/restore" && method === "POST") {
    if (Number(request.headers.get("content-length")) > 25_000_000) return json({ error: "that file is too large" }, 413);
    const b = await request.json().catch(() => null);
    if (!b || typeof b !== "object") return json({ error: "invalid request" }, 400);
    const mode = b.mode === "replace" ? "replace" : "merge";
    if (mode === "replace" && b.confirm !== "REPLACE") return json({ error: "replacing everything needs confirmation" }, 400);
    const data = typeof b.snapshot === "string" ? await getSnapshot(env, b.snapshot) : b.backup;
    if (!data) return json({ error: "backup not found" }, 404);
    if (mode === "replace" && env.BACKUPS) await snapshot(env, "before-restore").catch((e) => console.error("pre-restore snapshot failed", e));
    const r = await restoreBackup(env, data, mode);
    resetSpendCache();
    return json(r, r.error ? 400 : 200);
  }

  // OpenAI voice (key stays on the server)
  if (pathname === "/api/voice/speak" && method === "POST") return speak(env, request);
  if (pathname === "/api/voice/transcribe" && method === "POST") return transcribe(env, request);
  if (pathname === "/api/voice/log" && method === "POST") {      // the phone's voice event log, so problems can be diagnosed without screenshots
    const b = await request.json().catch(() => ({}));
    const text = String(b.log || "").slice(0, 8000);
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('voice_log', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(new Date().toISOString() + "\n" + String(b.ua || "").slice(0, 200) + "\nversion " + String(b.version || "").slice(0, 30) + "\n" + text).run();
    return json({ ok: true });
  }
  if (pathname === "/api/voice/config" && method === "GET") return json({ ready: !!env.OPENAI_API_KEY, voices: TTS_VOICES });

  // calendar check (Settings → "Test")
  if (pathname === "/api/calendar/test" && method === "GET") {
    const r = await getCalendar(env, { daysAhead: 7 });
    return json(r.error ? { error: r.error } : { ok: true, count: r.count, next: r.events.slice(0, 3) }, r.error ? 400 : 200);
  }

  const notify = await handleNotifyApi(request, env, url);
  if (notify) return notify;
  return json({ error: "not found" }, 404);
}

export default {
  // Cron trigger (see wrangler.jsonc): morning briefing + due-date reminder when their time arrives.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runTick(env).catch((err) => console.error("scheduled tick failed", err)));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname === "www.howardjarvis.app") {
      return Response.redirect(`https://howardjarvis.app${url.pathname}${url.search}`, 301);
    }
    if (url.pathname.startsWith("/api/")) return withSecurityHeaders(await handleApi(request, env, url));
    return withSecurityHeaders(await env.ASSETS.fetch(request));
  },
};
