/**
 * pushIT Authentication Module
 *
 * Server-side OAuth2 Authorization Code Flow.
 * No MSAL, no client-side tokens, no redirect loops.
 *
 * How it works:
 * 1. Frontend calls /api/v1/auth/me (with cookies)
 * 2. If 200: user is authenticated via session cookie → proceed
 * 3. If 401: redirect to /api/v1/auth/login
 *    → Server redirects to Azure AD authorize endpoint
 *    → Azure AD authenticates (or uses existing session from App Proxy)
 *    → Azure AD redirects to /api/v1/auth/callback with auth code
 *    → Server exchanges code for tokens, sets httpOnly session cookie
 *    → Server redirects to / (the app reloads)
 *    → Step 1 succeeds this time
 */

const PushitAuth = (() => {
  let currentUser = null;
  let authConfig = null; // { authMode, registrationOpen, vapidPublicKey }
  // NOTE: keep this in sync with package.json `version` and the ?v=… query
  // strings in public/index.html on every release.
  const CLIENT_VERSION = '1.11.0';

  /**
   * Initialize — check if we have a valid session.
   * Also checks for app updates and auto-refreshes if needed.
   */
  async function init() {
    try {
      // Check for app updates — non-blocking, don't delay auth
      checkForUpdates();

      // Fetch auth config to know which mode we're in
      try {
        const cfgRes = await fetch('/api/v1/auth/config');
        authConfig = await cfgRes.json();
      } catch (e) {
        authConfig = { authMode: 'entra' }; // default fallback
      }

      const res = await apiCall('/api/v1/auth/me');

      if (res.status === 401) {
        if (authConfig.authMode === 'local') {
          // Show local login/register form instead of redirecting to Azure
          console.log('[Auth] No session, showing local auth form...');
          showLocalAuthForm();
          return false;
        }
        console.log('[Auth] No session, redirecting to Entra login...');
        window.location.href = '/api/v1/auth/login';
        return false;
      }

      const data = await res.json();

      if (data.status === 1 && data.user) {
        currentUser = data.user;
        console.log('[Auth] Authenticated via', data.authMethod + ':', currentUser.display_name);

        // Handle hash-based routes (invite acceptance, password reset)
        await handleHashRoutes();

        return true;
      }

      console.warn('[Auth] Unexpected response from /auth/me:', data);
      return false;
    } catch (err) {
      console.error('[Auth] Init failed:', err.message);
      return false;
    }
  }

  /**
   * Handle hash-based routes (#accept-invite, #register-invite, #reset-password)
   */
  async function handleHashRoutes() {
    const hash = window.location.hash;
    if (!hash) return;

    if (hash.startsWith('#accept-invite?token=')) {
      const token = hash.split('token=')[1];
      if (token) {
        try {
          const res = await apiCall(`/api/v1/organizations/accept-invite/${token}`, { method: 'POST' });
          const data = await res.json();
          if (data.status === 1) {
            window.location.hash = '';
            // Will be handled by the app after loadApp()
          }
        } catch (e) {
          console.warn('[Auth] Failed to accept invite:', e.message);
        }
      }
    }
  }

  /**
   * Show the local auth login/register form.
   */
  function showLocalAuthForm() {
    const loginScreen = document.getElementById('login-screen');
    const statusEl = document.getElementById('auth-status');

    // Check if we need to show register-invite form
    const hash = window.location.hash;
    const isInviteRegister = hash.startsWith('#register-invite?token=');
    const isPasswordReset = hash.startsWith('#reset-password?token=');
    const inviteToken = isInviteRegister ? hash.split('token=')[1] : null;
    const resetToken = isPasswordReset ? hash.split('token=')[1] : null;

    // Clear existing content
    loginScreen.innerHTML = `
      <div class="logo">push<span style="color:#fff">IT</span></div>
      <p class="tagline">Self-hosted notifications for your team</p>

      <div id="local-auth-form" style="width:100%;max-width:320px;margin:24px auto 0;">
        ${isPasswordReset ? `
          <h3 style="color:#fff;margin-bottom:16px;text-align:center;">Reset Password</h3>
          <input type="password" id="la-new-password" placeholder="New password (min 8 chars)" style="width:100%;padding:12px;margin-bottom:8px;border-radius:8px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);box-sizing:border-box;">
          <button id="la-reset-btn" class="btn btn-primary" style="width:100%;padding:12px;margin-top:8px;">Set New Password</button>
        ` : isInviteRegister ? `
          <h3 style="color:#fff;margin-bottom:16px;text-align:center;">Join via Invite</h3>
          <input type="text" id="la-name" placeholder="Display name" style="width:100%;padding:12px;margin-bottom:8px;border-radius:8px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);box-sizing:border-box;">
          <input type="password" id="la-password" placeholder="Choose a password (min 8 chars)" style="width:100%;padding:12px;margin-bottom:8px;border-radius:8px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);box-sizing:border-box;">
          <button id="la-invite-register-btn" class="btn btn-primary" style="width:100%;padding:12px;margin-top:8px;">Create Account & Join</button>
        ` : `
          <div id="la-login-section">
            <input type="email" id="la-email" placeholder="Email" style="width:100%;padding:12px;margin-bottom:8px;border-radius:8px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);box-sizing:border-box;">
            <input type="password" id="la-password" placeholder="Password" style="width:100%;padding:12px;margin-bottom:8px;border-radius:8px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);box-sizing:border-box;">
            <button id="la-login-btn" class="btn btn-primary" style="width:100%;padding:12px;">Sign In</button>
            <p style="margin-top:12px;text-align:center;">
              <a href="#" id="la-forgot-link" style="color:var(--text-muted);font-size:13px;">Forgot password?</a>
            </p>
            ${authConfig.registrationOpen ? `
              <p style="margin-top:16px;text-align:center;color:var(--text-muted);font-size:13px;">
                Don't have an account? <a href="#" id="la-show-register" style="color:var(--primary);">Register</a>
              </p>
            ` : ''}
          </div>
          <div id="la-register-section" style="display:none;">
            <input type="text" id="la-reg-name" placeholder="Display name" style="width:100%;padding:12px;margin-bottom:8px;border-radius:8px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);box-sizing:border-box;">
            <input type="email" id="la-reg-email" placeholder="Email" style="width:100%;padding:12px;margin-bottom:8px;border-radius:8px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);box-sizing:border-box;">
            <input type="password" id="la-reg-password" placeholder="Password (min 8 chars, 1 letter, 1 number)" style="width:100%;padding:12px;margin-bottom:8px;border-radius:8px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);box-sizing:border-box;">
            <button id="la-register-btn" class="btn btn-primary" style="width:100%;padding:12px;">Create Account</button>
            <p style="margin-top:16px;text-align:center;color:var(--text-muted);font-size:13px;">
              Already have an account? <a href="#" id="la-show-login" style="color:var(--primary);">Sign In</a>
            </p>
          </div>
        `}
        <p id="la-error" style="color:#e94560;font-size:13px;margin-top:12px;text-align:center;display:none;"></p>
      </div>
    `;

    loginScreen.style.display = 'flex';

    // Wire up event handlers
    const showError = (msg) => {
      const el = document.getElementById('la-error');
      el.textContent = msg;
      el.style.display = 'block';
    };

    if (isPasswordReset && resetToken) {
      document.getElementById('la-reset-btn').addEventListener('click', async () => {
        const password = document.getElementById('la-new-password').value;
        try {
          const res = await apiCall('/api/v1/local-auth/reset-password', {
            method: 'POST',
            body: JSON.stringify({ token: resetToken, password }),
          });
          const data = await res.json();
          if (data.status === 1) {
            window.location.hash = '';
            window.location.reload();
          } else {
            showError(data.errors?.[0] || 'Reset failed');
          }
        } catch (e) {
          showError('Network error');
        }
      });
      return;
    }

    if (isInviteRegister && inviteToken) {
      document.getElementById('la-invite-register-btn').addEventListener('click', async () => {
        const display_name = document.getElementById('la-name').value;
        const password = document.getElementById('la-password').value;
        try {
          const res = await apiCall('/api/v1/local-auth/register-invite', {
            method: 'POST',
            body: JSON.stringify({ invite_token: inviteToken, password, display_name }),
          });
          const data = await res.json();
          if (data.status === 1) {
            window.location.hash = '';
            window.location.reload();
          } else {
            showError(data.errors?.[0] || 'Registration failed');
          }
        } catch (e) {
          showError('Network error');
        }
      });
      return;
    }

    // Login button
    document.getElementById('la-login-btn').addEventListener('click', async () => {
      const email = document.getElementById('la-email').value;
      const password = document.getElementById('la-password').value;
      try {
        const res = await apiCall('/api/v1/local-auth/login', {
          method: 'POST',
          body: JSON.stringify({ email, password }),
        });
        const data = await res.json();
        if (data.status === 1) {
          window.location.reload();
        } else {
          showError(data.errors?.[0] || 'Login failed');
        }
      } catch (e) {
        showError('Network error');
      }
    });

    // Enter key on password field triggers login
    const passwordField = document.getElementById('la-password');
    if (passwordField) {
      passwordField.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') document.getElementById('la-login-btn').click();
      });
    }

    // Forgot password link
    const forgotLink = document.getElementById('la-forgot-link');
    if (forgotLink) {
      forgotLink.addEventListener('click', async (e) => {
        e.preventDefault();
        const email = document.getElementById('la-email').value;
        if (!email) { showError('Enter your email first'); return; }
        try {
          const res = await apiCall('/api/v1/local-auth/forgot-password', {
            method: 'POST',
            body: JSON.stringify({ email }),
          });
          const data = await res.json();
          showError(data.message || 'Check your email for a reset link.');
          document.getElementById('la-error').style.color = '#4ecca3';
        } catch (e) {
          showError('Network error');
        }
      });
    }

    // Show/hide register form
    const showRegister = document.getElementById('la-show-register');
    const showLogin = document.getElementById('la-show-login');
    if (showRegister) {
      showRegister.addEventListener('click', (e) => {
        e.preventDefault();
        document.getElementById('la-login-section').style.display = 'none';
        document.getElementById('la-register-section').style.display = 'block';
        document.getElementById('la-error').style.display = 'none';
      });
    }
    if (showLogin) {
      showLogin.addEventListener('click', (e) => {
        e.preventDefault();
        document.getElementById('la-login-section').style.display = 'block';
        document.getElementById('la-register-section').style.display = 'none';
        document.getElementById('la-error').style.display = 'none';
      });
    }

    // Register button
    const registerBtn = document.getElementById('la-register-btn');
    if (registerBtn) {
      registerBtn.addEventListener('click', async () => {
        const display_name = document.getElementById('la-reg-name').value;
        const email = document.getElementById('la-reg-email').value;
        const password = document.getElementById('la-reg-password').value;
        try {
          const res = await apiCall('/api/v1/local-auth/register', {
            method: 'POST',
            body: JSON.stringify({ email, password, display_name }),
          });
          const data = await res.json();
          if (data.status === 1) {
            window.location.reload();
          } else {
            showError(data.errors?.[0] || 'Registration failed');
          }
        } catch (e) {
          showError('Network error');
        }
      });
    }
  }

  /**
   * Check if a newer version is deployed and auto-refresh.
   */
  async function checkForUpdates() {
    try {
      const res = await fetch('/api/v1/version', { cache: 'no-store' });
      const data = await res.json();
      if (data.version && data.version !== CLIENT_VERSION) {
        // Reload-loop guard: if we already reloaded for this server version
        // within the last 60s, the new bundle is still reporting the old
        // CLIENT_VERSION (release packaging missed bumping it). Don't loop —
        // log a warning and carry on so the app stays usable.
        const guardKey = 'pushit:lastVersionReload';
        const now = Date.now();
        let last = null;
        try { last = JSON.parse(sessionStorage.getItem(guardKey) || 'null'); } catch (e) {}
        if (last && last.serverVersion === data.version && (now - last.at) < 60000) {
          console.warn(`[Auth] Server is ${data.version} but client reports ${CLIENT_VERSION} after reload — skipping further reloads to avoid a loop. The release was packaged with a stale CLIENT_VERSION.`);
          return;
        }
        sessionStorage.setItem(guardKey, JSON.stringify({ serverVersion: data.version, at: now }));

        console.log(`[Auth] Update available: ${CLIENT_VERSION} → ${data.version}, refreshing...`);
        // Clear SW cache and reload
        if ('caches' in window) {
          const keys = await caches.keys();
          await Promise.all(keys.map((k) => caches.delete(k)));
        }
        window.location.reload();
      }
    } catch (e) {
      // Non-blocking — if version check fails, continue normally
    }
  }

  /**
   * Make an API call with credentials (session cookie).
   */
  async function apiCall(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'pushIT',  // CSRF protection — required for state-changing requests
        ...(options.headers || {}),
      },
    });

    return response;
  }

  /**
   * Sign out — clear session cookie and redirect to Azure AD logout.
   */
  async function signOut() {
    currentUser = null;

    try {
      await apiCall('/api/v1/auth/logout', { method: 'POST' });
    } catch (e) {}

    if (authConfig && authConfig.authMode === 'local') {
      // Local auth: just reload to show the login form
      window.location.reload();
    } else {
      // Entra auth: redirect to Azure AD logout
      const logoutUrl = 'https://login.microsoftonline.com/common/oauth2/v2.0/logout'
        + '?post_logout_redirect_uri=' + encodeURIComponent(window.location.origin);
      window.location.href = logoutUrl;
    }
  }

  /**
   * Clear local caches (service worker, browser caches).
   */
  function clearCache() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then((registrations) => {
        registrations.forEach((r) => r.unregister());
      });
    }
    if ('caches' in window) {
      caches.keys().then((keys) => keys.forEach((k) => caches.delete(k)));
    }
    console.log('[Auth] Cache cleared');
  }

  function isAuthenticated() {
    return !!currentUser;
  }

  function getUser() {
    return currentUser;
  }

  function getConfig() {
    return authConfig;
  }

  return {
    init,
    apiCall,
    signOut,
    clearCache,
    isAuthenticated,
    getUser,
    getConfig,
  };
})();
