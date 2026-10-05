// The assistant: system prompt, tools, model selection and the tool loop.
//
// Normal questions use CLAUDE_MODEL (default Sonnet 5.5). "Deep think" uses CLAUDE_DEEP_MODEL
// (default Opus 5.5) at higher effort and a larger output budget. Claude's web search / web fetch run
// on Anthropic's side; everything else (tasks, notes, memory, library, calendar, calculator) are our tools.
//
// Every request first goes out with all the new features. If the API refuses that exact shape (a
// feature not enabled on the account, a model name not available…) we remember it for a few minutes and
// retry in a plain, safe shape so Jarvis keeps answering instead of going silent.

import { addTask, setTaskDone, addNote, addMemory, deleteMemory, clean } from "./data.js";
import { calculate } from "./calc.js";
import { addDocument, searchLibrary } from "./library.js";
import { getCalendar } from "./calendar.js";
import { recordUsage, claudeEntries } from "./usage.js";

// ---------- photos ----------
// The browser downsizes camera photos before upload; this re-checks everything anyway because it is request
// input. Images go to Claude for this one turn only — they are never written to D1.
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_IMAGE_B64 = 6_000_000;      // ~4.5 MB decoded, under the API's 5 MB image limit

export function parseImage(img) {
  if (!img || typeof img !== "object") return null;
  const { media_type: type, data } = img;
  if (!IMAGE_TYPES.includes(type) || typeof data !== "string") return null;
  if (data.length < 100 || data.length > MAX_IMAGE_B64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
  return { media_type: type, data };
}

export function buildUserContent(text, image) {
  if (!image) return text;
  return [{ type: "image", source: { type: "base64", media_type: image.media_type, data: image.data } }, { type: "text", text }];
}

export const PHOTO_PROMPT =
  "Here is a photo. Tell me what it shows and pull out anything useful — text, names, numbers, dates, prices. Keep it brief.";

// ---------- models & request shape ----------
export const pickModel = (env, deep) => (deep ? env.CLAUDE_DEEP_MODEL || "claude-opus-5-5" : env.CLAUDE_MODEL || "claude-sonnet-5-5");

const BUDGET_MS = 85_000;             // Cloudflare drops browser connections after ~100 s, so stay well inside it
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
let degradedUntil = 0;                // per-instance memory of "the full request shape was refused"

export const HAIKU_SERVER_TOOLS = [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }];
export const SERVER_TOOLS = [
  { type: "web_search_20260209", name: "web_search", max_uses: 4 },
  { type: "web_fetch_20260209", name: "web_fetch", max_uses: 3 },
];

export const CLIENT_TOOLS = [
  { name: "add_task", description: "Add a to-do item for the owner. Use when they ask to be reminded of or to track something.",
    input_schema: { type: "object", properties: { text: { type: "string" }, due_date: { type: "string", description: "YYYY-MM-DD, optional" } }, required: ["text"] } },
  { name: "complete_task", description: "Mark a task done, by its id from the task list in the context.",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "add_note", description: "Save a note the owner wants to keep.",
    input_schema: { type: "object", properties: { title: { type: "string" }, body: { type: "string" } }, required: ["title"] } },
  { name: "remember", description: "Store a lasting fact about the owner (family, business, preferences, routines) so you know it in every future conversation. One short, self-contained sentence. Not for passing remarks, secrets like passwords or card numbers, or guesses.",
    input_schema: { type: "object", properties: { fact: { type: "string" } }, required: ["fact"] } },
  { name: "forget", description: "Delete a remembered fact, by its id from the memories list in the context. Use when the owner asks you to forget something or a memory is wrong.",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "search_library", description: "Search the owner's saved documents (contracts, manuals, receipts, notes of record). Returns the best-matching excerpts with the document title. Use whenever a question may be answered by something he has saved.",
    input_schema: { type: "object", properties: { query: { type: "string", description: "key words to look for" } }, required: ["query"] } },
  { name: "save_document", description: "Save text to the owner's library so it can be searched later (for example text transcribed from a photo). Only when he asks you to save it.",
    input_schema: { type: "object", properties: { title: { type: "string" }, text: { type: "string" } }, required: ["title", "text"] } },
  { name: "get_calendar", description: "Read the owner's calendar. days_back/days_ahead are counted from today (today is day 0), default 0 and 7.",
    input_schema: { type: "object", properties: { days_back: { type: "integer" }, days_ahead: { type: "integer" } } } },
  { name: "calculate", description: "Exact arithmetic: + - * / % ^, parentheses, sqrt, abs, round(x, places), floor, ceil, min, max, pow, log, ln, exp, sin/cos/tan, pi, e. Use it for any maths beyond the trivial instead of working it out yourself.",
    input_schema: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] } },
];

