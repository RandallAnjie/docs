PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(scopes_json)),
  expires_at INTEGER,
  last_used_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_organization
  ON api_tokens(organization_id, revoked_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_tokens_user
  ON api_tokens(user_id, revoked_at, created_at DESC);

CREATE TABLE IF NOT EXISTS integration_webhooks (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(events_json)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (organization_id, name)
);
CREATE INDEX IF NOT EXISTS idx_integration_webhooks_organization
  ON integration_webhooks(organization_id, enabled);

CREATE TABLE IF NOT EXISTS export_jobs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('workspace', 'space', 'page')),
  scope_id TEXT,
  format TEXT NOT NULL CHECK (format IN ('markdown', 'json', 'csv')),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  page_count INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_export_jobs_organization
  ON export_jobs(organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS site_domains (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  hostname TEXT NOT NULL COLLATE NOCASE,
  verification_token TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'verified', 'failed')),
  last_checked_at INTEGER,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (hostname)
);
CREATE INDEX IF NOT EXISTS idx_site_domains_site ON site_domains(site_id, created_at DESC);

CREATE TABLE IF NOT EXISTS site_prerender (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  excerpt TEXT NOT NULL DEFAULT '',
  content_hash TEXT,
  generated_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, page_id)
);

CREATE TABLE IF NOT EXISTS site_database_views (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  view_id TEXT NOT NULL REFERENCES database_views(id) ON DELETE CASCADE,
  published INTEGER NOT NULL DEFAULT 1 CHECK (published IN (0, 1)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, view_id)
);
CREATE INDEX IF NOT EXISTS idx_site_database_views_site
  ON site_database_views(site_id, published);

CREATE TABLE IF NOT EXISTS database_property_grants (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  property_id TEXT NOT NULL REFERENCES database_properties(id) ON DELETE CASCADE,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'group', 'organization')),
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('none', 'viewer', 'editor')),
  created_at INTEGER NOT NULL,
  UNIQUE (property_id, principal_type, principal_id)
);
CREATE INDEX IF NOT EXISTS idx_database_property_grants_database
  ON database_property_grants(database_id, property_id);

CREATE TABLE IF NOT EXISTS ai_settings (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  model TEXT NOT NULL DEFAULT 'grok-4.5',
  retention TEXT NOT NULL DEFAULT 'none' CHECK (retention IN ('none', '30d', 'indefinite')),
  updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_jobs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES users(id),
  page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('write', 'rewrite', 'summarize', 'ask', 'autofill', 'research')),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'degraded')),
  prompt TEXT NOT NULL,
  result_text TEXT,
  citations_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(citations_json)),
  error_message TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ai_jobs_organization
  ON ai_jobs(organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS enterprise_settings (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  saml_enabled INTEGER NOT NULL DEFAULT 0 CHECK (saml_enabled IN (0, 1)),
  saml_entity_id TEXT,
  saml_sso_url TEXT,
  saml_certificate TEXT,
  scim_enabled INTEGER NOT NULL DEFAULT 0 CHECK (scim_enabled IN (0, 1)),
  scim_token_hash TEXT,
  scim_token_prefix TEXT,
  verified_domain TEXT,
  domain_verification_token TEXT,
  domain_verified_at INTEGER,
  session_max_age_hours INTEGER NOT NULL DEFAULT 720,
  ip_allowlist_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(ip_allowlist_json)),
  retention_days INTEGER,
  legal_hold INTEGER NOT NULL DEFAULT 0 CHECK (legal_hold IN (0, 1)),
  siem_url TEXT,
  siem_secret TEXT,
  updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS legal_holds (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  released_at INTEGER,
  UNIQUE (page_id)
);
CREATE INDEX IF NOT EXISTS idx_legal_holds_organization
  ON legal_holds(organization_id, released_at, created_at DESC);

CREATE TABLE IF NOT EXISTS offline_pins (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, page_id)
);
CREATE INDEX IF NOT EXISTS idx_offline_pins_user ON offline_pins(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS calendar_connections (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('ics', 'caldav', 'google', 'microsoft')),
  name TEXT NOT NULL,
  ics_url TEXT,
  status TEXT NOT NULL DEFAULT 'configured' CHECK (status IN ('configured', 'error')),
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calendar_connections_org
  ON calendar_connections(organization_id, user_id);
