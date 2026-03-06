import 'dotenv/config'
import cors from 'cors'
import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hash,
  type Hex,
  isAddress,
  isHex,
  encodeFunctionData,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { getDb } from './db.js'
import { configureVapid, isConfigured as isVapidConfigured, getPublicKey, sendNotification } from './push.js'
import type { Device, Notification, PushSubscription, NotifyRequest, RegisterDeviceRequest, NotificationResponse } from './types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const RUN_MACRO_ABI = [
  {
    type: 'function',
    name: 'runMacro',
    stateMutability: 'payable',
    inputs: [
      { name: 'm', type: 'address', internalType: 'contract IUserDefined712Macro' },
      { name: 'params', type: 'bytes', internalType: 'bytes' },
      { name: 'signer', type: 'address', internalType: 'address' },
      { name: 'signature', type: 'bytes', internalType: 'bytes' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const

const SIGNATURE_BYTES = 65
const SIGNATURE_HEX_LEN = 2 + SIGNATURE_BYTES * 2

type RelayStatus = 'new' | 'pending' | 'succeeded' | 'failed'

interface RelayRequest {
  macro: Address
  params: Hex
  signer: Address
  signature: Hex
}

interface RelayRecord {
  status: RelayStatus
  request: RelayRequest
  txHash?: Hash
  receipt?: { status: string; blockNumber?: string }
  error?: string
  createdAt: number
}

const relayStore = new Map<string, RelayRecord>()

function requireEnv(name: string): string {
  const v = process.env[name]
  if (v == null || v === '') throw new Error(`Missing env: ${name}`)
  return v
}

function log(msg: string): void {
  console.log(`[relayer] ${msg}`)
}

async function main() {
  const key = requireEnv('RELAYER_PRIVKEY').trim()
  const privkey = (key.startsWith('0x') ? key : `0x${key}`) as Hex
  const rpcUrl = requireEnv('RELAYER_RPC_URL')
  const forwarderAddress = requireEnv('RELAYER_ONLY712_MACRO_FORWARDER_ADDRESS') as Address
  const port = Number(process.env.PORT ?? 3000)

  const account = privateKeyToAccount(privkey)
  const transport = http(rpcUrl)
  const publicClient = createPublicClient({ transport })
  const walletClient = createWalletClient({ account, transport })

  const balance = await publicClient.getBalance({ address: account.address })
  const nonce = await publicClient.getTransactionCount({ address: account.address })
  log(`account ${account.address}`)
  log(`balance ${balance.toString()} wei`)
  log(`nonce ${nonce}`)

  configureVapid()
  if (isVapidConfigured()) {
    log(`VAPID public key: ${getPublicKey()}`)
  }

  const db = getDb()

  const app = express()
  const corsOrigin = process.env.CORS_ORIGIN
  app.use(cors(corsOrigin ? { origin: corsOrigin } : {}))
  app.use(express.json())
  app.use(express.static(path.join(__dirname, '../web')))

  app.post('/relay', async (req, res) => {
    const id = crypto.randomUUID()

    const { macro, params, signer, signature } = req.body ?? {}
    if (typeof macro !== 'string' || !isAddress(macro)) {
      res.status(400).json({ error: 'macro must be a valid address' })
      return
    }
    if (typeof params !== 'string' || !isHex(params)) {
      res.status(400).json({ error: 'params must be 0x-prefixed hex' })
      return
    }
    if (typeof signer !== 'string' || !isAddress(signer)) {
      res.status(400).json({ error: 'signer must be a valid address' })
      return
    }
    if (typeof signature !== 'string' || !isHex(signature) || signature.length !== SIGNATURE_HEX_LEN) {
      res.status(400).json({ error: `signature must be 0x-prefixed hex, 65 bytes (got ${signature?.length ?? 0} chars)` })
      return
    }

    const request: RelayRequest = {
      macro: macro as Address,
      params: params as Hex,
      signer: signer as Address,
      signature: signature as Hex,
    }
    const record: RelayRecord = {
      status: 'new',
      request,
      createdAt: Date.now(),
    }
    relayStore.set(id, record)
    log(`request ${id} signer=${signer} forwarder=${forwarderAddress} macro=${macro} paramsLen=${params.length}`)

    try {
      record.status = 'pending'
      const data = encodeFunctionData({
        abi: RUN_MACRO_ABI,
        functionName: 'runMacro',
        args: [request.macro, request.params, request.signer, request.signature],
      })
      const hash = await walletClient.sendTransaction({
        to: forwarderAddress,
        data,
      })
      record.txHash = hash
      log(`request ${id} txHash=${hash}`)

      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      record.receipt = {
        status: receipt.status,
        blockNumber: receipt.blockNumber.toString(),
      }
      record.status = receipt.status === 'success' ? 'succeeded' : 'failed'
      log(`request ${id} outcome=${record.status}`)

      res.status(200).json({
        id,
        txHash: hash,
        status: record.status,
        receipt: record.receipt,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      record.status = 'failed'
      record.error = message
      log(`request ${id} failed: ${message}`)
      res.status(200).json({
        id,
        txHash: record.txHash,
        status: 'failed',
        error: message,
      })
    }
  })

  app.get('/relay', (_req, res) => {
    const list = Array.from(relayStore.entries()).map(([id, r]) => ({
      id,
      status: r.status,
      txHash: r.txHash,
      createdAt: r.createdAt,
    }))
    res.json(list)
  })

  app.get('/relay/:id', (req, res) => {
    const r = relayStore.get(req.params.id)
    if (!r) {
      res.status(404).json({ error: 'not found' })
      return
    }
    res.json({
      id: req.params.id,
      status: r.status,
      request: { macro: r.request.macro, signer: r.request.signer, paramsLength: r.request.params.length },
      txHash: r.txHash,
      receipt: r.receipt,
      error: r.error,
      createdAt: r.createdAt,
    })
  })

  app.get('/vapid-public-key', (_req, res) => {
    const publicKey = getPublicKey()
    if (!publicKey) {
      res.status(503).json({ error: 'VAPID not configured' })
      return
    }
    res.json({ publicKey })
  })

  app.post('/devices', (req, res) => {
    const { subscription } = req.body as RegisterDeviceRequest
    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      res.status(400).json({ error: 'Invalid subscription object' })
      return
    }

    const id = crypto.randomUUID()
    const now = Date.now()

    const stmt = db.prepare(`
      INSERT INTO devices (id, endpoint, p256dh, auth, created_at)
      VALUES (?, ?, ?, ?, ?)
    `)
    stmt.run(id, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, now)

    log(`device registered: ${id}`)
    res.status(201).json({ id, createdAt: now })
  })

  app.get('/devices', (_req, res) => {
    const stmt = db.prepare('SELECT id, created_at FROM devices')
    const rows = stmt.all() as { id: string; created_at: number }[]
    res.json(rows.map(r => ({ id: r.id, createdAt: r.created_at })))
  })

  app.get('/devices/:id', (req, res) => {
    const stmt = db.prepare('SELECT id, endpoint, p256dh, auth, created_at FROM devices WHERE id = ?')
    const row = stmt.get(req.params.id) as { id: string; endpoint: string; p256dh: string; auth: string; created_at: number } | undefined
    if (!row) {
      res.status(404).json({ error: 'Device not found' })
      return
    }
    res.json({
      id: row.id,
      createdAt: row.created_at,
    })
  })

  app.delete('/devices/:id', (req, res) => {
    const stmt = db.prepare('DELETE FROM devices WHERE id = ?')
    const result = stmt.run(req.params.id)
    if (result.changes === 0) {
      res.status(404).json({ error: 'Device not found' })
      return
    }
    log(`device unregistered: ${req.params.id}`)
    res.status(204).send()
  })

  app.post('/notify', async (req, res) => {
    if (!isVapidConfigured()) {
      res.status(503).json({ error: 'Push notifications not configured' })
      return
    }

    const { deviceId, message } = req.body as NotifyRequest
    if (!deviceId || !message) {
      res.status(400).json({ error: 'deviceId and message are required' })
      return
    }

    const deviceStmt = db.prepare('SELECT id, endpoint, p256dh, auth, created_at FROM devices WHERE id = ?')
    const deviceRow = deviceStmt.get(deviceId) as { id: string; endpoint: string; p256dh: string; auth: string; created_at: number } | undefined
    if (!deviceRow) {
      res.status(404).json({ error: 'Device not found' })
      return
    }

    const notificationId = crypto.randomUUID()
    const now = Date.now()

    const notiStmt = db.prepare(`
      INSERT INTO notifications (id, device_id, message, response, created_at, responded_at)
      VALUES (?, ?, ?, NULL, ?, NULL)
    `)
    notiStmt.run(notificationId, deviceId, message, now)

    const device: Device = {
      id: deviceRow.id,
      endpoint: deviceRow.endpoint,
      p256dh: deviceRow.p256dh,
      auth: deviceRow.auth,
      createdAt: deviceRow.created_at,
    }

    const notification: Notification = {
      id: notificationId,
      deviceId,
      message,
      response: null,
      createdAt: now,
      respondedAt: null,
    }

    const result = await sendNotification(device, notification)
    if (!result.success) {
      res.status(500).json({ error: result.error })
      return
    }

    log(`notification sent: ${notificationId} to device ${deviceId}`)
    res.status(201).json({ id: notificationId, createdAt: now })
  })

  app.get('/notifications/:id', (req, res) => {
    const stmt = db.prepare('SELECT id, device_id, message, response, created_at, responded_at FROM notifications WHERE id = ?')
    const row = stmt.get(req.params.id) as { id: string; device_id: string; message: string; response: string | null; created_at: number; responded_at: number | null } | undefined
    if (!row) {
      res.status(404).json({ error: 'Notification not found' })
      return
    }
    res.json({
      id: row.id,
      deviceId: row.device_id,
      message: row.message,
      response: row.response,
      createdAt: row.created_at,
      respondedAt: row.responded_at,
    })
  })

  app.get('/notifications', (req, res) => {
    const deviceId = req.query.deviceId as string | undefined
    let stmt
    if (deviceId) {
      stmt = db.prepare('SELECT id, device_id, message, response, created_at, responded_at FROM notifications WHERE device_id = ? ORDER BY created_at DESC')
      const rows = stmt.all(deviceId) as { id: string; device_id: string; message: string; response: string | null; created_at: number; responded_at: number | null }[]
      res.json(rows.map(r => ({
        id: r.id,
        deviceId: r.device_id,
        message: r.message,
        response: r.response,
        createdAt: r.created_at,
        respondedAt: r.responded_at,
      })))
    } else {
      stmt = db.prepare('SELECT id, device_id, message, response, created_at, responded_at FROM notifications ORDER BY created_at DESC')
      const rows = stmt.all() as { id: string; device_id: string; message: string; response: string | null; created_at: number; responded_at: number | null }[]
      res.json(rows.map(r => ({
        id: r.id,
        deviceId: r.device_id,
        message: r.message,
        response: r.response,
        createdAt: r.created_at,
        respondedAt: r.responded_at,
      })))
    }
  })

  app.post('/response', (req, res) => {
    const { notificationId, response } = req.body as NotificationResponse
    if (!notificationId || !response) {
      res.status(400).json({ error: 'notificationId and response are required' })
      return
    }
    if (response !== 'accepted' && response !== 'rejected') {
      res.status(400).json({ error: 'response must be "accepted" or "rejected"' })
      return
    }

    const checkStmt = db.prepare('SELECT id FROM notifications WHERE id = ?')
    const existing = checkStmt.get(notificationId)
    if (!existing) {
      res.status(404).json({ error: 'Notification not found' })
      return
    }

    const now = Date.now()
    const updateStmt = db.prepare('UPDATE notifications SET response = ?, responded_at = ? WHERE id = ?')
    updateStmt.run(response, now, notificationId)

    log(`notification ${notificationId} ${response}`)
    res.json({ id: notificationId, response, respondedAt: now })
  })

  app.listen(port, '0.0.0.0', () => log(`listening on 0.0.0.0:${port}`))
}

main().catch((err) => {
  console.error('[relayer] startup failed', err)
  process.exit(1)
})