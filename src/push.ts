import webpush from 'web-push'
import type { PushSubscription, Device, Notification } from './types.js'

let vapidConfigured = false

function isMockPushConfigured(): boolean {
  return process.env.PUSH_MOCK_SUCCESS === '1' || process.env.PUSH_MOCK_FAILURE === '1'
}

export function configureVapid(): void {
  const publicKey = process.env.VAPID_PUBLIC_KEY
  const privateKey = process.env.VAPID_PRIVATE_KEY
  const subject = process.env.VAPID_SUBJECT || 'mailto:noreply@example.com'

  if (!publicKey || !privateKey) {
    console.warn('[push] VAPID keys not configured. Push notifications will not work.')
    console.warn('[push] Run: npm run generate-vapid')
    return
  }

  webpush.setVapidDetails(subject, publicKey, privateKey)
  vapidConfigured = true
}

export function isConfigured(): boolean {
  return vapidConfigured || isMockPushConfigured()
}

export function getPublicKey(): string | undefined {
  return process.env.VAPID_PUBLIC_KEY
}

export function deviceToSubscription(device: Device): PushSubscription {
  return {
    endpoint: device.endpoint,
    keys: {
      p256dh: device.p256dh,
      auth: device.auth,
    },
  }
}

export async function sendNotification(
  device: Device,
  notification: Notification
): Promise<{ success: boolean; error?: string }> {
  if (process.env.PUSH_MOCK_SUCCESS === '1') {
    return { success: true }
  }

  if (process.env.PUSH_MOCK_FAILURE === '1') {
    return { success: false, error: 'Mock push failure' }
  }

  if (!vapidConfigured) {
    return { success: false,error: 'VAPID not configured' }
  }

  const subscription = deviceToSubscription(device)
  const payload = JSON.stringify({
    notificationId: notification.id,
    message: notification.message,
  })

  try {
    await webpush.sendNotification(subscription, payload)
    return { success: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[push] Failed to send notification: ${message}`)
    return { success: false, error: message }
  }
}
