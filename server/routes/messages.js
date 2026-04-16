const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();
const db = require('../db/db');
const { authenticateApp, authenticateUser, authenticateAny } = require('../middleware/auth');
const push = require('../services/push');
const emergency = require('../services/emergency');
const filters = require('../services/filters');
const config = require('../config');

/**
 * POST /api/v1/messages
 * Push a notification to a user or group, or to all subscribers.
 * Used by n8n and external services.
 *
 * If 'user' key is provided: send to that specific user (existing behavior)
 * If 'user' key is NOT provided: send to ALL subscribers of the app
 */
router.post('/', authenticateApp, async (req, res) => {
  try {
    const {
      user: userKey,
      title,
      message,
      device,
      html,
      priority = 0,
      sound,
      timestamp,
      ttl,
      url,
      url_title,
      callback_url,
      retry,
      expire,
      tags,
      image,
      icon,
    } = req.body;

    // Validate required fields
    if (!message) {
      return res.status(400).json({ status: 0, errors: ['message parameter is required'] });
    }

    // Validate priority
    const pri = parseInt(priority, 10);
    if (pri < -2 || pri > 2) {
      return res.status(400).json({ status: 0, errors: ['priority must be between -2 and 2'] });
    }

    // Emergency priority requires retry and expire
    if (pri === 2) {
      if (!retry || !expire) {
        return res.status(400).json({
          status: 0,
          errors: ['retry and expire parameters are required for emergency priority'],
        });
      }
    }

    // Resolve user(s) - if userKey provided, use it; otherwise get all subscribers
    let targetUsers = [];
    if (userKey) {
      // Existing behavior: resolve user key, group key, or comma-separated list
      targetUsers = await resolveTargets(userKey);
      if (targetUsers.length === 0) {
        return res.status(400).json({ status: 0, errors: ['user identifier is invalid'] });
      }
    } else {
      // New behavior: send to all subscribers of the app
      targetUsers = db.all(
        `SELECT u.* FROM users u
         JOIN app_subscriptions sub ON u.id = sub.user_id
         WHERE sub.application_id = ?`,
        [req.appRecord.id]
      );
      if (targetUsers.length === 0) {
        return res.status(200).json({
          status: 1,
          request: uuidv4().substring(0, 36),
          message: 'No subscribers for this app'
        });
      }
    }

    // Create and deliver messages for each target user
    let receipt = null;
    const results = [];

    for (const targetUser of targetUsers) {
      const msgId = uuidv4();

      // Calculate expiry
      let expiresAt = null;
      if (ttl && ttl > 0) {
        expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
      }

      // Store the message
      db.run(
        `INSERT INTO messages (id, application_id, app_token, user_id, device_id, title, message, html, priority, sound, url, url_title, timestamp, ttl, expires_at, callback_url, tags, attachment_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          msgId, req.appRecord.id, req.appRecord.token, targetUser.id, device || null,
          title || req.appRecord.name, message, html ? 1 : 0, pri,
          sound || null, url || null, url_title || null,
          timestamp || Math.floor(Date.now() / 1000),
          ttl || null, expiresAt, callback_url || null, tags || null,
          image || null,
        ]
      );

      // Process filters
      const msgData = {
        id: msgId,
        app_token: req.appRecord.token,
        title: title || req.appRecord.name,
        message,
        priority: pri,
        user_id: targetUser.id,
        url,
        timestamp: timestamp || Math.floor(Date.now() / 1000),
        receipt: null,
      };

      const filterActions = await filters.processFilters(targetUser.id, msgData);
      const { modifications, suppress } = await filters.executeFilterActions(filterActions, msgData);

      // Apply modifications from filters
      const effectivePriority = modifications.priority !== undefined ? modifications.priority : pri;
      const effectiveSound = modifications.sound || sound;

      // Skip push if filter suppresses
      if (!suppress) {
        // Build push payload
        const payload = {
          id: msgId,
          title: title || req.appRecord.name,
          message,
          priority: effectivePriority,
          sound: effectiveSound || 'pushit',
          url: url || null,
          url_title: url_title || null,
          html: html ? 1 : 0,
          timestamp: timestamp || Math.floor(Date.now() / 1000),
          app_name: req.appRecord.name,
          icon: icon || req.appRecord.icon_url || null,
          image: image || null,
        };

        // Handle emergency priority
        if (effectivePriority === 2) {
          receipt = emergency.createEmergencyRetry(msgId, {
            retry: parseInt(retry, 10),
            expire: parseInt(expire, 10),
            callback_url,
            tags,
          });
          payload.receipt = receipt;
        }

        // Include unread count for iOS home screen badge
        const unreadRow = db.get(
          'SELECT COUNT(*) as count FROM messages WHERE user_id = ? AND is_read = 0',
          [targetUser.id]
        );
        payload.unread_count = unreadRow ? unreadRow.count : 1;

        // Send push notification
        const deliveryResult = await push.sendToUser(targetUser.id, payload, device);
        console.log(`[Messages] Push delivery for ${targetUser.email}: delivered=${deliveryResult.delivered}/${deliveryResult.total || 0}, success=${deliveryResult.success}, reason=${deliveryResult.reason || 'ok'}`);

        if (deliveryResult.delivered > 0) {
          db.run(
            `UPDATE messages SET delivered = 1, delivered_at = datetime('now') WHERE id = ?`,
            [msgId]
          );
        }

        // Broadcast via WebSocket for real-time in-app updates
        // req.app is the Express app (not overwritten anymore)
        const expressApp = req.app;
        const wsBroadcast = expressApp && expressApp.locals && expressApp.locals.wsBroadcastToUser;
        if (wsBroadcast) {
          wsBroadcast(targetUser.id, {
            type: 'new_message',
            message: sanitizeMessage({
              ...msgData,
              image: image || null,
              app_name: req.appRecord.name,
              app_color: req.appRecord.color,
              created_at: new Date().toISOString(),
            }),
          });
        }

        results.push(deliveryResult);
      }

      // Auto-acknowledge if filter says so
      if (modifications.autoAcknowledge && receipt) {
        await emergency.acknowledgeByReceipt(receipt, 'auto-filter');
      }
    }

    // Update monthly count
    db.run(
      'UPDATE applications SET monthly_message_count = monthly_message_count + ? WHERE id = ?',
      [targetUsers.length, req.appRecord.id]
    );

    const response = { status: 1, request: uuidv4().substring(0, 36) };
    if (receipt) response.receipt = receipt;

    res.json(response);
  } catch (err) {
    console.error('[Messages] Error pushing message:', err);
    res.status(500).json({ status: 0, errors: ['Internal server error'] });
  }
});

/**
 * GET /api/v1/messages
 * Get message history for the authenticated user.
 * Supports optional query param ?unread=1 to filter only unread messages.
 */
router.get('/', authenticateUser, (req, res) => {
  const { limit: rawLimit = 50, offset: rawOffset = 0, unread } = req.query;

  // Clamp limit to [1, 200] and offset to >= 0 to prevent DoS via unbounded queries
  const limit = Math.max(1, Math.min(200, parseInt(rawLimit, 10) || 50));
  const offset = Math.max(0, parseInt(rawOffset, 10) || 0);

  let query = `SELECT m.*, a.name as app_name, a.color as app_color
               FROM messages m
               LEFT JOIN applications a ON m.application_id = a.id
               WHERE m.user_id = ?`;
  const params = [req.dbUser.id];

  if (unread) {
    query += ' AND m.is_read = 0';
  }

  query += ' ORDER BY m.created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const messages = db.all(query, params);

  let countQuery = 'SELECT COUNT(*) as count FROM messages WHERE user_id = ?';
  const countParams = [req.dbUser.id];
  if (unread) {
    countQuery += ' AND is_read = 0';
  }
  const total = db.get(countQuery, countParams);

  res.json({
    status: 1,
    messages: messages.map(sanitizeMessage),
    total: total.count,
    limit,
    offset,
  });
});

/**
 * POST /api/v1/messages/:id/read
 * Mark a message as read.
 */
router.post('/:id/read', authenticateUser, (req, res) => {
  const message = db.get(
    'SELECT * FROM messages WHERE id = ? AND user_id = ?',
    [req.params.id, req.dbUser.id]
  );

  if (!message) {
    return res.status(404).json({ status: 0, errors: ['Message not found'] });
  }

  db.run('UPDATE messages SET is_read = 1 WHERE id = ?', [req.params.id]);
  res.json({ status: 1 });
});

/**
 * POST /api/v1/messages/:id/unread
 * Mark a message as unread.
 */
router.post('/:id/unread', authenticateUser, (req, res) => {
  const message = db.get(
    'SELECT * FROM messages WHERE id = ? AND user_id = ?',
    [req.params.id, req.dbUser.id]
  );

  if (!message) {
    return res.status(404).json({ status: 0, errors: ['Message not found'] });
  }

  db.run('UPDATE messages SET is_read = 0 WHERE id = ?', [req.params.id]);
  res.json({ status: 1 });
});

/**
 * DELETE /api/v1/messages
 * Delete ALL messages for the current user.
 */
router.delete('/', authenticateUser, (req, res) => {
  const { app_name } = req.query;

  if (app_name) {
    // Delete only messages from the specified app
    db.run(
      `DELETE FROM messages WHERE user_id = ? AND application_id IN (
        SELECT id FROM applications WHERE name = ?
      )`,
      [req.dbUser.id, app_name]
    );
  } else {
    db.run('DELETE FROM messages WHERE user_id = ?', [req.dbUser.id]);
  }

  res.json({ status: 1 });
});

/**
 * POST /api/v1/messages/:id/acknowledge
 * Acknowledge an emergency notification.
 */
router.post('/:id/acknowledge', authenticateUser, async (req, res) => {
  const message = db.get(
    'SELECT * FROM messages WHERE id = ? AND user_id = ?',
    [req.params.id, req.dbUser.id]
  );

  if (!message) {
    return res.status(404).json({ status: 0, errors: ['Message not found'] });
  }

  if (!message.receipt) {
    return res.status(400).json({ status: 0, errors: ['Message is not an emergency notification'] });
  }

  const result = await emergency.acknowledgeByReceipt(message.receipt, req.dbUser.id);
  if (!result) {
    return res.status(400).json({ status: 0, errors: ['Already acknowledged or expired'] });
  }

  res.json({ status: 1, acknowledged: true });
});

/**
 * DELETE /api/v1/messages/:id
 * Delete a message.
 */
router.delete('/:id', authenticateUser, (req, res) => {
  db.run('DELETE FROM messages WHERE id = ? AND user_id = ?', [req.params.id, req.dbUser.id]);
  res.json({ status: 1 });
});

/**
 * GET /api/v1/receipts/:receipt
 * Check the status of an emergency notification receipt.
 */
router.get('/receipts/:receipt', authenticateApp, (req, res) => {
  const retry = db.get(
    `SELECT er.*, m.acknowledged, m.acknowledged_at, m.acknowledged_by
     FROM emergency_retries er
     JOIN messages m ON er.message_id = m.id
     WHERE er.receipt = ?`,
    [req.params.receipt]
  );

  if (!retry) {
    return res.status(404).json({ status: 0, errors: ['Receipt not found'] });
  }

  res.json({
    status: 1,
    acknowledged: retry.acknowledged === 1 ? 1 : 0,
    acknowledged_at: retry.acknowledged_at || 0,
    acknowledged_by: retry.acknowledged_by || null,
    last_delivered_at: retry.last_retry_at || retry.created_at,
    expired: retry.is_active === 0 && retry.acknowledged !== 1 ? 1 : 0,
    called_back: 0,
    called_back_at: 0,
  });
});

/**
 * Resolve target users from a user key, group key, or comma-separated list.
 */
async function resolveTargets(userKey) {
  // Check if it's a comma-separated list
  if (userKey.includes(',')) {
    const keys = userKey.split(',').map((k) => k.trim()).slice(0, 50);
    const users = [];
    for (const key of keys) {
      const user = db.get('SELECT * FROM users WHERE user_key = ?', [key]);
      if (user) users.push(user);
    }
    return users;
  }

  // Check if it's a group key
  const group = db.get('SELECT * FROM groups WHERE group_key = ?', [userKey]);
  if (group) {
    return db.all(
      `SELECT u.* FROM users u
       JOIN group_members gm ON u.id = gm.user_id
       WHERE gm.group_id = ?`,
      [group.id]
    );
  }

  // Single user key
  const user = db.get('SELECT * FROM users WHERE user_key = ?', [userKey]);
  return user ? [user] : [];
}

/**
 * Sanitize a message for API response.
 */
function sanitizeMessage(msg) {
  return {
    id: msg.id,
    title: msg.title,
    message: msg.message,
    html: msg.html,
    priority: msg.priority,
    sound: msg.sound,
    url: msg.url,
    url_title: msg.url_title,
    image: msg.attachment_url || msg.image || null,
    app_name: msg.app_name,
    app_color: msg.app_color,
    receipt: msg.receipt,
    acknowledged: msg.acknowledged,
    is_read: msg.is_read,
    timestamp: msg.timestamp,
    created_at: msg.created_at,
  };
}

module.exports = router;
