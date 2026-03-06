export interface PushSubscription {
  endpoint: string
  keys: {
    p256dh: string
    auth: string
  }
}

export interface Device {
  id: string
  endpoint: string
  p256dh: string
  auth: string
  createdAt: number
}

export interface Notification {
  id: string
  deviceId: string
  message: string
  response: 'accepted' | 'rejected' | null
  createdAt: number
  respondedAt: number | null
}

export interface NotifyRequest {
  deviceId: string
  message: string
}

export interface RegisterDeviceRequest {
  subscription: PushSubscription
}

export interface NotificationResponse {
  notificationId: string
  response: 'accepted' | 'rejected'
  messageLength?: number
}