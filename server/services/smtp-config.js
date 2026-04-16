/**
 * SMTP Configuration Service
 *
 * Resolves SMTP settings from two sources (in priority order):
 *   1. Environment variables (.env) — immutable at runtime
 *   2. Database `settings` table — configurable from the UI
 *
 * .env always wins: if SMTP_HOST + SMTP_USER are set in the environment,
 * DB-stored settings are ignored entirely.
 */

const config = require('../config');

/**
 * Get the active SMTP configuration.
 * Returns null if SMTP is not configured anywhere.
 */
function getSmtpConfig() {
  // Priority 1: .env config
  if (config.smtp.configured) {
    return {
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      user: config.smtp.user,
      pass: config.smtp.pass,
      from: config.smtp.from,
      source: 'env',
    };
  }

  // Priority 2: DB-stored settings (from UI configuration)
  try {
    const db = require('../db/db');
    const row = db.get("SELECT value FROM settings WHERE key = 'smtp_config'");
    if (row) {
      const parsed = JSON.parse(row.value);
      if (parsed.host && parsed.user) {
        return {
          host: parsed.host,
          port: parseInt(parsed.port || '587', 10),
          secure: parsed.secure === true || parsed.secure === 'true',
          user: parsed.user,
          pass: parsed.pass || '',
          from: parsed.from || 'noreply@example.com',
          source: 'database',
        };
      }
    }
  } catch (e) {
    // DB not ready yet, settings table doesn't exist, or malformed JSON
    if (e.message && !e.message.includes('not initialized')) {
      console.warn('[SMTP] Error reading DB config:', e.message);
    }
  }

  return null;
}

/**
 * Save SMTP configuration to the database settings table.
 */
function saveSmtpConfig(smtpSettings) {
  const db = require('../db/db');
  const value = JSON.stringify({
    host: smtpSettings.host,
    port: smtpSettings.port,
    secure: smtpSettings.secure,
    user: smtpSettings.user,
    pass: smtpSettings.pass,
    from: smtpSettings.from,
  });

  const existing = db.get("SELECT key FROM settings WHERE key = 'smtp_config'");
  if (existing) {
    db.run("UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = 'smtp_config'", [value]);
  } else {
    db.run("INSERT INTO settings (key, value) VALUES ('smtp_config', ?)", [value]);
  }
}

/**
 * Delete SMTP configuration from the database.
 */
function deleteSmtpConfig() {
  const db = require('../db/db');
  db.run("DELETE FROM settings WHERE key = 'smtp_config'");
}

/**
 * Test SMTP connection by sending a test email.
 */
async function testSmtpConfig(smtpSettings, testEmail) {
  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host: smtpSettings.host,
    port: parseInt(smtpSettings.port || '587', 10),
    secure: smtpSettings.secure === true || smtpSettings.secure === 'true',
    auth: { user: smtpSettings.user, pass: smtpSettings.pass },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
  });

  // Verify connection
  await transporter.verify();

  // Send test email
  await transporter.sendMail({
    from: smtpSettings.from || 'noreply@example.com',
    to: testEmail,
    subject: 'pushIT — SMTP Test',
    text: 'If you can read this, your SMTP configuration is working correctly!',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;text-align:center;padding:40px 20px;">
        <h2 style="color:#e94560;">pushIT SMTP Test</h2>
        <p>If you can read this, your SMTP configuration is working correctly!</p>
      </div>
    `,
  });
}

module.exports = {
  getSmtpConfig,
  saveSmtpConfig,
  deleteSmtpConfig,
  testSmtpConfig,
};
