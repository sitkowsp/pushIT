const express = require('express');
const crypto = require('crypto');
const https = require('https');
const jwt = require('jsonwebtoken');
const router = express.Router();
const config = require('../config');
const { authenticateUser } = require('../middleware/auth');

// ─── Session JWT helper ──────────────────────────────────────────────
// We create a self-signed JWT (using SESSION_SECRET) stored in an
// httpOnly cookie. This avoids the need for server-side session storage.

const SESSION_COOKIE = 'pushit_session';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60; // 7 days in seconds

function createSessionToken(userInfo) {
  return jwt.sign(userInfo, config.session.secret, { expiresIn: SESSION_MAX_AGE });
}

function verifySessionToken(token) {
  try {
    return jwt.verify(token, config.session.secret);
  } catch (e) {
    return null;
  }
}

// ─── OAuth2 Authorization Code Flow ──────────────────────────────────

// Pending auth states (code_verifier + nonce, keyed by state param)
// Cleaned up after 5 minutes or on use.
const pendingStates = new Map();

function cleanExpiredStates() {
  const now = Date.now();
  for (const [key, val] of pendingStates) {
    if (now - val.created > 5 * 60 * 1000) pendingStates.delete(key);
  }
}

/**
 * GET /api/v1/auth/login
 * Start the OAuth2 Authorization Code Flow.
 * Redirects the browser to Azure AD's authorize endpoint.
 * Azure AD will authenticate the user (or use existing session from
 * Application Proxy) and redirect back to /api/v1/auth/callback.
 */
router.get('/login', (req, res) => {
  cleanExpiredStates();

  const state = crypto.randomBytes(32).toString('hex');
  const nonce = crypto.randomBytes(16).toString('hex');

  // PKCE: generate code_verifier + code_challenge
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');

  pendingStates.set(state, { codeVerifier, nonce, created: Date.now() });

  const params = new URLSearchParams({
    client_id: config.azure.clientId,
    response_type: 'code',
    redirect_uri: `${config.baseUrl}/api/v1/auth/callback`,
    scope: 'openid profile email',
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    // Do NOT use prompt=none — let Azure AD decide:
    // - If user has session (from App Proxy): silent, instant redirect
    // - If no session (internal network): shows login page
  });

  const authorizeUrl = `${config.azure.authority}/oauth2/v2.0/authorize?${params}`;
  console.log('[Auth] Starting auth code flow, redirecting to Azure AD');
  res.redirect(authorizeUrl);
});

/**
 * GET /api/v1/auth/callback
 * OAuth2 callback — exchange authorization code for tokens.
 * Azure AD redirects here after the user authenticates.
 */
router.get('/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    console.error('[Auth] OAuth2 error:', error, error_description);
    return res.status(400).send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px;">
        <h2>Authentication Error</h2>
        <p>${error}: ${error_description || 'Unknown error'}</p>
        <a href="/">Try Again</a>
      </body></html>
    `);
  }

  if (!code || !state) {
    return res.status(400).send('Missing code or state parameter');
  }

  const pending = pendingStates.get(state);
  if (!pending) {
    return res.status(400).send('Invalid or expired state. Please try again.');
  }
  pendingStates.delete(state);

  try {
    // Exchange authorization code for tokens
    const tokenResponse = await exchangeCodeForTokens(code, pending.codeVerifier);

    if (!tokenResponse.id_token) {
      throw new Error('No id_token in response');
    }

    // Decode the id_token (we trust Azure AD — the code exchange validates it)
    const parts = tokenResponse.id_token.split('.');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());

    const userInfo = {
      entraObjectId: payload.oid || payload.sub,
      email: payload.preferred_username || payload.email || payload.upn,
      displayName: payload.name || (payload.preferred_username || '').split('@')[0],
      tenantId: payload.tid,
    };

    if (!userInfo.email) {
      throw new Error('No email claim in id_token');
    }

    console.log('[Auth] Auth code flow success:', userInfo.email);

    // Create session JWT and set as httpOnly cookie
    const sessionToken = createSessionToken(userInfo);

    res.cookie(SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      secure: config.isHttps,  // Only set secure flag when BASE_URL is HTTPS
      sameSite: 'lax',         // Allow redirect from Azure AD
      maxAge: SESSION_MAX_AGE * 1000, // ms
      path: '/',
    });

    // Redirect to the app
    res.redirect('/');
  } catch (err) {
    console.error('[Auth] Token exchange failed:', err.message);
    res.status(500).send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px;">
        <h2>Authentication Failed</h2>
        <p>${err.message}</p>
        <a href="/">Try Again</a>
      </body></html>
    `);
  }
});

/**
 * Exchange an authorization code for tokens via Azure AD's token endpoint.
 */
function exchangeCodeForTokens(code, codeVerifier) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      client_id: config.azure.clientId,
      client_secret: config.azure.clientSecret,
      code,
      redirect_uri: `${config.baseUrl}/api/v1/auth/callback`,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    }).toString();

    const url = new URL(`${config.azure.authority}/oauth2/v2.0/token`);

    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const request = https.request(options, (response) => {
      let data = '';
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(`${parsed.error}: ${parsed.error_description || ''}`));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject(new Error('Failed to parse token response'));
        }
      });
    });

    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

