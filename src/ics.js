// Read-only calendar from a private iCalendar (.ics) feed — no OAuth needed. Handles time zones,
// all-day events and the common repeating rules (DAILY / WEEKLY+BYDAY / MONTHLY / YEARLY, INTERVAL,
// COUNT, UNTIL, EXDATE) plus edited/cancelled single occurrences. Unsupported rules degrade to the
// first occurrence rather than failing.

const DAY = 86400000;
const WD = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7 };
const MAX_OCCURRENCES = 20000;

// ---------- time zones ----------
const dtfCache = new Map();
export function safeTz(tz) {
  if (!tz || typeof tz !== "string") return null;
  if (dtfCache.has(tz)) return dtfCache.get(tz) ? tz : null;
  try { dtfCache.set(tz, new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })); return tz; }
  catch { dtfCache.set(tz, null); return null; }
}
export function tzOffsetMs(utcMs, tz) {
  const f = dtfCache.get(tz) || (safeTz(tz) && dtfCache.get(tz));
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}
export function zonedToUtc(y, mo, d, h, mi, s, tz) {
  if (tz === "UTC") return Date.UTC(y, mo - 1, d, h, mi, s);
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const off = tzOffsetMs(guess, tz);
  let t = guess - off;
  const off2 = tzOffsetMs(t, tz);
  if (off2 !== off) t = guess - off2;               // the guess straddled a DST change
  return t;
}

// ---------- parsing ----------
export const unfold = (text) => text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);

function parseLine(line) {
  let q = false, i = -1;
  for (let k = 0; k < line.length; k++) { const c = line[k]; if (c === '"') q = !q; else if (c === ":" && !q) { i = k; break; } }
  if (i < 0) return null;
  const [name, ...ps] = line.slice(0, i).split(";");
  const params = {};
  for (const p of ps) { const j = p.indexOf("="); if (j > 0) params[p.slice(0, j).toUpperCase()] = p.slice(j + 1).replace(/^"|"$/g, ""); }
  return { name: name.toUpperCase(), params, value: line.slice(i + 1) };
}
const unescapeText = (s) => s.replace(/\\[nN]/g, " ").replace(/\\([,;\\])/g, "$1").trim();

function parseTime(value, params, defaultTz) {
  const v = value.trim();
  let m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) {
    const [y, mo, d] = [+m[1], +m[2], +m[3]];
    return { allDay: true, local: { y, mo, d, h: 0, mi: 0, s: 0 }, tz: defaultTz, ms: zonedToUtc(y, mo, d, 0, 0, 0, defaultTz) };
  }
  m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]];
  const tz = m[7] ? "UTC" : safeTz(params.TZID) || defaultTz;
  return { allDay: false, local: { y, mo, d, h, mi, s }, tz, ms: zonedToUtc(y, mo, d, h, mi, s, tz) };
}

function parseDuration(v) {
  const m = v.match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const ms = ((+m[2] || 0) * 7 + (+m[3] || 0)) * DAY + (+m[4] || 0) * 3600000 + (+m[5] || 0) * 60000 + (+m[6] || 0) * 1000;
  return m[1] === "-" ? -ms : ms;
}

function parseRrule(s) {
  const r = {};
  for (const part of s.split(";")) { const [k, v] = part.split("="); if (k && v) r[k.toUpperCase()] = v; }
  const rule = { freq: r.FREQ, interval: Math.max(1, +r.INTERVAL || 1), count: r.COUNT ? +r.COUNT : null, until: null, byday: [], bymonthday: [], bymonth: [] };
  if (r.UNTIL) { const t = parseTime(r.UNTIL.length === 8 ? r.UNTIL : r.UNTIL, {}, "UTC"); rule.until = t ? t.ms + (t.allDay ? DAY - 1 : 0) : null; }
  if (r.BYDAY) for (const d of r.BYDAY.split(",")) { const m = d.match(/^([+-]?\d+)?(MO|TU|WE|TH|FR|SA|SU)$/); if (m) rule.byday.push({ n: m[1] ? +m[1] : 0, d: WD[m[2]] }); }
  if (r.BYMONTHDAY) rule.bymonthday = r.BYMONTHDAY.split(",").map(Number).filter(Number.isFinite);
  if (r.BYMONTH) rule.bymonth = r.BYMONTH.split(",").map(Number).filter(Number.isFinite);
  return rule;
}

