// howardjarvis.app — a personal assistant for one owner. Single password
// (env.JARVIS_PASSWORD) -> HMAC-signed session cookie (env.SESSION_SECRET), so
// no session table is needed. Data lives in D1: tasks, notes, chat history.
// Static UI is served from public/ via the ASSETS binding; only /api/* hits this.

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

// ---------- tasks / notes ----------

const validDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const clean = (s, n) => (typeof s === "string" ? s.trim().slice(0, n) : "");

async function listTasks(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, text, due_date, done_at FROM tasks WHERE done_at IS NULL OR done_at > datetime('now', '-1 day') " +
      "ORDER BY done_at IS NOT NULL, due_date IS NULL, due_date, created_at"
  ).all();
  return results;
}

async function addTask(env, { text, due_date }) {
  text = clean(text, 500);
  if (!text) return { error: "text is required" };
  if (due_date != null && due_date !== "" && !validDate(due_date)) return { error: "due_date must be YYYY-MM-DD" };
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO tasks (id, text, due_date) VALUES (?, ?, ?)").bind(id, text, due_date || null).run();
  return { id, text, due_date: due_date || null };
}

async function setTaskDone(env, id, done) {
  const res = await env.DB.prepare("UPDATE tasks SET done_at = " + (done ? "datetime('now')" : "NULL") + " WHERE id = ?")
    .bind(id)
    .run();
  return res.meta.changes ? { ok: true } : { error: "task not found" };
}

async function listNotes(env) {
  const { results } = await env.DB.prepare("SELECT id, title, body, created_at FROM notes ORDER BY created_at DESC LIMIT 100").all();
  return results;
}

async function addNote(env, { title, body }) {
  title = clean(title, 200);
  if (!title) return { error: "title is required" };
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO notes (id, title, body) VALUES (?, ?, ?)").bind(id, title, clean(body, 10_000)).run();
  return { id, title };
}

// ---------- chat ----------

const TOOLS = [
  {
    name: "add_task",
    description: "Add a to-do item for the owner. Use when they ask to be reminded of or to track something.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string" },
        due_date: { type: "string", description: "YYYY-MM-DD, optional" },
      },
      required: ["text"],
    },
  },
  {
    name: "complete_task",
    description: "Mark a task done, by its id from the task list in the context.",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "add_note",
    description: "Save a note the owner wants to remember.",
    input_schema: {
      type: "object",
      properties: { title: { type: "string" }, body: { type: "string" } },
      required: ["title"],
    },
  },
];

async function runTool(env, name, input) {
  if (name === "add_task") return addTask(env, input || {});
  if (name === "complete_task") return setTaskDone(env, clean(input?.id, 100), true);
  if (name === "add_note") return addNote(env, input || {});
  return { error: `unknown tool ${name}` };
}

// ---------- photos ----------
// The browser downsizes camera photos before upload; this re-checks everything
// anyway because it is request input. Images go to Claude for this one turn only —
// they are never written to D1 (history stores a text marker, not the picture).
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

const PHOTO_PROMPT =
  "Here is a photo. Tell me what it shows and pull out anything useful — text, names, numbers, dates, prices. Keep it brief.";

export function buildSystemPrompt(tasks, notes, today) {
  return (
    "You are J.A.R.V.I.S. (Just A Rather Very Intelligent System), Howard's personal AI assistant at howardjarvis.app. " +
    "Speak as a dry, composed British butler: address him as \"Sir\", keep a touch of understated wit, and stay brief — a sentence or two " +
    "unless detail is asked for. You can add tasks, complete tasks and save notes with your tools; when you do, " +
    "confirm in plain words what you did. Never claim you did something you didn't call a tool for, and never invent " +
    "tasks or notes that aren't in the data below. When Howard sends a photo, read it carefully: transcribe the relevant text, " +
    "identify what it is, and report the key details (for a receipt, business card, label or document, the main fields). Say " +
    "plainly if the image is unclear — never guess at what you can't see. Only save notes or tasks from a photo when he asks; " +
    "otherwise offer. Resolve relative dates (\"tomorrow\", \"Friday\") against today's date.\n\n" +
    `Today is ${today}.\n\nOpen tasks (JSON):\n${JSON.stringify(tasks)}\n\nRecent notes (JSON):\n${JSON.stringify(notes.slice(0, 20))}`
  );
}

async function callClaude(env, system, messages) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({ model: env.CLAUDE_MODEL || "claude-sonnet-5-5", max_tokens: 800, system, tools: TOOLS, messages }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
  return res.json();
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

  const { results: past } = await env.DB.prepare("SELECT role, content FROM messages ORDER BY id DESC LIMIT 20").all();
  const messages = [...past.reverse().map((m) => ({ role: m.role, content: m.content })), { role: "user", content: buildUserContent(text || PHOTO_PROMPT, image) }];
  const today = new Date().toISOString().slice(0, 10);
  let toolsUsed = false;

  try {
    const system = buildSystemPrompt((await listTasks(env)).filter((t) => !t.done_at), await listNotes(env), today);
    let answer = "";
    for (let step = 0; step < 5; step++) {
      const data = await callClaude(env, system, messages);
      const uses = (data.content || []).filter((b) => b.type === "tool_use");
      answer = (data.content || []).map((b) => b.text || "").join("").trim();
      if (data.stop_reason !== "tool_use" || !uses.length) break;
      toolsUsed = true;
      messages.push({ role: "assistant", content: data.content });
      const resultBlocks = [];
      for (const u of uses) {
        resultBlocks.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(await runTool(env, u.name, u.input)) });
      }
      messages.push({ role: "user", content: resultBlocks });
    }
    if (!answer) answer = toolsUsed ? "Done." : "I didn't get a response — try again.";
    await env.DB.batch([
      env.DB.prepare("INSERT INTO messages (role, content) VALUES ('user', ?)").bind(image ? `📷 [photo] ${text}`.trim() : text),
      env.DB.prepare("INSERT INTO messages (role, content) VALUES ('assistant', ?)").bind(answer),
    ]);
    return json({ answer, refresh: toolsUsed });
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
  return json({ error: "not found" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname === "www.howardjarvis.app") {
      return Response.redirect(`https://howardjarvis.app${url.pathname}${url.search}`, 301);
    }
    if (url.pathname.startsWith("/api/")) return withSecurityHeaders(await handleApi(request, env, url));
    return withSecurityHeaders(await env.ASSETS.fetch(request));
  },
};
