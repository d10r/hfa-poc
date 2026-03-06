# Macro Relayer

Minimal relayer for EIP-712 signed transaction intents. Accepts a signed payload and submits `Only712MacroForwarder.runMacro(macro, params, signer, signature)` on behalf of a configured relayer account.

Also includes a **Push Notification Service** for sending actionable notifications to registered devices.

## Features

- Relay EIP-712 signed transaction intents
- Push notifications with Accept/Reject actions
- PWA web app for device registration
- SQLite persistence for device subscriptions and notification history

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Generate VAPID Keys

```bash
npm run generate-vapid
```

This outputs something like:
```
VAPID_PUBLIC_KEY=BC...
VAPID_PRIVATE_KEY=...
```

### 3. Configure Environment

Copy `.env.example` to `.env` and set:

| Variable | Required | Description |
|----------|----------|-------------|
| `RELAYER_PRIVKEY` | yes | Relayer EOA private key (hex, with or without `0x`) |
| `RELAYER_RPC_URL` | yes | RPC URL for the chain |
| `RELAYER_ONLY712_MACRO_FORWARDER_ADDRESS` | yes | Only712MacroForwarder contract address |
| `PORT` | no | HTTP port (default 3000) |
| `CORS_ORIGIN` | no | If set, only this origin is allowed for CORS; if unset, all origins are allowed |
| `VAPID_PUBLIC_KEY` | yes* | VAPID public key for push notifications |
| `VAPID_PRIVATE_KEY` | yes* | VAPID private key for push notifications |
| `VAPID_SUBJECT` | no | VAPID subject (default: `mailto:noreply@example.com`) |
| `DATABASE_PATH` | no | SQLite database path (default: `./data.db`) |

*Required for push notifications to work.

## Run

```bash
npm start
```

Dev with watch:

```bash
npm run dev
```

## API

### Relay Endpoints

#### POST /relay

Submit a relay request. Body (JSON):

- `macro` (string, required): Macro contract address
- `params` (string): `0x`-prefixed hex of the full payload for `runMacro`
- `signer` (string): Signer address (EOA or contract)
- `signature` (string): `0x`-prefixed hex

Response: `{ id, txHash, status, receipt?, error? }`

#### GET /relay

List all relay records.

#### GET /relay/:id

Get a specific relay record.

### Push Notification Endpoints

#### GET /vapid-public-key

Returns the VAPID public key needed for client-side push subscription.

Response: `{ publicKey: string }`

#### POST /devices

Register a device for push notifications.

Body:
```json
{
  "subscription": {
    "endpoint": "https://...",
    "keys": {
      "p256dh": "...",
      "auth": "..."
    }
  }
}
```

Response: `{ id, createdAt }`

#### GET /devices

List all registered devices.

#### GET /devices/:id

Get a specific device.

#### DELETE /devices/:id

Unregister a device.

#### POST /notify

Send a push notification to a device.

Body:
```json
{
  "deviceId": "uuid-of-device",
  "message": "Approve transaction?"
}
```

Response: `{ id, createdAt }`

The notification will have two action buttons: **Accept** and **Reject**.

#### GET /notifications

List all notifications. Optional query param: `?deviceId=uuid`

#### GET /notifications/:id

Get a specific notification with its response status.

Response:
```json
{
  "id": "uuid",
  "deviceId": "uuid",
  "message": "Approve transaction?",
  "response": "accepted",  // or "rejected" or null
  "createdAt": 1234567890,
  "respondedAt": 1234567891
}
```

#### POST /response

Record a user's response to a notification. Called by the service worker.

Body:
```json
{
  "notificationId": "uuid",
  "response": "accepted"  // or "rejected"
}
```

## Web App

Access the web app at the root URL (`/`). It provides:

1. **Device Registration**: Request push notification permission and register the device
2. **Notification History**: View received notifications and their response status

## Usage Example

### 1. Register a Device

1. Open the web app in a browser (Chrome/Edge recommended for push support)
2. Click "Register for Push Notifications"
3. Accept the notification permission prompt
4. Note the Device ID shown

### 2. Send a Notification

```bash
curl -X POST http://localhost:3000/notify \
  -H "Content-Type: application/json" \
  -d '{"deviceId": "YOUR-DEVICE-ID", "message": "Deploy Safe?"}'
```

### 3. Respond to Notification

When the notification appears, click **Accept** or **Reject**. The response is recorded.

### 4. Check Response

```bash
curl http://localhost:3000/notifications/YOUR-NOTIFICATION-ID
```

## Notes

- Push notifications require HTTPS in production (localhost works for development)
- Service worker must be registered for push notifications to work
- Responses are stored in SQLite and persist across restarts