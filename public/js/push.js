/**
 * pushIT Push Notification Module
 * Handles service worker registration, push subscription, and device management.
 */

const PushitPush = (() => {
  let swRegistration = null;
  let currentDevice = null;

  /**
   * Register the service worker and set up push.
   */
  async function init() {
    if (!('serviceWorker' in navigator)) {
      console.warn('[Push] Service workers not supported');
      return false;
    }

    try {
      swRegistration = await navigator.serviceWorker.register('/sw.js');
      console.log('[Push] Service worker registered');

      // Listen for messages from the SW
      navigator.serviceWorker.addEventListener('message', handleSwMessage);

      return true;
    } catch (err) {
      console.error('[Push] SW registration failed:', err);
      return false;
    }
  }

  /**
   * Subscribe to push notifications and register device.
   * Returns { success: true } or { success: false, reason: string }
   */
  async function subscribe() {
    if (!swRegistration) {
      console.warn('[Push] No service worker registration');
      return { success: false, reason: 'no_sw' };
    }

    // Check if Notification API is available
    if (!('Notification' in window)) {
      console.warn('[Push] Notification API not available');
      return { success: false, reason: 'not_supported' };
    }

    // Check if already permanently denied before even prompting
    if (Notification.permission === 'denied') {
      console.warn('[Push] Notification permission denied/blocked by browser');
      return { success: false, reason: 'denied' };
    }

    // Request permission
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      console.warn('[Push] Notification permission denied');
      return { success: false, reason: permission === 'denied' ? 'denied' : 'dismissed' };
    }

    try {
      // Get VAPID key from server
      const res = await fetch('/api/v1/devices/vapid-key');
      const { vapid_public_key } = await res.json();

      if (!vapid_public_key) {
        console.error('[Push] No VAPID key configured on server');
        return { success: false, reason: 'no_vapid' };
      }

      // Convert VAPID key to Uint8Array
      const applicationServerKey = urlBase64ToUint8Array(vapid_public_key);

      // Subscribe to push
      const subscription = await swRegistration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });

      // Register device on server
      const deviceName = generateDeviceName();
      const response = await PushitAuth.apiCall('/api/v1/devices/register', {
        method: 'POST',
        body: JSON.stringify({
          name: deviceName,
          subscription: subscription.toJSON(),
          user_agent: navigator.userAgent,
        }),
      });

      const data = await response.json();
      if (data.status === 1) {
        currentDevice = data.device;
        console.log('[Push] Device registered:', currentDevice.name);
        return { success: true };
      }

      return { success: false, reason: 'server_error' };
    } catch (err) {
      console.error('[Push] Subscription failed:', err);
      return { success: false, reason: 'error' };
    }
  }

  /**
   * Check current push subscription status.
   */
  async function getSubscriptionStatus() {
    if (!swRegistration) return { subscribed: false, permission: 'default' };

    const subscription = await swRegistration.pushManager.getSubscription();
    return {
      subscribed: !!subscription,
      permission: Notification.permission,
      endpoint: subscription?.endpoint,
    };
  }

  /**
   * Unsubscribe from push notifications.
   */
  async function unsubscribe() {
    if (!swRegistration) return;

    const subscription = await swRegistration.pushManager.getSubscription();
    if (subscription) {
      await subscription.unsubscribe();
    }

    currentDevice = null;
  }

  /**
   * Handle messages from the service worker.
   */
  function handleSwMessage(event) {
    const { type, messageId, receipt } = event.data || {};

    if (type === 'acknowledge') {
      // The SW wants to acknowledge a message
      acknowledgeMessage(messageId);
    }

    if (type === 'refresh-messages') {
      // User clicked a notification — switch to messages view and refresh
      console.log('[Push] Notification click → switching to messages view');
      if (window.PushitApp) {
        window.PushitApp.switchView('messages');
      }
    }

    if (type === 'get_token') {
      // SW needs the auth token — we can't easily share it
      // The acknowledgment should go through the main app instead
    }
  }

  /**
   * Acknowledge a message through the API.
   */
  async function acknowledgeMessage(messageId) {
    try {
      await PushitAuth.apiCall(`/api/v1/messages/${messageId}/acknowledge`, {
        method: 'POST',
      });
      console.log('[Push] Message acknowledged:', messageId);
      // Trigger UI refresh
      if (window.PushitApp) {
        window.PushitApp.refreshMessages();
      }
    } catch (err) {
      console.error('[Push] Acknowledge failed:', err);
    }
  }

  /**
   * Generate a device name from browser/OS info.
   */
  function generateDeviceName() {
    const ua = navigator.userAgent;
    let name = 'unknown';

    if (/iPhone/.test(ua)) name = 'iphone';
    else if (/iPad/.test(ua)) name = 'ipad';
    else if (/Android/.test(ua)) name = 'android';
    else if (/Mac/.test(ua)) name = 'mac';
    else if (/Windows/.test(ua)) name = 'windows';
    else if (/Linux/.test(ua)) name = 'linux';

    // Append browser (order matters — Edge/Chrome both contain "Chrome")
    if (/Edg\//.test(ua)) name += '-edge';
    else if (/Firefox/.test(ua)) name += '-firefox';
    else if (/Safari/.test(ua) && !/Chrome/.test(ua)) name += '-safari';
    else if (/Chrome/.test(ua)) name += '-chrome';

    return name;
  }

  /**
   * Convert a Base64 URL-encoded string to a Uint8Array.
   */
  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  /**
   * Check if the app is running as an installed PWA.
   */
  function isInstalledPWA() {
    return window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true;
  }

  return {
    init,
    subscribe,
    getSubscriptionStatus,
    unsubscribe,
    acknowledgeMessage,
    isInstalledPWA,
    get currentDevice() { return currentDevice; },
  };
})();
