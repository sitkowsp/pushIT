const { v4: uuidv4 } = require('uuid');
const db = require('../db/db');
const push = require('./push');
const config = require('../config');

let retryTimer = null;

/**
 * Create an emergency retry tracker for a priority=2 message.
 */
function createEmergencyRetry(messageId, options = {}) {
  const receipt = uuidv4().replace(/-/g, '').substring(0, 30);
  const retryInterval = Math.max(options.retry || config.emergency.retryInterval, 30);
  const expireDuration = Math.min(options.expire || config.emergency.maxDuration, 10800);
  const expireAt = new Date(Date.now() + expireDuration * 1000).toISOString();

  db.run(
    `INSERT INTO emergency_retries (id, message_id, receipt, retry_interval, expire_at, callback_url, tags)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [uuidv4(), messageId, receipt, retryInterval, expireAt, options.callback_url || null, options.tags || null]
  );

  // Update the message with the receipt
  db.run('UPDATE messages SET receipt = ? WHERE id = ?', [receipt, messageId]);

  return receipt;
}

/**
 * Acknowledge an emergency notification by receipt.
 */
async function acknowledgeByReceipt(receipt, acknowledgedBy) {
  const retry = db.get('SELECT * FROM emergency_retries WHERE receipt = ? AND is_active = 1', [receipt]);
  if (!retry) return null;

  // Stop retrying
  db.run('UPDATE emergency_retries SET is_active = 0 WHERE id = ?', [retry.id]);

  // Mark the message as acknowledged
  db.run(
    `UPDATE messages SET acknowledged = 1, acknowledged_at = datetime('now'), acknowledged_by = ? WHERE id = ?`,
    [acknowledgedBy, retry.message_id]
  );

  // Fire callback if configured
  if (retry.callback_url) {
    try {
      const message = db.get('SELECT * FROM messages WHERE id = ?', [retry.message_id]);
      await fireCallback(retry.callback_url, {
        receipt: receipt,
        acknowledged: 1,
        acknowledged_at: new Date().toISOString(),
        acknowledged_by: acknowledgedBy,
        message_id: retry.message_id,
        message_title: message?.title,
      });
    } catch (err) {
      console.error('[Emergency] Callback failed:', err.message);
    }
  }

  return retry;
}

/**
 * Cancel all emergency retries matching a tag.
 */
function cancelByTag(tag) {
  const result = db.run(
    'UPDATE emergency_retries SET is_active = 0 WHERE tags LIKE ? AND is_active = 1',
    [`%${tag}%`]
  );
  return result.changes;
}

/**
 * Process all active emergency retries (called periodically).
 */
async function processRetries() {
  const now = new Date().toISOString();

  // Expire old retries
  db.run('UPDATE emergency_retries SET is_active = 0 WHERE expire_at < ? AND is_active = 1', [now]);

  // Get all active retries due for resend
  const retries = db.all(
    `SELECT er.*, m.user_id, m.title, m.message, m.priority, m.sound, m.url, m.url_title
     FROM emergency_retries er
     JOIN messages m ON er.message_id = m.id
     WHERE er.is_active = 1
       AND er.retries_sent < er.max_retries
       AND (er.last_retry_at IS NULL OR datetime(er.last_retry_at, '+' || er.retry_interval || ' seconds') <= datetime('now'))`,
    []
  );

  for (const retry of retries) {
    const payload = {
      id: retry.message_id,
      title: retry.title || 'Emergency Alert',
      message: retry.message,
      priority: retry.priority,
      sound: retry.sound || 'persistent',
      url: retry.url,
      url_title: retry.url_title,
      receipt: retry.receipt,
      isRetry: true,
      retryCount: retry.retries_sent + 1,
    };

    await push.sendToUser(retry.user_id, payload);

    db.run(
      `UPDATE emergency_retries SET retries_sent = retries_sent + 1, last_retry_at = datetime('now') WHERE id = ?`,
      [retry.id]
    );
  }

  if (retries.length > 0) {
    console.log(`[Emergency] Processed ${retries.length} retry(s)`);
  }
}

/**
 * Fire a callback URL (for acknowledged emergency notifications).
 */
async function fireCallback(url, data) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`Callback returned ${response.status}`);
  }

  return response;
}

/**
 * Start the emergency retry processor (runs every 15 seconds).
 */
function startRetryProcessor() {
  retryTimer = setInterval(processRetries, 15000);
  console.log('[Emergency] Retry processor started (15s interval)');
}

/**
 * Stop the emergency retry processor.
 */
function stopRetryProcessor() {
  if (retryTimer) {
    clearInterval(retryTimer);
    retryTimer = null;
    console.log('[Emergency] Retry processor stopped');
  }
}

module.exports = {
  createEmergencyRetry,
  acknowledgeByReceipt,
  cancelByTag,
  processRetries,
  startRetryProcessor,
  stopRetryProcessor,
};
