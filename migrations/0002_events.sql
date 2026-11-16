-- The stream /stream pushes: every update Telegram delivered, verbatim, and every Bot API call the
-- bot made through this Worker. seq is the stream cursor (separate from messages.id).
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  recorded_at INTEGER NOT NULL,
  source TEXT NOT NULL,           -- 'telegram' | 'gateway'
  update_id INTEGER UNIQUE,       -- telegram: makes redelivery a no-op
  client TEXT,                    -- gateway: the calling client's self-declared name
  payload TEXT NOT NULL           -- telegram: the update; gateway: {method, params, result}
);
CREATE INDEX events_by_time ON events (recorded_at);

-- Backfill from what was stored before this table existed, in time order. The method of an
-- earlier send or edit wasn't stored, so those carry method null; deletes are rebuilt from
-- deleted_at. Both are marked backfilled.
INSERT INTO events (recorded_at, source, update_id, client, payload)
SELECT t, source, update_id, client, payload FROM (
  SELECT received_at AS t, 0 AS k, update_id AS o, 'telegram' AS source, update_id,
    NULL AS client, raw AS payload
  FROM updates
  UNION ALL
  SELECT recorded_at, 1, id, 'gateway', NULL, client,
    json_object('method', NULL, 'params', NULL, 'result', json(raw), 'backfilled', json('true'))
  FROM messages WHERE outgoing = 1
  UNION ALL
  SELECT deleted_at, 2, id, 'gateway', NULL, NULL,
    json_object('method', 'deleteMessage',
      'params', json_object('chat_id', chat_id, 'message_id', message_id),
      'result', json('true'), 'backfilled', json('true'))
  FROM messages WHERE deleted_at IS NOT NULL AND superseded = 0
) ORDER BY t, k, o;
