-- Long-term memory, document library (full-text searchable), and calendar settings live in `settings`.
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'text',
  chars INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per ~1200-character chunk. FTS5 gives ranked keyword search with stemming.
CREATE VIRTUAL TABLE doc_fts USING fts5(text, doc_id UNINDEXED, title UNINDEXED, tokenize = 'porter unicode61');
