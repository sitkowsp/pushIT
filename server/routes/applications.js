const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();
const db = require('../db/db');
const { authenticateUser, authenticateApp, generateAppToken } = require('../middleware/auth');

/**
 * GET /api/v1/applications
 * List all applications for the authenticated user.
 * - User's OWN apps (any visibility)
 * - Public apps from OTHER users that the current user is subscribed to
 */
router.get('/', authenticateUser, (req, res) => {
  // Get user's own apps
  const ownApps = db.all('SELECT * FROM applications WHERE user_id = ?', [req.dbUser.id]);

  // Get public apps from other users that the current user is subscribed to
  const subscribedApps = db.all(
    `SELECT a.* FROM applications a
     JOIN app_subscriptions sub ON a.id = sub.application_id
     WHERE sub.user_id = ? AND a.user_id != ?`,
    [req.dbUser.id, req.dbUser.id]
  );

  const formatApp = (app, isOwner) => {
    const subscriberCount = db.get(
      'SELECT COUNT(*) as count FROM app_subscriptions WHERE application_id = ?',
      [app.id]
    );
    const isSubscribed = db.get(
      'SELECT 1 FROM app_subscriptions WHERE application_id = ? AND user_id = ?',
      [app.id, req.dbUser.id]
    );
    // Actual message count for this user from this app (not the stale monthly counter)
    const messageCount = db.get(
      'SELECT COUNT(*) as count FROM messages WHERE application_id = ? AND user_id = ?',
      [app.id, req.dbUser.id]
    );

    // For owned apps, include org visibility info
    let orgVisibility = null;
    if (isOwner && app.visibility === 'public') {
      const visOrgs = db.all(
        `SELECT o.id, o.name FROM app_org_visibility aov
         JOIN organizations o ON aov.organization_id = o.id
         WHERE aov.application_id = ?`,
        [app.id]
      );
      orgVisibility = {
        all_orgs: visOrgs.length === 0,
        organizations: visOrgs,
      };
    }

    return {
      id: app.id,
      name: app.name,
      token: isOwner ? app.token : undefined,
      icon_url: app.icon_url,
      description: app.description,
      is_active: app.is_active,
      message_count: messageCount.count,
      created_at: app.created_at,
      visibility: app.visibility,
      color: app.color,
      is_owner: isOwner,
      subscriber_count: subscriberCount.count,
      is_subscribed: !!isSubscribed,
      org_visibility: orgVisibility,
    };
  };

  const allApps = [
    ...ownApps.map((a) => formatApp(a, true)),
    ...subscribedApps.map((a) => formatApp(a, false)),
  ];

  res.json({
    status: 1,
    applications: allApps,
  });
});

/**
 * POST /api/v1/applications
 * Create a new application and get an API token.
 * Supports visibility ('private'|'public') and color (hex string) fields.
 * Creator is automatically subscribed to their own app.
 */
router.post('/', authenticateUser, (req, res) => {
  const { name, description, icon_url, visibility = 'private', color = '#e94560' } = req.body;

  if (!name) {
    return res.status(400).json({ status: 0, errors: ['Application name is required'] });
  }

  const appId = uuidv4();
  const token = generateAppToken();

  db.run(
    `INSERT INTO applications (id, user_id, name, token, icon_url, description, visibility, color, monthly_reset_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', 'start of month', '+1 month'))`,
    [appId, req.dbUser.id, name, token, icon_url || null, description || null, visibility, color]
  );

  // Creator is automatically subscribed to their own app
  db.run(
    'INSERT INTO app_subscriptions (application_id, user_id) VALUES (?, ?)',
    [appId, req.dbUser.id]
  );

  res.json({
    status: 1,
    application: {
      id: appId,
      name,
      token,
      description,
      icon_url,
      visibility,
      color,
    },
  });
});

/**
 * PUT /api/v1/applications/:id
 * Update an application.
 * Only the owner can edit. visibility and color are now updatable.
 */
