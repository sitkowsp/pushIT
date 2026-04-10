-- pushIT Database Schema

-- Users (linked to Microsoft Entra ID)
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  entra_object_id TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  user_key TEXT UNIQUE NOT NULL,
  is_admin INTEGER DEFAULT 0,
  quiet_hours_start TEXT DEFAULT NULL,
  quiet_hours_end TEXT DEFAULT NULL,
  default_sound TEXT DEFAULT 'pushit',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  last_login TEXT DEFAULT NULL
);

-- Devices (push subscriptions per user)
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  push_endpoint TEXT,
  push_p256dh TEXT,
  push_auth TEXT,
  is_active INTEGER DEFAULT 1,
  user_agent TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  last_seen TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Applications (API tokens for sending messages)
CREATE TABLE IF NOT EXISTS applications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token TEXT UNIQUE NOT NULL,
  icon_url TEXT,
  description TEXT,
  is_active INTEGER DEFAULT 1,
  monthly_message_count INTEGER DEFAULT 0,
  monthly_reset_at TEXT,
  visibility TEXT DEFAULT 'private',
  color TEXT DEFAULT '#e94560',
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Messages
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  application_id TEXT,
  app_token TEXT,
  user_id TEXT NOT NULL,
  device_id TEXT DEFAULT NULL,
  title TEXT,
  message TEXT NOT NULL,
  html INTEGER DEFAULT 0,
  priority INTEGER DEFAULT 0,
  sound TEXT DEFAULT NULL,
  url TEXT DEFAULT NULL,
  url_title TEXT DEFAULT NULL,
  timestamp INTEGER,
  ttl INTEGER DEFAULT NULL,
  expires_at TEXT DEFAULT NULL,
  callback_url TEXT DEFAULT NULL,
  tags TEXT DEFAULT NULL,
  attachment_url TEXT DEFAULT NULL,
  receipt TEXT DEFAULT NULL,
  acknowledged INTEGER DEFAULT 0,
  acknowledged_at TEXT DEFAULT NULL,
  acknowledged_by TEXT DEFAULT NULL,
  delivered INTEGER DEFAULT 0,
  delivered_at TEXT DEFAULT NULL,
  is_read INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE SET NULL
);

-- Emergency retry tracking
CREATE TABLE IF NOT EXISTS emergency_retries (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  receipt TEXT UNIQUE NOT NULL,
  retry_interval INTEGER NOT NULL DEFAULT 60,
  expire_at TEXT NOT NULL,
  retries_sent INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 50,
  callback_url TEXT,
  tags TEXT,
  is_active INTEGER DEFAULT 1,
  last_retry_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

-- Groups (for sending to multiple users)
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  group_key TEXT UNIQUE NOT NULL,
  owner_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  device_name TEXT DEFAULT NULL,
  added_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (group_id, user_id),
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Notification filters
CREATE TABLE IF NOT EXISTS filters (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  is_active INTEGER DEFAULT 1,
  match_app_token TEXT DEFAULT NULL,
  match_title_pattern TEXT DEFAULT NULL,
  match_message_pattern TEXT DEFAULT NULL,
  match_priority_min INTEGER DEFAULT NULL,
  match_priority_max INTEGER DEFAULT NULL,
  action TEXT NOT NULL DEFAULT 'forward',
  action_webhook_url TEXT DEFAULT NULL,
  action_override_priority INTEGER DEFAULT NULL,
  action_override_sound TEXT DEFAULT NULL,
  action_suppress INTEGER DEFAULT 0,
  action_auto_acknowledge INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Webhook delivery log (outbound to n8n)
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  message_id TEXT,
  filter_id TEXT,
  webhook_url TEXT NOT NULL,
  payload TEXT NOT NULL,
  status_code INTEGER,
  response_body TEXT,
  success INTEGER DEFAULT 0,
  attempt INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE SET NULL,
  FOREIGN KEY (filter_id) REFERENCES filters(id) ON DELETE SET NULL
);

-- App Subscriptions (for public app subscriptions)
CREATE TABLE IF NOT EXISTS app_subscriptions (
  application_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (application_id, user_id),
  FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_app_subs_user ON app_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_app_subs_app ON app_subscriptions(application_id);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_users_entra ON users(entra_object_id);
CREATE INDEX IF NOT EXISTS idx_users_key ON users(user_key);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);
CREATE INDEX IF NOT EXISTS idx_apps_token ON applications(token);
CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_receipt ON messages(receipt);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_read ON messages(user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_emergency_receipt ON emergency_retries(receipt);
CREATE INDEX IF NOT EXISTS idx_emergency_active ON emergency_retries(is_active);
CREATE INDEX IF NOT EXISTS idx_filters_user ON filters(user_id);
CREATE INDEX IF NOT EXISTS idx_groups_key ON groups(group_key);
