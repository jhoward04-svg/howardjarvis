-- Timed reminders (pushed at the due time, optionally repeating) and simple lists (shopping etc.).
CREATE TABLE reminders (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  due_at TEXT NOT NULL,                       -- UTC, ISO 8601 ("2026-10-06T19:00:00.000Z")
  repeat TEXT NOT NULL DEFAULT '',            -- '', daily, weekdays, weekly, monthly
  fired_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX reminders_due ON reminders (fired_at, due_at);

CREATE TABLE list_items (
  id TEXT PRIMARY KEY,
  list TEXT NOT NULL DEFAULT 'shopping',
  text TEXT NOT NULL,
  done_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX list_items_list ON list_items (list, done_at);
