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
  agentAddress: string | null
  createdAt: number
}

export interface Notification {
  id: string
  deviceId: string
  pendingRequestId: string | null
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
  agentAddress?: string
}

export interface NotificationResponse {
  notificationId: string
  response: 'accepted' | 'rejected'
  messageLength?: number
}

export interface AgentRelayRequest {
  forwarderAddress: string
  macroAddress: string
  signer: string
  signature: string
  params: string
  message: Record<string, unknown>
  actionDescription?: string
}

export interface PendingRequest {
  id: string
  agentAddress: string
  forwarderAddress: string
  macroAddress: string
  params: string
  signer: string
  signature: string
  message: string
  actionDescription: string | null
  status: 'pending' | 'accepted' | 'rejected' | 'executing' | 'succeeded' | 'failed'
  notificationCount: number
  response: 'accepted' | 'rejected' | null
  txHash: string | null
  error: string | null
  createdAt: number
  executedAt: number | null
  respondedAt: number | null
}
