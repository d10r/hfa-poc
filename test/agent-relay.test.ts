import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { hashTypedData } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { Address, Hex } from 'viem'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const RELAYER_DIR = '/home/didi/src/sf/hfa/relayer'
const BASE_PRIVATE_KEY = '0xed5d2867d5695eb68eb35cc4000692cbe3bca9f3fb77d9f32da619098113c035'
const BASE_ADDRESS = '0xe171980ab7b97e440774d59dd2b1cbbf87366f2e'
const FORWARDER_ADDRESS = '0x712F1ccD0472025EC75bB67A92AA6406cDA0031D'
const MACRO_ADDRESS = '0x7b043b577A10b06296FE0bD0402F5025d97A3839'
const PARAMS = '0x1234'
const SIGNATURE = `0x${'11'.repeat(65)}`

interface TestServer {
  baseUrl: string
  process: ChildProcessByStdio<null, Readable, Readable>
  dbPath: string
  cleanup: () => Promise<void>
}

interface JsonResponse<T> {
  status: number
  body: T
}

async function startServer(options?: {
  pushMode?: 'success' | 'failure'
  relayMode?: 'success' | 'failure'
}): Promise<TestServer> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'hfa-relayer-test-'))
  const dbPath = path.join(tempDir, 'data.db')
  const basePort = 5800 + Math.floor(Math.random() * 1000)
  let port = basePort

  let child = spawn('npx', ['tsx', 'src/app.ts'], {
    cwd: RELAYER_DIR,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      DATABASE_PATH: dbPath,
      RELAYER_PRIVKEY: BASE_PRIVATE_KEY,
      RELAYER_RPC_URL: 'http://127.0.0.1:1',
      RELAYER_CLEAR_SIGNING_MACRO_FORWARDER_ADDRESS: FORWARDER_ADDRESS,
      PUSH_MOCK_SUCCESS: options?.pushMode === 'success' ? '1' : '0',
      PUSH_MOCK_FAILURE: options?.pushMode === 'failure' ? '1' : '0',
      MOCK_RELAY_EXECUTION: options?.relayMode ?? '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const ready = new Promise<void>((resolve, reject) => {
    const onStdout = (chunk: Buffer) => {
      const text = chunk.toString()
      if (text.includes('listening on')) {
        child.stdout.off('data', onStdout)
        child.off('exit', onExit)
        resolve()
      }
    }

    const onExit = (code: number | null) => {
      child.stdout.off('data', onStdout)
      if (code === 1 && port < basePort + 10) {
        port += 1
        child = spawn('npx', ['tsx', 'src/app.ts'], {
          cwd: RELAYER_DIR,
          env: {
            ...process.env,
            HOST: '127.0.0.1',
            PORT: String(port),
            DATABASE_PATH: dbPath,
            RELAYER_PRIVKEY: BASE_PRIVATE_KEY,
            RELAYER_RPC_URL: 'http://127.0.0.1:1',
            RELAYER_CLEAR_SIGNING_MACRO_FORWARDER_ADDRESS: FORWARDER_ADDRESS,
            PUSH_MOCK_SUCCESS: options?.pushMode === 'success' ? '1' : '0',
            PUSH_MOCK_FAILURE: options?.pushMode === 'failure' ? '1' : '0',
            MOCK_RELAY_EXECUTION: options?.relayMode ?? '',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        child.stdout.on('data', onStdout)
        child.once('exit', onExit)
        child.stderr.on('data', chunk => {
          const text = chunk.toString()
          if (text.trim()) process.stderr.write(text)
        })
        return
      }
      reject(new Error(`Server exited early with code ${code}`))
    }

    child.stdout.on('data', onStdout)
    child.once('exit', onExit)
    child.stderr.on('data', chunk => {
      const text = chunk.toString()
      if (text.trim()) {
        process.stderr.write(text)
      }
    })
  })

  child.on('exit', (code, signal) => {
    if (code !== 0 && signal == null) {
      process.stderr.write(`relayer test server exited unexpectedly with code ${code}\n`)
    }
  })

  await ready

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    process: child,
    dbPath,
    cleanup: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        const exited = await Promise.race([
          once(child, 'exit').then(() => true).catch(() => false),
          new Promise<boolean>(resolve => setTimeout(() => resolve(false), 2000)),
        ])

        if (!exited && child.exitCode === null) {
          child.kill('SIGKILL')
          await once(child, 'exit').catch(() => undefined)
        }
      }

      child.stdout.destroy()
      child.stderr.destroy()
      await rm(tempDir, { recursive: true, force: true })
    },
  }
}

