// Backups: a single JSON file with everything worth keeping (tasks, notes, memories, library documents, conversation
// history, preferences). Download it by hand, restore it later, and — if the BACKUPS R2 bucket is bound — a snapshot is
// saved automatically every week and before any destructive restore. Secrets (VAPID push key, calendar link) are left
// out unless asked for. D1 also keeps 30 days of point-in-time history on Cloudflare's side; this is the copy you hold.

export const BACKUP_VERSION = 1;
const SETTING_KEYS = ["briefing_enabled", "briefing_time", "reminder_enabled", "reminder_time", "timezone", "web_search", "monthly_budget", "model_mode"];
const SECRET_SETTING_KEYS = ["ics_url"];
const LIMITS = { tasks: 20000, notes: 20000, memories: 2000, documents: 2000, messages: 20000, docChars: 300000 };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isStr = (v, max) => typeof v === "string" && v.length <= max;
const isId = (v) => typeof v === "string" && /^[\w-]{1,64}$/.test(v);

export async function exportBackup(env, { secrets = false } = {}) {
  const all = async (sql) => (await env.DB.prepare(sql).all()).results;
  const [tasks, notes, memories, documents, chunks, messages, settingRows, reminders, lists] = await Promise.all([
    all("SELECT id, text, due_date, created_at, done_at FROM tasks ORDER BY created_at"),
    all("SELECT id, title, body, created_at FROM notes ORDER BY created_at"),
    all("SELECT id, text, created_at FROM memories ORDER BY created_at"),
    all("SELECT id, title, source, chars, created_at FROM documents ORDER BY created_at"),
    all("SELECT doc_id, text FROM doc_fts ORDER BY rowid"),
    all("SELECT role, content, created_at FROM messages ORDER BY id"),
    all("SELECT key, value FROM settings"),
    all("SELECT id, text, due_at, repeat, created_at FROM reminders WHERE fired_at IS NULL ORDER BY due_at"),
    all("SELECT id, list, text, done_at, created_at FROM list_items ORDER BY created_at"),
  ]);
  const text = {};
  for (const c of chunks) (text[c.doc_id] ||= []).push(c.text);
  const keep = new Set([...SETTING_KEYS, ...(secrets ? SECRET_SETTING_KEYS : [])]);
  return {
    app: "howardjarvis", version: BACKUP_VERSION, exported_at: new Date().toISOString(), includes_secrets: !!secrets,
    tasks, notes, memories, reminders, lists,
    documents: documents.map((d) => ({ ...d, text: (text[d.id] || []).join("\n\n") })),
    messages,
    settings: Object.fromEntries(settingRows.filter((r) => keep.has(r.key)).map((r) => [r.key, r.value])),
  };
}

// Everything is checked BEFORE anything is changed.
export function validateBackup(b) {
  if (!b || typeof b !== "object") return "that isn't a Jarvis backup file";
  if (b.app !== "howardjarvis") return "that isn't a Jarvis backup file";
  if (b.version !== BACKUP_VERSION) return `unsupported backup version (${b.version})`;
  for (const k of ["tasks", "notes", "memories", "documents", "messages"]) {
    if (!Array.isArray(b[k])) return `the backup is missing its ${k}`;
    if (b[k].length > LIMITS[k]) return `too many ${k} in the backup`;
  }
  for (const t of b.tasks) {
    if (!isId(t.id) || !isStr(t.text, 2000) || !t.text) return "a task in the backup is malformed";
    if (t.due_date != null && !(typeof t.due_date === "string" && DATE.test(t.due_date))) return "a task has a bad date";
    if (t.done_at != null && !isStr(t.done_at, 40)) return "a task has a bad completion time";
  }
  for (const n of b.notes) if (!isId(n.id) || !isStr(n.title, 400) || !n.title || !isStr(n.body ?? "", 20000)) return "a note in the backup is malformed";
  for (const m of b.memories) if (!isId(m.id) || !isStr(m.text, 1000) || !m.text) return "a memory in the backup is malformed";
  for (const d of b.documents) if (!isId(d.id) || !isStr(d.title, 400) || !isStr(d.text, LIMITS.docChars)) return "a document in the backup is malformed";
  for (const m of b.messages) if (!["user", "assistant"].includes(m.role) || !isStr(m.content, 50000)) return "a message in the backup is malformed";
  for (const k of ["reminders", "lists"]) if (b[k] != null && (!Array.isArray(b[k]) || b[k].length > 5000)) return `the backup's ${k} are malformed`;
  for (const r of b.reminders || []) if (!isId(r.id) || !isStr(r.text, 600) || !r.text || !isStr(r.due_at, 40) || Number.isNaN(Date.parse(r.due_at)) || !["", "daily", "weekdays", "weekly", "monthly"].includes(r.repeat ?? "")) return "a reminder in the backup is malformed";
  for (const i of b.lists || []) if (!isId(i.id) || !isStr(i.list, 80) || !i.list || !isStr(i.text, 400) || !i.text) return "a list item in the backup is malformed";
  if (b.settings != null && (typeof b.settings !== "object" || Array.isArray(b.settings))) return "the backup's settings are malformed";
  return null;
}

const chunked = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const run = async (env, stmts) => { for (const part of chunked(stmts, 40)) await env.DB.batch(part); };