// Marks the tools + system prompt as cacheable: repeat chats within minutes read them at a tenth of the price.
const cachedSystem = (text) => [{ type: "text", text, cache_control: { type: "ephemeral" } }];

export function buildRequest({ model, system, messages, deep, search, full }) {
  if (!full) {
    return { body: { model, max_tokens: 1500, system: cachedSystem(system), tools: CLIENT_TOOLS, messages }, betas: [] };
  }
  if (/haiku/.test(model)) {          // Haiku 4.5 takes no effort setting or server-side fallbacks, and only the basic web search tool
    return { body: { model, max_tokens: deep ? 6000 : 2500, system: cachedSystem(system), tools: [...CLIENT_TOOLS, ...(search ? HAIKU_SERVER_TOOLS : [])], messages }, betas: [] };
  }
  const body = {
    model,
    max_tokens: deep ? 6000 : 2500,
    system: cachedSystem(system),
    tools: [...CLIENT_TOOLS, ...(search ? SERVER_TOOLS : [])],
    messages,
    output_config: { effort: deep ? "high" : "medium" },
    fallbacks: "default",
  };
  return { body, betas: [FALLBACK_BETA] };
}

// ---------- prompt ----------
export function buildSystemPrompt(tasks, notes, today, extra = {}) {
  const { memories = [], calendar = false, libraryDocs = 0, search = false, deep = false } = extra;
  const lines = [
    "You are J.A.R.V.I.S. (Just A Rather Very Intelligent System), Howard's personal AI assistant at howardjarvis.app. " +
      "Speak as a dry, composed British butler: address him as \"Sir\" and keep a touch of understated wit.",
    "",
    "How you work:",
    "- Be accurate before clever. If you are not sure, say so plainly. Never invent facts, figures, quotes, links, tasks, notes, memories or events.",
    search
      ? "- For anything that may have changed or that you cannot be certain of (news, prices, opening hours, sport, weather, software versions, \"latest\" anything, people in the news), use web_search first and answer from what you find, naming the source naturally. If he gives you a link, use web_fetch."
      : "- You cannot browse the web right now; if he needs live information, say so rather than guess.",
    "- For arithmetic beyond the trivial, call calculate instead of working it out in your head.",
    "- Match the length to the question. Casual chat: a sentence or two. Questions that deserve depth (explanations, comparisons, plans, analysis, how-to): a properly organised answer — short paragraphs, lists where they help, plain markdown, no tables.",
    "- Your reply is shown on screen and also spoken aloud. When your answer is longer than about 40 words, finish with one last line in exactly this form: `SPOKEN: <one or two natural sentences, under 40 words, summarising the answer for speaking aloud — no markdown, no links, no lists>`. Do not add that line to short answers.",
    "- Memory: when Howard tells you a lasting fact about himself, his family, business, preferences or routines, call remember (one short, self-contained sentence) without making a fuss. Don't remember passing remarks, passwords, card numbers or guesses. If he asks you to forget something, call forget with its id from the list below.",
    libraryDocs
      ? `- Library: he has ${libraryDocs} saved document${libraryDocs === 1 ? "" : "s"}. When a question may be answered by something he has saved (contracts, manuals, receipts, records), call search_library and say which document you used. Use save_document only when he asks you to save something.`
      : "- Library: he has no saved documents yet. If he asks you to save text (for instance from a photo), use save_document.",
    calendar
      ? "- Calendar: his calendar is connected. For anything about his schedule, appointments or availability, call get_calendar — never guess."
      : "- Calendar: none is connected. If he asks about his schedule, say he can add a calendar link in Settings.",
    "- Tasks and notes: confirm in plain words what you did. Never claim to have done something you didn't call a tool for.",
    "- Photos: read them carefully — transcribe the relevant text, identify what it is and report the key details (for a receipt, business card, label or document, the main fields). Say plainly if the image is unclear. Only save notes, tasks or library entries from a photo when he asks; otherwise offer.",
    "- Resolve relative dates (\"tomorrow\", \"Friday\") against today's date.",
  ];
  if (deep) lines.push("", "This is a deep-think request: reason carefully, check your work, and give a thorough, well-organised answer.");
  lines.push("", `Today is ${today} (YYYY-MM-DD, in his time zone). The exact local date and time arrive with each message — trust them over your own sense of the date.`);
  lines.push("", "Memories (what you know about Howard):", memories.length ? memories.map((m) => `- [${m.id}] ${m.text}`).join("\n") : "(none yet)");
  lines.push("", `Open tasks (JSON):\n${JSON.stringify(tasks)}`, "", `Recent notes (JSON):\n${JSON.stringify(notes.slice(0, 20))}`);
  return lines.join("\n");
}

