PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS passkey_credentials (
  credential_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0 CHECK (counter >= 0),
  transports_json TEXT NOT NULL DEFAULT '[]',
  device_type TEXT NOT NULL CHECK (device_type IN ('singleDevice', 'multiDevice')),
  backed_up INTEGER NOT NULL DEFAULT 0 CHECK (backed_up IN (0, 1)),
  aaguid TEXT,
  label TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_passkey_credentials_user
  ON passkey_credentials(user_id, created_at);

CREATE TABLE IF NOT EXISTS auth_challenges (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('registration', 'authentication')),
  challenge TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  pending_user_id TEXT,
  pending_email TEXT,
  pending_display_name TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_auth_challenges_expiry
  ON auth_challenges(expires_at, consumed_at);

ALTER TABLE revision_restore_operations
  ADD COLUMN actor_id TEXT REFERENCES users(id);
