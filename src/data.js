// Plain data helpers shared by the HTTP API and the assistant's tools.

export const validDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
export const clean = (s, n) => (typeof s === "string" ? s.trim().slice(0, n) : "");

export async function listTasks(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, text, due_date, done_at FROM tasks WHERE done_at IS NULL OR done_at > datetime('now', '-1 day') " +
      "ORDER BY done_at IS NOT NULL, due_date IS NULL, due_date, created_at"
  ).all();
  return results;
}

export async function addTask(env, { text, due_date }) {
  text = clean(text, 500);
  if (!text) return { error: "text is required" };
  if (due_date != null && due_date !== "" && !validDate(due_date)) return { error: "due_date must be YYYY-MM-DD" };
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO tasks (id, text, due_date) VALUES (?, ?, ?)").bind(id, text, due_date || null).run();
  return { id, text, due_date: due_date || null };
}

export async function setTaskDone(env, id, done) {
  const res = await env.DB.prepare("UPDATE tasks SET done_at = " + (done ? "datetime('now')" : "NULL") + " WHERE id = ?")
    .bind(id)
    .run();
  return res.meta.changes ? { ok: true } : { error: "task not found" };
}

export async function listNotes(env) {
  const { results } = await env.DB.prepare("SELECT id, title, body, created_at FROM notes ORDER BY created_at DESC LIMIT 100").all();
  return results;
}

export async function addNote(env, { title, body }) {
  title = clean(title, 200);
  if (!title) return { error: "title is required" };
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO notes (id, title, body) VALUES (?, ?, ?)").bind(id, title, clean(body, 10_000)).run();
  return { id, title };
}

// ---------- long-term memory: short facts Jarvis keeps about the owner ----------
const MAX_MEMORIES = 500;

export async function listMemories(env, limit = 100) {
  const { results } = await env.DB.prepare("SELECT id, text, created_at FROM memories ORDER BY created_at DESC, rowid DESC LIMIT ?").bind(limit).all();
  return results;
}

export async function addMemory(env, { fact }) {
  const text = clean(fact, 500);
  if (!text) return { error: "fact is required" };
  const dup = await env.DB.prepare("SELECT id FROM memories WHERE lower(text) = lower(?)").bind(text).first();
  if (dup) return { ok: true, id: dup.id, note: "already remembered" };
  const { results } = await env.DB.prepare("SELECT COUNT(*) AS n FROM memories").all();
  if (results[0].n >= MAX_MEMORIES) return { error: "memory is full — ask Howard which memories to forget" };
  const id = crypto.randomUUID().slice(0, 8);
  await env.DB.prepare("INSERT INTO memories (id, text) VALUES (?, ?)").bind(id, text).run();
  return { ok: true, id, text };
}

export async function deleteMemory(env, id) {
  const res = await env.DB.prepare("DELETE FROM memories WHERE id = ?").bind(clean(id, 40)).run();
  return res.meta.changes ? { ok: true } : { error: "no such memory" };
}