router.put('/:id', authenticateUser, (req, res) => {
  const { name, description, icon_url, is_active, visibility, color } = req.body;

  const app = db.get(
    'SELECT * FROM applications WHERE id = ? AND user_id = ?',
    [req.params.id, req.dbUser.id]
  );

  if (!app) {
    return res.status(404).json({ status: 0, errors: ['Application not found'] });
  }

  const updates = [];
  const params = [];

  if (name !== undefined) { updates.push('name = ?'); params.push(name); }
  if (description !== undefined) { updates.push('description = ?'); params.push(description); }
  if (icon_url !== undefined) { updates.push('icon_url = ?'); params.push(icon_url); }
  if (is_active !== undefined) { updates.push('is_active = ?'); params.push(is_active ? 1 : 0); }
  if (visibility !== undefined) {
    if (!['private', 'public'].includes(visibility)) {
      return res.status(400).json({ status: 0, errors: ['Visibility must be private or public'] });
    }
    updates.push('visibility = ?'); params.push(visibility);
  }
  if (color !== undefined) { updates.push('color = ?'); params.push(color); }

  if (updates.length > 0) {
    params.push(app.id);
    db.run(`UPDATE applications SET ${updates.join(', ')} WHERE id = ?`, params);
  }

  res.json({ status: 1 });
});

/**
 * POST /api/v1/applications/:id/regenerate-token
 * Regenerate the API token for an application.
 */
router.post('/:id/regenerate-token', authenticateUser, (req, res) => {
  const app = db.get(
    'SELECT * FROM applications WHERE id = ? AND user_id = ?',
    [req.params.id, req.dbUser.id]
  );

  if (!app) {
    return res.status(404).json({ status: 0, errors: ['Application not found'] });
  }

  const newToken = generateAppToken();
  db.run('UPDATE applications SET token = ? WHERE id = ?', [newToken, app.id]);

  res.json({
    status: 1,
    token: newToken,
  });
});

/**
 * DELETE /api/v1/applications/:id
 * Delete an application. Only the owner can delete.
 */
router.delete('/:id', authenticateUser, (req, res) => {
  const app = db.get(
    'SELECT * FROM applications WHERE id = ? AND user_id = ?',
    [req.params.id, req.dbUser.id]
  );

  if (!app) {
    return res.status(404).json({ status: 0, errors: ['Application not found'] });
  }

  db.run('DELETE FROM applications WHERE id = ?', [req.params.id]);
  res.json({ status: 1 });
});

/**
 * GET /api/v1/applications/public
 * List all public apps visible to the current user.
 * Respects org-visibility: if an app has org restrictions, only members
 * of those orgs can see it. Apps with no restrictions are visible to all.
 */
router.get('/public', authenticateUser, (req, res) => {
  // Get all public apps, then filter by org visibility
  const allPublicApps = db.all('SELECT * FROM applications WHERE visibility = ? ORDER BY name', ['public']);

  const publicApps = allPublicApps.filter((app) => {
    // Check if this app has org-visibility restrictions
    const visRestrictions = db.all(
      'SELECT organization_id FROM app_org_visibility WHERE application_id = ?',
      [app.id]
    );
    if (visRestrictions.length === 0) {
      // No restrictions — visible to everyone
      return true;
    }
    // Check if user is a member of any of the allowed orgs
    const orgIds = visRestrictions.map((r) => r.organization_id);
    for (const orgId of orgIds) {
      const isMember = db.get(
        'SELECT 1 FROM org_members WHERE organization_id = ? AND user_id = ?',
        [orgId, req.dbUser.id]
      );
      if (isMember) return true;
    }
    return false;
  });

  const formatApp = (app) => {
    const subscriberCount = db.get(
      'SELECT COUNT(*) as count FROM app_subscriptions WHERE application_id = ?',
      [app.id]
    );
    const isSubscribed = db.get(
      'SELECT 1 FROM app_subscriptions WHERE application_id = ? AND user_id = ?',
      [app.id, req.dbUser.id]
    );

    const isOwner = app.user_id === req.dbUser.id;
    return {
      id: app.id,
      name: app.name,
      // Only expose token to the app owner — never leak to other users
      token: isOwner ? app.token : undefined,
      icon_url: app.icon_url,
      description: app.description,
      is_active: app.is_active,
      created_at: app.created_at,
      visibility: app.visibility,
      color: app.color,
      subscriber_count: subscriberCount.count,
      is_subscribed: !!isSubscribed,
      is_owner: isOwner,
    };
  };

  res.json({
    status: 1,
    applications: publicApps.map(formatApp),
  });
});

