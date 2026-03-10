# ClearSigning Relayer

Minimal relayer for EIP-712 signed transaction intents. Accepts a signed payload and submits `ClearSigningMacroForwarder.runMacro(macro, params, signer, signature)` on behalf of a configured relayer account.

Also includes a **Push Notification Service** for sending actionable notifications to registered devices, with **Agent Relay** support for transaction requestApproval.

## Features

- Relay EIP-712 signed transaction intents
- Push notifications with Accept/Reject actions
- Agent pairing: link devices to agent addresses
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
| `RELAYER_CLEAR_SIGNING_MACRO_FORWARDER_ADDRESS` | yes | ClearSigningMacroForwarder contract address |
| `HOST` | no | Host to bind to (default: `localhost`) |
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

Build:

```bash
npm run build
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

### Agent Relay Endpoints

#### POST /agent-relay

Submit a transaction request from an agent. Sends push notification to all devices paired with the agent (signer address).

Body:
```json
{
  "forwarderAddress": "0x...",
  "macroAddress": "0x...",
  "signer": "0x...",
  "signature": "0x...",
  "params": "0x...",
  "message": { ... },
  "actionDescription": "Create flow schedule of 10 USDCx/day to 0x..."
}
```

Response: `{ id, agentAddress, devicesNotified, createdAt }`

#### GET /pending-requests

List all pending transaction requests. Optional query param: `?agent=0x...`

#### GET /pending-requests/:id

Get a specific pending request.

#### GET /pairing-info?agent=0x...

Get pairing info for an agent address.

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
  },
  "agentAddress": "0x..."  // optional: pair device with agent
}
```

Response: `{ id, agentAddress, createdAt }`

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

The notification has Accept and Reject buttons.

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
2. **Agent Pairing**: Open `/?agent=0x...` to pair device with an agent
3. **Notification History**: View received notifications and their response status

## Agent Harness

The `agent/` directory contains scripts for signing transaction requests.

### signer.ts

Sign a FlowScheduler712Macro transaction request:

```bash
npx tsx agent/sign.ts \
  --private-key 0x... \
  --forwarder 0x... \
  --macro 0x... \
  --super-token 0x... \
  --receiver 0x... \
  --flow-rate 11574074074074 \
  --relayer-url http://localhost:3000
```

Options:
- `--private-key`: Agent's private key (or set `PRIVATE_KEY` env)
- `--rpc-url`: RPC URL (or set `RPC_URL` env)
- `--chain-id`: Chain ID (default: 11155420 for OP Sepolia)
- `--forwarder`: Forwarder contract address
- `--macro`: Macro contract address
- `--relayer-url`: Relayer API URL (default: http://localhost:3000)
- `--super-token`: SuperToken address
- `--receiver`: Receiver address
- `--flow-rate`: Flow rate in wei per second
- `--start-date`: Start date (unix timestamp, default: 1 hour from now)
- `--end-date`: End date (unix timestamp, default: 0)
- `--dry-run`: Only output JSON, don't send to relayer

## Usage Example

### 1. Pair Device with Agent

1. Open the web app with agent parameter: `http://localhost:3000/?agent=0xABC...`
2. Click "Register for Push Notifications"
3. Device is now paired with that agent

### 2. Send Transaction Request (as Agent)

```bash
npx tsx agent/sign.ts \
  --private-key $AGENT_PRIVKEY \
  --forwarder 0x... \
  --macro 0x... \
  --super-token 0x... \
  --receiver 0x... \
  --flow-rate 1000000000000000
```

### 3. Respond to Notification

When the notification appears on the paired device, tap Accept or Reject. The response is recorded.

### 4. Check Pending Request

```bash
curl http://localhost:3000/pending-requests/REQUEST-ID
```

## Notes

- Push notifications require HTTPS in production (localhost works for development)
- Service worker must be registered for push notifications to work
- Responses are stored in SQLite and persist across restarts
- For FlowScheduler712Macro, ensure the signer has granted flow permissions to the FlowScheduler contract
