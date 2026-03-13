# ClearSigning Relayer

Minimal relayer for EIP-712 signed transaction intents.

It accepts a signed payload and submits `ClearSigningMacroForwarder.runMacro(macro, params, signer, signature)` on behalf of a configured relayer account.

It also includes:

- push notifications with accept/reject actions
- device pairing to agent addresses
- a small PWA for device registration
- SQLite persistence for requests and notifications

## Features

- relay EIP-712 signed macro intents
- pair devices with agent addresses
- send actionable push notifications
- execute approved requests from notification responses
- build agent requests from metadata-driven macro definitions

## Setup

### 1. Install

```bash
npm install
```

### 2. Generate VAPID keys

```bash
npm run generate-vapid
```

### 3. Configure environment

Copy `.env.example` to `.env` and set:

| Variable | Required | Description |
|----------|----------|-------------|
| `RELAYER_PRIVKEY` | yes | Relayer EOA private key |
| `RELAYER_RPC_URL` | yes | RPC URL for the relayer chain |
| `RELAYER_CLEAR_SIGNING_MACRO_FORWARDER_ADDRESS` | yes | ClearSigningMacroForwarder contract address |
| `VAPID_PUBLIC_KEY` | yes* | Web push VAPID public key |
| `VAPID_PRIVATE_KEY` | yes* | Web push VAPID private key |
| `HOST` | no | HTTP host, default `localhost` |
| `PORT` | no | HTTP port, default `3000` |
| `DATABASE_PATH` | no | SQLite path, default `./data.db` |

`*` required for push notifications.

## Run

```bash
npm run dev
```

Build:

```bash
npm run build
```

Typecheck:

```bash
npm run typecheck
```

## API

### Relay

#### `POST /relay`

Body:

```json
{
  "macro": "0x...",
  "params": "0x...",
  "signer": "0x...",
  "signature": "0x..."
}
```

Response: `{ id, txHash, status, receipt?, error? }`

### Agent relay

#### `POST /agent-relay`

Body:

```json
{
  "forwarderAddress": "0x...",
  "macroAddress": "0x...",
  "signer": "0x...",
  "signature": "0x...",
  "params": "0x...",
  "message": { "...": "..." },
  "actionDescription": "Create flow schedule ..."
}
```

Response: `{ id, agentAddress, devicesNotified, createdAt }`

#### `GET /pending-requests`

List pending requests. Optional query param: `?agent=0x...`

#### `GET /pending-requests/:id`

Get one pending request.

#### `GET /pairing-info?agent=0x...`

Get pairing info for an agent.

### Push notifications

#### `GET /vapid-public-key`

Returns `{ publicKey }`

#### `POST /devices`

Registers a device.

#### `GET /devices`

Lists devices.

#### `DELETE /devices/:id`

Unregisters a device.

#### `GET /notifications`

Lists notifications. Optional query param: `?deviceId=...`

#### `POST /response`

Records a notification response and executes the request on accept.

## Web app

The root URL `/` provides:

1. device registration
2. pairing with `/?agent=0x...`
3. notification history

## Agent harness

The `agent/` directory contains a generic request CLI plus reusable helpers.

There are now two PoC flows:

- macro-based clear-signing requests
- registry-driven arbitrary contract-call intents

### Metadata-driven requests

Macros are defined in `agent/macros/*.json`.

The CLI is generic:

```bash
npx tsx agent/request.ts submit \
  --macro flow-scheduler \
  --action create-flow-schedule \
  --args '{"superToken":"0x...","receiver":"0x...","flowRate":"11574074074074"}' \
  --private-key 0x... \
  --rpc-url https://optimism-sepolia.rpc.x.superfluid.dev \
  --relayer-url http://localhost:3000
```

Build only:

```bash
npx tsx agent/request.ts build \
  --macro flow-scheduler \
  --action create-flow-schedule \
  --args '{"superToken":"0x...","receiver":"0x...","flowRate":"11574074074074"}' \
  --private-key 0x... \
  --rpc-url https://optimism-sepolia.rpc.x.superfluid.dev
```

Sign prepared JSON from stdin:

```bash
... build ... | npx tsx agent/request.ts sign --private-key 0x...
```

