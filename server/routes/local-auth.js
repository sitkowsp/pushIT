const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const router = express.Router();
const config = require('../config');
const db = require('../db/db');
const { authenticateUser, generateUserKey } = require('../middleware/auth');

const SESSION_COOKIE = 'pushit_session';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60; // 7 days

function createSessionToken(userInfo) {
  return jwt.sign(userInfo, config.session.secret, { expiresIn: SESSION_MAX_AGE });
}

// Email validation (basic but sufficient)
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Password validation (8-128 chars, at least 1 letter and 1 number)
// Max 128 to prevent bcrypt DoS (bcrypt truncates at 72 bytes anyway)
function isValidPassword(password) {
  return password && password.length >= 8 && password.length <= 128 &&
    /[a-zA-Z]/.test(password) && /[0-9]/.test(password);
}

// Display name validation
function isValidDisplayName(name) {
  return name && name.length >= 1 && name.length <= 100;
}

/**
 * POST /api/v1/local-auth/register
 * Register a new account with email and password.
 * Only available when authMode is 'local'.
 */
router.post('/register', async (req, res) => {
  if (config.authMode !== 'local') {
    return res.status(404).json({ status: 0, errors: ['Local registration is not enabled'] });
  }

  if (!config.localAuth.registrationOpen) {
    return res.status(403).json({ status: 0, errors: ['Registration is currently closed. Ask an admin for an invite.'] });
  }

  const { email, password, display_name } = req.body;

  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ status: 0, errors: ['A valid email address is required'] });
  }
  if (!isValidPassword(password)) {
    return res.status(400).json({ status: 0, errors: ['Password must be 8-128 characters with at least 1 letter and 1 number'] });
  }
  if (!isValidDisplayName(display_name?.trim())) {
    return res.status(400).json({ status: 0, errors: ['Display name is required (max 100 characters)'] });
  }

  // Check for existing user
  const existing = db.get('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
  if (existing) {
    return res.status(409).json({ status: 0, errors: ['An account with this email already exists'] });
  }

  try {
    const { v4: uuidv4 } = require('uuid');
    const userId = uuidv4();
    const userKey = generateUserKey();
    const passwordHash = await bcrypt.hash(password, config.localAuth.bcryptRounds);
    const verificationToken = crypto.randomBytes(32).toString('hex');

    // Use 'local:<email>' as entra_object_id for compatibility with old schemas
    // where entra_object_id has a NOT NULL constraint.
    db.run(
      `INSERT INTO users (id, entra_object_id, email, display_name, user_key, password_hash, auth_type, email_verified, verification_token, last_login)
       VALUES (?, ?, ?, ?, ?, ?, 'local', 0, ?, datetime('now'))`,
      [userId, `local:${email.toLowerCase()}`, email.toLowerCase(), display_name.trim(), userKey, passwordHash, verificationToken]
    );

    console.log(`[LocalAuth] New user registered: ${email} (${userId})`);

    // Send verification email if SMTP is configured
    if (config.smtp.configured) {
      try {
        await sendVerificationEmail(email.toLowerCase(), verificationToken);
      } catch (emailErr) {
        console.warn('[LocalAuth] Failed to send verification email:', emailErr.message);
        // Don't block registration if email fails
      }
    } else {
      // No SMTP — auto-verify the user
      db.run('UPDATE users SET email_verified = 1, verification_token = NULL WHERE id = ?', [userId]);
    }

    // Create session immediately (user can start using the app)
    const userInfo = {
      userId,
      email: email.toLowerCase(),
      displayName: display_name.trim(),
      authType: 'local',
    };
    const sessionToken = createSessionToken(userInfo);

    res.cookie(SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      secure: config.isHttps,
      sameSite: 'lax',
      maxAge: SESSION_MAX_AGE * 1000,
      path: '/',
    });

    res.json({
      status: 1,
      user: {
        id: userId,
        email: email.toLowerCase(),
        display_name: display_name.trim(),
        user_key: userKey,
      },
    });
  } catch (err) {
    console.error('[LocalAuth] Registration error:', err);
    res.status(500).json({ status: 0, errors: ['Registration failed'] });
  }
});

/**
 * POST /api/v1/local-auth/login
 * Login with email and password.
 */
router.post('/login', async (req, res) => {
  if (config.authMode !== 'local') {
    return res.status(404).json({ status: 0, errors: ['Local login is not enabled'] });
  }

  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ status: 0, errors: ['Email and password are required'] });
  }

  const user = db.get('SELECT * FROM users WHERE email = ? AND auth_type = ?', [email.toLowerCase(), 'local']);
  if (!user) {
    return res.status(401).json({ status: 0, errors: ['Invalid email or password'] });
  }

  try {
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ status: 0, errors: ['Invalid email or password'] });
    }

    // Update last login
    db.run(`UPDATE users SET last_login = datetime('now') WHERE id = ?`, [user.id]);

    const userInfo = {
      userId: user.id,
      email: user.email,
      displayName: user.display_name,
      authType: 'local',
    };
    const sessionToken = createSessionToken(userInfo);

    res.cookie(SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      secure: config.isHttps,
      sameSite: 'lax',
      maxAge: SESSION_MAX_AGE * 1000,
      path: '/',
    });

    console.log(`[LocalAuth] Login success: ${email}`);

    res.json({ status: 1 });
  } catch (err) {
    console.error('[LocalAuth] Login error:', err);
    res.status(500).json({ status: 0, errors: ['Login failed'] });
  }
});

