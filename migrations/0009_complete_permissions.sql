PRAGMA foreign_keys = ON;

ALTER TABLE space_grants RENAME TO space_grants_before_complete_permissions;

CREATE TABLE space_grants (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'group', 'organization')),
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('none', 'space_admin', 'editor', 'commenter', 'viewer')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  UNIQUE (organization_id, space_id, principal_type, principal_id)
);

INSERT INTO space_grants(
  id, organization_id, space_id, principal_type, principal_id, role, created_by, created_at
)
SELECT id, organization_id, space_id, principal_type, principal_id, role, created_by, created_at
  FROM space_grants_before_complete_permissions;

DROP TABLE space_grants_before_complete_permissions;

CREATE INDEX idx_space_grants_principal
  ON space_grants(organization_id, principal_type, principal_id);

-- Guest is now a legacy external/read-only membership. It cannot inherit group elevation.
DELETE FROM group_members
 WHERE user_id IN (
   SELECT user_id FROM organization_members WHERE role = 'guest'
 );

-- Historical direct grants are normalized as well as runtime-capped, so the
-- stored ACL and the effective ACL cannot disagree in management screens.
UPDATE space_grants
   SET role = 'viewer'
 WHERE principal_type = 'user'
   AND role NOT IN ('none', 'viewer')
   AND principal_id IN (
     SELECT user_id FROM organization_members WHERE role = 'guest'
   );

UPDATE page_grants
   SET role = 'viewer'
 WHERE principal_type = 'user'
   AND role NOT IN ('none', 'viewer')
   AND principal_id IN (
     SELECT user_id FROM organization_members WHERE role = 'guest'
   );

-- Invalidate collaboration tickets in every tenant whose effective guest ACL
-- may have changed during this migration.
UPDATE page_access_state
   SET acl_version = acl_version + 1,
       updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE page_id IN (
   SELECT p.id
     FROM pages p
    WHERE p.organization_id IN (
      SELECT organization_id FROM organization_members WHERE role = 'guest'
    )
 );

-- The bootstrap system identity must never retain tenant access after passkey activation.
DELETE FROM organization_members
 WHERE organization_id = 'org_phase0' AND user_id = 'usr_phase0_system';

-- New guest invitations are disabled. Existing pending links fail closed as revoked.
UPDATE invitations
   SET revoked_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE organization_role = 'guest' AND accepted_at IS NULL AND revoked_at IS NULL;
