/**
 * Generate VAPID keys for Web Push notifications.
 * Run: npm run vapid:generate
 * Then copy the keys to your .env file.
 */
const webPush = require('web-push');

const vapidKeys = webPush.generateVAPIDKeys();

console.log('\n📱 VAPID Keys Generated\n');
console.log('Add these to your .env file:\n');
console.log(`VAPID_PUBLIC_KEY=${vapidKeys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${vapidKeys.privateKey}`);
console.log('\nIMPORTANT: Keep the private key secret!\n');
