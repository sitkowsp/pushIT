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
  if (visibility !== undefined) { updates.push('visibility = ?'); params.push(visibility); }
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
 * List all public apps in the tenant.
 * No auth needed beyond user auth.
 */
router.get('/public', authenticateUser, (req, res) => {
  const publicApps = db.all('SELECT * FROM applications WHERE visibility = ? ORDER BY name', ['public']);

  const formatApp = (app) => {
    const subscriberCount = db.get(
      'SELECT COUNT(*) as count FROM app_subscriptions WHERE application_id = ?',
      [app.id]
    );
    const isSubscribed = db.get(
      'SELECT 1 FROM app_subscriptions WHERE application_id = ? AND user_id = ?',
      [app.id, req.dbUser.id]
    );

    return {
      id: app.id,
      name: app.name,
      token: app.token,
      icon_url: app.icon_url,
      description: app.description,
      is_active: app.is_active,
      created_at: app.created_at,
      visibility: app.visibility,
      color: app.color,
      subscriber_count: subscriberCount.count,
      is_subscribed: !!isSubscribed,
      is_owner: app.user_id === req.dbUser.id,
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

  res.json({ status: 1 });
});

/**
 * POST /api/v1/applications/:id/unsubscribe
 * Unsubscribe current user from an app.
 * Owner cannot unsubscribe from their own app.
 */
router.post('/:id/unsubscribe', authenticateUser, (req, res) => {
  const app = db.get('SELECT * FROM applications WHERE id = ?', [req.params.id]);

  if (!app) {
    return res.status(404).json({ status: 0, errors: ['Application not found'] });
  }

  // Remove subscription
  db.run(
    'DELETE FROM app_subscriptions WHERE application_id = ? AND user_id = ?',
    [app.id, req.dbUser.id]
  );

  // Delete existing messages from this app for the user
  // so the message list reflects the unsubscribed state
  db.run(
    'DELETE FROM messages WHERE application_id = ? AND user_id = ?',
    [app.id, req.dbUser.id]
  );

  res.json({ status: 1 });
});

module.exports = router;
