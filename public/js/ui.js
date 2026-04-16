/**
 * pushIT UI Module
 * Handles rendering and UI interactions.
 * All events use delegation or addEventListener (no inline onclick for CSP compliance).
 */

const PushitUI = (() => {
  /**
   * Initialize event delegation for dynamically rendered elements.
   */
  function initDelegation() {
    // Hide broken images (replaces inline onerror handlers for CSP compliance)
    document.addEventListener('error', (e) => {
      if (e.target.tagName === 'IMG' && e.target.closest('.message-image')) {
        e.target.closest('.message-image').style.display = 'none';
      }
    }, true);  // use capture phase to catch img errors

    document.addEventListener('click', (e) => {
      // Acknowledge button
      const ackBtn = e.target.closest('[data-action="acknowledge"]');
      if (ackBtn) {
        PushitApp.acknowledge(ackBtn.dataset.id);
        return;
      }

      // Copy to clipboard
      const copyEl = e.target.closest('[data-action="copy"]');
      if (copyEl) {
        copyToClipboard(copyEl.dataset.value, copyEl);
        return;
      }

      // Toggle filter
      const toggleEl = e.target.closest('[data-action="toggle-filter"]');
      if (toggleEl) {
        PushitApp.toggleFilter(toggleEl.dataset.id, toggleEl.dataset.active === 'true');
        return;
      }

      // Enable push (in settings)
      const pushBtn = e.target.closest('[data-action="enable-push"]');
      if (pushBtn) {
        PushitApp.enablePush();
        return;
      }

      // Toggle API block
      const toggleApiBtn = e.target.closest('[data-action="toggle-api-block"]');
      if (toggleApiBtn) {
        const body = toggleApiBtn.nextElementSibling;
        const chevron = toggleApiBtn.querySelector('.api-chevron');
        if (body) {
          const open = body.style.display !== 'none';
          body.style.display = open ? 'none' : 'block';
          if (chevron) chevron.textContent = open ? '▸' : '▾';
        }
        return;
      }

      // Sign out
      const signOutBtn = e.target.closest('[data-action="sign-out"]');
      if (signOutBtn) {
        PushitApp.signOut();
        return;
      }

      // Edit app
      const editAppBtn = e.target.closest('[data-action="edit-app"]');
      if (editAppBtn) {
        PushitApp.editApp(editAppBtn.dataset.id);
        return;
      }

      // Delete app
      const deleteAppBtn = e.target.closest('[data-action="delete-app"]');
      if (deleteAppBtn) {
        PushitApp.deleteApp(deleteAppBtn.dataset.id);
        return;
      }

      // Rename device
      const renameDeviceBtn = e.target.closest('[data-action="rename-device"]');
      if (renameDeviceBtn) {
        PushitApp.renameDevice(renameDeviceBtn.dataset.id);
        return;
      }

      // Delete device
      const deleteDeviceBtn = e.target.closest('[data-action="delete-device"]');
      if (deleteDeviceBtn) {
        PushitApp.deleteDevice(deleteDeviceBtn.dataset.id);
        return;
      }

      // Unsubscribe app
      const unsubBtn = e.target.closest('[data-action="unsubscribe-app"]');
      if (unsubBtn) {
        PushitApp.unsubscribeApp(unsubBtn.dataset.id);
        return;
      }

      // Subscribe app
      const subBtn = e.target.closest('[data-action="subscribe-app"]');
      if (subBtn) {
        PushitApp.subscribeApp(subBtn.dataset.id);
        return;
      }

      // Browse public apps
      const browseBtn = e.target.closest('[data-action="browse-public-apps"]');
      if (browseBtn) {
        PushitApp.browsePublicApps();
        return;
      }

      // Delete message
      const deleteMsg = e.target.closest('[data-action="delete-message"]');
      if (deleteMsg) {
        PushitApp.deleteMessage(deleteMsg.dataset.id);
        return;
      }

      // Mark message as read
      const markRead = e.target.closest('[data-action="mark-read"]');
      if (markRead) {
        PushitApp.markRead(markRead.dataset.id);
        return;
      }

      // Create organization
      const createOrgBtn = e.target.closest('[data-action="create-org"]');
      if (createOrgBtn) {
        PushitApp.createOrg();
        return;
      }

      // View organization
      const viewOrgBtn = e.target.closest('[data-action="view-org"]');
      if (viewOrgBtn) {
        PushitApp.viewOrg(viewOrgBtn.dataset.id);
        return;
      }

      // Invite to organization
      const inviteOrgBtn = e.target.closest('[data-action="invite-org"]');
      if (inviteOrgBtn) {
        PushitApp.inviteToOrg(inviteOrgBtn.dataset.id);
        return;
      }

      // Remove org member
      const removeMemBtn = e.target.closest('[data-action="remove-org-member"]');
      if (removeMemBtn) {
        PushitApp.removeOrgMember(removeMemBtn.dataset.orgId, removeMemBtn.dataset.userId);
        return;
      }

      // Resend invite
      const resendBtn = e.target.closest('[data-action="resend-invite"]');
      if (resendBtn) {
        PushitApp.resendInvite(resendBtn.dataset.orgId, resendBtn.dataset.inviteId);
        return;
      }

      // Delete invite
      const deleteInvBtn = e.target.closest('[data-action="delete-invite"]');
      if (deleteInvBtn) {
        PushitApp.deleteInvite(deleteInvBtn.dataset.orgId, deleteInvBtn.dataset.inviteId);
        return;
      }

      // Delete organization
      const deleteOrgBtn = e.target.closest('[data-action="delete-org"]');
      if (deleteOrgBtn) {
        PushitApp.deleteOrg(deleteOrgBtn.dataset.id);
        return;
      }

      // Edit SMTP config
      const editSmtpBtn = e.target.closest('[data-action="edit-smtp"]');
      if (editSmtpBtn) {
        PushitApp.editSmtp();
        return;
      }

      // Delete SMTP config
      const deleteSmtpBtn = e.target.closest('[data-action="delete-smtp"]');
      if (deleteSmtpBtn) {
        PushitApp.deleteSmtp();
        return;
      }

      // Delete all messages
      const deleteAllBtn = e.target.closest('[data-action="delete-all-messages"]');
      if (deleteAllBtn) {
        PushitApp.deleteAllMessages();
        return;
      }

      // In standalone PWA mode (iOS 12.2+), external links open in
      // SFSafariViewController (in-app browser). This can cause HTTP 421 errors
      // due to HTTP/2 connection coalescing with shared wildcard certs.
      // openExternalUrl() handles this: tries x-safari-https:// scheme first,
      // then falls back to a modal with plain link + copy URL option.
      // Server-side fix: Protocols http/1.1 in Apache prevents coalescing.
      const linkBtn = e.target.closest('a.link-btn');
      if (linkBtn && linkBtn.href) {
        const isStandalone = window.matchMedia('(display-mode: standalone)').matches
          || window.navigator.standalone === true;
        if (isStandalone) {
          e.preventDefault();
          PushitApp.openExternalUrl(linkBtn.href);
          return;
        }
        // Regular browser: let default <a> behavior work (target="_blank")
      }
    });
  }

  /**
   * Show a toast notification.
   */
  function toast(message, type = 'info', duration = 3000) {
    const container = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(-20px)';
      setTimeout(() => el.remove(), 300);
    }, duration);
  }

  /**
   * Render the message list.
   */
  function renderMessages(messages) {
    const container = document.getElementById('message-list');
    if (!container) return;

    if (messages.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="icon">📭</div>
          <div class="title">No messages yet</div>
          <div class="subtitle">Push notifications from your apps and n8n will appear here</div>
        </div>`;
      return;
    }

    // In standalone PWA: omit target="_blank" so iOS opens external links in Safari.
    // In regular browser: use target="_blank" to open links in a new tab.
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true;
    const linkTarget = isStandalone ? '' : ' target="_blank"';

    container.innerHTML = messages.map((msg) => {
      const priorityClass = msg.priority >= 2 ? 'priority-emergency'
        : msg.priority >= 1 ? 'priority-high'
        : msg.priority <= -1 ? 'priority-low' : '';

      const unreadClass = msg.is_read === 0 ? 'message-unread' : '';
      const appColor = msg.app_color ? `border-left-color: ${msg.app_color};` : '';

      const time = formatTime(msg.timestamp || msg.created_at);
      const body = msg.html ? sanitizeHtml(msg.message) : escapeHtml(msg.message);

      let actionsHtml = '';
      if (msg.priority >= 2 && msg.receipt && !msg.acknowledged) {
        actionsHtml += `<button class="ack-btn" data-action="acknowledge" data-id="${msg.id}">Acknowledge</button>`;
      }
      if (msg.url) {
        actionsHtml += `<a href="${escapeHtml(msg.url)}"${linkTarget} rel="noopener" class="link-btn">${escapeHtml(msg.url_title || 'Open Link')}</a>`;
      }
      const actions = actionsHtml ? `<div class="actions">${actionsHtml}</div>` : '';

      const imageHtml = msg.image
        ? `<div class="message-image"><img src="${escapeHtml(msg.image)}" alt="" loading="lazy" style="max-width:100%;border-radius:8px;margin-top:8px;max-height:200px;object-fit:contain;" /></div>`
        : '';

      return `
        <div class="message-card ${priorityClass} ${unreadClass}" style="${appColor}" data-action="mark-read" data-id="${msg.id}">
          <div class="header">
            <span class="title">${escapeHtml(msg.title || 'Notification')}</span>
            <div style="display:flex; align-items:center; gap:8px;">
              <span class="time">${time}</span>
              <button class="delete-btn" data-action="delete-message" data-id="${msg.id}" style="padding:4px 8px;">✕</button>
            </div>
          </div>
          <div class="body">${body}</div>
          ${imageHtml}
          ${msg.app_name ? `<div class="app-name">${escapeHtml(msg.app_name)}</div>` : ''}
          ${actions}
        </div>`;
    }).join('');
  }

  /**
   * Render the applications list.
   */
  function renderApplications(apps) {
    const container = document.getElementById('apps-list');
    if (!container) return;

    if (apps.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="icon">🔧</div>
          <div class="title">No applications</div>
          <div class="subtitle">Create an app to get an API token for sending notifications</div>
        </div>
        <button class="btn btn-primary btn-small" data-action="browse-public-apps" style="margin-top:16px;">Browse Public Apps</button>`;
      return;
    }

    container.innerHTML = apps.map((app) => {
      const color = app.color || '#e94560';
      const visibility = app.visibility === 'public' ? 'Public' : 'Private';
      const visibilityBadgeClass = app.visibility === 'public' ? 'public' : '';
      const isOwner = app.is_owner !== false;
      const subscriberCount = app.subscriber_count || 0;

      let actionButtons = '';
      const subscribeBtn = app.is_subscribed
        ? `<button data-action="unsubscribe-app" data-id="${app.id}" class="danger" style="flex:1;">Unsubscribe</button>`
        : `<button data-action="subscribe-app" data-id="${app.id}" style="flex:1;">Subscribe</button>`;

      if (isOwner) {
        actionButtons = `
          <div class="app-actions">
            <button data-action="edit-app" data-id="${app.id}" style="flex:1;">Edit</button>
            <button data-action="delete-app" data-id="${app.id}" class="danger" style="flex:1;">Delete</button>
            ${subscribeBtn}
          </div>`;
      } else {
        actionButtons = `
          <div class="app-actions">
            ${subscribeBtn}
          </div>`;
      }

      return `
        <div class="setting-row" style="flex-direction: column; align-items: flex-start; gap: 8px;">
          <div style="display:flex; align-items:center; justify-content:space-between; width:100%;">
            <div style="display:flex; align-items:center;">
              <span class="app-color-dot" style="background-color:${escapeHtml(color)}"></span>
              <span class="label">${escapeHtml(app.name)}</span>
            </div>
            <span class="value">${app.message_count || 0} msgs</span>
          </div>
          <div style="display:flex; align-items:center; gap:8px; width:100%;">
            <span class="visibility-badge ${visibilityBadgeClass}">${visibility}${isOwner ? '' : ` · ${subscriberCount} subs`}</span>
          </div>
          <div class="key-display" data-action="copy" data-value="${app.token}" title="Click to copy">${app.token}</div>
          ${app.description ? `<span style="font-size:12px;color:var(--text-muted)">${escapeHtml(app.description)}</span>` : ''}
          ${actionButtons}
        </div>
      `;
    }).join('');

    // Add browse public apps button at the bottom
    const browseBtn = document.createElement('div');
    browseBtn.style.marginTop = '16px';
    browseBtn.innerHTML = '<button class="btn btn-primary btn-small" data-action="browse-public-apps" style="width:100%;">Browse Public Apps</button>';
    container.appendChild(browseBtn);
  }

  /**
   * Render the filters list.
   */
  function renderFilters(filters) {
    const container = document.getElementById('filters-list');
    if (!container) return;

    if (filters.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="icon">🔍</div>
          <div class="title">No filters</div>
          <div class="subtitle">Create filters to route, modify, or forward notifications</div>
        </div>`;
      return;
    }

    container.innerHTML = filters.map((f) => `
      <div class="setting-row" style="flex-direction: column; align-items: flex-start; gap: 4px;">
        <div style="display:flex; justify-content:space-between; width:100%; align-items:center;">
          <span class="label">${escapeHtml(f.name)}</span>
          <div class="toggle ${f.is_active ? 'active' : ''}" data-action="toggle-filter" data-id="${f.id}" data-active="${!f.is_active}"></div>
        </div>
        <span style="font-size:12px;color:var(--text-muted)">
          ${escapeHtml(f.action)}${f.action_webhook_url ? ' → webhook' : ''}
          ${f.match_title_pattern ? ` | title: /${escapeHtml(f.match_title_pattern)}/` : ''}
          ${f.match_message_pattern ? ` | msg: /${escapeHtml(f.match_message_pattern)}/` : ''}
        </span>
      </div>
    `).join('');
  }

  /**
   * Render the settings/profile view.
   */
  function renderSettings(user, pushStatus, devices) {
    const container = document.getElementById('settings-content');
    if (!container || !user) return;

    try {
      _renderSettingsInner(container, user, pushStatus, devices);
    } catch (err) {
      console.error('[UI] Settings render error:', err);
      container.innerHTML = '<p style="color:var(--danger);padding:20px;">Failed to render settings. Try reloading.</p>';
    }
  }

  function _renderSettingsInner(container, user, pushStatus, devices) {

    container.innerHTML = `
      <div class="settings-section">
        <h3>Account</h3>
        <div class="setting-row">
          <span class="label">Name</span>
          <span class="value">${escapeHtml(user.display_name)}</span>
        </div>
        <div class="setting-row">
          <span class="label">Email</span>
          <span class="value">${escapeHtml(user.email)}</span>
        </div>
        <div class="setting-row" style="flex-direction: column; align-items: flex-start; gap: 8px;">
          <span class="label">Your User Key</span>
          <div class="key-display" data-action="copy" data-value="${user.user_key}" title="Click to copy">${user.user_key}</div>
        </div>
      </div>

      <div class="settings-section">
        <h3>Notifications</h3>
        <div class="setting-row">
          <span class="label">Push Permission</span>
          <span class="value" style="color: ${pushStatus.permission === 'granted' ? 'var(--success)' : 'var(--warning)'}">${pushStatus.permission}</span>
        </div>
        <div class="setting-row">
          <span class="label">Subscribed</span>
          <span class="value" style="color: ${pushStatus.subscribed ? 'var(--success)' : 'var(--danger)'}">${pushStatus.subscribed ? 'Yes' : 'No'}</span>
        </div>
        ${!pushStatus.subscribed ? `
          <button class="btn btn-primary btn-small" data-action="enable-push" style="width:100%;margin-top:8px;">
            Enable Push Notifications
          </button>` : ''}
      </div>

      <div class="settings-section">
        <h3>Devices (${devices.length})</h3>
        ${devices.map((d) => `
          <div class="setting-row" style="flex-wrap:wrap;gap:8px;">
            <span class="label" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(d.name)}</span>
            <span class="value" style="color: ${d.is_active ? 'var(--success)' : 'var(--text-muted)'}">
              ${d.is_active ? (d.has_push ? 'Active' : 'No push') : 'Inactive'}
            </span>
            <span style="display:flex;gap:6px;flex-shrink:0;">
              <button class="btn btn-small" data-action="rename-device" data-id="${d.id}" title="Rename device">Rename</button>
              <button class="btn btn-danger btn-small" data-action="delete-device" data-id="${d.id}" title="Delete device">Delete</button>
            </span>
          </div>
        `).join('')}
      </div>

      <div class="settings-section" id="orgs-section">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <h3>Organizations</h3>
          <button class="btn btn-primary btn-small" data-action="create-org">+ New</button>
        </div>
        <div id="orgs-list" style="margin-top:8px;">
          <p style="color:var(--text-muted);font-size:13px;">Loading...</p>
        </div>
      </div>

      ${user.is_admin ? `
      <div class="settings-section" id="smtp-config-section">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <h3>Email (SMTP)</h3>
          <span id="smtp-status" style="font-size:12px;color:var(--text-muted);"></span>
        </div>
        <div id="smtp-config-content" style="margin-top:8px;">
          <p style="color:var(--text-muted);font-size:13px;">Loading...</p>
        </div>
      </div>
      ` : ''}

      <div class="settings-section">
        <h3>API Usage</h3>
        <p class="api-desc">Send notifications via <code>POST /api/v1/messages</code></p>

        <div class="api-block">
          <div class="api-block-header" data-action="toggle-api-block">
            <span>Quick Start — curl</span>
            <span class="api-chevron">▸</span>
          </div>
          <div class="api-block-body" style="display:none;">
            <pre class="api-code">curl -X POST ${escapeHtml(window.location.origin)}/api/v1/messages \\
  -H "Content-Type: application/json" \\
  -d '{
    "token": "APP_TOKEN",
    "user": "${escapeHtml(user.user_key)}",
    "title": "Hello",
    "message": "Test notification"
  }'</pre>
          </div>
        </div>

        <div class="api-block">
          <div class="api-block-header" data-action="toggle-api-block">
            <span>Broadcast to All Subscribers</span>
            <span class="api-chevron">▸</span>
          </div>
          <div class="api-block-body" style="display:none;">
            <p class="api-hint">Omit the <code>user</code> field to send to everyone subscribed to your app:</p>
            <pre class="api-code">{
  "token": "APP_TOKEN",
  "title": "System Alert",
  "message": "Maintenance in 30 min"
}</pre>
          </div>
        </div>

        <div class="api-block">
          <div class="api-block-header" data-action="toggle-api-block">
            <span>All Parameters</span>
            <span class="api-chevron">▸</span>
          </div>
          <div class="api-block-body" style="display:none;">
            <pre class="api-code">{
  "token": "APP_TOKEN",
  "user": "USER_KEY (optional)",
  "title": "Notification title",
  "message": "Body text (required)",
  "html": false,
  "priority": 0,
  "sound": "pushit",
  "url": "https://...",
  "url_title": "Open Link",
  "device": "device-name",
  "timestamp": 1712000000,
  "ttl": 3600,
  "icon": "https://example.com/app-icon.png",
  "image": "https://example.com/screenshot.png",
  "tags": "tag1,tag2",
  "retry": 60,
  "expire": 3600
}</pre>
            <p class="api-hint" style="margin-top:8px;">
              <b>Priority:</b> -2 lowest, -1 low, 0 normal, 1 high, 2 emergency<br>
              <b>Emergency (2):</b> requires <code>retry</code> + <code>expire</code><br>
              <b>Broadcast:</b> omit <code>user</code> to notify all subscribers<br>
              <b>Icon:</b> custom notification icon (HTTPS URL, ~192×192 PNG)<br>
              <b>Image:</b> large preview image shown in notification &amp; message card<br>
              <i>Note: iOS web push only supports title + body. Custom icon &amp; image display on Android/Windows/macOS only. Images always show in-app.</i>
            </p>
          </div>
        </div>

        <div class="api-block">
          <div class="api-block-header" data-action="toggle-api-block">
            <span>With URL Button</span>
            <span class="api-chevron">▸</span>
          </div>
          <div class="api-block-body" style="display:none;">
            <pre class="api-code">{
  "token": "APP_TOKEN",
  "user": "${escapeHtml(user.user_key)}",
  "title": "Build #247",
  "message": "All tests passed",
  "url": "https://ci.example.com/247",
  "url_title": "View Build",
  "priority": 1
}</pre>
          </div>
        </div>

        <div class="api-block">
          <div class="api-block-header" data-action="toggle-api-block">
            <span>n8n HTTP Request Node</span>
            <span class="api-chevron">▸</span>
          </div>
          <div class="api-block-body" style="display:none;">
            <p class="api-hint">Add an <b>HTTP Request</b> node with:</p>
            <pre class="api-code">Method: POST
URL: ${escapeHtml(window.location.origin)}/api/v1/messages
Body (JSON):
{
  "token": "APP_TOKEN",
  "title": "Workflow Done",
  "message": "{{ $json.summary }}"
}</pre>
          </div>
        </div>

        <div class="api-block">
          <div class="api-block-header" data-action="toggle-api-block">
            <span>PowerShell</span>
            <span class="api-chevron">▸</span>
          </div>
          <div class="api-block-body" style="display:none;">
            <pre class="api-code">$body = @{
  token   = "APP_TOKEN"
  user    = "${escapeHtml(user.user_key)}"
  title   = "Alert"
  message = "Something happened"
} | ConvertTo-Json

Invoke-RestMethod \`
  -Uri "${escapeHtml(window.location.origin)}/api/v1/messages" \`
  -Method POST -Body $body \`
  -ContentType "application/json"</pre>
          </div>
        </div>

        <div class="api-block">
          <div class="api-block-header" data-action="toggle-api-block">
            <span>Python</span>
            <span class="api-chevron">▸</span>
          </div>
          <div class="api-block-body" style="display:none;">
            <pre class="api-code">import requests

requests.post(
  "${escapeHtml(window.location.origin)}/api/v1/messages",
  json={
    "token": "APP_TOKEN",
    "user": "${escapeHtml(user.user_key)}",
    "title": "Task Done",
    "message": "Processing complete"
  }
)</pre>
          </div>
        </div>

        <div class="api-block">
          <div class="api-block-header" data-action="toggle-api-block">
            <span>Response Format</span>
            <span class="api-chevron">▸</span>
          </div>
          <div class="api-block-body" style="display:none;">
            <p class="api-hint"><b>Success:</b></p>
            <pre class="api-code">{ "status": 1, "request": "uuid" }</pre>
            <p class="api-hint" style="margin-top:8px;"><b>Error:</b></p>
            <pre class="api-code">{ "status": 0, "errors": ["message"] }</pre>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <button class="btn btn-danger btn-small" data-action="sign-out" style="width:100%;">
          Sign Out
        </button>
      </div>
    `;
  }

  /**
   * Show a modal dialog.
   */
  function showModal(title, content) {
    const existing = document.querySelector('.modal-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <h2>${title}</h2>
        ${content}
      </div>`;

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    document.body.appendChild(overlay);
    return overlay;
  }

  /**
   * Close all modals.
   */
  function closeModal() {
    const overlay = document.querySelector('.modal-overlay');
    if (overlay) overlay.remove();
  }

  /**
   * Copy text to clipboard.
   */
  async function copyToClipboard(text, el) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied to clipboard', 'success', 2000);
      if (el) {
        el.classList.add('copied');
        setTimeout(() => el.classList.remove('copied'), 1500);
      }
    } catch (err) {
      // Fallback
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      toast('Copied!', 'success', 2000);
    }
  }

  /**
   * Format a timestamp for display.
   */
  function formatTime(ts) {
    let date;
    if (typeof ts === 'number') {
      date = new Date(ts > 1e12 ? ts : ts * 1000);
    } else {
      date = new Date(ts);
    }

    const now = new Date();
    const diff = now - date;

    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;

    return date.toLocaleDateString();
  }

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
   * Sanitize HTML messages — whitelist safe tags/attributes only.
   * Prevents stored XSS from app-token holders sending html:true messages.
   */
  function sanitizeHtml(html) {
    if (!html) return '';
    const ALLOWED_TAGS = new Set([
      'b', 'i', 'u', 'em', 'strong', 'a', 'br', 'p', 'ul', 'ol', 'li',
      'code', 'pre', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'span', 'div',
      'font', 'small', 'sub', 'sup', 'hr', 'table', 'thead', 'tbody',
      'tr', 'td', 'th',
    ]);
    const ALLOWED_ATTRS = new Set([
      'href', 'target', 'rel', 'style', 'color', 'size', 'class',
    ]);

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const clean = document.createDocumentFragment();

    function sanitizeNode(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        return document.createTextNode(node.textContent);
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return null;

      const tagName = node.tagName.toLowerCase();
      if (!ALLOWED_TAGS.has(tagName)) {
        // Replace disallowed tags with their text content
        const frag = document.createDocumentFragment();
        for (const child of node.childNodes) {
          const cleaned = sanitizeNode(child);
          if (cleaned) frag.appendChild(cleaned);
        }
        return frag;
      }

      const el = document.createElement(tagName);
      for (const attr of node.attributes) {
        const name = attr.name.toLowerCase();
        if (!ALLOWED_ATTRS.has(name)) continue;
        let value = attr.value;
        // Block javascript: URLs in href
        if (name === 'href' && /^\s*javascript:/i.test(value)) continue;
        if (name === 'href') {
          el.setAttribute('rel', 'noopener noreferrer');
          el.setAttribute('target', '_blank');
        }
        el.setAttribute(name, value);
      }

      for (const child of node.childNodes) {
        const cleaned = sanitizeNode(child);
        if (cleaned) el.appendChild(cleaned);
      }
      return el;
    }

    for (const child of doc.body.childNodes) {
      const cleaned = sanitizeNode(child);
      if (cleaned) clean.appendChild(cleaned);
    }

    const wrapper = document.createElement('div');
    wrapper.appendChild(clean);
    return wrapper.innerHTML;
  }

  return {
    initDelegation,
    toast,
    renderMessages,
    renderApplications,
    renderFilters,
    renderSettings,
    showModal,
    closeModal,
    copyToClipboard,
  };
})();