export function parseICS(text, defaultTz = "UTC") {
  const events = [];
  let cur = null;
  for (const raw of unfold(text)) {
    const l = parseLine(raw);
    if (!l) continue;
    if (l.name === "BEGIN" && l.value === "VEVENT") { cur = { exdates: [] }; continue; }
    if (l.name === "END" && l.value === "VEVENT") {
      if (cur && cur.start) {
        if (!cur.end) cur.end = cur.durationMs != null ? { ms: cur.start.ms + cur.durationMs } : { ms: cur.start.ms + (cur.start.allDay ? DAY : 0) };
        events.push(cur);
      }
      cur = null; continue;
    }
    if (!cur) continue;
    switch (l.name) {
      case "UID": cur.uid = l.value; break;
      case "SUMMARY": cur.summary = unescapeText(l.value); break;
      case "LOCATION": cur.location = unescapeText(l.value); break;
      case "STATUS": cur.status = l.value.toUpperCase(); break;
      case "DTSTART": cur.start = parseTime(l.value, l.params, defaultTz); break;
      case "DTEND": { const t = parseTime(l.value, l.params, defaultTz); if (t) cur.end = t; break; }
      case "DURATION": cur.durationMs = parseDuration(l.value); break;
      case "RRULE": cur.rrule = parseRrule(l.value); break;
      case "RECURRENCE-ID": { const t = parseTime(l.value, l.params, defaultTz); if (t) cur.recurrenceMs = t.ms; break; }
      case "EXDATE": for (const v of l.value.split(",")) { const t = parseTime(v, l.params, defaultTz); if (t) cur.exdates.push(t.ms); } break;
      default: break;
    }
  }
  return events;
}

// ---------- recurrence ----------
const ymdAdd = (y, mo, d, n) => { const t = new Date(Date.UTC(y, mo - 1, d + n)); return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() }; };
const dim = (y, mo) => new Date(Date.UTC(y, mo, 0)).getUTCDate();
const isoWeekday = (y, mo, d) => ((new Date(Date.UTC(y, mo - 1, d)).getUTCDay() + 6) % 7) + 1;
function nthWeekday(y, mo, wd, n) {
  const last = dim(y, mo);
  if (n > 0) { const day = 1 + ((wd - isoWeekday(y, mo, 1) + 7) % 7) + 7 * (n - 1); return day <= last ? day : null; }
  const day = last - ((isoWeekday(y, mo, last) - wd + 7) % 7) - 7 * (-n - 1);
  return day >= 1 ? day : null;
}

