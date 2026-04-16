-- Migration v5: App org-visibility + SMTP settings storage

-- App-to-org visibility junction table.
-- When a public app has entries here, only members of listed orgs can see it.
-- If no entries exist, the app is visible to all orgs (default behavior).
CREATE TABLE IF NOT EXISTS app_org_visibility (
  application_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (application_id, organization_id),
  FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_app_org_vis_app ON app_org_visibility(application_id);
CREATE INDEX IF NOT EXISTS idx_app_org_vis_org ON app_org_visibility(organization_id);

-- Settings table for runtime-configurable values (e.g. SMTP from UI)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Promote first user to admin (for existing deployments upgrading to v1.12.0)
UPDATE users SET is_admin = 1 WHERE id = (
  SELECT id FROM users ORDER BY created_at ASC LIMIT 1
);
