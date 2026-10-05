// Timed reminders. A cron tick (see notify.js) fires the ones that are due and pushes a notification.
// Times are stored in UTC; people speak and read them in their own time zone (the `timezone` setting).

import { zonedToUtc, safeTz } from "./ics.js";
import { clean } from "./data.js";

export const REPEATS = ["", "daily", "weekdays", "weekly", "monthly"];
const MAX_ACTIVE = 200;

async function tzOf(env) {
  const r = await env.DB.prepare("SELECT value FROM settings WHERE key = 'timezone'").first();
  return safeTz(r && r.value) || "UTC";
}

// The wall-clock parts of an instant in `tz`.
export function localOf(ms, tz) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute };
}

export function parseLocal(when) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2})?$/.exec(String(when || "").trim());
  if (!m) return null;
  const v = { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5] };
  if (v.mo < 1 || v.mo > 12 || v.d < 1 || v.d > 31 || v.h > 23 || v.mi > 59) return null;
  return v;
}

export const labelOf = (ms, tz) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(ms));

// The next time after `nowMs` that a repeating reminder (last due at `dueMs`) should fire, at the same local clock time.
export function nextOccurrence(dueMs, repeat, tz, nowMs) {
  const L = localOf(dueMs, tz);
  let { y, mo, d } = L;
  const anchorDay = d;
  for (let i = 0; i < 4000; i++) {
    if (repeat === "monthly") {
      mo++; if (mo > 12) { mo = 1; y++; }
      d = Math.min(anchorDay, new Date(Date.UTC(y, mo, 0)).getUTCDate());
    } else {
      const t = new Date(Date.UTC(y, mo - 1, d + (repeat === "weekly" ? 7 : 1)));
      y = t.getUTCFullYear(); mo = t.getUTCMonth() + 1; d = t.getUTCDate();
      if (repeat === "weekdays" && [0, 6].includes(t.getUTCDay())) continue;
    }
    const ms = zonedToUtc(y, mo, d, L.h, L.mi, 0, tz);
    if (ms > nowMs) return ms;
  }
  return null;
}

export async function addReminder(env, { text, when, in_minutes, repeat }, nowMs = Date.now()) {
  text = clean(text, 300);
  if (!text) return { error: "text is required" };
  repeat = repeat || "";
  if (!REPEATS.includes(repeat)) return { error: "repeat must be daily, weekdays, weekly or monthly" };
  const tz = await tzOf(env);
  let dueMs;
  if (in_minutes != null && in_minutes !== "") {
    const n = Number(in_minutes);
    if (!Number.isFinite(n) || n < 1 || n > 525600) return { error: "in_minutes must be between 1 and 525600" };
    dueMs = nowMs + Math.round(n) * 60_000;
  } else {
    const v = parseLocal(when);
    if (!v) return { error: "when must be a local date and time like 2026-10-06T15:00" };
    dueMs = zonedToUtc(v.y, v.mo, v.d, v.h, v.mi, 0, tz);
    if (dueMs < nowMs - 60_000) return { error: "that time has already passed" };
  }
  const active = await env.DB.prepare("SELECT COUNT(*) AS n FROM reminders WHERE fired_at IS NULL").first();
  if (active.n >= MAX_ACTIVE) return { error: "too many reminders — cancel some first" };
  const id = crypto.randomUUID().slice(0, 8);
  await env.DB.prepare("INSERT INTO reminders (id, text, due_at, repeat) VALUES (?, ?, ?, ?)").bind(id, text, new Date(dueMs).toISOString(), repeat).run();
  return { ok: true, id, text, due: labelOf(dueMs, tz), repeat: repeat || "once", timezone: tz };
}

export async function listReminders(env) {
  const tz = await tzOf(env);
  const { results } = await env.DB.prepare("SELECT id, text, due_at, repeat FROM reminders WHERE fired_at IS NULL ORDER BY due_at LIMIT 100").all();
  return results.map((r) => ({ id: r.id, text: r.text, due_at: r.due_at, due: labelOf(Date.parse(r.due_at), tz), repeat: r.repeat || "once" }));
}

// By id, or by words from its text (when exactly one reminder matches).
export async function cancelReminder(env, { id, text }) {
  if (id) {
    const r = await env.DB.prepare("DELETE FROM reminders WHERE id = ?").bind(clean(id, 40)).run();
    return r.meta.changes ? { ok: true } : { error: "no such reminder" };
  }
  const q = clean(text, 200).toLowerCase();
  if (!q) return { error: "give an id or some words from the reminder" };
  const hits = (await listReminders(env)).filter((r) => r.text.toLowerCase().includes(q));
  if (!hits.length) return { error: "no reminder matches that" };
  if (hits.length > 1) return { error: "more than one reminder matches — say which", matches: hits.map((h) => ({ id: h.id, text: h.text, due: h.due })) };
  await env.DB.prepare("DELETE FROM reminders WHERE id = ?").bind(hits[0].id).run();
  return { ok: true, cancelled: hits[0].text };
}

// Called every few minutes: returns the reminders that just fired. One-offs are marked done; repeating ones move on.
export async function fireDueReminders(env, nowMs = Date.now()) {
  const tz = await tzOf(env);
  const { results } = await env.DB.prepare("SELECT id, text, due_at, repeat FROM reminders WHERE fired_at IS NULL AND due_at <= ? ORDER BY due_at LIMIT 50").bind(new Date(nowMs).toISOString()).all();
  const fired = [];
  for (const r of results) {
    const next = r.repeat ? nextOccurrence(Date.parse(r.due_at), r.repeat, tz, nowMs) : null;
    if (next) await env.DB.prepare("UPDATE reminders SET due_at = ? WHERE id = ?").bind(new Date(next).toISOString(), r.id).run();
    else await env.DB.prepare("UPDATE reminders SET fired_at = ? WHERE id = ?").bind(new Date(nowMs).toISOString(), r.id).run();
    fired.push(r.text);
  }
  await env.DB.prepare("DELETE FROM reminders WHERE fired_at IS NOT NULL AND fired_at < ?").bind(new Date(nowMs - 30 * 86400_000).toISOString()).run();
  return fired;
}
