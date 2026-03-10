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
import type { Device, Notification, PushSubscription, NotifyRequest, RegisterDeviceRequest, NotificationResponse, AgentRelayRequest, PendingRequest } from './types.js'

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
type PendingRequestStatus = 'pending' | 'accepted' | 'rejected' | 'executing' | 'succeeded' | 'failed'

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

interface StoredPendingRequestRow {
  id: string
  agent_address: string
  forwarder_address: string
  macro_address: string
  params: string
  signer: string
  signature: string
  message: string
  action_description: string | null
  status: PendingRequestStatus
  notification_count: number
  response: string | null
  tx_hash: string | null
  error: string | null
  created_at: number
  executed_at: number | null
  responded_at: number | null
}

interface StoredNotificationRow {
  id: string
  device_id: string
  pending_request_id: string | null
  message: string
  response: string | null
  created_at: number
  responded_at: number | null
}

const relayStore = new Map<string, RelayRecord>()

function toPendingRequest(row: StoredPendingRequestRow): PendingRequest {
  return {
    id: row.id,
    agentAddress: row.agent_address,
    forwarderAddress: row.forwarder_address,
    macroAddress: row.macro_address,
    params: row.params,
    signer: row.signer,
    signature: row.signature,
    message: row.message,
    actionDescription: row.action_description,
    status: row.status,
    notificationCount: row.notification_count,
    response: row.response as PendingRequest['response'],
    txHash: row.tx_hash,
    error: row.error,
    createdAt: row.created_at,
    executedAt: row.executed_at,
    respondedAt: row.responded_at,
  }
}

function toNotification(row: StoredNotificationRow): Notification {
  return {
    id: row.id,
    deviceId: row.device_id,
    pendingRequestId: row.pending_request_id,
    message: row.message,
    response: row.response as Notification['response'],
    createdAt: row.created_at,
    respondedAt: row.responded_at,
  }
}

function requireEnv(name: string): string {
  const v = process.env[name]
  if (v == null || v === '') throw new Error(`Missing env: ${name}`)
  return v
}

function log(msg: string): void {
  console.log(`[relayer] ${msg}`)
}

function getConfiguredForwarderAddress(): Address {
  return requireEnv('RELAYER_CLEAR_SIGNING_MACRO_FORWARDER_ADDRESS') as Address
}

function isMockRelayExecutionEnabled(): boolean {
  return process.env.MOCK_RELAY_EXECUTION === 'success' || process.env.MOCK_RELAY_EXECUTION === 'failure'
}

function isTerminalPendingRequestStatus(status: PendingRequestStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'rejected'
}

