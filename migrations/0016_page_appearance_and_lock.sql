PRAGMA foreign_keys = ON;

ALTER TABLE pages ADD COLUMN icon TEXT;
ALTER TABLE pages ADD COLUMN cover_attachment_id TEXT;
ALTER TABLE pages ADD COLUMN font_style TEXT NOT NULL DEFAULT 'sans'
  CHECK (font_style IN ('sans', 'serif', 'mono'));
ALTER TABLE pages ADD COLUMN is_full_width INTEGER NOT NULL DEFAULT 0
  CHECK (is_full_width IN (0, 1));
ALTER TABLE pages ADD COLUMN is_small_text INTEGER NOT NULL DEFAULT 0
  CHECK (is_small_text IN (0, 1));
ALTER TABLE pages ADD COLUMN is_locked INTEGER NOT NULL DEFAULT 0
  CHECK (is_locked IN (0, 1));

CREATE INDEX IF NOT EXISTS idx_pages_cover_attachment
  ON pages(cover_attachment_id) WHERE cover_attachment_id IS NOT NULL;