Send signed JSON from stdin:

```bash
... sign ... | npx tsx agent/request.ts send --relayer-url http://localhost:3000
```

### CLI options

- `--macro`: macro metadata name, e.g. `flow-scheduler`
- `--action`: action name, e.g. `create-flow-schedule`
- `--args`: JSON object with action arguments
- `--private-key`: signer key, or `PRIVATE_KEY`
- `--rpc-url`: RPC URL, or `RPC_URL`
- `--chain-id`: chain id, default `11155420`
- `--forwarder`: forwarder override; otherwise use signer config
- `--relayer-url`: relayer URL, default `http://localhost:3000`
- `--signer`: signer address override
- `--domain`: security domain override
- `--provider`: security provider override
- `--valid-after`: valid-after timestamp
- `--valid-before`: valid-before timestamp
- `--nonce-key`: nonce key
- `--dry-run`: build and sign only

### Metadata conventions

Each macro JSON defines:

- per-chain macro addresses
- optional default security domain
- actions with:
  - optional `context`
  - required `fields`

Field specs are short strings such as:

- `address`
- `int96`
- `uint32=86400`
- `uint32=now+3600`
- `bytes=0x`
- `bytes32:en`

The runtime uses convention over metadata repetition:

- action `create-flow-schedule` -> encode function `encodeCreateFlowScheduleParams`
- encode inputs = context values + one final tuple of action fields
- typed data metadata comes from the macro contract itself:
  - `getPrimaryTypeName(params)`
  - `getActionTypeDefinition(params)`
- action message = `{ description, ...fields }`

## Usage example

1. Open `http://localhost:3000/?agent=0xABC...`
2. Register push notifications
3. Submit from the agent:

```bash
npx tsx agent/request.ts submit \
  --macro flow-scheduler \
  --action create-flow-schedule \
  --args '{"superToken":"0x4eab9f84a4864325b48a30a3cf89f14672bcc752","receiver":"0x...","flowRate":"1000000000000000"}' \
  --private-key $AGENT_PRIVKEY \
  --rpc-url https://optimism-sepolia.rpc.x.superfluid.dev
```

4. Accept or reject on the paired device

## Notes

- push notifications need HTTPS in production
- localhost works for local development
- responses persist in SQLite
- forwarder address is signer config, not macro metadata
- default chain is Optimism Sepolia
- default forwarder is `0x712F1ccD0472025EC75bB67A92AA6406cDA0031D`

## Testing

Run everything:

```bash
npm test
```

Signer-focused tests:

```bash
npm test -- test/signer.test.ts
```

Relayer integration tests:

```bash
npm test -- test/agent-relay.test.ts
```

## Arbitrary intent PoC

This PoC adds a second path that does not require a macro.

Instead, an agent submits a registry-backed intent describing an arbitrary protocol action. The relayer stores the preview text, sends the same notification flow, and executes a direct contract call when the user accepts.

Implemented execution kind:

- `contract_call`

Registry examples:

- `agent/intents/cctp.json` - executable PoC example
- `agent/intents/cow-swap.json` - builder-only example for an offchain order action

### Build and submit a contract-call intent

```bash
npx tsx agent/intentRequest.ts submit \
  --protocol cctp \
  --action bridge-usdc \
  --args '{"amount":"1000000","destinationDomain":6,"mintRecipient":"0x0000000000000000000000001111111111111111111111111111111111111111","burnToken":"0x2222222222222222222222222222222222222222"}' \
  --private-key 0x... \
  --rpc-url https://optimism-sepolia.rpc.x.superfluid.dev \
  --relayer-url http://localhost:3000
```

### Build a candidate registry entry with Venice

```bash
VENICE_INFERENCE_KEY=... npm run build-intent-registry -- "provide a mapping for a cctp bridging action"
```

The generated file is written under `agent/generated-intents/` for human review.

Notes:

- this is intentionally a PoC and does not try to prove onchain that description and calldata match
- the relayer recomputes the description and calldata from the registry before storing/executing the intent
- TODO: for a production-grade version, the relayer should also fully verify the attached intent signature before accepting the request
- CoW is included as a registry-builder example, but runtime execution is intentionally limited to direct contract calls for now
