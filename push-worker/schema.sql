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
-- Scan to set up: encrypted hand-overs between two of your devices (unreadable here; 10 min, one read).
CREATE TABLE IF NOT EXISTS pairs (
  id TEXT PRIMARY KEY,
  blob TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
-- "Show Nexus in your calendar apps": opt-in iCal feeds. id = SHA-256 of the secret address;
-- key_hash = SHA-256 of the write key held by the user's devices.
CREATE TABLE IF NOT EXISTS feeds (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL,
  ics TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
