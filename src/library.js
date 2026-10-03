// The document library: text is split into ~1200-character chunks and indexed with SQLite FTS5
// (ranked keyword search with stemming), so Jarvis can answer from the owner's own documents.

export const MAX_DOC_CHARS = 300_000;
const CHUNK = 1200;

export function chunkText(text, size = CHUNK) {
  const paras = text.replace(/\r\n?/g, "\n").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let cur = "";
  const flush = () => { if (cur.trim()) chunks.push(cur.trim()); cur = ""; };
  for (const p of paras) {
    if (p.length > size) {                              // a very long paragraph: split on sentences, then hard-cut
      flush();
      let piece = "";
      for (const s of p.split(/(?<=[.!?])\s+/)) {
        if ((piece + " " + s).length > size && piece) { chunks.push(piece.trim()); piece = ""; }
        piece += (piece ? " " : "") + s;
        while (piece.length > size) { chunks.push(piece.slice(0, size)); piece = piece.slice(size); }
      }
      if (piece.trim()) chunks.push(piece.trim());
    } else if ((cur + "\n\n" + p).length > size) { flush(); cur = p; }
    else cur += (cur ? "\n\n" : "") + p;
  }
  flush();
  return chunks;
}

// Turn free text into a safe FTS5 query: every word quoted, OR-ed together (ranked by relevance).
export function ftsQuery(q) {
  const words = (String(q).toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || []).slice(0, 12);
  return words.map((w) => `"${w}"`).join(" OR ");
}

export async function addDocument(env, { title, text, source = "text" }) {
  title = String(title || "").trim().slice(0, 200) || "Untitled";
  text = String(text || "").trim();
  if (text.length < 20) return { error: "that document is too short to save" };
  if (text.length > MAX_DOC_CHARS) return { error: `too long — the limit is ${MAX_DOC_CHARS.toLocaleString()} characters` };
  const id = crypto.randomUUID().slice(0, 8);
  const chunks = chunkText(text);
  await env.DB.prepare("INSERT INTO documents (id, title, source, chars) VALUES (?, ?, ?, ?)").bind(id, title, source, text.length).run();
  for (let i = 0; i < chunks.length; i += 40) {
    await env.DB.batch(chunks.slice(i, i + 40).map((c) => env.DB.prepare("INSERT INTO doc_fts (text, doc_id, title) VALUES (?, ?, ?)").bind(c, id, title)));
  }
  return { ok: true, id, title, chunks: chunks.length, chars: text.length };
}

export async function searchLibrary(env, query, limit = 5) {
  const q = ftsQuery(query);
  if (!q) return { error: "give me some words to search for" };
  const { results } = await env.DB.prepare(
    "SELECT doc_id, title, text FROM doc_fts WHERE doc_fts MATCH ? ORDER BY rank LIMIT ?"
  ).bind(q, limit).all();
  return { results: results.map((r) => ({ document_id: r.doc_id, title: r.title, excerpt: r.text.length > 900 ? r.text.slice(0, 900) + "…" : r.text })) };
}

export async function listDocuments(env) {
  const { results } = await env.DB.prepare("SELECT id, title, source, chars, created_at FROM documents ORDER BY created_at DESC LIMIT 200").all();
  return results;
}

export async function libraryCount(env) {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM documents").first();
  return r ? r.n : 0;
}

export async function deleteDocument(env, id) {
  const res = await env.DB.prepare("DELETE FROM documents WHERE id = ?").bind(id).run();
  if (!res.meta.changes) return { error: "no such document" };
  await env.DB.prepare("DELETE FROM doc_fts WHERE doc_id = ?").bind(id).run();
  return { ok: true };
}
