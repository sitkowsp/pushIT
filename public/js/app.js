/**
 * pushIT Main Application
 * Orchestrates auth, push, and UI modules.
 *
 * Authentication is handled entirely by Azure Application Proxy.
 * By the time this code runs, the user is already authenticated —
 * the proxy won't let unauthenticated requests through.
 */

const PushitApp = (() => {
  let user = null;
  let messages = [];
  let applications = [];
  let filters = [];
  let devices = [];
  let ws = null;
  let currentView = 'messages';
  let filterAppName = null; // Active app filter for messages view

  /**
   * Escape HTML to prevent XSS.
   */
  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /**
   * Initialize the app.
   * Application Proxy has already authenticated the user.
   */
  async function init() {
    // Register service worker in background — don't block auth flow.
    // On iOS PWA (standalone mode), SW registration can hang in a fresh
    // browsing context. Auth must proceed regardless.
    PushitPush.init().catch((err) => {
      console.warn('[App] SW init failed (non-blocking):', err);
    });

    // Fetch user profile from backend
    const isAuth = await PushitAuth.init();

    if (isAuth) {
      await loadApp();
    } else {
      // PushitAuth.init() redirects to /api/v1/auth/login on 401,
      // so we only reach here on unexpected errors (network, server down).
      document.getElementById('login-screen').style.display = 'flex';
      document.getElementById('app-main').style.display = 'none';
      const spinner = document.querySelector('#login-screen .loading');
      if (spinner) spinner.style.display = 'none';
      const statusEl = document.getElementById('auth-status');
      if (statusEl) {
        statusEl.textContent = 'Could not connect to server. Please try again.';
      }
      const loginBtn = document.getElementById('login-btn');
      if (loginBtn) loginBtn.style.display = 'inline-flex';
      const clearBtn = document.getElementById('clear-cache-btn');
      if (clearBtn) clearBtn.style.display = 'inline-flex';
    }
  }

  /**
   * Handle reload (retry).
   */
  function signIn() {
    window.location.reload();
  }

  /**
   * Handle sign-out.
   */
  async function signOut() {
    await PushitPush.unsubscribe();
    if (ws) ws.close();
    await PushitAuth.signOut();
  }

  /**
   * Load the main app after authentication.
   */
  async function loadApp() {
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app-main').style.display = 'flex';

    // User profile was already loaded by PushitAuth.init()
    user = PushitAuth.getUser();
    if (user) {
      document.getElementById('user-name').textContent =
        (user.display_name || user.email || '').split(' ')[0];
    }

    // Check push status — non-blocking, don't let it delay the UI
    PushitPush.getSubscriptionStatus().then((pushStatus) => {
      if (!pushStatus.subscribed && pushStatus.permission !== 'denied') {
        setTimeout(showSetupPrompts, 1500);
      }
    }).catch(() => {});

    // Connect WebSocket
    connectWebSocket();

    // Load and render messages immediately
    try {
      await refreshMessages();
    } catch (err) {
      console.error('[App] Initial message load failed:', err);
    }
  }

  /**
   * Show setup prompts for PWA install and push notifications.
   *
   * Desktop browsers: always show push enable banner (PWA install not needed).
   * Mobile browsers:
   *   - If installed as PWA → show push enable banner
   *   - If NOT installed as PWA → show install instructions (iOS needs PWA for push)
   */
  function showSetupPrompts() {
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

    if (!isMobile || PushitPush.isInstalledPWA()) {
      // Desktop browser OR installed PWA — just offer push enable
      showPushPromptBanner();
    } else {
      // Mobile browser, not installed as PWA — show install instructions
      const prompt = document.getElementById('install-prompt');
      if (prompt) prompt.style.display = 'block';
    }
  }

  /**
   * Show a banner prompting the user to enable push notifications.
   * Displayed when the app is installed as PWA but push is not subscribed.
   */
  function showPushPromptBanner() {
    // Don't show if already exists
    if (document.getElementById('push-prompt-banner')) return;

    const banner = document.createElement('div');
    banner.id = 'push-prompt-banner';
    banner.style.cssText = 'background:var(--bg-input);border:1px solid var(--accent);border-radius:var(--radius-sm);padding:12px 16px;margin:0 0 12px 0;display:flex;align-items:center;justify-content:space-between;gap:12px;';
    banner.innerHTML = `
      <span style="font-size:13px;color:var(--text-primary);">Push notifications are disabled. Enable them to receive alerts.</span>
      <button class="btn btn-primary btn-small" data-action="enable-push" style="white-space:nowrap;flex-shrink:0;">Enable</button>
    `;

    // Insert before the message list
    const messagesView = document.getElementById('view-messages');
    const messageList = document.getElementById('message-list');
    if (messagesView && messageList) {
      messagesView.insertBefore(banner, messageList);
    }
  }

  /**
   * Enable push notifications.
   */
  async function enablePush() {
    const result = await PushitPush.subscribe();
    if (result.success || result === true) {
      PushitUI.toast('Push notifications enabled!', 'success');
      // Remove the push prompt banner if it exists
      const banner = document.getElementById('push-prompt-banner');
      if (banner) banner.remove();
      // Also hide the install prompt
      const installPrompt = document.getElementById('install-prompt');
      if (installPrompt) installPrompt.style.display = 'none';
      if (currentView === 'settings') {
        await loadSettings();
      }
    } else {
      const reason = result.reason || 'unknown';
      let msg;
      switch (reason) {
        case 'denied':
          msg = 'Notifications blocked by browser. Click the lock/tune icon in the address bar → reset notification permission, then try again.';
          break;
        case 'dismissed':
          msg = 'Notification permission was dismissed. Please try again and click "Allow" when prompted.';
          break;
        case 'not_supported':
          msg = 'This browser does not support push notifications.';
          break;
        case 'no_sw':
          msg = 'Service worker not ready. Try reloading the page.';
          break;
        default:
          msg = 'Failed to enable push notifications. Please try again.';
      }
      PushitUI.toast(msg, 'error', 6000);
    }
  }

  /**
   * Connect to WebSocket for real-time updates.
   */
  function connectWebSocket() {
    if (ws) ws.close();

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}/ws`);

    ws.onopen = () => {
      // Server authenticates via the session cookie on the WS upgrade request.
      // No client-side auth message needed.
      console.log('[App] WebSocket connected (cookie auth)');
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'new_message') {
          messages.unshift(data.message);
          if (currentView === 'messages') {
            PushitUI.renderMessages(messages);
          }
          updateBadge();
        }
      } catch (e) {
        // Ignore invalid messages
      }
    };

    ws.onclose = () => {
      setTimeout(connectWebSocket, 5000);
    };

    ws.onerror = () => {
      ws.close();
    };
  }

  /**
   * Switch between views.
   */
  function switchView(view) {
    currentView = view;

    document.querySelectorAll('nav button').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.view === view);
    });

    document.querySelectorAll('.view').forEach((v) => {
      v.classList.toggle('active', v.id === `view-${view}`);
    });

    switch (view) {
      case 'messages': refreshMessages(); break;
      case 'apps': loadApps(); break;
      case 'filters': loadFilters(); break;
      case 'settings': loadSettings(); break;
    }
  }

  /**
   * Refresh messages from the API.
   */
  async function refreshMessages() {
    try {
      const res = await PushitAuth.apiCall('/api/v1/messages?limit=100');
      const data = await res.json();
      if (data.status === 1) {
        messages = data.messages;
        updateAppFilter();
        applyFilterAndRender();
        updateBadge();
      }
    } catch (err) {
      console.error('[App] Failed to refresh messages:', err);
    }
  }

  /**
   * Populate the app filter dropdown from current messages.
   */
  function updateAppFilter() {
    const select = document.getElementById('app-filter');
    if (!select) return;

    // Get unique app names from messages
    const appNames = [...new Set(messages.map((m) => m.app_name).filter(Boolean))].sort();

    if (appNames.length === 0) {
      select.style.display = 'none';
      filterAppName = null;
      return;
    }

    select.style.display = '';
    const prev = select.value;
    select.innerHTML = '<option value="">All apps</option>' +
      appNames.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');

    // Restore previous selection if it still exists
    if (prev && appNames.includes(prev)) {
      select.value = prev;
      filterAppName = prev;
    } else {
      select.value = '';
      filterAppName = null;
    }
  }

  /**
   * Apply the current filter and render messages.
   */
  function applyFilterAndRender() {
    const filtered = filterAppName
      ? messages.filter((m) => m.app_name === filterAppName)
      : messages;
    PushitUI.renderMessages(filtered);
  }

  /**
   * Acknowledge an emergency message.
   */
  async function acknowledge(messageId) {
    try {
      await PushitAuth.apiCall(`/api/v1/messages/${messageId}/acknowledge`, {
        method: 'POST',
      });
      PushitUI.toast('Acknowledged', 'success');
      await refreshMessages();
    } catch (err) {
      PushitUI.toast('Failed to acknowledge', 'error');
    }
  }

  /**
   * Delete a message.
   */
  async function deleteMessage(messageId) {
    try {
      await PushitAuth.apiCall(`/api/v1/messages/${messageId}`, {
        method: 'DELETE',
      });
      PushitUI.toast('Message deleted', 'success');
      await refreshMessages();
    } catch (err) {
      PushitUI.toast('Failed to delete message', 'error');
    }
  }

  /**
   * Mark a message as read.
   */
  async function markRead(messageId) {
    try {
      await PushitAuth.apiCall(`/api/v1/messages/${messageId}/read`, {
        method: 'POST',
      });
      await refreshMessages();
    } catch (err) {
      console.error('Failed to mark message as read:', err);
    }
  }

  /**
   * Delete all messages.
   */
  async function deleteAllMessages() {
    const label = filterAppName ? `Delete all "${filterAppName}" messages?` : 'Delete all messages?';
    if (confirm(label + ' This action cannot be undone.')) {
      try {
        const url = filterAppName
          ? `/api/v1/messages?app_name=${encodeURIComponent(filterAppName)}`
          : '/api/v1/messages';
        await PushitAuth.apiCall(url, { method: 'DELETE' });
        PushitUI.toast(filterAppName ? `${filterAppName} messages deleted` : 'All messages deleted', 'success');
        await refreshMessages();
      } catch (err) {
        PushitUI.toast('Failed to delete messages', 'error');
      }
    }
  }

  /**
   * Load applications.
   */
  async function loadApps() {
    try {
      const res = await PushitAuth.apiCall('/api/v1/applications');
      const data = await res.json();
      if (data.status === 1) {
        applications = data.applications;
        PushitUI.renderApplications(applications);
      }
    } catch (err) {
      console.error('[App] Failed to load apps:', err);
    }
  }

  /**
   * Create a new application.
   */
  async function createApp() {
    PushitUI.showModal('New Application', `
      <div class="form-group">
        <label>Name</label>
        <input type="text" id="new-app-name" placeholder="e.g. n8n, monitoring, backup-script" />
      </div>
      <div class="form-group">
        <label>Description (optional)</label>
        <input type="text" id="new-app-desc" placeholder="What sends these notifications?" />
      </div>
      <div class="form-group">
        <label>Visibility</label>
        <div class="visibility-selector">
          <label>
            <input type="radio" name="visibility" value="private" checked />
            <span>Private</span>
          </label>
          <label>
            <input type="radio" name="visibility" value="public" />
            <span>Public</span>
          </label>
        </div>
      </div>
      <div class="form-group">
        <label>Color</label>
        <input type="color" id="new-app-color" value="#e94560" />
      </div>
      <button id="submit-new-app-btn" class="btn btn-primary" style="width:100%;">Create</button>
    `);
    document.getElementById('submit-new-app-btn').addEventListener('click', submitNewApp);
  }

  async function submitNewApp() {
    const name = document.getElementById('new-app-name').value.trim();
    const description = document.getElementById('new-app-desc').value.trim();
    const visibility = document.querySelector('input[name="visibility"]:checked').value;
    const color = document.getElementById('new-app-color').value;

    if (!name) {
      PushitUI.toast('Name is required', 'error');
      return;
    }

    try {
      const res = await PushitAuth.apiCall('/api/v1/applications', {
        method: 'POST',
        body: JSON.stringify({
          name,
          description,
          visibility,
          color,
        }),
      });
      const data = await res.json();
      if (data.status === 1) {
        PushitUI.closeModal();
        PushitUI.toast(`App created! Token: ${data.application.token}`, 'success', 5000);
        await loadApps();
      }
    } catch (err) {
      PushitUI.toast('Failed to create app', 'error');
    }
  }

  /**
   * Edit an application.
   */
  async function editApp(appId) {
    const app = applications.find((a) => a.id === appId);
    if (!app) {
      PushitUI.toast('App not found', 'error');
      return;
    }

    const color = app.color || '#e94560';
    const visibility = app.visibility || 'private';

    PushitUI.showModal('Edit Application', `
      <div class="form-group">
        <label>Name</label>
        <input type="text" id="edit-app-name" value="${escapeHtml(app.name)}" />
      </div>
      <div class="form-group">
        <label>Description</label>
        <input type="text" id="edit-app-desc" value="${escapeHtml(app.description || '')}" />
      </div>
      <div class="form-group">
        <label>Visibility</label>
        <div class="visibility-selector">
          <label>
            <input type="radio" name="edit-visibility" value="private" ${visibility === 'private' ? 'checked' : ''} />
            <span>Private</span>
          </label>
          <label>
            <input type="radio" name="edit-visibility" value="public" ${visibility === 'public' ? 'checked' : ''} />
            <span>Public</span>
          </label>
        </div>
      </div>
      <div class="form-group">
        <label>Color</label>
        <input type="color" id="edit-app-color" value="${escapeHtml(color)}" />
      </div>
      <button id="submit-edit-app-btn" class="btn btn-primary" style="width:100%;">Save Changes</button>
    `);
    document.getElementById('submit-edit-app-btn').addEventListener('click', () => submitEditApp(appId));
  }

  async function submitEditApp(appId) {
    const name = document.getElementById('edit-app-name').value.trim();
    const description = document.getElementById('edit-app-desc').value.trim();
    const visibility = document.querySelector('input[name="edit-visibility"]:checked').value;
    const color = document.getElementById('edit-app-color').value;

    if (!name) {
      PushitUI.toast('Name is required', 'error');
      return;
    }

    try {
      const res = await PushitAuth.apiCall(`/api/v1/applications/${appId}`, {
        method: 'PUT',
        body: JSON.stringify({
          name,
          description,
          visibility,
          color,
        }),
      });
      const data = await res.json();
      if (data.status === 1) {
        PushitUI.closeModal();
        PushitUI.toast('App updated!', 'success');
        await loadApps();
      }
    } catch (err) {
      PushitUI.toast('Failed to update app', 'error');
    }
  }

  /**
   * Delete an application.
   */
  async function deleteApp(appId) {
    if (confirm('Are you sure you want to delete this application? This action cannot be undone.')) {
      try {
        await PushitAuth.apiCall(`/api/v1/applications/${appId}`, {
          method: 'DELETE',
        });
        PushitUI.toast('App deleted!', 'success');
        await loadApps();
      } catch (err) {
        PushitUI.toast('Failed to delete app', 'error');
      }
    }
  }

  /**
   * Unsubscribe from an application.
   */
  async function unsubscribeApp(appId) {
    if (confirm('Unsubscribe from this app? This will also remove existing messages from this app.')) {
      try {
        await PushitAuth.apiCall(`/api/v1/applications/${appId}/unsubscribe`, {
          method: 'POST',
        });
        PushitUI.toast('Unsubscribed!', 'success');
        await loadApps();
        // Refresh messages since unsubscribe deletes messages from this app
        await refreshMessages();
      } catch (err) {
        PushitUI.toast('Failed to unsubscribe', 'error');
      }
    }
  }

  /**
   * Browse public applications.
   */
  async function browsePublicApps() {
    try {
      const res = await PushitAuth.apiCall('/api/v1/applications/public');
      const data = await res.json();
      if (data.status === 1) {
        const publicApps = data.applications;

        if (publicApps.length === 0) {
          PushitUI.showModal('Browse Public Apps', `
            <div class="empty-state" style="padding:40px 0;">
              <div class="icon">🔍</div>
              <div class="title">No public apps available</div>
            </div>
          `);
          return;
        }

        const appsHtml = publicApps.map((app) => {
          const color = app.color || '#e94560';
          const isSubscribed = app.is_subscribed === true;
          return `
            <div class="setting-row" style="flex-direction: column; align-items: flex-start; gap: 8px;">
              <div style="display:flex; align-items:center; justify-content:space-between; width:100%;">
                <div style="display:flex; align-items:center;">
                  <span class="app-color-dot" style="background-color:${escapeHtml(color)}"></span>
                  <span class="label">${escapeHtml(app.name)}</span>
                </div>
              </div>
              ${app.description ? `<span style="font-size:12px;color:var(--text-muted)">${escapeHtml(app.description)}</span>` : ''}
              <button data-action="subscribe-app" data-id="${app.id}" class="btn btn-primary btn-small" style="width:100%; ${isSubscribed ? 'opacity:0.5; cursor:default;' : ''}" ${isSubscribed ? 'disabled' : ''}>
                ${isSubscribed ? 'Already Subscribed' : 'Subscribe'}
              </button>
            </div>
          `;
        }).join('');

        PushitUI.showModal('Browse Public Apps', `<div>${appsHtml}</div>`);
      }
    } catch (err) {
      PushitUI.toast('Failed to load public apps', 'error');
    }
  }

  /**
   * Subscribe to an application.
   */
  async function subscribeApp(appId) {
    try {
      await PushitAuth.apiCall(`/api/v1/applications/${appId}/subscribe`, {
        method: 'POST',
      });
      PushitUI.toast('Subscribed!', 'success');
      await browsePublicApps();
    } catch (err) {
      PushitUI.toast('Failed to subscribe', 'error');
    }
  }

  /**
   * Load filters.
   */
  async function loadFilters() {
    try {
      const res = await PushitAuth.apiCall('/api/v1/filters');
      const data = await res.json();
      if (data.status === 1) {
        filters = data.filters;
        PushitUI.renderFilters(filters);
      }
    } catch (err) {
      console.error('[App] Failed to load filters:', err);
    }
  }

  /**
   * Create a new filter.
   */
  async function createFilter() {
    PushitUI.showModal('New Filter', `
      <div class="form-group">
        <label>Filter Name</label>
        <input type="text" id="filter-name" placeholder="e.g. Critical alerts to n8n" />
      </div>
      <div class="form-group">
        <label>Match Title (regex pattern, optional)</label>
        <input type="text" id="filter-title" placeholder="e.g. CRITICAL|ERROR" />
      </div>
      <div class="form-group">
        <label>Match Message (regex pattern, optional)</label>
        <input type="text" id="filter-message" placeholder="e.g. server down|disk full" />
      </div>
      <div class="form-group">
        <label>Action</label>
        <select id="filter-action">
          <option value="forward">Forward to webhook</option>
          <option value="modify">Modify priority/sound</option>
          <option value="suppress">Suppress notification</option>
        </select>
      </div>
      <div class="form-group" id="filter-webhook-group">
        <label>Webhook URL</label>
        <input type="url" id="filter-webhook" placeholder="https://n8n.example.com/webhook/..." />
      </div>
      <button id="submit-new-filter-btn" class="btn btn-primary" style="width:100%;">Create Filter</button>
    `);
    document.getElementById('submit-new-filter-btn').addEventListener('click', submitNewFilter);
  }

  async function submitNewFilter() {
    const name = document.getElementById('filter-name').value.trim();
    const matchTitle = document.getElementById('filter-title').value.trim();
    const matchMessage = document.getElementById('filter-message').value.trim();
    const action = document.getElementById('filter-action').value;
    const webhookUrl = document.getElementById('filter-webhook').value.trim();

    if (!name) {
      PushitUI.toast('Name is required', 'error');
      return;
    }

    try {
      const res = await PushitAuth.apiCall('/api/v1/filters', {
        method: 'POST',
        body: JSON.stringify({
          name,
          match_title_pattern: matchTitle || null,
          match_message_pattern: matchMessage || null,
          action,
          action_webhook_url: webhookUrl || null,
          action_suppress: action === 'suppress',
        }),
      });
      const data = await res.json();
      if (data.status === 1) {
        PushitUI.closeModal();
        PushitUI.toast('Filter created!', 'success');
        await loadFilters();
      }
    } catch (err) {
      PushitUI.toast('Failed to create filter', 'error');
    }
  }

  /**
   * Toggle a filter's active state.
   */
  async function toggleFilter(filterId, active) {
    try {
      await PushitAuth.apiCall(`/api/v1/filters/${filterId}`, {
        method: 'PUT',
        body: JSON.stringify({ is_active: active }),
      });
      await loadFilters();
    } catch (err) {
      PushitUI.toast('Failed to update filter', 'error');
    }
  }

  /**
   * Rename a registered device.
   */
  async function renameDevice(deviceId) {
    const device = devices.find((d) => d.id === deviceId);
    if (!device) {
      PushitUI.toast('Device not found', 'error');
      return;
    }

    const next = (window.prompt('New device name:', device.name) || '').trim();
    if (!next || next === device.name) return;

    try {
      const res = await PushitAuth.apiCall(`/api/v1/devices/${deviceId}`, {
        method: 'PUT',
        body: JSON.stringify({ name: next }),
      });
      const data = await res.json();
      if (res.status === 409) {
        PushitUI.toast('Name already in use', 'error');
        return;
      }
      if (data.status === 1) {
        PushitUI.toast('Device renamed', 'success');
        await loadSettings();
      } else {
        const msg = (data.errors && data.errors[0]) || 'Failed to rename device';
        PushitUI.toast(msg, 'error');
      }
    } catch (err) {
      PushitUI.toast('Failed to rename device', 'error');
    }
  }

  /**
   * Delete (deactivate) a registered device.
   */
  async function deleteDevice(deviceId) {
    const device = devices.find((d) => d.id === deviceId);
    const label = device ? device.name : 'this device';
    if (!confirm(`Delete "${label}"? It will stop receiving push notifications.`)) {
      return;
    }
    try {
      await PushitAuth.apiCall(`/api/v1/devices/${deviceId}`, {
        method: 'DELETE',
      });
      PushitUI.toast('Device deleted', 'success');
      await loadSettings();
    } catch (err) {
      PushitUI.toast('Failed to delete device', 'error');
    }
  }

  /**
   * Load settings.
   */
  async function loadSettings() {
    let pushStatus = { subscribed: false, permission: 'default' };
    try {
      pushStatus = await PushitPush.getSubscriptionStatus();
    } catch (err) {
      // SW not ready yet — use defaults
    }

    try {
      const res = await PushitAuth.apiCall('/api/v1/devices');
      const data = await res.json();
      devices = data.status === 1 ? data.devices : [];
    } catch (err) {
      devices = [];
    }

    if (user) {
      PushitUI.renderSettings(user, pushStatus, devices);
      // Load organizations after settings render (fills the orgs-list div)
      loadOrgs();
    }
  }

  /**
   * Update the unread badge.
   */
  function updateBadge() {
    const unread = messages.filter((m) => m.is_read === 0).length;
    const unacked = messages.filter((m) => m.priority >= 2 && !m.acknowledged).length;

    // In-app badge (nav tab) — show unread count
    const badge = document.getElementById('messages-badge');
    if (badge) {
      const count = unread || unacked;
      badge.textContent = count;
      badge.style.display = count > 0 ? 'flex' : 'none';
    }

    // iOS/OS home screen badge (Badging API) — show unread count
    if ('setAppBadge' in navigator) {
      if (unread > 0) {
        navigator.setAppBadge(unread).catch(() => {});
      } else {
        navigator.clearAppBadge().catch(() => {});
      }
    }
  }

  /**
   * Open a URL in the system's default browser.
   *
   * iOS standalone PWA limitation (iOS 12.2+):
   * ALL link-opening methods — <a> clicks, window.open('_blank'),
   * window.open('_system'), location.href — open external URLs in
   * SFSafariViewController (in-app browser). This is an intentional
   * Apple platform restriction with NO JavaScript bypass.
   *
   * The in-app browser reuses TLS sessions, which can cause SNI mismatch
   * errors ("Misdirected Request") with reverse proxies serving multiple
   * domains on the same IP.
   *
   * Our workaround: use navigator.share() on iOS standalone, which opens
   * the native share sheet. The user can tap "Open in Safari" to get a
   * real Safari window with a fresh TLS connection.
   *
   * On regular browsers (not standalone), target="_blank" opens a new tab.
   */
  /**
   * Open a URL from a standalone PWA or regular browser.
   *
   * iOS standalone PWA (iOS 12.2+) opens external URLs in SFSafariViewController
   * (in-app browser) which reuses TLS sessions → SNI mismatch → HTTP 421.
   *
   * Fix: use the undocumented `x-safari-https://` URL scheme which opens the
   * URL directly in real Safari, bypassing the in-app browser entirely.
   * Confirmed working on iOS 17, 18.5, and 26.0 (from Stack Overflow).
   * From within a PWA it opens without any prompt.
   *
   * For non-iOS standalone (Android): fall back to window.open.
   * For regular browsers (not standalone): window.open with _blank.
   */
  function openExternalUrl(url) {
    // Validate URL — only allow http/https to prevent javascript: XSS
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        console.error('[App] Blocked non-http URL:', url);
        return;
      }
    } catch (e) {
      console.error('[App] Invalid URL:', url);
      return;
    }

    const isStandalone = window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true;
    // Detect iOS: includes iPad in desktop-mode (reports as MacIntel with touch)
    const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    console.log('[App] openExternalUrl:', { url, isStandalone, isIOS });

    if (isStandalone && isIOS) {
      // iOS standalone PWA → external links open in SFSafariViewController (in-app
      // browser). This can cause HTTP 421 "Misdirected Request" due to HTTP/2
      // connection coalescing when other other vhosts share the same wildcard
      // cert and IP. The server-side fix (Protocols http/1.1) prevents coalescing.
      //
      // Strategy: try the undocumented x-safari-https:// scheme first (opens in
      // real Safari on some iOS versions). If it doesn't navigate away within
      // 600ms, fall back to a modal with a plain <a> link + copy button.
      const safariUrl = url.replace(/^https?:\/\//, 'x-safari-https://');
      console.log('[App] Trying x-safari scheme');
      location.href = safariUrl;

      // If still here after 600ms, x-safari didn't work → show modal fallback
      let modalShown = false;
      setTimeout(() => {
        if (!modalShown) {
          modalShown = true;
          _showExternalLinkModal(url);
        }
      }, 600);
      return;
    }

    if (isStandalone) {
      // Non-iOS standalone (e.g., Android PWA)
      window.open(url, '_blank', 'noopener');
      return;
    }

    // Regular browser — open in new tab
    window.open(url, '_blank', 'noopener');
  }

  /**
   * Show a modal with options to open an external link or copy its URL.
   * Used as fallback on iOS standalone when x-safari-https:// doesn't work.
   * CSP-compliant: no inline event handlers, all listeners attached in JS.
   */
  function _showExternalLinkModal(url) {
    const safeUrl = escapeHtml(url);
    const modalContent = `
      <p style="margin-bottom:16px;line-height:1.5;color:var(--text-muted);">
        This link opens an external site. If it doesn't load, copy the URL and paste it in Safari.
      </p>
      <div style="display:flex;flex-direction:column;gap:12px;">
        <a id="ext-link-open" href="${safeUrl}" target="_blank" rel="noopener noreferrer"
           class="btn btn-primary" style="text-align:center;text-decoration:none;justify-content:center;">
          Open Link
        </a>
        <button id="ext-link-copy" class="btn" type="button">
          Copy URL
        </button>
      </div>`;

    const overlay = PushitUI.showModal('External Link', modalContent);

    // Attach listeners (CSP: script-src 'self' forbids inline handlers)
    const openBtn = overlay.querySelector('#ext-link-open');
    const copyBtn = overlay.querySelector('#ext-link-copy');

    if (openBtn) {
      openBtn.addEventListener('click', () => {
        setTimeout(() => PushitUI.closeModal(), 300);
      });
    }

    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        await PushitUI.copyToClipboard(url, copyBtn);
        copyBtn.textContent = 'Copied!';
        setTimeout(() => PushitUI.closeModal(), 800);
      });
    }
  }

  // ─── Organizations ──────────────────────────────────────────────────

  /**
   * Load and render organizations in the Settings view.
   */
  async function loadOrgs() {
    const container = document.getElementById('orgs-list');
    if (!container) return;

    try {
      const res = await PushitAuth.apiCall('/api/v1/organizations');
      const data = await res.json();
      if (data.status !== 1) {
        container.innerHTML = '<p style="color:var(--text-muted);font-size:13px;">No organizations yet.</p>';
        return;
      }

      const orgs = data.organizations;
      if (orgs.length === 0) {
        container.innerHTML = '<p style="color:var(--text-muted);font-size:13px;">No organizations yet. Create one to share apps with your team.</p>';
        return;
      }

      container.innerHTML = orgs.map((org) => `
        <div class="setting-row" style="flex-wrap:wrap;gap:8px;">
          <span class="label" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;cursor:pointer;" data-action="view-org" data-id="${org.id}">
            ${escapeHtml(org.name)} <span style="color:var(--text-muted);font-size:12px;">(${org.member_count} members)</span>
          </span>
          <span style="display:flex;gap:6px;flex-shrink:0;">
            <button class="btn btn-small" data-action="view-org" data-id="${org.id}">Manage</button>
            ${org.role === 'owner' ? `<button class="btn btn-danger btn-small" data-action="delete-org" data-id="${org.id}">Delete</button>` : ''}
          </span>
        </div>
      `).join('');
    } catch (err) {
      container.innerHTML = '<p style="color:var(--text-muted);font-size:13px;">Failed to load organizations.</p>';
    }
  }

  /**
   * Create a new organization.
   */
  async function createOrg() {
    const name = prompt('Organization name:');
    if (!name || name.trim().length < 2) return;

    try {
      const res = await PushitAuth.apiCall('/api/v1/organizations', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim() }),
      });
      const data = await res.json();
      if (data.status === 1) {
        PushitUI.toast('Organization created!', 'success');
        await loadOrgs();
      } else {
        PushitUI.toast(data.errors?.[0] || 'Failed to create', 'error');
      }
    } catch (err) {
      PushitUI.toast('Failed to create organization', 'error');
    }
  }

  /**
   * View organization details.
   */
  async function viewOrg(orgId) {
    try {
      const res = await PushitAuth.apiCall(`/api/v1/organizations/${orgId}`);
      const data = await res.json();
      if (data.status !== 1) {
        PushitUI.toast('Organization not found', 'error');
        return;
      }

      const org = data.organization;
      const isOwner = org.role === 'owner';

      let membersHtml = org.members.map((m) => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);">
          <div>
            <span style="font-weight:500;">${escapeHtml(m.display_name)}</span>
            <span style="color:var(--text-muted);font-size:12px;">${escapeHtml(m.email)}</span>
            ${m.role === 'owner' ? '<span style="color:var(--primary);font-size:11px;margin-left:4px;">Owner</span>' : ''}
          </div>
          ${isOwner && m.id !== user.id ? `<button class="btn btn-danger btn-small" data-action="remove-org-member" data-org-id="${orgId}" data-user-id="${m.id}">Remove</button>` : ''}
        </div>
      `).join('');

      let invitesHtml = '';
      if (isOwner && org.invites && org.invites.length > 0) {
        invitesHtml = `
          <h4 style="margin-top:16px;margin-bottom:8px;color:var(--text-secondary);">Pending Invites</h4>
          ${org.invites.map((inv) => `
            <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:13px;">
              <span>${escapeHtml(inv.email)}</span>
              <span style="color:var(--text-muted);">expires ${new Date(inv.expires_at).toLocaleDateString()}</span>
            </div>
          `).join('')}
        `;
      }

      let appsHtml = '';
      if (org.applications && org.applications.length > 0) {
        appsHtml = `
          <h4 style="margin-top:16px;margin-bottom:8px;color:var(--text-secondary);">Organization Apps</h4>
          ${org.applications.map((a) => `
            <div style="display:flex;align-items:center;gap:8px;padding:6px 0;">
              <span class="app-color-dot" style="background-color:${escapeHtml(a.color || '#e94560')}"></span>
              <span>${escapeHtml(a.name)}</span>
            </div>
          `).join('')}
        `;
      }

      PushitUI.showModal(escapeHtml(org.name), `
        <h4 style="margin-bottom:8px;color:var(--text-secondary);">Members (${org.members.length})</h4>
        ${membersHtml}
        ${invitesHtml}
        ${appsHtml}
        ${isOwner ? `
          <div style="margin-top:20px;display:flex;gap:8px;">
            <button class="btn btn-primary btn-small" data-action="invite-org" data-id="${orgId}" style="flex:1;">Invite Member</button>
          </div>
        ` : ''}
      `);
    } catch (err) {
      PushitUI.toast('Failed to load organization', 'error');
    }
  }

  /**
   * Invite a user to an organization.
   */
  async function inviteToOrg(orgId) {
    const email = prompt('Email address to invite:');
    if (!email) return;

    try {
      const res = await PushitAuth.apiCall(`/api/v1/organizations/${orgId}/invite`, {
        method: 'POST',
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (data.status === 1) {
        const msg = data.invite.invite_url
          ? `Invite sent! Share this link: ${data.invite.invite_url}`
          : 'Invite sent!';
        PushitUI.toast(msg, 'success', 8000);
        PushitUI.closeModal();
        await viewOrg(orgId);
      } else {
        PushitUI.toast(data.errors?.[0] || 'Failed to invite', 'error');
      }
    } catch (err) {
      PushitUI.toast('Failed to send invite', 'error');
    }
  }

  /**
   * Remove a member from an organization.
   */
  async function removeOrgMember(orgId, userId) {
    if (!confirm('Remove this member from the organization?')) return;

    try {
      await PushitAuth.apiCall(`/api/v1/organizations/${orgId}/members/${userId}`, {
        method: 'DELETE',
      });
      PushitUI.toast('Member removed', 'success');
      PushitUI.closeModal();
      await viewOrg(orgId);
    } catch (err) {
      PushitUI.toast('Failed to remove member', 'error');
    }
  }

  /**
   * Delete an organization.
   */
  async function deleteOrg(orgId) {
    if (!confirm('Delete this organization? All members will be removed.')) return;

    try {
      await PushitAuth.apiCall(`/api/v1/organizations/${orgId}`, {
        method: 'DELETE',
      });
      PushitUI.toast('Organization deleted', 'success');
      await loadOrgs();
    } catch (err) {
      PushitUI.toast('Failed to delete organization', 'error');
    }
  }

  /**
   * Bind all UI event listeners.
   */
  function bindEvents() {
    const loginBtn = document.getElementById('login-btn');
    if (loginBtn) loginBtn.addEventListener('click', signIn);

    const clearBtn = document.getElementById('clear-cache-btn');
    if (clearBtn) clearBtn.addEventListener('click', () => {
      PushitAuth.clearCache();
      setTimeout(() => window.location.reload(), 500);
    });

    const pushBtn = document.getElementById('enable-push-btn');
    if (pushBtn) pushBtn.addEventListener('click', enablePush);

    const refreshBtn = document.getElementById('refresh-messages-btn');
    if (refreshBtn) refreshBtn.addEventListener('click', refreshMessages);

    const appFilter = document.getElementById('app-filter');
    if (appFilter) appFilter.addEventListener('change', () => {
      filterAppName = appFilter.value || null;
      applyFilterAndRender();
    });

    const createAppBtn = document.getElementById('create-app-btn');
    if (createAppBtn) createAppBtn.addEventListener('click', createApp);

    const createFilterBtn = document.getElementById('create-filter-btn');
    if (createFilterBtn) createFilterBtn.addEventListener('click', createFilter);

    document.querySelectorAll('nav button[data-view]').forEach((btn) => {
      btn.addEventListener('click', () => switchView(btn.dataset.view));
    });

    // Refresh messages when app returns to foreground (covers background→foreground,
    // notification tap on iOS where SW postMessage may not arrive, and WS reconnect gaps)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && currentView === 'messages') {
        console.log('[App] Visibility restored → refreshing messages');
        refreshMessages();
      }
    });
  }

  return {
    init,
    bindEvents,
    signIn,
    signOut,
    switchView,
    refreshMessages,
    acknowledge,
    deleteMessage,
    markRead,
    deleteAllMessages,
    enablePush,
    createApp,
    submitNewApp,
    editApp,
    submitEditApp,
    deleteApp,
    renameDevice,
    deleteDevice,
    unsubscribeApp,
    browsePublicApps,
    subscribeApp,
    createFilter,
    submitNewFilter,
    toggleFilter,
    openExternalUrl,
    createOrg,
    viewOrg,
    inviteToOrg,
    removeOrgMember,
    deleteOrg,
  };
})();

// ─── Boot ───────────────────────────────────────────────────────────
// Use DOMContentLoaded — more reliable than 'load' on iOS PWA standalone mode.
// The 'load' event can miss if fired before listeners are attached (cached assets).
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  // DOM already ready (scripts at bottom of body or deferred)
  boot();
}

function boot() {
  PushitUI.initDelegation();
  PushitApp.bindEvents();

  // Listen for messages from the service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'refresh-messages') {
        PushitApp.refreshMessages();
      }
    });
  }

  PushitApp.init();
}
