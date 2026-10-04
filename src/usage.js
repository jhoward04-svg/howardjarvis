// Spending tracker. Every paid call adds to a daily counter; costs are ESTIMATED from list prices below
// (the provider dashboards are the source of truth). A monthly budget, if set, switches off the optional paid
// extras (Deep think, OpenAI voice) once reached — ordinary chat always keeps working.

// USD per million tokens [input, output].
export const CLAUDE_PRICES = {
  "claude-sonnet-5-5": [2, 10], "claude-sonnet-5": [2, 10], "claude-sonnet-4-6": [3, 15],
  "claude-opus-5-5": [4, 20], "claude-opus-5": [5, 25], "claude-opus-4-8": [5, 25], "claude-opus-4-7": [5, 25],
  "claude-fable-5-1": [10, 50], "claude-fable-5": [10, 50], "claude-haiku-4-5": [1, 5],
};
const UNKNOWN_MODEL = [5, 25];                 // unknown model: assume Opus-tier so estimates err on the high side
export const RATES = {
  searchPer1k: 10,                             // web search, USD per 1,000 searches
  ttsPer1kChars: 0.0167,                       // OpenAI speech ≈ $0.015 per minute at ~900 characters per minute
  sttPerMinute: 0.006,                         // OpenAI transcription, USD per minute of audio (upper estimate)
};

const today = () => new Date().toISOString().slice(0, 10);
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);

export function claudeEntries(model, usage) {
  const m = model || "unknown";
  const out = [];
  const inTok = num(usage?.input_tokens) + num(usage?.cache_creation_input_tokens) + num(usage?.cache_read_input_tokens) * 0.1;
  if (inTok) out.push([`in:${m}`, inTok]);
  if (num(usage?.output_tokens)) out.push([`out:${m}`, num(usage.output_tokens)]);
  const st = usage?.server_tool_use;
  if (st && num(st.web_search_requests)) out.push(["search", num(st.web_search_requests)]);
  if (st && num(st.web_fetch_requests)) out.push(["fetch", num(st.web_fetch_requests)]);
  return out;
}

// Never let accounting break the feature being accounted for.
export async function recordUsage(env, entries, day = today()) {
  try {
    const rows = entries.filter(([, v]) => num(v) > 0);
    if (!rows.length) return;
    await env.DB.batch(rows.map(([metric, v]) =>
      env.DB.prepare("INSERT INTO usage (day, metric, value) VALUES (?, ?, ?) ON CONFLICT(day, metric) DO UPDATE SET value = value + excluded.value").bind(day, metric, num(v))));
  } catch (err) { console.error("usage record failed", err); }
}

// metrics: { metricName: value } for one day (or a total) -> estimated dollars by category.
export function costOf(metrics) {
  let claude = 0; const byModel = {};
  for (const [k, v] of Object.entries(metrics)) {
    const m = k.match(/^(in|out):(.+)$/);
    if (!m) continue;
    const price = CLAUDE_PRICES[m[2]] || UNKNOWN_MODEL;
    const c = (num(v) / 1e6) * (m[1] === "in" ? price[0] : price[1]);
    claude += c; byModel[m[2]] = (byModel[m[2]] || 0) + c;
  }
  const search = (num(metrics.search) / 1000) * RATES.searchPer1k;
  const tts = (num(metrics.tts_chars) / 1000) * RATES.ttsPer1kChars;
  const stt = (num(metrics.stt_secs) / 60) * RATES.sttPerMinute;
  const total = claude + search + tts + stt;
  const r = (x) => Math.round(x * 10000) / 10000;
  return { claude: r(claude), search: r(search), tts: r(tts), stt: r(stt), total: r(total), byModel: Object.fromEntries(Object.entries(byModel).map(([k, v]) => [k, r(v)])) };
}

export async function usageSince(env, sinceDay) {
  const { results } = await env.DB.prepare("SELECT day, metric, value FROM usage WHERE day >= ? ORDER BY day").bind(sinceDay).all();
  const days = {};
  for (const r of results) (days[r.day] ||= {})[r.metric] = r.value;
  return days;
}

export const monthStart = (d = new Date()) => d.toISOString().slice(0, 8) + "01";

let cache = { at: 0, spent: 0 };
export async function monthSpend(env, now = Date.now()) {
  if (now - cache.at < 20_000) return cache.spent;
  const days = await usageSince(env, monthStart(new Date(now)));
  const total = {};
  for (const m of Object.values(days)) for (const [k, v] of Object.entries(m)) total[k] = (total[k] || 0) + v;
  cache = { at: now, spent: costOf(total).total };
  return cache.spent;
}
export const resetSpendCache = () => { cache = { at: 0, spent: 0 }; };

// budget is the owner's monthly ceiling in USD ("" / 0 = none).
export async function budgetState(env, budgetSetting) {
  const budget = Number(budgetSetting) > 0 ? Number(budgetSetting) : 0;
  const spent = await monthSpend(env);
  return { budget, spent, exceeded: budget > 0 && spent >= budget, near: budget > 0 && spent >= budget * 0.8 };
}

// Everything the Spending screen needs, in one object.
export async function usageReport(env, days, settings) {
  days = Math.min(90, Math.max(1, Math.trunc(days) || 30));
  const now = new Date();
  const list = [];
  for (let i = days - 1; i >= 0; i--) list.push(new Date(now.getTime() - i * 86400000).toISOString().slice(0, 10));
  const byDay = await usageSince(env, list[0]);
  const rows = list.map((day) => {
    const m = byDay[day] || {};
    const c = costOf(m);
    return { day, cost: c, chats: m.chats || 0, deep_chats: m.deep_chats || 0, searches: m.search || 0, tts_chars: m.tts_chars || 0, stt_secs: Math.round(m.stt_secs || 0), stt_calls: m.stt_calls || 0 };
  });
  const sum = (f) => rows.reduce((a, r) => a + f(r), 0);
  const total = {}; for (const m of Object.values(byDay)) for (const [k, v] of Object.entries(m)) total[k] = (total[k] || 0) + v;
  const monthDays = await usageSince(env, monthStart(now)); const mTotal = {};
  for (const m of Object.values(monthDays)) for (const [k, v] of Object.entries(m)) mTotal[k] = (mTotal[k] || 0) + v;
  const budget = await budgetState(env, settings.monthly_budget);
  const row = async (k) => { const r = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(k).first(); try { return r ? JSON.parse(r.value) : null; } catch { return null; } };
  const day = now.toISOString().slice(0, 10);
  const deep = await row("deep_count"), voice = await row("voice_usage");
  return {
    days: rows, range: { totals: costOf(total), chats: sum((r) => r.chats), deep_chats: sum((r) => r.deep_chats), searches: sum((r) => r.searches), tts_chars: sum((r) => r.tts_chars), stt_secs: sum((r) => r.stt_secs) },
    month: { cost: costOf(mTotal), budget: budget.budget, spent: budget.spent, exceeded: budget.exceeded, near: budget.near },
    limits: {
      deep: { used: deep && deep.day === day ? deep.n : 0, limit: Number(env.DEEP_DAILY_LIMIT) || 40 },
      tts_chars: { used: voice && voice.day === day ? voice.tts_chars || 0 : 0, limit: Number(env.VOICE_DAILY_CHARS) || 60000 },
      stt_calls: { used: voice && voice.day === day ? voice.stt_calls || 0 : 0, limit: Number(env.VOICE_DAILY_STT) || 500 },
    },
    rates: RATES, models: CLAUDE_PRICES,
  };
}
