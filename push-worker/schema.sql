-- One row per browser/device that allowed notifications.
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  seen_at INTEGER NOT NULL
);
-- Upcoming rings. `ref` is an opaque id (task uuid / excel row key); no titles are stored.
CREATE TABLE IF NOT EXISTS reminders (
  device_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  fire_at INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'task',
  PRIMARY KEY (device_id, ref, fire_at)
);
CREATE INDEX IF NOT EXISTS reminders_due ON reminders (fire_at);