// mode "merge": add what's missing, change nothing else.  mode "replace": make the data match the backup exactly.
export async function restoreBackup(env, b, mode) {
  const bad = validateBackup(b);
  if (bad) return { error: bad };
  if (!["merge", "replace"].includes(mode)) return { error: "mode must be merge or replace" };
  const db = env.DB, counts = { tasks: 0, notes: 0, memories: 0, documents: 0, messages: 0, settings: 0, reminders: 0, lists: 0 };
  const { chunkText } = await import("./library.js");

  if (mode === "replace") {
    await run(env, ["tasks", "notes", "memories", "documents", "doc_fts", "messages", "reminders", "list_items"].map((t) => db.prepare(`DELETE FROM ${t}`)));
  }
  const ignore = mode === "merge" ? "OR IGNORE" : "OR REPLACE";
  await run(env, b.tasks.map((t) => db.prepare(`INSERT ${ignore} INTO tasks (id, text, due_date, created_at, done_at) VALUES (?, ?, ?, COALESCE(?, datetime('now')), ?)`).bind(t.id, t.text, t.due_date ?? null, t.created_at ?? null, t.done_at ?? null)));
  counts.tasks = b.tasks.length;
  await run(env, b.notes.map((n) => db.prepare(`INSERT ${ignore} INTO notes (id, title, body, created_at) VALUES (?, ?, ?, COALESCE(?, datetime('now')))`).bind(n.id, n.title, n.body ?? "", n.created_at ?? null)));
  counts.notes = b.notes.length;
  await run(env, b.memories.map((m) => db.prepare(`INSERT ${ignore} INTO memories (id, text, created_at) VALUES (?, ?, COALESCE(?, datetime('now')))`).bind(m.id, m.text, m.created_at ?? null)));
  counts.memories = b.memories.length;

  await run(env, (b.reminders || []).map((r) => db.prepare(`INSERT ${ignore} INTO reminders (id, text, due_at, repeat, created_at) VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')))`).bind(r.id, r.text, r.due_at, r.repeat || "", r.created_at ?? null)));
  counts.reminders = (b.reminders || []).length;
  await run(env, (b.lists || []).map((i) => db.prepare(`INSERT ${ignore} INTO list_items (id, list, text, done_at, created_at) VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')))`).bind(i.id, i.list, i.text, i.done_at ?? null, i.created_at ?? null)));
  counts.lists = (b.lists || []).length;

  for (const d of b.documents) {
    if (mode === "merge") { const have = await db.prepare("SELECT id FROM documents WHERE id = ?").bind(d.id).first(); if (have) continue; }
    const chunks = chunkText(d.text);
    await run(env, [
      db.prepare("DELETE FROM doc_fts WHERE doc_id = ?").bind(d.id),
      db.prepare("INSERT OR REPLACE INTO documents (id, title, source, chars, created_at) VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')))").bind(d.id, d.title, d.source || "restore", d.text.length, d.created_at ?? null),
      ...chunks.map((c) => db.prepare("INSERT INTO doc_fts (text, doc_id, title) VALUES (?, ?, ?)").bind(c, d.id, d.title)),
    ]);
    counts.documents++;
  }
  if (mode === "replace") {                                   // history is only restored when replacing (merging would duplicate it)
    await run(env, b.messages.map((m) => db.prepare("INSERT INTO messages (role, content, created_at) VALUES (?, ?, COALESCE(?, datetime('now')))").bind(m.role, m.content, m.created_at ?? null)));
    counts.messages = b.messages.length;
  }
  const allowed = new Set([...SETTING_KEYS, ...SECRET_SETTING_KEYS]);
  const sets = Object.entries(b.settings || {}).filter(([k, v]) => allowed.has(k) && typeof v === "string" && v.length < 2000);
  await run(env, sets.map(([k, v]) => db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(k, v)));
  counts.settings = sets.length;
  return { ok: true, mode, counts };
}

// ---------- automatic snapshots (R2) ----------
export const hasSnapshots = (env) => !!env.BACKUPS;

export async function snapshot(env, label = "") {
  if (!env.BACKUPS) return { error: "no backup storage is connected" };
  const data = await exportBackup(env, { secrets: false });
  const key = `snapshots/${new Date().toISOString().replace(/[:.]/g, "-")}${label ? "-" + label : ""}.json`;
  await env.BACKUPS.put(key, JSON.stringify(data), { httpMetadata: { contentType: "application/json" } });
  await pruneSnapshots(env, 12);
  return { ok: true, key };
}

export async function listSnapshots(env) {
  if (!env.BACKUPS) return [];
  const out = await env.BACKUPS.list({ prefix: "snapshots/" });
  return out.objects.map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded })).sort((a, b) => String(b.key).localeCompare(String(a.key)));
}

export async function pruneSnapshots(env, keep) {
  const all = await listSnapshots(env);
  for (const o of all.slice(keep)) await env.BACKUPS.delete(o.key);
}

export async function getSnapshot(env, key) {
  if (!env.BACKUPS || !/^snapshots\/[\w.:-]+\.json$/.test(key)) return null;
  const obj = await env.BACKUPS.get(key);
  return obj ? await obj.json() : null;
}