/**
 * POST /api/v1/applications/:id/subscribe
 * Subscribe current user to a public app.
 */
router.post('/:id/subscribe', authenticateUser, (req, res) => {
  const app = db.get('SELECT * FROM applications WHERE id = ?', [req.params.id]);

  if (!app) {
    return res.status(404).json({ status: 0, errors: ['Application not found'] });
  }

  if (app.visibility !== 'public') {
    return res.status(400).json({ status: 0, errors: ['Cannot subscribe to private app'] });
  }

  // Enforce org-visibility restrictions
  const visRestrictions = db.all(
    'SELECT organization_id FROM app_org_visibility WHERE application_id = ?',
    [app.id]
  );
  if (visRestrictions.length > 0) {
    const orgIds = visRestrictions.map((r) => r.organization_id);
    const isMember = orgIds.some((orgId) =>
      db.get('SELECT 1 FROM org_members WHERE organization_id = ? AND user_id = ?', [orgId, req.dbUser.id])
    );
    if (!isMember) {
      return res.status(403).json({ status: 0, errors: ['This app is restricted to specific organizations'] });
    }
  }

  const alreadySubscribed = db.get(
    'SELECT 1 FROM app_subscriptions WHERE application_id = ? AND user_id = ?',
    [app.id, req.dbUser.id]
  );

  if (alreadySubscribed) {
    return res.status(400).json({ status: 0, errors: ['Already subscribed to this app'] });
  }

  db.run(
    'INSERT INTO app_subscriptions (application_id, user_id) VALUES (?, ?)',
    [app.id, req.dbUser.id]
  );

  // Auto-assign ownership if the app is orphaned (owner is not subscribed)
  let becameOwner = false;
  const ownerSubscribed = db.get(
    'SELECT 1 FROM app_subscriptions WHERE application_id = ? AND user_id = ?',
    [app.id, app.user_id]
  );
  if (!ownerSubscribed) {
    db.run('UPDATE applications SET user_id = ? WHERE id = ?', [req.dbUser.id, app.id]);
    becameOwner = true;
  }

  res.json({ status: 1, became_owner: becameOwner });
});

/**
 * GET /api/v1/applications/:id/visibility
 * Get org-visibility settings for an app. Owner only.
 */
router.get('/:id/visibility', authenticateUser, (req, res) => {
  const app = db.get('SELECT * FROM applications WHERE id = ? AND user_id = ?', [req.params.id, req.dbUser.id]);
  if (!app) {
    return res.status(404).json({ status: 0, errors: ['Application not found'] });
  }

  const visibleOrgs = db.all(
    `SELECT o.id, o.name FROM app_org_visibility aov
     JOIN organizations o ON aov.organization_id = o.id
     WHERE aov.application_id = ?`,
    [app.id]
  );

  // Get all orgs the user is a member of (for the UI selector)
  const userOrgs = db.all(
    `SELECT o.id, o.name FROM organizations o
     JOIN org_members om ON o.id = om.organization_id
     WHERE om.user_id = ?
     ORDER BY o.name`,
    [req.dbUser.id]
  );

  res.json({
    status: 1,
    visible_orgs: visibleOrgs,
    all_user_orgs: userOrgs,
    // If no entries, the app is visible to all orgs
    all_orgs: visibleOrgs.length === 0,
  });
});

/**
 * PUT /api/v1/applications/:id/visibility
 * Set org-visibility for a public app. Owner only.
 * Pass { organization_ids: [...] } to restrict, or { all_orgs: true } for unrestricted.
 */
