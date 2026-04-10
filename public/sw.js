/**
 * pushIT Service Worker
 * Handles: caching, push notifications
 *
 * Strategy: Network-first for ALL resources.
 * Cache is used ONLY as offline fallback.
 * This ensures users always get the latest code after deploys.
 */

const CACHE_NAME = 'pushit-v30';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/app.js',
  '/js/auth.js',
  '/js/push.js',
  '/js/ui.js',
  '/manifest.json',
];

// ─── Install ────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// ─── Activate ───────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ─── Fetch: Network-first for everything ────────────────────────────
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only handle same-origin GET requests
  if (!event.request.url.startsWith(self.location.origin)) return;
  if (event.request.method !== 'GET') return;

  // Never intercept API calls or WebSocket
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/ws')) return;

  // Network-first: try network, fall back to cache
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Cache successful responses for offline fallback
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => {
        // Network failed — try cache
        return caches.match(event.request).then((cached) => {
          return cached || caches.match('/index.html');
        });
      })
  );
});

// ─── Push Notifications ─────────────────────────────────────────────
self.addEventListener('push', (event) => {
  if (!event.data) {
    event.waitUntil(
      self.registration.showNotification('pushIT', { body: 'New notification' })
    );
    return;
  }

  let data;
  try {
    data = event.data.json();
  } catch (e) {
    data = { title: 'pushIT', message: event.data.text() };
  }

  const priority = data.priority || 0;
  const title = data.title || data.app_name || 'pushIT';

  const options = {
    body: data.message || '',
    icon: data.icon || '/icons/icon-192.png',
    badge: '/icons/icon-72.png',
    tag: data.id || `pushit-${Date.now()}`,
    data: {
      id: data.id,
      url: data.url,
      priority: priority,
      receipt: data.receipt,
    },
  };

  // Large image preview in notification
  // NOTE: iOS Safari web push does NOT support the `image` property (or custom `icon`).
  // iOS only renders title + body; the icon comes from the PWA manifest, not options.icon.
  // Setting these properties is harmless — iOS silently ignores them, other platforms use them.
  if (data.image) {
    options.image = data.image;
  }

  if (priority >= 1) options.renotify = true;
  if (priority >= 2) options.requireInteraction = true;
  if (priority <= -2) options.silent = true;

  if (priority >= 2 && data.receipt) {
    options.actions = [{ action: 'acknowledge', title: 'Acknowledge' }];
  } else if (data.url) {
    options.actions = [{ action: 'open', title: 'Open' }];
  }

  const unreadCount = data.unread_count || 0;

  event.waitUntil(
    self.registration.showNotification(title, options).then(() => {
      // Update iOS/OS home screen badge with unread count
      if (self.navigator && 'setAppBadge' in self.navigator && unreadCount > 0) {
        return self.navigator.setAppBadge(unreadCount);
      }
    }).catch((err) => {
      console.error('[SW] Failed to show notification:', err);
    })
  );
});

// ─── Notification Click ─────────────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
  const { action } = event;
  const data = event.notification.data || {};

  event.notification.close();

  if (action === 'acknowledge' && data.receipt) {
    event.waitUntil(acknowledgeMessage(data.id, data.receipt));
  } else if (action === 'open' && data.url) {
    // Note: iOS Safari web push does NOT support notification action buttons,
    // so this branch only fires on Android/Windows/macOS where clients.openWindow()
    // works correctly for external URLs.
    event.waitUntil(clients.openWindow(data.url));
  } else {
    event.waitUntil(
      clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
        for (const client of windowClients) {
          if (client.url.includes(self.location.origin)) {
            client.postMessage({ type: 'refresh-messages' });
            return client.focus();
          }
        }
        return clients.openWindow('/');
      })
    );
  }
});

// ─── Notification Close ─────────────────────────────────────────────
self.addEventListener('notificationclose', (event) => {});

// ─── Helpers ────────────────────────────────────────────────────────
async function acknowledgeMessage(messageId, receipt) {
  try {
    const allClients = await clients.matchAll();
    for (const client of allClients) {
      client.postMessage({ type: 'acknowledge', messageId, receipt });
    }
  } catch (err) {
    console.error('[SW] Acknowledge failed:', err);
  }
}