async function postJson<T>(baseUrl: string, pathname: string, body: unknown): Promise<JsonResponse<T>> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return {
    status: response.status,
    body: await response.json() as T,
  }
}

async function getJson<T>(baseUrl: string, pathname: string): Promise<T> {
  const response = await fetch(`${baseUrl}${pathname}`)
  assert.equal(response.status, 200)
  return response.json() as Promise<T>
}

function makeSubscription(endpointSuffix: string) {
  return {
    endpoint: `https://push.example/${endpointSuffix}`,
    keys: {
      p256dh: 'p256dh-key',
      auth: 'auth-key',
    },
  }
}

test('accepting a pending request executes and persists success', async () => {
  const server = await startServer({ pushMode: 'success', relayMode: 'success' })

  try {
    const device = await postJson<{ id: string }>(server.baseUrl, '/devices', {
      subscription: makeSubscription('device-1'),
      agentAddress: BASE_ADDRESS,
    })
    assert.equal(device.status, 201)

    const agentRelay = await postJson<{ id: string; devicesNotified: number }>(server.baseUrl, '/agent-relay', {
      forwarderAddress: FORWARDER_ADDRESS,
      macroAddress: MACRO_ADDRESS,
      signer: BASE_ADDRESS,
      signature: SIGNATURE,
      params: PARAMS,
      message: { action: { description: 'Test action' } },
      actionDescription: 'Test action',
    })

    assert.equal(agentRelay.status, 201)
    assert.equal(agentRelay.body.devicesNotified, 1)

    const notifications = await getJson<Array<{ id: string; pendingRequestId: string | null }>>(
      server.baseUrl,
      `/notifications?deviceId=${device.body.id}`
    )

    assert.equal(notifications.length, 1)
    assert.equal(notifications[0].pendingRequestId, agentRelay.body.id)

    const response = await postJson<{ pendingRequest: { status: string; txHash: string | null; response: string | null } }>(
      server.baseUrl,
      '/response',
      { notificationId: notifications[0].id, response: 'accepted' }
    )

    assert.equal(response.status, 200)
    assert.equal(response.body.pendingRequest.status, 'succeeded')
    assert.equal(response.body.pendingRequest.response, 'accepted')
    assert.ok(response.body.pendingRequest.txHash)

    const pending = await getJson<{
      id: string
      status: string
      response: string | null
      txHash: string | null
      executedAt: number | null
      notificationCount: number
    }>(server.baseUrl, `/pending-requests/${agentRelay.body.id}`)

    assert.equal(pending.status, 'succeeded')
    assert.equal(pending.response, 'accepted')
    assert.equal(pending.notificationCount, 1)
    assert.ok(pending.txHash)
    assert.ok(pending.executedAt)
  } finally {
    await server.cleanup()
  }
})

test('rejecting a pending request resolves without execution', async () => {
  const server = await startServer({ pushMode: 'success', relayMode: 'success' })

  try {
    const device = await postJson<{ id: string }>(server.baseUrl, '/devices', {
      subscription: makeSubscription('device-2'),
      agentAddress: BASE_ADDRESS,
    })
    assert.equal(device.status, 201)

    const agentRelay = await postJson<{ id: string }>(server.baseUrl, '/agent-relay', {
      forwarderAddress: FORWARDER_ADDRESS,
      macroAddress: MACRO_ADDRESS,
      signer: BASE_ADDRESS,
      signature: SIGNATURE,
      params: PARAMS,
      message: { action: { description: 'Reject me' } },
      actionDescription: 'Reject me',
    })
    assert.equal(agentRelay.status, 201)

    const notifications = await getJson<Array<{ id: string }>>(
      server.baseUrl,
      `/notifications?deviceId=${device.body.id}`
    )

    const response = await postJson<{ pendingRequest: { status: string; txHash: string | null; response: string | null } }>(
      server.baseUrl,
      '/response',
      { notificationId: notifications[0].id, response: 'rejected' }
    )

    assert.equal(response.status, 200)
    assert.equal(response.body.pendingRequest.status, 'rejected')
    assert.equal(response.body.pendingRequest.response, 'rejected')
    assert.equal(response.body.pendingRequest.txHash, null)
  } finally {
    await server.cleanup()
  }
})

