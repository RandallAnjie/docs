PRAGMA foreign_keys = ON;

-- One Notion internal-integration token per organization, encrypted with a
-- key derived from the worker's secret. The token never leaves the server.
CREATE TABLE IF NOT EXISTS notion_connections (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  token_ciphertext TEXT NOT NULL,
  token_iv TEXT NOT NULL,
  workspace_name TEXT,
  bot_name TEXT,
  connected_by TEXT NOT NULL REFERENCES users(id),
  connected_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