function* occurrences(e, toMs) {
  const rule = e.rrule, s = e.start.local, tz = e.start.tz;
  const make = (y, mo, d) => zonedToUtc(y, mo, d, s.h, s.mi, s.s, tz);
  let emitted = 0;
  const ok = (ms) => (rule.until == null || ms <= rule.until) && ms <= toMs;
  let guard = 0;

  if (rule.freq === "DAILY") {
    for (let k = 0; guard++ < MAX_OCCURRENCES; k++) {
      const { y, mo, d } = ymdAdd(s.y, s.mo, s.d, k * rule.interval); const ms = make(y, mo, d);
      if (!ok(ms) || (rule.count != null && emitted >= rule.count)) return;
      emitted++; yield ms;
    }
  } else if (rule.freq === "WEEKLY") {
    const days = (rule.byday.length ? rule.byday.map((b) => b.d) : [isoWeekday(s.y, s.mo, s.d)]).sort((a, b) => a - b);
    const monday = ymdAdd(s.y, s.mo, s.d, -(isoWeekday(s.y, s.mo, s.d) - 1));
    for (let w = 0; guard++ < MAX_OCCURRENCES; w++) {
      let any = false;
      for (const wd of days) {
        const { y, mo, d } = ymdAdd(monday.y, monday.mo, monday.d, w * 7 * rule.interval + wd - 1);
        const ms = make(y, mo, d);
        if (ms < e.start.ms) continue;
        if (!ok(ms) || (rule.count != null && emitted >= rule.count)) return;
        any = true; emitted++; yield ms;
      }
      if (!any && make(monday.y, monday.mo, monday.d + w * 7 * rule.interval) > toMs) return;
    }
  } else if (rule.freq === "MONTHLY" || rule.freq === "YEARLY") {
    const yearly = rule.freq === "YEARLY";
    for (let k = 0; guard++ < MAX_OCCURRENCES; k++) {
      let y, mo;
      if (yearly) { y = s.y + k * rule.interval; mo = null; }
      else { const t = s.mo - 1 + k * rule.interval; y = s.y + Math.floor(t / 12); mo = (t % 12) + 1; }
      const months = yearly ? (rule.bymonth.length ? rule.bymonth : [s.mo]) : [mo];
      const dates = [];
      for (const m of months) {
        if (rule.byday.length && !yearly) {
          for (const b of rule.byday) {
            if (b.n) { const d = nthWeekday(y, m, b.d, b.n); if (d) dates.push([m, d]); }
            else for (let d = 1; d <= dim(y, m); d++) if (isoWeekday(y, m, d) === b.d) dates.push([m, d]);
          }
        } else if (rule.bymonthday.length) {
          for (const bd of rule.bymonthday) { const d = bd > 0 ? bd : dim(y, m) + 1 + bd; if (d >= 1 && d <= dim(y, m)) dates.push([m, d]); }
        } else if (s.d <= dim(y, m)) dates.push([m, s.d]);
      }
      dates.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      let any = false;
      for (const [m, d] of dates) {
        const ms = make(y, m, d);
        if (ms < e.start.ms) continue;
        if (!ok(ms) || (rule.count != null && emitted >= rule.count)) return;
        any = true; emitted++; yield ms;
      }
      if (!any && make(y, mo || 12, 28) > toMs) return;
    }
  } else {
    yield e.start.ms;                                // unsupported rule: show the first occurrence only
  }
}

export function expandEvents(events, fromMs, toMs) {
  const overridden = new Set(events.filter((e) => e.recurrenceMs != null).map((e) => `${e.uid}|${e.recurrenceMs}`));
  const out = [];
  for (const e of events) {
    if (e.status === "CANCELLED") continue;
    const dur = Math.max(0, e.end.ms - e.start.ms);
    const add = (startMs) => {
      const endMs = startMs + dur;
      const hit = dur === 0 ? startMs >= fromMs && startMs <= toMs : endMs > fromMs && startMs < toMs;
      if (hit) out.push({ startMs, endMs, allDay: e.start.allDay, summary: e.summary || "(no title)", location: e.location || "" });
    };
    if (!e.rrule) { add(e.start.ms); continue; }
    const ex = new Set(e.exdates);
    for (const ms of occurrences(e, toMs)) {
      if (ex.has(ms) || overridden.has(`${e.uid}|${ms}`)) continue;
      add(ms);
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs || a.summary.localeCompare(b.summary));
}

// ---------- presentation (always in the owner's time zone) ----------
export function describeEvent(inst, tz) {
  const date = (ms, opt) => new Intl.DateTimeFormat("en-US", { timeZone: tz, ...opt }).format(new Date(ms));
  const ymd = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
  const out = { date: ymd(inst.startMs), day: date(inst.startMs, { weekday: "short" }), title: inst.summary };
  if (inst.location) out.location = inst.location;
  if (inst.allDay) {
    out.all_day = true;
    const lastDay = ymd(inst.endMs - 1);
    if (lastDay !== out.date) out.through = lastDay;
  } else {
    const t = { hour: "numeric", minute: "2-digit" };
    out.start = date(inst.startMs, t);
    if (inst.endMs > inst.startMs) { out.end = date(inst.endMs, t); if (ymd(inst.endMs) !== out.date) out.end_date = ymd(inst.endMs); }
  }
  return out;
}

export function eventsBetween(icsText, fromMs, toMs, tz) {
  return expandEvents(parseICS(icsText, tz), fromMs, toMs).map((i) => describeEvent(i, tz));
}

export function normalizeIcsUrl(input) {
  if (typeof input !== "string") return null;
  let s = input.trim();
  if (/^webcal:\/\//i.test(s)) s = "https://" + s.slice(9);
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(u.hostname) || /^[\d.]+$/.test(u.hostname) || u.hostname.includes(":")) return null;
  return u.toString();
}