test('multiple paired devices get distinct notifications', async () => {
  const server = await startServer({ pushMode: 'success', relayMode: 'success' })

  try {
    const deviceOne = await postJson<{ id: string }>(server.baseUrl, '/devices', {
      subscription: makeSubscription('device-a'),
      agentAddress: BASE_ADDRESS,
    })
    const deviceTwo = await postJson<{ id: string }>(server.baseUrl, '/devices', {
      subscription: makeSubscription('device-b'),
      agentAddress: BASE_ADDRESS,
    })
    assert.equal(deviceOne.status, 201)
    assert.equal(deviceTwo.status, 201)

    const agentRelay = await postJson<{ id: string; devicesNotified: number }>(server.baseUrl, '/agent-relay', {
      forwarderAddress: FORWARDER_ADDRESS,
      macroAddress: MACRO_ADDRESS,
      signer: BASE_ADDRESS,
      signature: SIGNATURE,
      params: PARAMS,
      message: { action: { description: 'Notify both' } },
      actionDescription: 'Notify both',
    })

    assert.equal(agentRelay.status, 201)
    assert.equal(agentRelay.body.devicesNotified, 2)

    const notificationsOne = await getJson<Array<{ id: string; pendingRequestId: string | null }>>(
      server.baseUrl,
      `/notifications?deviceId=${deviceOne.body.id}`
    )
    const notificationsTwo = await getJson<Array<{ id: string; pendingRequestId: string | null }>>(
      server.baseUrl,
      `/notifications?deviceId=${deviceTwo.body.id}`
    )

    assert.equal(notificationsOne.length, 1)
    assert.equal(notificationsTwo.length, 1)
    assert.notEqual(notificationsOne[0].id, notificationsTwo[0].id)
    assert.equal(notificationsOne[0].pendingRequestId, agentRelay.body.id)
    assert.equal(notificationsTwo[0].pendingRequestId, agentRelay.body.id)
  } finally {
    await server.cleanup()
  }
})

test('duplicate acceptance is idempotent', async () => {
  const server = await startServer({ pushMode: 'success', relayMode: 'success' })

  try {
    const device = await postJson<{ id: string }>(server.baseUrl, '/devices', {
      subscription: makeSubscription('device-dup'),
      agentAddress: BASE_ADDRESS,
    })
    assert.equal(device.status, 201)

    const agentRelay = await postJson<{ id: string }>(server.baseUrl, '/agent-relay', {
      forwarderAddress: FORWARDER_ADDRESS,
      macroAddress: MACRO_ADDRESS,
      signer: BASE_ADDRESS,
      signature: SIGNATURE,
      params: PARAMS,
      message: { action: { description: 'Accept once' } },
      actionDescription: 'Accept once',
    })
    assert.equal(agentRelay.status, 201)

    const notifications = await getJson<Array<{ id: string }>>(
      server.baseUrl,
      `/notifications?deviceId=${device.body.id}`
    )

    const first = await postJson<{ pendingRequest: { status: string; txHash: string | null } }>(
      server.baseUrl,
      '/response',
      { notificationId: notifications[0].id, response: 'accepted' }
    )
    const second = await postJson<{ pendingRequest: { status: string; txHash: string | null } }>(
      server.baseUrl,
      '/response',
      { notificationId: notifications[0].id, response: 'accepted' }
    )

    assert.equal(first.body.pendingRequest.status, 'succeeded')
    assert.equal(second.body.pendingRequest.status, 'succeeded')
    assert.equal(second.body.pendingRequest.txHash, first.body.pendingRequest.txHash)
  } finally {
    await server.cleanup()
  }
})

