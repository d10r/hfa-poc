import 'dotenv/config'
import cors from 'cors'
import express from 'express'
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

  const app = express()
  const corsOrigin = process.env.CORS_ORIGIN
  app.use(cors(corsOrigin ? { origin: corsOrigin } : {}))
  app.use(express.json())

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

  app.listen(port, () => log(`listening on port ${port}`))
}

main().catch((err) => {
  console.error('[relayer] startup failed', err)
  process.exit(1)
})