/**
 * GET /api/v1/local-auth/verify-email/:token
 * Verify user's email address.
 */
router.get('/verify-email/:token', (req, res) => {
  const user = db.get('SELECT * FROM users WHERE verification_token = ?', [req.params.token]);

  if (!user) {
    return res.status(400).send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px;">
        <h2>Invalid Link</h2>
        <p>This verification link is invalid or has already been used.</p>
        <a href="/">Go to pushIT</a>
      </body></html>
    `);
  }

  db.run('UPDATE users SET email_verified = 1, verification_token = NULL WHERE id = ?', [user.id]);
  console.log(`[LocalAuth] Email verified: ${user.email}`);

  res.send(`
    <html><body style="font-family:sans-serif;text-align:center;padding:60px;">
      <h2>Email Verified!</h2>
      <p>Your email address has been verified. You can now use all features.</p>
      <a href="/">Go to pushIT</a>
    </body></html>
  `);
});

/**
 * POST /api/v1/local-auth/forgot-password
 * Request a password reset email.
 */
router.post('/forgot-password', async (req, res) => {
  if (config.authMode !== 'local') {
    return res.status(404).json({ status: 0, errors: ['Not available'] });
  }

  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ status: 0, errors: ['Email is required'] });
  }

  const user = db.get('SELECT * FROM users WHERE email = ? AND auth_type = ?', [email.toLowerCase(), 'local']);

  // Always return success to prevent email enumeration
  if (!user) {
    return res.json({ status: 1, message: 'If an account with that email exists, a reset link has been sent.' });
  }

  // Prefix with 'reset:' to distinguish from email verification tokens,
  // and embed a timestamp so we can enforce expiry (1 hour).
  const resetToken = `reset:${Date.now()}:${crypto.randomBytes(32).toString('hex')}`;
  db.run('UPDATE users SET verification_token = ? WHERE id = ?', [resetToken, user.id]);

  if (config.smtp.configured) {
    try {
      await sendPasswordResetEmail(user.email, resetToken);
    } catch (err) {
      console.warn('[LocalAuth] Failed to send reset email:', err.message);
    }
  }

  res.json({ status: 1, message: 'If an account with that email exists, a reset link has been sent.' });
});

/**
 * POST /api/v1/local-auth/reset-password
 * Reset password using a reset token.
 */
router.post('/reset-password', async (req, res) => {
  if (config.authMode !== 'local') {
    return res.status(404).json({ status: 0, errors: ['Not available'] });
  }

  const { token, password } = req.body;
  if (!token || !password) {
    return res.status(400).json({ status: 0, errors: ['Token and new password are required'] });
  }

  if (!isValidPassword(password)) {
    return res.status(400).json({ status: 0, errors: ['Password must be 8-128 characters with at least 1 letter and 1 number'] });
  }

  // Accept both prefixed (new) and unprefixed (legacy) tokens
  const fullToken = token.startsWith('reset:') ? token : `reset:0:${token}`;
  const user = db.get(
    'SELECT * FROM users WHERE (verification_token = ? OR verification_token = ?) AND auth_type = ?',
    [token, fullToken, 'local']
  );
  if (!user) {
    return res.status(400).json({ status: 0, errors: ['Invalid or expired reset token'] });
  }

  // Enforce 1-hour expiry on reset tokens
  const storedToken = user.verification_token || '';
  if (storedToken.startsWith('reset:')) {
    const parts = storedToken.split(':');
    const created = parseInt(parts[1], 10);
    if (created > 0 && Date.now() - created > 3600000) { // 1 hour
      db.run('UPDATE users SET verification_token = NULL WHERE id = ?', [user.id]);
      return res.status(400).json({ status: 0, errors: ['Reset token has expired. Please request a new one.'] });
    }
  }

  try {
    const passwordHash = await bcrypt.hash(password, config.localAuth.bcryptRounds);
    db.run('UPDATE users SET password_hash = ?, verification_token = NULL WHERE id = ?', [passwordHash, user.id]);

    console.log(`[LocalAuth] Password reset: ${user.email}`);
    res.json({ status: 1 });
  } catch (err) {
    console.error('[LocalAuth] Password reset error:', err);
    res.status(500).json({ status: 0, errors: ['Password reset failed'] });
  }
});

// ─── Email helpers ──────────────────────────────────────────────────

async function sendVerificationEmail(email, token) {
  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
  });

  const verifyUrl = `${config.baseUrl}/api/v1/local-auth/verify-email/${token}`;

  await transporter.sendMail({
    from: config.smtp.from,
    to: email,
    subject: 'pushIT — Verify your email',
    text: `Welcome to pushIT!\n\nVerify your email by visiting:\n${verifyUrl}\n\nIf you didn't create this account, ignore this email.`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
        <h2>Welcome to pushIT!</h2>
        <p>Verify your email by clicking the button below:</p>
        <p><a href="${verifyUrl}" style="display:inline-block;padding:12px 24px;background:#e94560;color:#fff;text-decoration:none;border-radius:6px;">Verify Email</a></p>
        <p style="color:#666;font-size:13px;">If you didn't create this account, ignore this email.</p>
      </div>
    `,
  });
}

async function sendPasswordResetEmail(email, token) {
  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
  });

  const resetUrl = `${config.baseUrl}/#reset-password?token=${token}`;

  await transporter.sendMail({
    from: config.smtp.from,
    to: email,
    subject: 'pushIT — Reset your password',
    text: `Reset your pushIT password by visiting:\n${resetUrl}\n\nIf you didn't request this, ignore this email.`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
        <h2>Reset your password</h2>
        <p>Click the button below to set a new password:</p>
        <p><a href="${resetUrl}" style="display:inline-block;padding:12px 24px;background:#e94560;color:#fff;text-decoration:none;border-radius:6px;">Reset Password</a></p>
        <p style="color:#666;font-size:13px;">If you didn't request this, ignore this email.</p>
      </div>
    `,
  });
}

// ─── Invite acceptance (register via invite link) ───────────────────

/**
 * POST /api/v1/local-auth/register-invite
 * Register via an organization invite token.
 * Works even when REGISTRATION_OPEN is false.
 */
router.post('/register-invite', async (req, res) => {
  if (config.authMode !== 'local') {
    return res.status(404).json({ status: 0, errors: ['Not available'] });
  }

  const { invite_token, password, display_name } = req.body;

  if (!invite_token) {
    return res.status(400).json({ status: 0, errors: ['Invite token is required'] });
  }
  if (!isValidPassword(password)) {
    return res.status(400).json({ status: 0, errors: ['Password must be 8-128 characters with at least 1 letter and 1 number'] });
  }

  // Find valid invite
  const invite = db.get(
    `SELECT * FROM org_invites WHERE token = ? AND accepted_at IS NULL AND expires_at > datetime('now')`,
    [invite_token]
  );

  if (!invite) {
    return res.status(400).json({ status: 0, errors: ['Invalid or expired invite'] });
  }

  // Check if user already exists
  const existing = db.get('SELECT * FROM users WHERE email = ?', [invite.email.toLowerCase()]);
  if (existing) {
    // User exists — just add them to the org
    const alreadyMember = db.get(
      'SELECT 1 FROM org_members WHERE organization_id = ? AND user_id = ?',
      [invite.organization_id, existing.id]
    );
    if (!alreadyMember) {
      db.run(
        'INSERT INTO org_members (organization_id, user_id, role) VALUES (?, ?, ?)',
        [invite.organization_id, existing.id, 'member']
      );
    }
    db.run(`UPDATE org_invites SET accepted_at = datetime('now') WHERE id = ?`, [invite.id]);
    return res.json({ status: 1, message: 'You have been added to the organization. Please login.' });
  }

  try {
    const { v4: uuidv4 } = require('uuid');
    const userId = uuidv4();
    const userKey = generateUserKey();
    const passwordHash = await bcrypt.hash(password, config.localAuth.bcryptRounds);

    db.run(
      `INSERT INTO users (id, entra_object_id, email, display_name, user_key, password_hash, auth_type, email_verified, last_login)
       VALUES (?, ?, ?, ?, ?, ?, 'local', 1, datetime('now'))`,
      [userId, `local:${invite.email.toLowerCase()}`, invite.email.toLowerCase(), (display_name || invite.email.split('@')[0]).trim(), userKey, passwordHash]
    );

    // Add to organization
    db.run(
      'INSERT INTO org_members (organization_id, user_id, role) VALUES (?, ?, ?)',
      [invite.organization_id, userId, 'member']
    );

    // Mark invite as accepted
    db.run(`UPDATE org_invites SET accepted_at = datetime('now') WHERE id = ?`, [invite.id]);

    console.log(`[LocalAuth] User registered via invite: ${invite.email} → org ${invite.organization_id}`);

    // Create session
    const sessionToken = createSessionToken({
      userId,
      email: invite.email.toLowerCase(),
      displayName: (display_name || invite.email.split('@')[0]).trim(),
      authType: 'local',
    });

    res.cookie(SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      secure: config.isHttps,
      sameSite: 'lax',
      maxAge: SESSION_MAX_AGE * 1000,
      path: '/',
    });

    res.json({ status: 1 });
  } catch (err) {
    console.error('[LocalAuth] Invite registration error:', err);
    res.status(500).json({ status: 0, errors: ['Registration failed'] });
  }
});

module.exports = router;
