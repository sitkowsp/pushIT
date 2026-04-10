const webPush = require('web-push');
const config = require('../config');
const db = require('../db/db');

/**
 * Initialize Web Push with VAPID keys.
 */
function initWebPush() {
  if (!config.vapid.publicKey || !config.vapid.privateKey) {
    console.warn('[Push] VAPID keys not configured. Push notifications disabled.');
    console.warn('[Push] Run: npm run vapid:generate');
    return false;
  }

  webPush.setVapidDetails(
    config.vapid.email,
    config.vapid.publicKey,
    config.vapid.privateKey
  );

  console.log('[Push] Web Push initialized with VAPID keys');
  return true;
}

/**
 * Send a push notification to a specific device.
 */
async function sendToDevice(device, payload) {
  if (!device.push_endpoint) {
    return { success: false, reason: 'No push subscription' };
  }

  const subscription = {
    endpoint: device.push_endpoint,
    keys: {
      p256dh: device.push_p256dh,
      auth: device.push_auth,
    },
  };

  const options = {
    TTL: payload.ttl || 86400, // Default 24 hours
    urgency: mapPriorityToUrgency(payload.priority),
    // Web Push topic max 32 chars, URL-safe Base64 only
    topic: payload.id ? payload.id.replace(/-/g, '').substring(0, 32) : undefined,
  };

  try {
    const result = await webPush.sendNotification(subscription, JSON.stringify(payload), options);
    console.log(`[Push] Sent to device ${device.id} (${device.name}): status=${result.statusCode}, endpoint=${device.push_endpoint.substring(0, 60)}...`);
    return { success: true };
  } catch (err) {
    if (err.statusCode === 410 || err.statusCode === 404) {
      // Subscription expired or invalid — deactivate device
      db.run('UPDATE devices SET is_active = 0 WHERE id = ?', [device.id]);
      console.log(`[Push] Device ${device.id} subscription expired, deactivated`);
      return { success: false, reason: 'Subscription expired', deactivated: true };
    }
    console.error(`[Push] Failed to send to device ${device.id}:`, err.message);
    return { success: false, reason: err.message };
  }
}

/**
 * Send a push notification to all active devices of a user.
 */
async function sendToUser(userId, payload, targetDevice = null) {
  let query = 'SELECT * FROM devices WHERE user_id = ? AND is_active = 1 AND push_endpoint IS NOT NULL';
  const params = [userId];

  if (targetDevice) {
    query += ' AND name = ?';
    params.push(targetDevice);
  }

  const devices = db.all(query, params);

  if (devices.length === 0) {
    return { success: false, delivered: 0, reason: 'No active devices' };
  }

  const results = await Promise.all(
    devices.map((device) => sendToDevice(device, payload))
  );

  const delivered = results.filter((r) => r.success).length;
  return { success: delivered > 0, delivered, total: devices.length };
}

/**
 * Send a push notification to all members of a group.
 */
async function sendToGroup(groupKey, payload) {
  const members = db.all(
    `SELECT u.id as user_id, gm.device_name
     FROM group_members gm
     JOIN users u ON gm.user_id = u.id
     JOIN groups g ON gm.group_id = g.id
     WHERE g.group_key = ?`,
    [groupKey]
  );

  if (members.length === 0) {
    return { success: false, delivered: 0, reason: 'No group members' };
  }

  let totalDelivered = 0;
  for (const member of members) {
    const result = await sendToUser(member.user_id, payload, member.device_name);
    totalDelivered += result.delivered || 0;
  }

  return { success: totalDelivered > 0, delivered: totalDelivered, members: members.length };
}

/**
 * Map pushIT priority (-2 to 2) to Web Push urgency.
 */
function mapPriorityToUrgency(priority) {
  switch (priority) {
    case -2: return 'very-low';
    case -1: return 'low';
    case 0:  return 'normal';
    case 1:  return 'high';
    case 2:  return 'high';
    default: return 'normal';
  }
}

module.exports = {
  initWebPush,
  sendToDevice,
  sendToUser,
  sendToGroup,
};