test('failed push marks request failed when no notification can be delivered', async () => {
  const server = await startServer({ pushMode: 'failure', relayMode: 'success' })

  try {
    const device = await postJson<{ id: string }>(server.baseUrl, '/devices', {
      subscription: makeSubscription('device-fail'),
      agentAddress: BASE_ADDRESS,
    })
    assert.equal(device.status, 201)

    const agentRelay = await postJson<{ error: string }>(server.baseUrl, '/agent-relay', {
      forwarderAddress: FORWARDER_ADDRESS,
      macroAddress: MACRO_ADDRESS,
      signer: BASE_ADDRESS,
      signature: SIGNATURE,
      params: PARAMS,
      message: { action: { description: 'Fail push' } },
      actionDescription: 'Fail push',
    })

    assert.equal(agentRelay.status, 500)

    const pendingRequests = await getJson<Array<{ id: string; status: string; error: string | null }>>(
      server.baseUrl,
      `/pending-requests?agent=${BASE_ADDRESS}`
    )

    assert.equal(pendingRequests.length, 1)
    assert.equal(pendingRequests[0].status, 'failed')
    assert.match(pendingRequests[0].error ?? '', /Mock push failure/)
  } finally {
    await server.cleanup()
  }
})

test('accepting a contract_call intent executes and persists success', async () => {
  const server = await startServer({ pushMode: 'success', relayMode: 'success' })

  try {
    const signer = privateKeyToAccount(BASE_PRIVATE_KEY)
    const typedData = {
      domain: {
        name: 'HumanFriendlyIntent',
        version: '1',
        chainId: 11155420,
        verifyingContract: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA' as Address,
      },
      primaryType: 'IntentEnvelope' as const,
      types: {
        IntentEnvelope: [
          { name: 'protocol', type: 'string' },
          { name: 'action', type: 'string' },
          { name: 'to', type: 'address' },
          { name: 'data', type: 'bytes' },
          { name: 'value', type: 'uint256' },
          { name: 'description', type: 'string' },
        ],
      },
      message: {
        protocol: 'cctp',
        action: 'bridge-usdc',
        to: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA' as Address,
        data: '0x6fd3504e00000000000000000000000000000000000000000000000000000000000f4240000000000000000000000000000000000000000000000000000000000000000600000000000000000000000011111111111111111111111111111111111111110000000000000000000000002222222222222222222222222222222222222222' as Hex,
        value: 0n,
        description: 'Bridge 1 USDC to Base for recipient 0x0000...1111',
      },
    } as const
    const signature = await signer.signTypedData(typedData)
    const pairRes = await postJson<{ id: string }>(server.baseUrl, '/devices', {
      subscription: {
        endpoint: 'https://example.com/push/intent-1',
        keys: {
          p256dh: 'p256dh-intent-1',
          auth: 'auth-intent-1',
        },
      },
      agentAddress: BASE_ADDRESS,
    })
    assert.strictEqual(pairRes.status, 201)

    const relayRes = await postJson<{ id: string; devicesNotified: number }>(server.baseUrl, '/intent-relay', {
      requestKind: 'contract_call',
      signatureKind: 'eip712',
      signer: BASE_ADDRESS,
      signature,
      intent: {
        protocol: 'cctp',
        action: 'bridge-usdc',
        chainId: 11155420,
        to: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
        data: typedData.message.data,
        value: '0',
        args: {
          amount: '1000000',
          destinationDomain: 6,
          mintRecipient: '0x0000000000000000000000001111111111111111111111111111111111111111',
          burnToken: '0x2222222222222222222222222222222222222222',
        },
      },
      message: {
        action: { description: 'Bridge 1 USDC to Base for recipient 0x0000...1111' },
        typedDataHash: hashTypedData(typedData),
      },
      actionDescription: 'Bridge 1 USDC to Base for recipient 0x0000...1111',
    })
    if (relayRes.status !== 201) {
      assert.fail(JSON.stringify(relayRes.body))
    }
    assert.strictEqual(relayRes.status, 201)
    assert.strictEqual(relayRes.body.devicesNotified, 1)

    const notifications = await getJson<Array<{ id: string; pendingRequestId: string }>>(server.baseUrl, '/notifications')
    const notification = notifications[0]

    const responseRes = await postJson<{ pendingRequest: { status: string; txHash: string | null; execution: string | null; requestKind: string } }>(
      server.baseUrl,
      '/response',
      {
        notificationId: notification.id,
        response: 'accepted',
      }
    )

    assert.strictEqual(responseRes.status, 200)
    assert.strictEqual(responseRes.body.pendingRequest.requestKind, 'contract_call')
    assert.strictEqual(responseRes.body.pendingRequest.status, 'succeeded')
    assert.ok(responseRes.body.pendingRequest.txHash)
    assert.ok(responseRes.body.pendingRequest.execution)
  } finally {
    await server.cleanup()
  }
})
