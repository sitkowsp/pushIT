const express = require('express');
const router = express.Router();
const db = require('../db/db');
const config = require('../config');

/**
 * POST /api/v1/webhooks/n8n
 * Receive webhook calls from n8n.
 * Validates the shared secret and processes the notification.
 * This is an alternative to the standard messages API for n8n-specific flows.
 */
router.post('/n8n', (req, res) => {
  // Validate webhook secret
  const secret = req.headers['x-webhook-secret'] || req.body.webhook_secret;
  if (config.n8n.webhookSecret && secret !== config.n8n.webhookSecret) {
    return res.status(401).json({ status: 0, errors: ['Invalid webhook secret'] });
  }

  // Forward to the messages handler
  // The n8n webhook uses the same format as the messages API
  // but authenticates via shared secret instead of app token
  const { token, user, ...messageData } = req.body;

  if (!user) {
    return res.status(400).json({ status: 0, errors: ['user parameter is required'] });
  }
  if (!messageData.message) {
    return res.status(400).json({ status: 0, errors: ['message parameter is required'] });
  }

  // Find or use a system application for n8n
  let n8nApp = db.get("SELECT * FROM applications WHERE name = 'n8n' AND is_active = 1 LIMIT 1");

  if (!n8nApp) {
    // Auto-create n8n system app on first use
    const { v4: uuidv4 } = require('uuid');
    const { generateAppToken } = require('../middleware/auth');
    const appId = uuidv4();
    const appToken = generateAppToken();

    // Get first admin user, or first user
    const adminUser = db.get('SELECT id FROM users WHERE is_admin = 1 LIMIT 1')
      || db.get('SELECT id FROM users LIMIT 1');

    if (!adminUser) {
      return res.status(500).json({ status: 0, errors: ['No users registered yet'] });
    }

    db.run(
      `INSERT INTO applications (id, user_id, name, token, description)
       VALUES (?, ?, 'n8n', ?, 'Auto-created n8n integration app')`,
      [appId, adminUser.id, appToken]
    );

    n8nApp = db.get('SELECT * FROM applications WHERE id = ?', [appId]);
  }

  // Inject the app token and forward
  req.body.token = n8nApp.token;
  req.appRecord = n8nApp;

  const push = require('../services/push');
  const emergency = require('../services/emergency');
  const filters = require('../services/filters');
  const { v4: uuidv4 } = require('uuid');

  // Process inline (simplified version of messages POST handler)
  processN8nMessage(req, res, n8nApp);
});

async function processN8nMessage(req, res, app) {
  try {
    const { v4: uuidv4 } = require('uuid');
    const push = require('../services/push');
    const emergency = require('../services/emergency');
    const filtersService = require('../services/filters');

    const {
      user: userKey, title, message, device, html,
      priority = 0, sound, timestamp, ttl, url, url_title,
      callback_url, retry, expire, tags,
    } = req.body;

    const pri = parseInt(priority, 10);

    // Resolve user
    const targetUser = db.get('SELECT * FROM users WHERE user_key = ?', [userKey]);
    if (!targetUser) {
      return res.status(400).json({ status: 0, errors: ['user identifier is invalid'] });
    }

    const msgId = uuidv4();
    let expiresAt = null;
    if (ttl && ttl > 0) {
      expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    }

    db.run(
      `INSERT INTO messages (id, application_id, app_token, user_id, device_id, title, message, html, priority, sound, url, url_title, timestamp, ttl, expires_at, callback_url, tags)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        msgId, app.id, app.token, targetUser.id, device || null,
        title || 'n8n', message, html ? 1 : 0, pri,
        sound || null, url || null, url_title || null,
        timestamp || Math.floor(Date.now() / 1000),
        ttl || null, expiresAt, callback_url || null, tags || null,
      ]
    );

    // Process filters
    const msgData = {
      id: msgId, app_token: app.token, title: title || 'n8n',
      message, priority: pri, user_id: targetUser.id, url,
    };

    const filterActions = await filtersService.processFilters(targetUser.id, msgData);
    const { modifications, suppress } = await filtersService.executeFilterActions(filterActions, msgData);

    let receipt = null;

    if (!suppress) {
      const effectivePriority = modifications.priority !== undefined ? modifications.priority : pri;

      const payload = {
        id: msgId,
        title: title || 'n8n',
        message,
        priority: effectivePriority,
        sound: modifications.sound || sound || 'pushit',
        url: url || null,
        url_title: url_title || null,
        app_name: 'n8n',
      };

      if (effectivePriority === 2 && retry && expire) {
        receipt = emergency.createEmergencyRetry(msgId, {
          retry: parseInt(retry, 10),
          expire: parseInt(expire, 10),
          callback_url, tags,
        });
        payload.receipt = receipt;
      }

      const result = await push.sendToUser(targetUser.id, payload, device);
      if (result.delivered > 0) {
        db.run("UPDATE messages SET delivered = 1, delivered_at = datetime('now') WHERE id = ?", [msgId]);
      }
    }

    const response = { status: 1, request: uuidv4().substring(0, 36) };
    if (receipt) response.receipt = receipt;
    res.json(response);
  } catch (err) {
    console.error('[Webhook] n8n processing error:', err);
    res.status(500).json({ status: 0, errors: ['Internal server error'] });
  }
}

/**
 * POST /api/v1/webhooks/callback-test
 * Test endpoint for outbound webhook callbacks.
 */
router.post('/callback-test', (req, res) => {
  console.log('[Webhook] Callback test received:', JSON.stringify(req.body, null, 2));
  res.json({ status: 1, received: true });
});

module.exports = router;
