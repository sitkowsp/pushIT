const express = require('express');
const router = express.Router();
const { authenticateUser } = require('../middleware/auth');
const { getSmtpConfig, saveSmtpConfig, deleteSmtpConfig, testSmtpConfig } = require('../services/smtp-config');
const config = require('../config');

/**
 * GET /api/v1/settings/smtp
 * Get SMTP configuration status. Admin only.
 * Returns whether SMTP is configured and its source (env or database).
 * Never returns the password.
 */
router.get('/smtp', authenticateUser, (req, res) => {
  if (!req.dbUser.is_admin) {
    return res.status(403).json({ status: 0, errors: ['Admin only'] });
  }

  const smtpCfg = getSmtpConfig();

  // If configured via .env, the UI cannot modify it
  const envConfigured = config.smtp.configured;

  if (smtpCfg) {
    return res.json({
      status: 1,
      smtp: {
        configured: true,
        source: smtpCfg.source,
        host: smtpCfg.host,
        port: smtpCfg.port,
        secure: smtpCfg.secure,
        user: smtpCfg.user,
        from: smtpCfg.from,
        // Never send password to frontend
      },
      envConfigured,
    });
  }

  res.json({
    status: 1,
    smtp: { configured: false },
    envConfigured,
  });
});

/**
 * POST /api/v1/settings/smtp
 * Save SMTP configuration to database. Admin only.
 * Only works when SMTP is NOT configured via .env.
 */
router.post('/smtp', authenticateUser, (req, res) => {
  if (!req.dbUser.is_admin) {
    return res.status(403).json({ status: 0, errors: ['Admin only'] });
  }

  if (config.smtp.configured) {
    return res.status(400).json({ status: 0, errors: ['SMTP is configured via .env and cannot be changed from the UI'] });
  }

  const { host, port, secure, user, pass, from } = req.body;

  if (!host || !user) {
    return res.status(400).json({ status: 0, errors: ['SMTP host and user are required'] });
  }

  // If password is empty, keep the existing one from DB
  let effectivePass = pass || '';
  if (!effectivePass) {
    const db = require('../db/db');
    const row = db.get("SELECT value FROM settings WHERE key = 'smtp_config'");
    if (row) {
      try { effectivePass = JSON.parse(row.value).pass || ''; } catch (e) { /* ignore */ }
    }
  }

  saveSmtpConfig({ host, port: port || 587, secure: secure || false, user, pass: effectivePass, from: from || 'noreply@example.com' });

  console.log(`[Settings] SMTP config saved by ${req.dbUser.email}`);
  res.json({ status: 1 });
});

/**
 * DELETE /api/v1/settings/smtp
 * Remove DB-stored SMTP configuration. Admin only.
 */
router.delete('/smtp', authenticateUser, (req, res) => {
  if (!req.dbUser.is_admin) {
    return res.status(403).json({ status: 0, errors: ['Admin only'] });
  }

  if (config.smtp.configured) {
    return res.status(400).json({ status: 0, errors: ['SMTP is configured via .env — remove it from .env to use UI configuration'] });
  }

  deleteSmtpConfig();
  console.log(`[Settings] SMTP config deleted by ${req.dbUser.email}`);
  res.json({ status: 1 });
});

/**
 * POST /api/v1/settings/smtp/test
 * Test SMTP configuration by sending a test email. Admin only.
 */
router.post('/smtp/test', authenticateUser, async (req, res) => {
  if (!req.dbUser.is_admin) {
    return res.status(403).json({ status: 0, errors: ['Admin only'] });
  }

  const { host, port, secure, user, pass, from } = req.body;

  if (!host || !user) {
    return res.status(400).json({ status: 0, errors: ['SMTP host and user are required'] });
  }

  // If password is empty, try to use the stored password from DB
  let effectivePass = pass || '';
  if (!effectivePass) {
    const existing = getSmtpConfig();
    if (existing && existing.source === 'database' && existing.host === host && existing.user === user) {
      // Re-read from DB to get the actual password (getSmtpConfig doesn't expose it to frontend)
      const db = require('../db/db');
      const row = db.get("SELECT value FROM settings WHERE key = 'smtp_config'");
      if (row) {
        try { effectivePass = JSON.parse(row.value).pass || ''; } catch (e) { /* ignore */ }
      }
    }
  }

  try {
    await testSmtpConfig(
      { host, port: port || 587, secure: secure || false, user, pass: effectivePass, from: from || 'noreply@example.com' },
      req.dbUser.email
    );
    res.json({ status: 1, message: `Test email sent to ${req.dbUser.email}` });
  } catch (err) {
    console.error('[Settings] SMTP test failed:', err.message);
    res.status(400).json({ status: 0, errors: [`SMTP test failed: ${err.message}`] });
  }
});

module.exports = router;
