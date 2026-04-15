const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();
const db = require('../db/db');
const { authenticateUser } = require('../middleware/auth');
const config = require('../config');

// Validation: letters, digits, dash, underscore, dot, space; 1–64 chars
const DEVICE_NAME_RE = /^[A-Za-z0-9._\- ]{1,64}$/;

/**
 * Find a unique device name for a user by appending -2, -3, ... if needed.
 * Only collides with active devices.
 */
function findUniqueName(userId, baseName) {
  const taken = new Set(
    db.all(
      'SELECT name FROM devices WHERE user_id = ? AND is_active = 1',
      [userId]
    ).map((r) => r.name)
  );
  if (!taken.has(baseName)) return baseName;
  let i = 2;
  while (taken.has(`${baseName}-${i}`)) i += 1;
  return `${baseName}-${i}`;
}

/**
 * GET /api/v1/devices
 * List all active devices for the authenticated user.
 */
router.get('/', authenticateUser, (req, res) => {
  const devices = db.all(
    'SELECT * FROM devices WHERE user_id = ? AND is_active = 1',
    [req.dbUser.id]
  );

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
 *
 * Matching rules:
 *   1. If a device with the same push_endpoint already exists for this user,
 *      update it in place (same browser re-subscribing). Name is preserved.
 *   2. Otherwise, create a new device. If the requested name collides with
 *      an existing active device, append -2, -3, ... to keep both rows.
 */
router.post('/register', authenticateUser, (req, res) => {
  const { name, subscription, user_agent } = req.body;

  if (!name) {
    return res.status(400).json({ status: 0, errors: ['Device name is required'] });
  }

  const endpoint = subscription?.endpoint || null;
  const p256dh = subscription?.keys?.p256dh || null;
  const auth = subscription?.keys?.auth || null;

  // 1. Match by push endpoint first (same browser re-subscribing)
  let device = endpoint
    ? db.get(
        'SELECT * FROM devices WHERE user_id = ? AND push_endpoint = ?',
        [req.dbUser.id, endpoint]
      )
    : null;

  if (device) {
    db.run(
      `UPDATE devices SET
        push_p256dh = ?, push_auth = ?,
        is_active = 1, user_agent = ?, last_seen = datetime('now')
       WHERE id = ?`,
      [p256dh, auth, user_agent || null, device.id]
    );
  } else {
    // 2. New device — find a unique name (auto-suffix on collision)
    const finalName = findUniqueName(req.dbUser.id, name);
    const deviceId = uuidv4();
    db.run(
      `INSERT INTO devices (id, user_id, name, push_endpoint, push_p256dh, push_auth, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        deviceId,
        req.dbUser.id,
        finalName,
        endpoint,
        p256dh,
        auth,
        user_agent || null,
      ]
    );
    device = db.get('SELECT * FROM devices WHERE id = ?', [deviceId]);
  }

  res.json({
    status: 1,
    device: {
      id: device.id,
      name: device.name,
      is_active: 1,
      has_push: !!endpoint,
    },
  });
});

/**
 * PUT /api/v1/devices/:id
 * Rename a device. Body: { name: "<new-name>" }.
 */
router.put('/:id', authenticateUser, (req, res) => {
  const raw = (req.body?.name || '').trim();

  if (!raw) {
    return res.status(400).json({ status: 0, errors: ['Name is required'] });
  }
  if (!DEVICE_NAME_RE.test(raw)) {
    return res.status(400).json({
      status: 0,
      errors: ['Name must be 1–64 chars: letters, digits, dash, underscore, dot, space'],
    });
  }

  const device = db.get(
    'SELECT * FROM devices WHERE id = ? AND user_id = ?',
    [req.params.id, req.dbUser.id]
  );
  if (!device) {
    return res.status(404).json({ status: 0, errors: ['Device not found'] });
  }

  // Reject if another active device for this user already uses the name
  const conflict = db.get(
    'SELECT id FROM devices WHERE user_id = ? AND is_active = 1 AND name = ? AND id != ?',
    [req.dbUser.id, raw, req.params.id]
  );
  if (conflict) {
    return res.status(409).json({ status: 0, errors: ['Name already in use'] });
  }

  db.run(
    `UPDATE devices SET name = ?, last_seen = datetime('now') WHERE id = ?`,
    [raw, device.id]
  );

  const updated = db.get('SELECT * FROM devices WHERE id = ?', [device.id]);
  res.json({
    status: 1,
    device: {
      id: updated.id,
      name: updated.name,
      is_active: updated.is_active,
      has_push: !!updated.push_endpoint,
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
 * Soft-delete a device: clears the push subscription and hides it from the list.
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
