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
  // NOTE: keep this in sync with package.json `version` and the ?v=… query
  // strings in public/index.html on every release.
  const CLIENT_VERSION = '1.10.0';

  /**
   * Initialize — check if we have a valid session.
   * Also checks for app updates and auto-refreshes if needed.
   */
  async function init() {
    try {
      // Check for app updates — non-blocking, don't delay auth
      checkForUpdates();

      const res = await apiCall('/api/v1/auth/me');

      if (res.status === 401) {
        console.log('[Auth] No session, redirecting to login...');
        window.location.href = '/api/v1/auth/login';
        return false;
      }

      const data = await res.json();

      if (data.status === 1 && data.user) {
        currentUser = data.user;
        console.log('[Auth] Authenticated via', data.authMethod + ':', currentUser.display_name);
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

    const logoutUrl = 'https://login.microsoftonline.com/common/oauth2/v2.0/logout'
      + '?post_logout_redirect_uri=' + encodeURIComponent(window.location.origin);
    window.location.href = logoutUrl;
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

  return {
    init,
    apiCall,
    signOut,
    clearCache,
    isAuthenticated,
    getUser,
  };
})();