router.put('/:id/visibility', authenticateUser, (req, res) => {
  const app = db.get('SELECT * FROM applications WHERE id = ? AND user_id = ?', [req.params.id, req.dbUser.id]);
  if (!app) {
    return res.status(404).json({ status: 0, errors: ['Application not found'] });
  }

  const { organization_ids, all_orgs } = req.body;

  if (all_orgs) {
    // Remove all restrictions — app visible to everyone
    db.run('DELETE FROM app_org_visibility WHERE application_id = ?', [app.id]);
    return res.json({ status: 1 });
  }

  if (!organization_ids || !Array.isArray(organization_ids) || organization_ids.length === 0) {
    return res.status(400).json({ status: 0, errors: ['Provide organization_ids or set all_orgs: true'] });
  }

  // Validate all org IDs first — only accept orgs the user is a member of
  const validOrgIds = [];
  for (const orgId of organization_ids) {
    const isMember = db.get(
      'SELECT 1 FROM org_members WHERE organization_id = ? AND user_id = ?',
      [orgId, req.dbUser.id]
    );
    if (isMember) {
      validOrgIds.push(orgId);
    }
  }

  if (validOrgIds.length === 0) {
    return res.status(400).json({ status: 0, errors: ['None of the provided organizations are valid'] });
  }

  // Replace visibility entries atomically
  db.run('DELETE FROM app_org_visibility WHERE application_id = ?', [app.id]);
  for (const orgId of validOrgIds) {
    db.run(
      'INSERT INTO app_org_visibility (application_id, organization_id) VALUES (?, ?)',
      [app.id, orgId]
    );
  }

  res.json({ status: 1 });
});

/**
 * GET /api/v1/applications/:id/subscribers
 * List all subscribers of an app with their org memberships.
 * Owner only.
 */
router.get('/:id/subscribers', authenticateUser, (req, res) => {
  const app = db.get(
    'SELECT * FROM applications WHERE id = ? AND user_id = ?',
    [req.params.id, req.dbUser.id]
  );

  if (!app) {
    return res.status(404).json({ status: 0, errors: ['Application not found or you are not the owner'] });
  }

  const subscribers = db.all(
    `SELECT u.id, u.display_name, u.email, sub.created_at as subscribed_at
     FROM app_subscriptions sub
     JOIN users u ON sub.user_id = u.id
     WHERE sub.application_id = ?
     ORDER BY sub.created_at ASC`,
    [app.id]
  );

  // For each subscriber, get their org memberships
  const result = subscribers.map((sub) => {
    const orgs = db.all(
      `SELECT o.id, o.name, om.role FROM org_members om
       JOIN organizations o ON om.organization_id = o.id
       WHERE om.user_id = ?
       ORDER BY o.name`,
      [sub.id]
    );
    return {
      id: sub.id,
      display_name: sub.display_name,
      email: sub.email,
      subscribed_at: sub.subscribed_at,
      organizations: orgs,
      is_owner: sub.id === req.dbUser.id,
    };
  });

  res.json({
    status: 1,
    subscribers: result,
    total: result.length,
  });
});

/**
 * DELETE /api/v1/applications/:id/subscribers/:userId
 * Force-unsubscribe a user from an app. Owner only.
 * Also deletes the user's messages from this app.
 * Cannot remove the owner themselves.
 */
router.delete('/:id/subscribers/:userId', authenticateUser, (req, res) => {
  const app = db.get(
    'SELECT * FROM applications WHERE id = ? AND user_id = ?',
    [req.params.id, req.dbUser.id]
  );

  if (!app) {
    return res.status(404).json({ status: 0, errors: ['Application not found or you are not the owner'] });
  }

  const targetUserId = req.params.userId;

  // Cannot remove the app owner
  if (targetUserId === req.dbUser.id) {
    return res.status(400).json({ status: 0, errors: ['Cannot unsubscribe the app owner'] });
  }

  // Verify the user is actually subscribed
  const subscription = db.get(
    'SELECT 1 FROM app_subscriptions WHERE application_id = ? AND user_id = ?',
    [app.id, targetUserId]
  );

  if (!subscription) {
    return res.status(404).json({ status: 0, errors: ['User is not subscribed to this app'] });
  }

  // Remove subscription
  db.run(
    'DELETE FROM app_subscriptions WHERE application_id = ? AND user_id = ?',
    [app.id, targetUserId]
  );

  // Delete the user's messages from this app
  db.run(
    'DELETE FROM messages WHERE application_id = ? AND user_id = ?',
    [app.id, targetUserId]
  );

  res.json({ status: 1 });
});