// ---------- parsing the reply ----------
export function splitSpoken(text) {
  const t = String(text || "").trim();
  const i = t.lastIndexOf("SPOKEN:");
  if (i < 0 || (i > 0 && !/\n\s*$/.test(t.slice(0, i)))) return { answer: t, spoken: "" };
  return { answer: t.slice(0, i).trim(), spoken: t.slice(i + 7).trim().replace(/^`+|`+$/g, "").trim() };
}

export function extractSources(content, limit = 6) {
  const seen = new Map();
  const add = (url, title) => { if (typeof url === "string" && /^https?:\/\//.test(url) && !seen.has(url)) seen.set(url, { title: String(title || url).slice(0, 140), url }); };
  for (const b of content || []) {
    if (b.type === "text" && Array.isArray(b.citations)) for (const c of b.citations) add(c.url, c.title);
  }
  if (!seen.size) {                                   // nothing cited inline: fall back to the top search hits
    for (const b of content || []) if (b.type === "web_search_tool_result" && Array.isArray(b.content)) for (const r of b.content.slice(0, 3)) add(r.url, r.title);
  }
  return [...seen.values()].slice(0, limit);
}

// The API wants the first message to be from the user; a stored briefing can sit at the head of the history.
export function normalizeHistory(rows) {
  // Every chat re-sends this history, so keep it lean: drop the "Sources:" lists and cap very long messages.
  const out = rows.map((m) => {
    let c = String(m.content || "").replace(/\n\nSources:\n[\s\S]*$/, "");
    if (c.length > 1200) c = c.slice(0, 1200) + " …";
    return { role: m.role, content: c };
  });
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

// ---------- tools ----------
export async function runTool(env, name, input) {
  const i = input && typeof input === "object" ? input : {};
  switch (name) {
    case "add_task": return addTask(env, i);
    case "complete_task": return setTaskDone(env, clean(i.id, 100), true);
    case "add_note": return addNote(env, i);
    case "remember": return addMemory(env, i);
    case "forget": return deleteMemory(env, i.id);
    case "search_library": return searchLibrary(env, clean(i.query, 200));
    case "save_document": return addDocument(env, { title: i.title, text: i.text, source: "assistant" });
    case "get_calendar": return getCalendar(env, { daysBack: i.days_back, daysAhead: i.days_ahead ?? 7 });
    case "calculate": return calculate(i.expression);
    default: return { error: `unknown tool ${name}` };
  }
}
const TOOL_WRITES = new Set(["add_task", "complete_task", "add_note", "remember", "forget", "save_document"]);

// ---------- calling Claude ----------
class ApiError extends Error { constructor(status, text) { super(`Claude API ${status}: ${text.slice(0, 300)}`); this.status = status; } }

async function post(env, { body, betas }, timeoutMs) {
  const headers = { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" };
  if (betas.length) headers["anthropic-beta"] = betas.join(",");
  const base = (env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "");
  const res = await fetch(base + "/v1/messages", { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new ApiError(res.status, await res.text().catch(() => ""));
  return res.json();
}

async function callClaude(env, args, deadline) {
  const left = () => Math.max(1000, deadline - Date.now());
  const attempt = (full, model) => post(env, buildRequest({ ...args, model, full }), Math.min(left(), 80_000));
  const wanted = pickModel(env, args.deep);
  const retryable = (e) => e instanceof ApiError && (e.status === 429 || e.status >= 500);
  const tryOnce = async (full, model) => {
    try { return await attempt(full, model); }
    catch (e) { if (retryable(e) && left() > 8000) { await new Promise((r) => setTimeout(r, 1500)); return attempt(full, model); } throw e; }
  };

  if (Date.now() >= degradedUntil) {
    try { return { data: await tryOnce(true, wanted), degraded: false }; }
    catch (e) {
      if (!(e instanceof ApiError) || ![400, 404, 422].includes(e.status)) throw e;
      console.error("full request refused, retrying in plain mode:", e.message);
      degradedUntil = Date.now() + 10 * 60_000;
    }
  }
  return { data: await tryOnce(false, pickModel(env, false)), degraded: true };
}

// ---------- the conversation loop ----------
export async function runChat(env, { prompt, image, deep, history, ctx }) {
  const system = buildSystemPrompt(ctx.tasks, ctx.notes, ctx.today, { ...ctx.extra, deep });
  const messages = [...normalizeHistory(history), { role: "user", content: buildUserContent(prompt, image) }];
  const deadline = Date.now() + BUDGET_MS;
  let refresh = false, degraded = false, sources = [], final = null;
  const spent = [["chats", 1]];
  if (deep) spent.push(["deep_chats", 1]);

  for (let step = 0; step < 8; step++) {
    const r = await callClaude(env, { system, messages, deep, search: ctx.extra.search }, deadline);
    const data = r.data;
    degraded = degraded || r.degraded;
    spent.push(...claudeEntries(data.model || pickModel(env, deep && !r.degraded), data.usage));
    const content = data.content || [];
    for (const s of extractSources(content)) if (!sources.some((x) => x.url === s.url)) sources.push(s);

    if (data.stop_reason === "pause_turn") {          // a server tool (search/fetch) needs more time: send the turn back as it was
      messages.push({ role: "assistant", content });
      continue;
    }
    const uses = content.filter((b) => b.type === "tool_use");
    if (data.stop_reason === "tool_use" && uses.length) {
      messages.push({ role: "assistant", content });
      const results = [];
      for (const u of uses) {
        if (TOOL_WRITES.has(u.name)) refresh = true;
        let out;
        try { out = await runTool(env, u.name, u.input); } catch (err) { console.error("tool failed", u.name, err); out = { error: "that tool failed" }; }
        results.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(out) });
      }
      messages.push({ role: "user", content: results });
      continue;
    }
    final = data;
    break;
  }
  sources = sources.slice(0, 6);
  await recordUsage(env, spent);

  let text = final ? (final.content || []).filter((b) => b.type === "text").map((b) => b.text || "").join("").trim() : "";
  if (final && final.stop_reason === "refusal") text = "I'm afraid I can't help with that one, Sir.";
  else if (final && final.stop_reason === "max_tokens" && text) text += "\n\n(That was cut short — ask me to continue.)";
  if (!final) text = "That took more steps than I could finish in one go, Sir — try asking a little more narrowly.";
  if (!text) text = refresh ? "Done." : "I didn't get a response — try again.";

  const { answer, spoken } = splitSpoken(text);
  return { answer, spoken, sources, refresh, degraded, deep: !!deep };
}

// ---------- PDF → text (for the library) ----------
export function validPdfBase64(data) {
  return typeof data === "string" && data.length > 200 && data.length <= 6_000_000 && /^[A-Za-z0-9+/]+={0,2}$/.test(data);
}

export async function extractPdfText(env, data) {
  const body = {
    model: pickModel(env, false),
    max_tokens: 6000,
    messages: [{ role: "user", content: [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data } },
      { type: "text", text: "Transcribe all the text in this document faithfully, in reading order. Output plain text only — no commentary, no summary." },
    ] }],
  };
  const out = await post(env, { body, betas: [] }, BUDGET_MS);
  await recordUsage(env, claudeEntries(out.model || body.model, out.usage));
  return (out.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
}
