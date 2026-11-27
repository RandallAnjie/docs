-- Invites (Notion "Share → Invite"): a grant marked additive adds access on
-- top of what someone already has, for the page and the pages below it.
-- Existing grants stay non-additive and keep their current meaning.
ALTER TABLE page_grants ADD COLUMN additive INTEGER NOT NULL DEFAULT 0;
