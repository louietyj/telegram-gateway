-- Every update Telegram delivered, verbatim. update_id makes redelivery a no-op.
CREATE TABLE updates (
  update_id INTEGER PRIMARY KEY,
  received_at INTEGER NOT NULL,
  source TEXT NOT NULL,           -- 'webhook' | 'backfill'
  raw TEXT NOT NULL
);

CREATE TABLE chats (
  chat_id INTEGER PRIMARY KEY,
  type TEXT,
  title TEXT,
  username TEXT,
  migrated_to INTEGER,            -- a basic group's new supergroup id
  bot_status TEXT,                -- from my_chat_member: member, left, kicked, administrator
  updated_at INTEGER NOT NULL
);

-- One row per message version, both directions. id is the read cursor (seq): an edit is a
-- new row with version + 1, and older versions get superseded = 1.
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  superseded INTEGER NOT NULL DEFAULT 0,
  date INTEGER NOT NULL,
  edit_date INTEGER,
  deleted_at INTEGER,
  from_id INTEGER,
  from_name TEXT,
  from_username TEXT,
  is_bot INTEGER NOT NULL DEFAULT 0,
  outgoing INTEGER NOT NULL DEFAULT 0,  -- sent through this Worker
  client TEXT,                          -- the sending client's self-declared name
  thread_id INTEGER,
  reply_to_message_id INTEGER,
  kind TEXT NOT NULL,
  text TEXT,
  media TEXT,                           -- JSON array of file descriptors
  update_id INTEGER UNIQUE,
  recorded_at INTEGER NOT NULL,
  raw TEXT NOT NULL,
  UNIQUE (chat_id, message_id, version)
);
CREATE INDEX messages_by_chat ON messages (chat_id, message_id);
CREATE INDEX messages_by_reply ON messages (chat_id, reply_to_message_id);

CREATE VIRTUAL TABLE messages_fts USING fts5 (
  text, from_name, content = 'messages', content_rowid = 'id'
);
CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts (rowid, text, from_name) VALUES (new.id, new.text, new.from_name);
END;
