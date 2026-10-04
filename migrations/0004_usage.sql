-- Spending dashboard: one counter per (UTC day, metric). Metrics look like
--   in:<model>, out:<model>   Claude tokens          search, fetch   web searches / fetches
--   tts_chars                 OpenAI speech chars     stt_secs, stt_calls   OpenAI listening
--   chats, deep_chats         number of questions
CREATE TABLE usage (
  day TEXT NOT NULL,
  metric TEXT NOT NULL,
  value REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (day, metric)
);