/**
 * GET /api/v1/auth/config
 * Return app configuration for the frontend.
 */
router.get('/config', (req, res) => {
  res.json({
    vapidPublicKey: config.vapid.publicKey,
    authMode: config.authMode,  // 'entra' or 'local'
    registrationOpen: config.authMode === 'local' ? config.localAuth.registrationOpen : false,
  });
});

/**
 * GET /api/v1/auth/me
 * Return the current user's profile.
 */
router.get('/me', authenticateUser, (req, res) => {
  res.json({
    status: 1,
    user: {
      id: req.dbUser.id,
      user_key: req.dbUser.user_key,
      email: req.dbUser.email,
      display_name: req.dbUser.display_name,
      is_admin: req.dbUser.is_admin,
      quiet_hours_start: req.dbUser.quiet_hours_start,
      quiet_hours_end: req.dbUser.quiet_hours_end,
      default_sound: req.dbUser.default_sound,
      created_at: req.dbUser.created_at,
    },
    authMethod: req.user.authMethod,
  });
});

/**
 * PUT /api/v1/auth/me
 * Update current user's settings.
 */
router.put('/me', authenticateUser, (req, res) => {
  const { quiet_hours_start, quiet_hours_end, default_sound } = req.body;
  const db = require('../db/db');

  const updates = [];
  const params = [];

  if (quiet_hours_start !== undefined) {
    updates.push('quiet_hours_start = ?');
    params.push(quiet_hours_start || null);
  }
  if (quiet_hours_end !== undefined) {
    updates.push('quiet_hours_end = ?');
    params.push(quiet_hours_end || null);
  }
  if (default_sound !== undefined) {
    updates.push('default_sound = ?');
    params.push(default_sound);
  }

  if (updates.length > 0) {
    updates.push("updated_at = datetime('now')");
    params.push(req.dbUser.id);
    db.run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
  }

  res.json({ status: 1 });
});

/**
 * POST /api/v1/auth/logout
 * Clear the session cookie.
 */
router.post('/logout', (req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ status: 1 });
});

/**
 * GET /api/v1/auth/debug
 * Debug endpoint — shows all headers and which auth strategy will match.
 */
router.get('/debug', (req, res) => {
  const hdr = config.proxyHeaders;

  // Collect relevant headers
  const allHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (
      key.startsWith('x-ms-') ||
      key.startsWith('x-forwarded-') ||
      key.startsWith('x-user-') ||
      key.startsWith('x-wamsauth-') ||
      key === 'authorization' ||
      key === 'cookie'
    ) {
      if (key === 'authorization') {
        allHeaders[key] = value.substring(0, 30) + '...';
      } else if (key === 'cookie') {
        // Show cookie names only, not values
        allHeaders[key] = value.replace(/=([^;]+)/g, '=<redacted>');
      } else {
        allHeaders[key] = value;
      }
    }
  }

  // Check session cookie
  const sessionCookie = req.cookies && req.cookies[SESSION_COOKIE];
  const sessionUser = sessionCookie ? verifySessionToken(sessionCookie) : null;

  const strategies = {
    'Strategy 0 — Session Cookie': {
      hasCookie: !!sessionCookie,
      valid: !!sessionUser,
      user: sessionUser ? { email: sessionUser.email, name: sessionUser.displayName } : null,
      willMatch: !!sessionUser,
    },
    'Strategy 1 — Custom SSO Headers': {
      configured: `email=${hdr.email}, name=${hdr.displayName}, oid=${hdr.objectId}, upn=${hdr.upn}`,
      emailHeader: req.headers[hdr.email] || null,
      willMatch: !!(req.headers[hdr.email] || req.headers[hdr.upn]),
    },
    'Strategy 2 — MS Client Principal': {
      principalName: req.headers['x-ms-client-principal-name'] || null,
      willMatch: !!req.headers['x-ms-client-principal-name'],
    },
    'Strategy 3 — Token Passthrough': {
      hasIdToken: !!req.headers['x-ms-token-aad-id-token'],
      willMatch: !!req.headers['x-ms-token-aad-id-token'],
    },
    'Strategy 4 — Bearer JWT': {
      hasBearer: !!(req.headers.authorization && req.headers.authorization.startsWith('Bearer ')),
      willMatch: !!(req.headers.authorization && req.headers.authorization.startsWith('Bearer ')),
    },
  };

  let activeStrategy = 'NONE — user will get 401';
  for (const [name, s] of Object.entries(strategies)) {
    if (s.willMatch) { activeStrategy = name; break; }
  }

  res.json({
    status: 1,
    activeStrategy,
    strategies,
    allHeaders,
    remoteAddr: req.ip,
    loginUrl: activeStrategy.startsWith('NONE') ? '/api/v1/auth/login' : null,
    hint: activeStrategy.startsWith('NONE')
      ? 'No auth detected. Visit /api/v1/auth/login to start server-side OAuth flow.'
      : null,
  });
});

// Export session helpers for use in middleware
router._verifySessionToken = verifySessionToken;
router._SESSION_COOKIE = SESSION_COOKIE;

module.exports = router;
