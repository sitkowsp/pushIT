-- pushIT Migration v2: App visibility, subscriptions, message read status
-- Run this against the existing deployed database

-- Add visibility and color columns to applications
ALTER TABLE applications ADD COLUMN visibility TEXT DEFAULT 'private';
ALTER TABLE applications ADD COLUMN color TEXT DEFAULT '#e94560';

-- Add is_read column to messages
ALTER TABLE messages ADD COLUMN is_read INTEGER DEFAULT 0;

-- Create app_subscriptions table
CREATE TABLE IF NOT EXISTS app_subscriptions (
  application_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (application_id, user_id),
  FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Indexes for subscriptions
CREATE INDEX IF NOT EXISTS idx_app_subs_user ON app_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_app_subs_app ON app_subscriptions(application_id);

-- Index for message read status
CREATE INDEX IF NOT EXISTS idx_messages_read ON messages(user_id, is_read);

-- Auto-subscribe existing app owners to their own apps
INSERT OR IGNORE INTO app_subscriptions (application_id, user_id)
SELECT id, user_id FROM applications;
