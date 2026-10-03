// Morning briefings, due-date reminders and Web Push for the single owner.
//
// A cron trigger calls runTick() every few minutes. It compares "now" in the owner's
// time zone with the configured times and, at most once per day each, writes a briefing
// / reminder into the conversation and sends a push to every subscribed device.
//
// Pushes carry NO payload: the service worker fetches /api/notice (cookie-authenticated)
// when one arrives. That avoids payload encryption and means the text of a briefing never
// travels through the push provider (Google/Apple/Mozilla) — only an empty "wake up".

const enc = new TextEncoder();
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// ---------- small helpers ----------

export const b64u = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const DEFAULTS = {
  briefing_enabled: "1", briefing_time: "07:30",
  reminder_enabled: "1", reminder_time: "17:00",
  timezone: "UTC", last_briefing: "", last_reminder: "",
};
const PUBLIC_KEYS = ["briefing_enabled", "briefing_time", "reminder_enabled", "reminder_time", "timezone"];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function validTimezone(tz) {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

// "2026-10-03" and "07:30" as the clock reads in `tz`.
export function localParts(date, tz) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

// True once the local clock passes `at`, until `windowMin` later, if not already sent today.
// The window stops a briefing arriving at 9 pm because the Worker was down all morning.
export function isDue(now, tz, at, lastSentDate, windowMin) {
  const { date, time } = localParts(now, tz);
  if (lastSentDate === date) return false;
  const diff = toMin(time) - toMin(at);
  return diff >= 0 && diff < windowMin;
}

export const dayDiff = (a, b) => Math.round((Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 86400000);

// Browsers only ever hand out push endpoints on these hosts; refusing everything else
// stops this Worker being aimed at arbitrary URLs.
export function isAllowedPushEndpoint(endpoint) {
  let u;
  try { u = new URL(endpoint); } catch { return false; }
  if (u.protocol !== "https:") return false;
  return /^(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com)$/.test(u.hostname) ||
    /\.(push\.services\.mozilla\.com|notify\.windows\.com|push\.apple\.com)$/.test(u.hostname);
}

// ---------- settings storage ----------

async function readAll(env) {
  const { results } = await env.DB.prepare("SELECT key, value FROM settings").all();
  return Object.fromEntries(results.map((r) => [r.key, r.value]));
}
export async function getSettings(env) { return { ...DEFAULTS, ...(await readAll(env)) }; }
async function put(env, key, value) {
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, value).run();
}

export async function applySettings(env, body) {
  const out = {};
  for (const k of ["briefing_enabled", "reminder_enabled"]) {
    if (k in body) { if (typeof body[k] !== "boolean") return { error: `${k} must be true or false` }; out[k] = body[k] ? "1" : "0"; }
  }
  for (const k of ["briefing_time", "reminder_time"]) {
    if (k in body) { if (!TIME_RE.test(body[k])) return { error: `${k} must be HH:MM` }; out[k] = body[k]; }
  }
  if ("timezone" in body) { if (!validTimezone(body.timezone)) return { error: "unknown timezone" }; out.timezone = body.timezone; }
  for (const [k, v] of Object.entries(out)) await put(env, k, v);
  return { ok: true };
}

// ---------- VAPID (RFC 8292) ----------

export async function ensureVapid(env) {
  const all = await readAll(env);
  if (all.vapid_public && all.vapid_private) return { pub: all.vapid_public, jwk: JSON.parse(all.vapid_private) };
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pub = b64u(await crypto.subtle.exportKey("raw", pair.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  await put(env, "vapid_public", pub);
  await put(env, "vapid_private", JSON.stringify(jwk));
  return { pub, jwk };
}

export async function vapidHeader(endpoint, pub, jwk, nowSec = Math.floor(Date.now() / 1000)) {
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowSec + 12 * 3600, sub: "https://howardjarvis.app" })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${head}.${body}`));  // raw r||s, as JWS wants
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${pub}`;
}

export async function sendPushAll(env) {
  const { results } = await env.DB.prepare("SELECT endpoint FROM push_subscriptions").all();
  if (!results.length) return { sent: 0, removed: 0, failed: 0 };
  const { pub, jwk } = await ensureVapid(env);
  const tally = { sent: 0, removed: 0, failed: 0 };
  for (const { endpoint } of results) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: await vapidHeader(endpoint, pub, jwk), TTL: "86400", Urgency: "normal", "Content-Length": "0" },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 404 || res.status === 410) {
        await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(endpoint).run();
        tally.removed++;
      } else if (res.ok) tally.sent++;
      else { tally.failed++; console.error("push rejected", res.status); }
    } catch (err) { tally.failed++; console.error("push failed", err); }
  }
  return tally;
}

// ---------- composing ----------

export function categorize(tasks, today) {
  const open = tasks.filter((t) => !t.done_at);
  const withDue = open.filter((t) => t.due_date);
  return {
    overdue: withDue.filter((t) => t.due_date < today),
    today: withDue.filter((t) => t.due_date === today),
    soon: withDue.filter((t) => { const d = dayDiff(t.due_date, today); return d >= 1 && d <= 3; }),
    undated: open.filter((t) => !t.due_date).length,
    openCount: open.length,
  };
}

const list = (ts) => ts.map((t) => t.text).join("; ");

export function plainBriefing(c) {
  if (!c.openCount) return "Good morning, Sir. Your task list is clear — nothing outstanding.";
  const parts = [];
  if (c.overdue.length) parts.push(`${c.overdue.length} overdue: ${list(c.overdue)}`);
  if (c.today.length) parts.push(`due today: ${list(c.today)}`);
  if (c.soon.length) parts.push(`coming up in the next three days: ${list(c.soon)}`);
  if (c.undated) parts.push(`${c.undated} more without a date`);
  return `Good morning, Sir. You have ${c.openCount} open ${c.openCount === 1 ? "task" : "tasks"} — ${parts.join(". ")}.`;
}

