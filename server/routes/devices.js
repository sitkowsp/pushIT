const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();
const db = require('../db/db');
const { authenticateUser } = require('../middleware/auth');
const config = require('../config');

/**
 * GET /api/v1/devices
 * List all devices for the authenticated user.
 */
router.get('/', authenticateUser, (req, res) => {
  const devices = db.all('SELECT * FROM devices WHERE user_id = ?', [req.dbUser.id]);

  res.json({
    status: 1,
    devices: devices.map((d) => ({
      id: d.id,
      name: d.name,
      is_active: d.is_active,
      has_push: !!d.push_endpoint,
      created_at: d.created_at,
      last_seen: d.last_seen,
    })),
  });
});

/**
 * POST /api/v1/devices/register
 * Register a new device and its push subscription.
 */
router.post('/register', authenticateUser, (req, res) => {
  const { name, subscription, user_agent } = req.body;

  if (!name) {
    return res.status(400).json({ status: 0, errors: ['Device name is required'] });
  }

  // Check if device already exists for this user
  let device = db.get(
    'SELECT * FROM devices WHERE user_id = ? AND name = ?',
    [req.dbUser.id, name]
  );

  if (device) {
    // Update existing device
    db.run(
      `UPDATE devices SET
        push_endpoint = ?, push_p256dh = ?, push_auth = ?,
        is_active = 1, user_agent = ?, last_seen = datetime('now')
       WHERE id = ?`,
      [
        subscription?.endpoint || null,
        subscription?.keys?.p256dh || null,
        subscription?.keys?.auth || null,
        user_agent || null,
        device.id,
      ]
    );
  } else {
    // Create new device
    const deviceId = uuidv4();
    db.run(
      `INSERT INTO devices (id, user_id, name, push_endpoint, push_p256dh, push_auth, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        deviceId,
        req.dbUser.id,
        name,
        subscription?.endpoint || null,
        subscription?.keys?.p256dh || null,
        subscription?.keys?.auth || null,
        user_agent || null,
      ]
    );
    device = db.get('SELECT * FROM devices WHERE id = ?', [deviceId]);
  }

  res.json({
    status: 1,
    device: {
      id: device.id,
      name: device.name || name,
      is_active: 1,
      has_push: !!(subscription?.endpoint),
    },
  });
});

/**
 * PUT /api/v1/devices/:id/subscription
 * Update push subscription for a device (e.g., when subscription refreshes).
 */
router.put('/:id/subscription', authenticateUser, (req, res) => {
  const { subscription } = req.body;

  const device = db.get(
    'SELECT * FROM devices WHERE id = ? AND user_id = ?',
    [req.params.id, req.dbUser.id]
  );

  if (!device) {
    return res.status(404).json({ status: 0, errors: ['Device not found'] });
  }

  db.run(
    `UPDATE devices SET
      push_endpoint = ?, push_p256dh = ?, push_auth = ?,
      last_seen = datetime('now')
     WHERE id = ?`,
    [
      subscription?.endpoint || null,
      subscription?.keys?.p256dh || null,
      subscription?.keys?.auth || null,
      device.id,
    ]
  );

  res.json({ status: 1 });
});

/**
 * DELETE /api/v1/devices/:id
 * Deactivate a device.
 */
router.delete('/:id', authenticateUser, (req, res) => {
  db.run(
    'UPDATE devices SET is_active = 0, push_endpoint = NULL WHERE id = ? AND user_id = ?',
    [req.params.id, req.dbUser.id]
  );
  res.json({ status: 1 });
});

/**
 * GET /api/v1/devices/vapid-key
 * Get the VAPID public key for push subscription (no auth needed).
 */
router.get('/vapid-key', (req, res) => {
  res.json({
    status: 1,
    vapid_public_key: config.vapid.publicKey,
  });
});

module.exports = router;