/**
 * PUT /api/v1/applications/:id/transfer-ownership
 * Transfer app ownership to another subscriber. Owner only.
 * Body: { new_owner_id: "user-uuid" }
 */
router.put('/:id/transfer-ownership', authenticateUser, (req, res) => {
  const app = db.get(
    'SELECT * FROM applications WHERE id = ? AND user_id = ?',
    [req.params.id, req.dbUser.id]
  );

  if (!app) {
    return res.status(404).json({ status: 0, errors: ['Application not found or you are not the owner'] });
  }

  const { new_owner_id } = req.body;
  if (!new_owner_id) {
    return res.status(400).json({ status: 0, errors: ['new_owner_id is required'] });
  }

  // Cannot transfer to yourself
  if (new_owner_id === req.dbUser.id) {
    return res.status(400).json({ status: 0, errors: ['You are already the owner'] });
  }

  // Verify the new owner is actually subscribed
  const isSubscribed = db.get(
    'SELECT 1 FROM app_subscriptions WHERE application_id = ? AND user_id = ?',
    [app.id, new_owner_id]
  );

  if (!isSubscribed) {
    return res.status(400).json({ status: 0, errors: ['New owner must be a subscriber of this app'] });
  }

  // Transfer ownership
  db.run('UPDATE applications SET user_id = ? WHERE id = ?', [new_owner_id, app.id]);

  res.json({ status: 1 });
});

/**
 * POST /api/v1/applications/:id/unsubscribe
 * Unsubscribe current user from an app.
 *
 * If the user is the app owner:
 *   - If other subscribers exist → reject (must transfer ownership first)
 *   - If sole subscriber → requires body { action: 'delete' | 'abandon' }
 *     - 'delete': deletes the app entirely
 *     - 'abandon': unsubscribes owner; first future subscriber becomes new owner
 */
router.post('/:id/unsubscribe', authenticateUser, (req, res) => {
  const app = db.get('SELECT * FROM applications WHERE id = ?', [req.params.id]);

  if (!app) {
    return res.status(404).json({ status: 0, errors: ['Application not found'] });
  }

  const isOwner = app.user_id === req.dbUser.id;

  if (isOwner) {
    // Count other subscribers (excluding owner)
    const otherSubs = db.get(
      'SELECT COUNT(*) as count FROM app_subscriptions WHERE application_id = ? AND user_id != ?',
      [app.id, req.dbUser.id]
    );

    if (otherSubs.count > 0) {
      return res.status(400).json({
        status: 0,
        errors: ['Transfer ownership to another subscriber before unsubscribing'],
        code: 'TRANSFER_REQUIRED',
        subscriber_count: otherSubs.count,
      });
    }

    // Sole subscriber — require explicit action
    const { action } = req.body || {};
    if (!action || !['delete', 'abandon'].includes(action)) {
      return res.status(400).json({
        status: 0,
        errors: ['You are the only subscriber. Choose action: "delete" to remove the app, or "abandon" to leave it for future subscribers.'],
        code: 'SOLE_OWNER',
      });
    }

    if (action === 'delete') {
      db.run('DELETE FROM applications WHERE id = ?', [app.id]);
      return res.json({ status: 1, action: 'deleted' });
    }

    // action === 'abandon': unsubscribe but keep the app
    // The app stays in the public list; first new subscriber becomes owner
    db.run(
      'DELETE FROM app_subscriptions WHERE application_id = ? AND user_id = ?',
      [app.id, req.dbUser.id]
    );
    db.run(
      'DELETE FROM messages WHERE application_id = ? AND user_id = ?',
      [app.id, req.dbUser.id]
    );
    return res.json({ status: 1, action: 'abandoned' });
  }

  // Non-owner: simple unsubscribe
  db.run(
    'DELETE FROM app_subscriptions WHERE application_id = ? AND user_id = ?',
    [app.id, req.dbUser.id]
  );
  db.run(
    'DELETE FROM messages WHERE application_id = ? AND user_id = ?',
    [app.id, req.dbUser.id]
  );

  res.json({ status: 1 });
});

module.exports = router;
