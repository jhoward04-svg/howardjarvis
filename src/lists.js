// Simple lists — shopping is the default — that Jarvis edits by voice and you tick off on screen.

import { clean } from "./data.js";

export const listName = (s) => clean(typeof s === "string" ? s : "", 40).toLowerCase().replace(/\s+/g, " ") || "shopping";
const MAX_ITEMS = 500;

export async function addItems(env, { list, items }) {
  const name = listName(list);
  const wanted = (Array.isArray(items) ? items : [items]).map((x) => clean(typeof x === "string" ? x : "", 200)).filter(Boolean).slice(0, 50);
  if (!wanted.length) return { error: "items are required" };
  const have = new Set((await env.DB.prepare("SELECT lower(text) AS t FROM list_items WHERE list = ? AND done_at IS NULL").bind(name).all()).results.map((r) => r.t));
  const count = (await env.DB.prepare("SELECT COUNT(*) AS n FROM list_items").first()).n;
  const added = [], skipped = [];
  for (const text of wanted) {
    if (have.has(text.toLowerCase())) { skipped.push(text); continue; }
    if (count + added.length >= MAX_ITEMS) return { error: "the lists are full — clear some ticked items first", added, skipped };
    await env.DB.prepare("INSERT INTO list_items (id, list, text) VALUES (?, ?, ?)").bind(crypto.randomUUID().slice(0, 8), name, text).run();
    have.add(text.toLowerCase()); added.push(text);
  }
  return { ok: true, list: name, added, already_on_list: skipped };
}

// { lists: { shopping: [{id,text,done_at}], ... } } — only `list` if given.
export async function getLists(env, list) {
  const q = list
    ? env.DB.prepare("SELECT id, list, text, done_at FROM list_items WHERE list = ? ORDER BY done_at IS NOT NULL, created_at").bind(listName(list))
    : env.DB.prepare("SELECT id, list, text, done_at FROM list_items ORDER BY list, done_at IS NOT NULL, created_at");
  const lists = {};
  for (const r of (await q.all()).results) (lists[r.list] ||= []).push({ id: r.id, text: r.text, done_at: r.done_at });
  return { lists };
}

// Tick off (or remove) items by their words. Exact match first, then "contains".
export async function checkOff(env, { list, items, remove }) {
  const name = listName(list);
  const rows = (await env.DB.prepare("SELECT id, text FROM list_items WHERE list = ? AND done_at IS NULL").bind(name).all()).results;
  const out = { ok: true, list: name, [remove ? "removed" : "ticked_off"]: [], not_found: [] };
  for (const w of (Array.isArray(items) ? items : [items]).map((x) => clean(typeof x === "string" ? x : "", 200).toLowerCase()).filter(Boolean)) {
    const hit = rows.find((r) => r.text.toLowerCase() === w) || rows.find((r) => r.text.toLowerCase().includes(w) || w.includes(r.text.toLowerCase()));
    if (!hit) { out.not_found.push(w); continue; }
    rows.splice(rows.indexOf(hit), 1);
    if (remove) await env.DB.prepare("DELETE FROM list_items WHERE id = ?").bind(hit.id).run();
    else await env.DB.prepare("UPDATE list_items SET done_at = datetime('now') WHERE id = ?").bind(hit.id).run();
    out[remove ? "removed" : "ticked_off"].push(hit.text);
  }
  return out;
}

export async function setItemDone(env, id, done) {
  const r = await env.DB.prepare("UPDATE list_items SET done_at = " + (done ? "datetime('now')" : "NULL") + " WHERE id = ?").bind(clean(id, 40)).run();
  return r.meta.changes ? { ok: true } : { error: "no such item" };
}
export async function deleteItem(env, id) {
  const r = await env.DB.prepare("DELETE FROM list_items WHERE id = ?").bind(clean(id, 40)).run();
  return r.meta.changes ? { ok: true } : { error: "no such item" };
}
export async function clearDone(env, list) {
  const r = list
    ? await env.DB.prepare("DELETE FROM list_items WHERE done_at IS NOT NULL AND list = ?").bind(listName(list)).run()
    : await env.DB.prepare("DELETE FROM list_items WHERE done_at IS NOT NULL").run();
  return { ok: true, removed: r.meta.changes || 0 };
}
