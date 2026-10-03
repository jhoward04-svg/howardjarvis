-- Personal Jarvis: tasks, notes, and chat history for a single owner.
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  due_date TEXT,            -- YYYY-MM-DD, optional
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  done_at TEXT
);
CREATE INDEX idx_tasks_open ON tasks(due_date) WHERE done_at IS NULL;

CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Login throttling (single global row, same idea as the shop's admin gate).
CREATE TABLE login_attempts (
  id TEXT PRIMARY KEY DEFAULT 'default',
  failed INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT
);
INSERT INTO login_attempts (id) VALUES ('default');