async function main() {
  const key = requireEnv('RELAYER_PRIVKEY').trim()
  const privkey = (key.startsWith('0x') ? key : `0x${key}`) as Hex
  const rpcUrl = requireEnv('RELAYER_RPC_URL')
  const forwarderAddress = getConfiguredForwarderAddress()
  const host = process.env.HOST ?? 'localhost'
  const port = Number(process.env.PORT ?? 3000)

  const account = privateKeyToAccount(privkey)
  const transport = http(rpcUrl)
  const publicClient = createPublicClient({ transport })
  const walletClient = createWalletClient({ account, transport })

  let balance = 0n
  let nonce = 0
  if (!isMockRelayExecutionEnabled()) {
    balance = await publicClient.getBalance({ address: account.address })
    nonce = await publicClient.getTransactionCount({ address: account.address })
  }
  log(`account ${account.address}`)
  log(`balance ${balance.toString()} wei`)
  log(`nonce ${nonce}`)

  configureVapid()
  if (isVapidConfigured()) {
    log(`VAPID public key: ${getPublicKey()}`)
  }

  const db = getDb()

  async function executeRelayRequest(request: RelayRequest, targetForwarderAddress?: Address): Promise<{
    txHash?: Hash
    receipt?: { status: string; blockNumber?: string }
    error?: string
    status: RelayStatus
  }> {
    if (process.env.MOCK_RELAY_EXECUTION === 'success') {
      return {
        txHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
        receipt: { status: 'success', blockNumber: '1' },
        status: 'succeeded',
      }
    }

    if (process.env.MOCK_RELAY_EXECUTION === 'failure') {
      return {
        status: 'failed',
        error: 'Mock relay failure',
      }
    }

    try {
      const data = encodeFunctionData({
        abi: RUN_MACRO_ABI,
        functionName: 'runMacro',
        args: [request.macro, request.params, request.signer, request.signature],
      })
      const hash = await walletClient.sendTransaction({
        chain: null,
        to: targetForwarderAddress ?? forwarderAddress,
        data,
      })
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      return {
        txHash: hash,
        receipt: {
          status: receipt.status,
          blockNumber: receipt.blockNumber.toString(),
        },
        status: receipt.status === 'success' ? 'succeeded' : 'failed',
      }
    } catch (err) {
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      return {
        status: 'failed',
        error: message,
      }
    }
  }

  const app = express()
  const corsOrigin = process.env.CORS_ORIGIN
  app.use(cors(corsOrigin ? { origin: corsOrigin } : {}))
  app.use(express.json())

  app.get('/sw.js', (_req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate')
    res.sendFile(path.join(__dirname, '../web/sw.js'))
  })
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
      const result = await executeRelayRequest(request)
      record.txHash = result.txHash
      record.receipt = result.receipt
      record.status = result.status
      if (result.txHash) {
        log(`request ${id} txHash=${result.txHash}`)
      }
      if (result.error) {
        record.error = result.error
      }
      log(`request ${id} outcome=${record.status}`)

      res.status(200).json({
        id,
        txHash: record.txHash,
        status: record.status,
        receipt: record.receipt,
        error: record.error,
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
    const { subscription, agentAddress } = req.body as RegisterDeviceRequest
    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      res.status(400).json({ error: 'Invalid subscription object' })
      return
    }
    if (agentAddress !== undefined && agentAddress !== null && !isAddress(agentAddress)) {
      res.status(400).json({ error: 'agentAddress must be a valid address' })
      return
    }

    const id = crypto.randomUUID()
    const now = Date.now()

    const stmt = db.prepare(`
      INSERT INTO devices (id, endpoint, p256dh, auth, agent_address, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    stmt.run(id, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, agentAddress || null, now)

    if (agentAddress) {
      const agentStmt = db.prepare(`
        INSERT OR IGNORE INTO agents (address, created_at) VALUES (?, ?)
      `)
      agentStmt.run(agentAddress, now)
    }

    log(`device registered: ${id}${agentAddress ? ` for agent ${agentAddress}` : ''}`)
    res.status(201).json({ id, agentAddress, createdAt: now })
  })

  app.get('/devices', (_req, res) => {
    const stmt = db.prepare('SELECT id, created_at FROM devices')
    const rows = stmt.all() as { id: string; created_at: number }[]
    res.json(rows.map(r => ({ id: r.id, createdAt: r.created_at })))
  })

  app.get('/devices/:id', (req, res) => {
    const stmt = db.prepare('SELECT id, agent_address, created_at FROM devices WHERE id = ?')
    const row = stmt.get(req.params.id) as { id: string; agent_address: string | null; created_at: number } | undefined
    if (!row) {
      res.status(404).json({ error: 'Device not found' })
      return
    }
    res.json({
      id: row.id,
      agentAddress: row.agent_address,
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

    const deviceStmt = db.prepare('SELECT id, endpoint, p256dh, auth, agent_address, created_at FROM devices WHERE id = ?')
    const deviceRow = deviceStmt.get(deviceId) as { id: string; endpoint: string; p256dh: string; auth: string; agent_address: string | null; created_at: number } | undefined
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
      agentAddress: deviceRow.agent_address,
      createdAt: deviceRow.created_at,
    }

    const notification: Notification = {
      id: notificationId,
      deviceId,
      pendingRequestId: null,
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
    const stmt = db.prepare('SELECT id, device_id, pending_request_id, message, response, created_at, responded_at FROM notifications WHERE id = ?')
    const row = stmt.get(req.params.id) as StoredNotificationRow | undefined
    if (!row) {
      res.status(404).json({ error: 'Notification not found' })
      return
    }
    res.json(toNotification(row))
  })

  app.get('/notifications', (req, res) => {
    const deviceId = req.query.deviceId as string | undefined
    let stmt
    if (deviceId) {
      stmt = db.prepare('SELECT id, device_id, pending_request_id, message, response, created_at, responded_at FROM notifications WHERE device_id = ? ORDER BY created_at DESC')
      const rows = stmt.all(deviceId) as StoredNotificationRow[]
      res.json(rows.map(toNotification))
    } else {
      stmt = db.prepare('SELECT id, device_id, pending_request_id, message, response, created_at, responded_at FROM notifications ORDER BY created_at DESC')
      const rows = stmt.all() as StoredNotificationRow[]
      res.json(rows.map(toNotification))
    }
  })

  app.post('/response', async (req, res) => {
    const { notificationId, response, messageLength } = req.body as NotificationResponse
    if (!notificationId || !response) {
      res.status(400).json({ error: 'notificationId and response are required' })
      return
    }
    if (response !== 'accepted' && response !== 'rejected') {
      res.status(400).json({ error: 'response must be "accepted" or "rejected"' })
      return
    }

    const notificationStmt = db.prepare('SELECT id, device_id, pending_request_id, message, response, created_at, responded_at FROM notifications WHERE id = ?')
    const notificationRow = notificationStmt.get(notificationId) as StoredNotificationRow | undefined
    if (!notificationRow) {
      res.status(404).json({ error: 'Notification not found' })
      return
    }

    if (notificationRow.response) {
      const pendingRequest = notificationRow.pending_request_id
        ? db.prepare('SELECT * FROM pending_requests WHERE id = ?').get(notificationRow.pending_request_id) as StoredPendingRequestRow | undefined
        : undefined
      res.json({
        id: notificationId,
        response: notificationRow.response,
        respondedAt: notificationRow.responded_at,
        pendingRequest: pendingRequest ? toPendingRequest(pendingRequest) : undefined,
      })
      return
    }

    const now = Date.now()
    const updateStmt = db.prepare('UPDATE notifications SET response = ?, responded_at = ? WHERE id = ?')
    updateStmt.run(response, now, notificationId)

    const pendingRequestId = notificationRow.pending_request_id
    if (!pendingRequestId) {
      if (response === 'accepted' && messageLength !== undefined) {
        log(`notification ${notificationId} ${response} messageLength=${messageLength}`)
      } else {
        log(`notification ${notificationId} ${response}`)
      }
      res.json({ id: notificationId, response, respondedAt: now })
      return
    }

    const pendingStmt = db.prepare('SELECT * FROM pending_requests WHERE id = ?')
    const pendingRow = pendingStmt.get(pendingRequestId) as StoredPendingRequestRow | undefined
    if (!pendingRow) {
      res.status(404).json({ error: 'Pending request not found' })
      return
    }

    if (isTerminalPendingRequestStatus(pendingRow.status)) {
      res.json({
        id: notificationId,
        response: notificationRow.response,
        respondedAt: notificationRow.responded_at,
        pendingRequest: toPendingRequest(pendingRow),
      })
      return
    }

    if (response === 'rejected') {
      db.prepare('UPDATE pending_requests SET response = ?, status = ?, responded_at = ? WHERE id = ?')
        .run('rejected', 'rejected', now, pendingRequestId)
      log(`notification ${notificationId} rejected request ${pendingRequestId}`)
      const updated = pendingStmt.get(pendingRequestId) as StoredPendingRequestRow
      res.json({
        id: notificationId,
        response,
        respondedAt: now,
        pendingRequest: toPendingRequest(updated),
      })
      return
    }

    db.prepare('UPDATE pending_requests SET response = ?, status = ?, responded_at = ?, error = NULL WHERE id = ?')
      .run('accepted', 'accepted', now, pendingRequestId)
    db.prepare('UPDATE pending_requests SET status = ? WHERE id = ?')
      .run('executing', pendingRequestId)

    const relayRequest: RelayRequest = {
      macro: pendingRow.macro_address as Address,
      params: pendingRow.params as Hex,
      signer: pendingRow.signer as Address,
      signature: pendingRow.signature as Hex,
    }

    const result = await executeRelayRequest(relayRequest, pendingRow.forwarder_address as Address)
    const finalStatus: PendingRequestStatus = result.status === 'succeeded' ? 'succeeded' : 'failed'
    const executedAt = Date.now()

    db.prepare(
      'UPDATE pending_requests SET status = ?, tx_hash = ?, error = ?, executed_at = ?, responded_at = ? WHERE id = ?'
    ).run(finalStatus, result.txHash ?? null, result.error ?? null, executedAt, now, pendingRequestId)

    if (response === 'accepted' && messageLength !== undefined) {
      log(`notification ${notificationId} ${response} messageLength=${messageLength} request=${pendingRequestId} status=${finalStatus}`)
    } else {
      log(`notification ${notificationId} ${response} request=${pendingRequestId} status=${finalStatus}`)
    }
    const updated = pendingStmt.get(pendingRequestId) as StoredPendingRequestRow
    res.json({ id: notificationId, response, respondedAt: now, pendingRequest: toPendingRequest(updated) })
  })

  app.get('/pairing-info', (req, res) => {
    const agentAddress = req.query.agent as string | undefined
    if (!agentAddress || !isAddress(agentAddress)) {
      res.status(400).json({ error: 'Valid agent address required' })
      return
    }
    res.json({
      agentAddress,
      message: `Register to receive transaction requests from agent ${agentAddress}`,
    })
  })

  app.post('/agent-relay', async (req, res) => {
    if (!isVapidConfigured()) {
      res.status(503).json({ error: 'Push notifications not configured' })
      return
    }

    const body = req.body as AgentRelayRequest
    const { forwarderAddress, macroAddress, signer, signature, params, message, actionDescription } = body

    if (!forwarderAddress || !isAddress(forwarderAddress)) {
      res.status(400).json({ error: 'forwarderAddress must be a valid address' })
      return
    }
    if (!macroAddress || !isAddress(macroAddress)) {
      res.status(400).json({ error: 'macroAddress must be a valid address' })
      return
    }
    if (!signer || !isAddress(signer)) {
      res.status(400).json({ error: 'signer must be a valid address' })
      return
    }
    if (!signature || !isHex(signature)) {
      res.status(400).json({ error: 'signature must be 0x-prefixed hex' })
      return
    }
    if (!params || !isHex(params)) {
      res.status(400).json({ error: 'params must be 0x-prefixed hex' })
      return
    }
    if (!message || typeof message !== 'object') {
      res.status(400).json({ error: 'message must be an object' })
      return
    }

    const agentAddress = signer

    const agentStmt = db.prepare('INSERT OR IGNORE INTO agents (address, created_at) VALUES (?, ?)')
    agentStmt.run(agentAddress, Date.now())

    const deviceStmt = db.prepare('SELECT id, endpoint, p256dh, auth, created_at FROM devices WHERE agent_address = ?')
    const devices = deviceStmt.all(agentAddress) as { id: string; endpoint: string; p256dh: string; auth: string; created_at: number }[]

    if (devices.length === 0) {
      res.status(404).json({ error: 'No devices registered for this agent' })
      return
    }

    const requestId = crypto.randomUUID()
    const now = Date.now()
    const messageJson = JSON.stringify(message)
    const description = actionDescription || (message as { action?: { description?: string } }).action?.description || 'Transaction request'

    const requestStmt = db.prepare(`
      INSERT INTO pending_requests (id, agent_address, forwarder_address, macro_address, params, signer, signature, message, action_description, status, notification_count, response, tx_hash, error, created_at, executed_at, responded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, ?, NULL, NULL)
    `)
    requestStmt.run(requestId, agentAddress, forwarderAddress, macroAddress, params, signer, signature, messageJson, description, now)

    const notiStmt = db.prepare(`
      INSERT INTO notifications (id, device_id, pending_request_id, message, response, created_at, responded_at)
      VALUES (?, ?, ?, ?, NULL, ?, NULL)
    `)
    const incrementNotificationCountStmt = db.prepare('UPDATE pending_requests SET notification_count = notification_count + 1 WHERE id = ?')

    let sentCount = 0
    const errors: string[] = []

    for (const deviceRow of devices) {
      const notificationId = crypto.randomUUID()
      notiStmt.run(notificationId, deviceRow.id, requestId, description, now)
      incrementNotificationCountStmt.run(requestId)

      const device: Device = {
        id: deviceRow.id,
        endpoint: deviceRow.endpoint,
        p256dh: deviceRow.p256dh,
        auth: deviceRow.auth,
        agentAddress: agentAddress,
        createdAt: deviceRow.created_at,
      }

      const notification: Notification = {
        id: notificationId,
        deviceId: deviceRow.id,
        pendingRequestId: requestId,
        message: description,
        response: null,
        createdAt: now,
        respondedAt: null,
      }

      const result = await sendNotification(device, notification)
      if (result.success) {
        sentCount++
      } else {
        errors.push(`device ${deviceRow.id}: ${result.error}`)
      }
    }

    log(`agent-relay ${requestId} from ${agentAddress}: sent ${sentCount}/${devices.length} notifications`)
    
    if (sentCount === 0) {
      db.prepare('UPDATE pending_requests SET status = ?, error = ? WHERE id = ?')
        .run('failed', errors.join('; ') || 'Failed to send any notifications', requestId)
      res.status(500).json({ error: 'Failed to send any notifications', details: errors })
      return
    }

    res.status(201).json({
      id: requestId,
      agentAddress,
      devicesNotified: sentCount,
      createdAt: now,
    })
  })

  app.get('/pending-requests/:id', (req, res) => {
    const stmt = db.prepare('SELECT * FROM pending_requests WHERE id = ?')
    const row = stmt.get(req.params.id) as StoredPendingRequestRow | undefined
    if (!row) {
      res.status(404).json({ error: 'Pending request not found' })
      return
    }
    const request = toPendingRequest(row)
    res.json({
      ...request,
      message: JSON.parse(request.message),
    })
  })

  app.get('/pending-requests', (req, res) => {
    const agentAddress = req.query.agent as string | undefined
    let stmt
    if (agentAddress) {
      stmt = db.prepare('SELECT * FROM pending_requests WHERE agent_address = ? ORDER BY created_at DESC')
      const rows = stmt.all(agentAddress) as StoredPendingRequestRow[]
      res.json(rows.map(toPendingRequest))
    } else {
      stmt = db.prepare('SELECT * FROM pending_requests ORDER BY created_at DESC')
      const rows = stmt.all() as StoredPendingRequestRow[]
      res.json(rows.map(toPendingRequest))
    }
  })

  app.listen(port, host, () => log(`listening on ${host}:${port}`))
}

main().catch((err) => {
  console.error('[relayer] startup failed', err)
  process.exit(1)
})
