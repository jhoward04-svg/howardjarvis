// Fetches the owner's private calendar feed (.ics) and returns events for a window of days.
import { eventsBetween, zonedToUtc, safeTz } from "./ics.js";

const DAY = 86400000;

async function readSettings(env) {
  const { results } = await env.DB.prepare("SELECT key, value FROM settings WHERE key IN ('ics_url', 'timezone')").all();
  return Object.fromEntries(results.map((r) => [r.key, r.value]));
}

export async function fetchIcs(url) {
  const res = await fetch(url, { headers: { accept: "text/calendar, text/plain, */*" }, signal: AbortSignal.timeout(10_000), cf: { cacheTtl: 300, cacheEverything: true } });
  if (!res.ok) throw new Error(`the calendar feed answered ${res.status}`);
  const text = await res.text();
  if (text.length > 8_000_000) throw new Error("the calendar feed is too large");
  if (!text.includes("BEGIN:VCALENDAR")) throw new Error("that link isn't a calendar feed (.ics)");
  return text;
}

// daysBack/daysAhead are relative to today in the owner's time zone (today = day 0).
export async function getCalendar(env, { daysBack = 0, daysAhead = 7, now = new Date() } = {}) {
  const s = await readSettings(env);
  if (!s.ics_url) return { error: "no calendar is connected — add a calendar link in Settings" };
  const tz = safeTz(s.timezone) || "UTC";
  daysBack = Math.min(Math.max(Math.trunc(daysBack) || 0, 0), 30);
  daysAhead = Math.min(Math.max(Math.trunc(daysAhead) || 0, 0), 60);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const [y, m, d] = today.split("-").map(Number);
  const dayStart = (offset) => { const t = new Date(Date.UTC(y, m - 1, d + offset)); return zonedToUtc(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), 0, 0, 0, tz); };
  try {
    const text = await fetchIcs(s.ics_url);
    const events = eventsBetween(text, dayStart(-daysBack), dayStart(daysAhead + 1), tz);
    return { timezone: tz, from: new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(dayStart(-daysBack)), days: daysBack + daysAhead + 1, count: events.length, events: events.slice(0, 60) };
  } catch (err) {
    return { error: err.message };
  }
}
