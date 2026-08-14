PRAGMA foreign_keys = ON;

ALTER TABLE auth_challenges
  ADD COLUMN invitation_id TEXT REFERENCES invitations(id);
