# Macro Relayer

Minimal relayer for EIP-712 signed transaction intents. Accepts a signed payload and submits `Only712MacroForwarder.runMacro(macro, params, signer, signature)` on behalf of a configured relayer account.

- In-memory only (no persistence). Tracks each request as new → pending → succeeded/failed.
- At startup logs relayer address, native balance, and nonce.
- Waits for transaction receipt and returns outcome in the response.

## Env

Copy `.env.example` to `.env` and set:

| Variable | Required | Description |
|----------|----------|-------------|
| `RELAYER_PRIVKEY` | yes | Relayer EOA private key (hex, with or without `0x`) |
| `RELAYER_RPC_URL` | yes | RPC URL for the chain |
| `RELAYER_ONLY712_MACRO_FORWARDER_ADDRESS` | yes | Only712MacroForwarder contract address |
| `PORT` | no | HTTP port (default 3000) |
| `CORS_ORIGIN` | no | If set, only this origin is allowed for CORS; if unset, all origins are allowed |

## Run

```bash
npm install
npm start
```

Dev with watch:

```bash
npm run dev
```

## API

### POST /relay

Submit a relay request. Body (JSON):

- `macro` (string, required): Macro contract address (e.g. FlowScheduler712Macro).
- `params` (string): `0x`-prefixed hex of the full payload for `runMacro`. Obtain it by calling the forwarder's `encodeParams(actionParams, security)`
- `signer` (string): Signer address (EOA or contract).
- `signature` (string): `0x`-prefixed hex

Response (after tx is mined): `{ id, txHash, status: 'succeeded' | 'failed', receipt?, error? }`. On validation failure returns 400. On send/receipt failure still returns 200 with `status: 'failed'` and `error`.

Example:

```bash
curl -X POST http://localhost:3000/relay \
  -H "Content-Type: application/json" \
  -d '{
    "macro": "0x...",
    "params": "0x...",
    "signer": "0x...",
    "signature": "0x..."
  }'
```

### GET /relay

List all relay records (id, status, txHash, createdAt). For debugging.

### GET /relay/:id

Return one record by id (status, request summary, txHash, receipt, error, createdAt).
