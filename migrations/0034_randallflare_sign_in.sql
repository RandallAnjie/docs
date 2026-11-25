PRAGMA foreign_keys = ON;

-- Rdocs signs people in with their RandallFlare account only: the edge
-- gateway verifies the visitor and states them in RF-User-* headers.
-- external_id is that RandallFlare account id (or email:<address> for an
-- email-code visitor on the app's member list).
ALTER TABLE users ADD COLUMN external_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_external_id
  ON users(external_id) WHERE external_id IS NOT NULL;

-- Rdocs no longer keeps device passkeys, WebAuthn challenges or its own
-- session cookies.
DROP TABLE IF EXISTS auth_challenges;
DROP TABLE IF EXISTS passkey_credentials;
DROP TABLE IF EXISTS sessions;
