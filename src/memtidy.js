// "Tidy memory": Claude proposes merging duplicates, correcting stale facts and dropping trivia. Nothing changes until
// the owner approves the proposal; applying re-checks every id against the database.

import { askClaude } from "./brain.js";
import { listMemories, clean } from "./data.js";

const SYSTEM =
  "You tidy the long-term memory of a personal assistant. You receive a JSON list of short facts about its owner, each with an id and a creation date. " +
  "Propose only clear improvements: (1) merge entries that say the same thing or overlap into one better sentence, (2) fix an entry that a NEWER entry contradicts, " +
  "(3) delete entries that are trivia or one-off events with no lasting value. Be conservative — when unsure, leave an entry alone. Never invent facts and never drop information that is not duplicated elsewhere. " +
  'Reply with ONLY a JSON object: {"merge":[{"ids":["id1","id2"],"text":"merged fact"}],"update":[{"id":"id","text":"corrected fact"}],"delete":[{"id":"id","reason":"short reason"}]} — empty arrays if nothing needs doing. Each id may appear at most once in total.';

// Validates a proposal against the real memories and returns only the sound parts, with the old text attached for display.
export function sanitizeProposal(raw, memories) {
  const byId = new Map(memories.map((m) => [m.id, m]));
  const used = new Set();
  const take = (id) => (typeof id === "string" && byId.has(id) && !used.has(id) ? (used.add(id), true) : false);
  const out = { merge: [], update: [], delete: [] };
  const arr = (v) => (Array.isArray(v) ? v.slice(0, 100) : []);
  for (const m of arr(raw && raw.merge)) {
    const text = clean(m && m.text, 500);
    const ids = arr(m && m.ids).filter((id) => typeof id === "string" && byId.has(id) && !used.has(id));
    if (text && ids.length >= 2) { ids.forEach(take); out.merge.push({ ids, text, was: ids.map((id) => byId.get(id).text) }); }
  }
  for (const u of arr(raw && raw.update)) {
    const text = clean(u && u.text, 500);
    if (text && take(u && u.id)) out.update.push({ id: u.id, text, was: byId.get(u.id).text });
  }
  for (const d of arr(raw && raw.delete)) if (take(d && d.id)) out.delete.push({ id: d.id, reason: clean(d.reason, 200), was: byId.get(d.id).text });
  return out;
}

export async function proposeTidy(env) {
  const memories = await listMemories(env, 500);
  if (memories.length < 4) return { proposal: { merge: [], update: [], delete: [] }, note: "There's too little in memory to tidy yet, Sir." };
  const reply = await askClaude(env, {
    system: SYSTEM,
    user: JSON.stringify(memories.slice().reverse().map((m) => ({ id: m.id, text: m.text, created: String(m.created_at).slice(0, 10) }))),
    maxTokens: 3000,
  });
  const start = reply.indexOf("{"), end = reply.lastIndexOf("}");
  let raw = null;
  try { raw = JSON.parse(reply.slice(start, end + 1)); } catch { /* fall through */ }
  if (!raw) return { error: "I couldn't make sense of the suggestion — try again." };
  return { proposal: sanitizeProposal(raw, memories) };
}

export async function applyTidy(env, proposal) {
  const memories = await listMemories(env, 500);
  const p = sanitizeProposal(proposal, memories);            // re-validate: ids must still exist, no overlaps
  const stmts = [];
  for (const m of p.merge) {
    stmts.push(env.DB.prepare("INSERT INTO memories (id, text) VALUES (?, ?)").bind(crypto.randomUUID().slice(0, 8), m.text));
    for (const id of m.ids) stmts.push(env.DB.prepare("DELETE FROM memories WHERE id = ?").bind(id));
  }
  for (const u of p.update) stmts.push(env.DB.prepare("UPDATE memories SET text = ? WHERE id = ?").bind(u.text, u.id));
  for (const d of p.delete) stmts.push(env.DB.prepare("DELETE FROM memories WHERE id = ?").bind(d.id));
  if (stmts.length) await env.DB.batch(stmts);
  return { ok: true, merged: p.merge.length, updated: p.update.length, deleted: p.delete.length };
}