export function plainReminder(c) {
  const n = c.today.length;
  return `Sir, ${n === 1 ? "a task is" : `${n} tasks are`} still due today: ${list(c.today)}.`;
}

async function claudeText(env, system, user) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    signal: AbortSignal.timeout(25_000),
    body: JSON.stringify({ model: env.CLAUDE_MODEL || "claude-sonnet-5-5", max_tokens: 400, system, messages: [{ role: "user", content: user }] }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}`);
  const data = await res.json();
  const text = (data.content || []).map((b) => b.text || "").join("").trim();
  if (!text) throw new Error("empty briefing");
  return text;
}

export async function composeBriefing(env, today) {
  const { results } = await env.DB.prepare("SELECT text, due_date, done_at FROM tasks WHERE done_at IS NULL ORDER BY due_date IS NULL, due_date").all();
  const c = categorize(results, today);
  const fallback = plainBriefing(c);
  if (!env.ANTHROPIC_API_KEY || !c.openCount) return fallback;
  try {
    return await claudeText(
      env,
      "You are J.A.R.V.I.S., Howard's personal assistant, a dry and composed British butler who addresses him as \"Sir\". " +
        "Write his morning briefing in at most 80 words, plain text, no markdown, no lists. Lead with what is overdue or due today, " +
        "then a brief mention of what's coming. Use only the tasks given — never invent any. Today is " + today + ".",
      JSON.stringify({ overdue: c.overdue, due_today: c.today, next_three_days: c.soon, undated_count: c.undated })
    );
  } catch (err) {
    console.error("briefing via Claude failed, using template", err);
    return fallback;
  }
}

// ---------- delivering ----------

async function deliver(env, { title, text, emoji, kind }) {
  await env.DB.prepare("INSERT INTO messages (role, content) VALUES ('assistant', ?)").bind(`${emoji} ${title}\n\n${text}`).run();
  const body = text.length > 160 ? text.slice(0, 157) + "…" : text;
  await put(env, "last_notice", JSON.stringify({ title, body, text, kind, at: new Date().toISOString() }));
  return sendPushAll(env);
}

export async function briefNow(env, now = new Date()) {
  const s = await getSettings(env);
  const { date } = localParts(now, s.timezone);
  const text = await composeBriefing(env, date);
  const push = await deliver(env, { title: "Morning briefing", text, emoji: "☀️", kind: "briefing" });
  return { text, push };
}

export async function runTick(env, now = new Date()) {
  const s = await getSettings(env);
  const { date } = localParts(now, s.timezone);
  const done = [];

  if (s.briefing_enabled === "1" && isDue(now, s.timezone, s.briefing_time, s.last_briefing, 240)) {
    await put(env, "last_briefing", date);                 // mark first: a failed send must never repeat all morning
    await deliver(env, { title: "Morning briefing", text: await composeBriefing(env, date), emoji: "☀️", kind: "briefing" });
    done.push("briefing");
  }
  if (s.reminder_enabled === "1" && isDue(now, s.timezone, s.reminder_time, s.last_reminder, 180)) {
    await put(env, "last_reminder", date);
    const { results } = await env.DB.prepare("SELECT text, due_date, done_at FROM tasks WHERE done_at IS NULL AND due_date IS NOT NULL").all();
    const c = categorize(results, date);
    if (c.today.length) { await deliver(env, { title: "Due today", text: plainReminder(c), emoji: "⏰", kind: "reminder" }); done.push("reminder"); }
  }
  return done;
}

// ---------- API (called from the authenticated section of the Worker) ----------

export async function handleNotifyApi(request, env, url) {
  const { pathname } = url, method = request.method;

  if (pathname === "/api/settings" && method === "GET") {
    const s = await getSettings(env);
    const { pub } = await ensureVapid(env);
    const { results } = await env.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").all();
    return json({ settings: Object.fromEntries(PUBLIC_KEYS.map((k) => [k, k.endsWith("_enabled") ? s[k] === "1" : s[k]])), vapidPublicKey: pub, devices: results[0].n });
  }
  if (pathname === "/api/settings" && method === "POST") {
    const r = await applySettings(env, await request.json().catch(() => ({})));
    return json(r, r.error ? 400 : 200);
  }
  if (pathname === "/api/push/subscribe" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const sub = body.subscription;
    if (!sub || typeof sub.endpoint !== "string" || !isAllowedPushEndpoint(sub.endpoint)) return json({ error: "unsupported push endpoint" }, 400);
    await env.DB.prepare("INSERT INTO push_subscriptions (endpoint, subscription) VALUES (?, ?) ON CONFLICT(endpoint) DO UPDATE SET subscription = excluded.subscription")
      .bind(sub.endpoint, JSON.stringify(sub).slice(0, 4000)).run();
    return json({ ok: true });
  }
  if (pathname === "/api/push/unsubscribe" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    if (typeof body.endpoint === "string") await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(body.endpoint).run();
    return json({ ok: true });
  }
  if (pathname === "/api/push/test" && method === "POST") {
    await put(env, "last_notice", JSON.stringify({ title: "JARVIS", body: "Notifications are working, Sir.", kind: "test", at: new Date().toISOString() }));
    return json({ ok: true, push: await sendPushAll(env) });
  }
  if (pathname === "/api/briefing/now" && method === "POST") return json({ ok: true, ...(await briefNow(env)) });
  if (pathname === "/api/notice" && method === "GET") {
    const s = await readAll(env);
    return json(s.last_notice ? JSON.parse(s.last_notice) : {});
  }
  return null;
}
