import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import {
  buildTypedData,
  parsePreparedUnsignedRequest,
  parseSignedAgentRequest,
  serializeForJson,
  getChain,
  type ClearSigningTypedDataMessage,
} from '../agent/clearSigning.js'
import type { PreparedUnsignedRequest, SignedAgentRequest } from '../agent/clearSigning.js'
import {
  buildMacroAction,
  getMacroMetadata,
  parseArgsJson,
} from '../agent/macroMetadata.js'
import { buildContractCallIntent, getIntentRegistryEntry, verifyIntentDescription } from '../agent/intentRegistry.js'

const TEST_CHAIN_ID = 11155420
const TEST_FORWARDER = '0x712F1ccD0472025EC75bB67A92AA6406cDA0031D'
const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const TEST_SIGNER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const RELAYER_DIR = '/home/didi/src/sf/hfa/relayer'

test('clearSigning: getChain returns correct chain config', () => {
  const chain = getChain(TEST_CHAIN_ID, 'https://sepolia.optimism.io')
  assert.strictEqual(chain.id, TEST_CHAIN_ID)
  assert.strictEqual(chain.name, 'Chain 11155420')
  assert.strictEqual(chain.nativeCurrency.symbol, 'ETH')
})

test('clearSigning: buildTypedData returns valid EIP-712 structure', () => {
  const message: ClearSigningTypedDataMessage = {
    action: { description: 'Test action' },
    domain: 'test.domain',
    nonce: 1n,
    provider: 'test.provider',
    validAfter: 0n,
    validBefore: 1000000000n,
  }

  const typedData = buildTypedData(
    TEST_CHAIN_ID,
    TEST_FORWARDER,
    'TestAction',
    'Action(string description)',
    message
  )

  assert.strictEqual(typedData.domain.name, 'ClearSigning')
  assert.strictEqual(typedData.domain.version, '1')
  assert.strictEqual(typedData.domain.chainId, TEST_CHAIN_ID)
  assert.strictEqual(typedData.domain.verifyingContract, TEST_FORWARDER)
  assert.strictEqual(typedData.primaryType, 'TestAction')
  assert.ok(Array.isArray(typedData.types.TestAction))
  assert.ok(Array.isArray(typedData.types.Action))
})

test('clearSigning: serializeForJson handles bigint correctly', () => {
  const obj = {
    value: 1234567890123456789n,
    nested: { amount: 100n },
    normal: 'string',
    number: 42,
  }

  const parsed = JSON.parse(serializeForJson(obj))
  assert.strictEqual(parsed.value, '1234567890123456789')
  assert.strictEqual(parsed.nested.amount, '100')
  assert.strictEqual(parsed.normal, 'string')
  assert.strictEqual(parsed.number, 42)
})

test('clearSigning: serializeForJson handles all types', () => {
  const parsed = JSON.parse(serializeForJson({ bigint: 0n, negative: -1n, max: 18446744073709551615n, zero: '0' }))
  assert.strictEqual(parsed.bigint, '0')
  assert.strictEqual(parsed.negative, '-1')
  assert.strictEqual(parsed.max, '18446744073709551615')
  assert.strictEqual(parsed.zero, '0')
})

test('macro metadata: loads configured macro and action', () => {
  const metadata = getMacroMetadata('flow-scheduler', 'create-flow-schedule', TEST_CHAIN_ID)
  assert.strictEqual(metadata.macroAddress, '0x7b043b577A10b06296FE0bD0402F5025d97A3839')
  assert.strictEqual(metadata.securityDomain, 'flowscheduler.xyz')
  assert.ok(metadata.action.fields.superToken)
})

test('macro metadata: parses args json object', () => {
  assert.deepStrictEqual(parseArgsJson('{"foo":"bar"}'), { foo: 'bar' })
  assert.throws(() => parseArgsJson('[]'), /must be a JSON object/)
})

test('signing: can sign with correct private key', async () => {
  const { signPreparedRequest } = await import('../agent/clearSigning.js')
  const prepared: PreparedUnsignedRequest = {
    forwarderAddress: TEST_FORWARDER,
    macroAddress: '0x1234567890123456789012345678901234567890',
    signer: TEST_SIGNER,
    params: '0x',
    typedData: {
      domain: { name: 'ClearSigning', version: '1', chainId: TEST_CHAIN_ID, verifyingContract: TEST_FORWARDER },
      types: {
        Action: [{ name: 'description', type: 'string' }],
        ScheduleFlow: [
          { name: 'action', type: 'Action' },
          { name: 'domain', type: 'string' },
          { name: 'nonce', type: 'uint256' },
          { name: 'provider', type: 'string' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
        ],
      },
      primaryType: 'ScheduleFlow',
      message: {
        action: { description: 'Test flow' },
        domain: 'test',
        nonce: 0n,
        provider: 'test',
        validAfter: 0n,
        validBefore: 0n,
      },
    },
    message: {
      action: { description: 'Test flow' },
      domain: 'test',
      nonce: 0n,
      provider: 'test',
      validAfter: 0n,
      validBefore: 0n,
    },
    actionDescription: 'Test flow',
  }

  const signed = await signPreparedRequest(TEST_PRIVATE_KEY, prepared)
  assert.strictEqual(signed.forwarderAddress, TEST_FORWARDER)
  assert.strictEqual(signed.signer, TEST_SIGNER)
  assert.ok(signed.signature.startsWith('0x'))
  assert.strictEqual(signed.signature.length, 132)
})

test('signing: throws on signer mismatch', async () => {
  const { signPreparedRequest } = await import('../agent/clearSigning.js')
  const prepared: PreparedUnsignedRequest = {
    forwarderAddress: TEST_FORWARDER,
    macroAddress: '0x1234567890123456789012345678901234567890',
    signer: '0xwrongaddress0000000000000000000000000',
    params: '0x',
    typedData: {
      domain: { name: 'ClearSigning', version: '1', chainId: TEST_CHAIN_ID, verifyingContract: TEST_FORWARDER },
      types: {
        Action: [{ name: 'description', type: 'string' }],
        ScheduleFlow: [
          { name: 'action', type: 'Action' },
          { name: 'domain', type: 'string' },
          { name: 'nonce', type: 'uint256' },
          { name: 'provider', type: 'string' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
        ],
      },
      primaryType: 'ScheduleFlow',
      message: {
        action: { description: 'Test flow' },
        domain: 'test',
        nonce: 0n,
        provider: 'test',
        validAfter: 0n,
        validBefore: 0n,
      },
    },
    message: {
      action: { description: 'Test flow' },
      domain: 'test',
      nonce: 0n,
      provider: 'test',
      validAfter: 0n,
      validBefore: 0n,
    },
    actionDescription: 'Test flow',
  }

  await assert.rejects(signPreparedRequest(TEST_PRIVATE_KEY, prepared), /Signer address mismatch/)
})

test('relayClient: can serialize and deserialize signed request', async () => {
  const { signPreparedRequest } = await import('../agent/clearSigning.js')
  const prepared: PreparedUnsignedRequest = {
    forwarderAddress: TEST_FORWARDER,
    macroAddress: '0x1234567890123456789012345678901234567890',
    signer: TEST_SIGNER,
    params: '0xabcdef',
    typedData: {
      domain: { name: 'ClearSigning', version: '1', chainId: TEST_CHAIN_ID, verifyingContract: TEST_FORWARDER },
      types: {
        Action: [{ name: 'description', type: 'string' }],
        ScheduleFlow: [
          { name: 'action', type: 'Action' },
          { name: 'domain', type: 'string' },
          { name: 'nonce', type: 'uint256' },
          { name: 'provider', type: 'string' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
        ],
      },
      primaryType: 'ScheduleFlow',
      message: {
        action: { description: 'Test flow' },
        domain: 'test',
        nonce: 0n,
        provider: 'test',
        validAfter: 0n,
        validBefore: 0n,
      },
    },
    message: {
      action: { description: 'Test flow' },
      domain: 'test',
      nonce: 0n,
      provider: 'test',
      validAfter: 0n,
      validBefore: 0n,
    },
    actionDescription: 'Test flow: send 1 USDCx/sec to 0x123...',
  }

  const signed = await signPreparedRequest(TEST_PRIVATE_KEY, prepared)
  const parsed: SignedAgentRequest = JSON.parse(serializeForJson(signed))
  assert.strictEqual(parsed.forwarderAddress, TEST_FORWARDER)
  assert.strictEqual(parsed.signer, TEST_SIGNER)
  assert.strictEqual(parsed.params, '0xabcdef')
  assert.ok(parsed.signature.startsWith('0x'))
})

test('request parsing: prepared request restores bigint fields', () => {
  const parsed = parsePreparedUnsignedRequest(JSON.stringify({
    forwarderAddress: TEST_FORWARDER,
    macroAddress: '0x1234567890123456789012345678901234567890',
    signer: TEST_SIGNER,
    params: '0xabcdef',
    typedData: {
      domain: { name: 'ClearSigning', version: '1', chainId: TEST_CHAIN_ID, verifyingContract: TEST_FORWARDER },
      types: {
        Action: [{ name: 'description', type: 'string' }, { name: 'flowRate', type: 'int96' }],
        ScheduleFlow: [
          { name: 'action', type: 'Action' },
          { name: 'domain', type: 'string' },
          { name: 'nonce', type: 'uint256' },
          { name: 'provider', type: 'string' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
        ],
      },
      primaryType: 'ScheduleFlow',
      message: {
        action: { description: 'Test flow', flowRate: '123' },
        domain: 'test',
        nonce: '1',
        provider: 'test',
        validAfter: '2',
        validBefore: '3',
      },
    },
    message: {
      action: { description: 'Test flow', flowRate: '123' },
      domain: 'test',
      nonce: '1',
      provider: 'test',
      validAfter: '2',
      validBefore: '3',
    },
    actionDescription: 'Test flow',
  }))

  assert.strictEqual(parsed.message.nonce, 1n)
  assert.strictEqual(parsed.message.validAfter, 2n)
  assert.strictEqual(parsed.message.validBefore, 3n)
})

test('request parsing: signed request restores bigint fields', () => {
  const parsed = parseSignedAgentRequest(JSON.stringify({
    forwarderAddress: TEST_FORWARDER,
    macroAddress: '0x1234567890123456789012345678901234567890',
    signer: TEST_SIGNER,
    signature: '0xabcdef',
    params: '0x1234',
    message: {
      action: { description: 'Test flow', flowRate: '123' },
      domain: 'test',
      nonce: '1',
      provider: 'test',
      validAfter: '2',
      validBefore: '3',
    },
    actionDescription: 'Test flow',
  }))

  assert.strictEqual(parsed.message.nonce, 1n)
  assert.strictEqual(parsed.message.validAfter, 2n)
  assert.strictEqual(parsed.message.validBefore, 3n)
})

test('request CLI: sign command accepts serialized prepared request from stdin', async () => {
  const prepared: PreparedUnsignedRequest = {
    forwarderAddress: TEST_FORWARDER,
    macroAddress: '0x1234567890123456789012345678901234567890',
    signer: TEST_SIGNER,
    params: '0xabcdef',
    typedData: {
      domain: { name: 'ClearSigning', version: '1', chainId: TEST_CHAIN_ID, verifyingContract: TEST_FORWARDER },
      types: {
        Action: [{ name: 'description', type: 'string' }, { name: 'flowRate', type: 'int96' }],
        ScheduleFlow: [
          { name: 'action', type: 'Action' },
          { name: 'domain', type: 'string' },
          { name: 'nonce', type: 'uint256' },
          { name: 'provider', type: 'string' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
        ],
      },
      primaryType: 'ScheduleFlow',
      message: {
        action: { description: 'Test flow', flowRate: 123n },
        domain: 'test',
        nonce: 1n,
        provider: 'test',
        validAfter: 2n,
        validBefore: 3n,
      },
    },
    message: {
      action: { description: 'Test flow', flowRate: 123n },
      domain: 'test',
      nonce: 1n,
      provider: 'test',
      validAfter: 2n,
      validBefore: 3n,
    },
    actionDescription: 'Test flow',
  }

  const child = spawn('npx', ['tsx', 'agent/request.ts', 'sign', '--private-key', TEST_PRIVATE_KEY], {
    cwd: RELAYER_DIR,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdin.end(serializeForJson(prepared))

  const stdoutChunks: Buffer[] = []
  const stderrChunks: Buffer[] = []
  child.stdout.on('data', chunk => stdoutChunks.push(Buffer.from(chunk)))
  child.stderr.on('data', chunk => stderrChunks.push(Buffer.from(chunk)))

  const [code] = await once(child, 'exit') as [number | null]
  assert.strictEqual(code, 0, Buffer.concat(stderrChunks).toString())
  const signed = parseSignedAgentRequest(Buffer.concat(stdoutChunks).toString())
  assert.strictEqual(signed.signer, TEST_SIGNER)
  assert.strictEqual(signed.message.nonce, 1n)
})

test('request CLI: send command posts signed request from stdin', async () => {
  const requests: unknown[] = []
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/agent-relay') {
      res.statusCode = 404
      res.end('not found')
      return
    }
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString()))
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ id: 'req-1', agentAddress: TEST_SIGNER, devicesNotified: 1 }))
    })
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const relayerUrl = `http://127.0.0.1:${address.port}`

  const signedJson = JSON.stringify({
    forwarderAddress: TEST_FORWARDER,
    macroAddress: '0x1234567890123456789012345678901234567890',
    signer: TEST_SIGNER,
    signature: '0xabcdef',
    params: '0x1234',
    message: {
      action: { description: 'Test flow', flowRate: '123' },
      domain: 'test',
      nonce: '1',
      provider: 'test',
      validAfter: '2',
      validBefore: '3',
    },
    actionDescription: 'Test flow',
  })

  try {
    const child = spawn('npx', ['tsx', 'agent/request.ts', 'send', '--relayer-url', relayerUrl], {
      cwd: RELAYER_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stdin.end(signedJson)

    const stderrChunks: Buffer[] = []
    child.stderr.on('data', chunk => stderrChunks.push(Buffer.from(chunk)))
    const [code] = await once(child, 'exit') as [number | null]
    assert.strictEqual(code, 0, Buffer.concat(stderrChunks).toString())
    assert.strictEqual(requests.length, 1)
    assert.deepStrictEqual(requests[0], JSON.parse(signedJson))
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
  }
})

test('macro metadata: build action fails for unknown macro', () => {
  assert.throws(() => getMacroMetadata('missing', 'create-flow-schedule', TEST_CHAIN_ID), /Unknown macro/)
})

test('macro metadata: build action fails for unknown action', () => {
  assert.throws(() => getMacroMetadata('flow-scheduler', 'missing', TEST_CHAIN_ID), /Unknown action/)
})

test('macro metadata: build action can use metadata and rpc', async () => {
  const metadata = getMacroMetadata('flow-scheduler', 'create-flow-schedule', TEST_CHAIN_ID)

  const requests: Array<{ method: string; params: unknown[] }> = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString()) as { method: string; params: unknown[]; id: number }
      requests.push({ method: payload.method, params: payload.params })

      let result: unknown = '0x'
      if (payload.method === 'eth_call') {
        const call = payload.params[0] as { data: string }
        if (call.data.startsWith('0x652452e8')) {
          result = '0x'
            + '0000000000000000000000000000000000000000000000000000000000000060'
            + '00000000000000000000000000000000000000000000000000000000000000a0'
            + '1111111111111111111111111111111111111111111111111111111111111111'
            + '000000000000000000000000000000000000000000000000000000000000000e'
            + '437265617465206120666c6f7700000000000000000000000000000000000000'
            + '0000000000000000000000000000000000000000000000000000000000000002'
            + '1234000000000000000000000000000000000000000000000000000000000000'
        } else if (call.data.startsWith('0x390b89cb')) {
          result = '0x'
            + '0000000000000000000000000000000000000000000000000000000000000020'
            + '000000000000000000000000000000000000000000000000000000000000000c'
            + '5363686564756c65466c6f770000000000000000000000000000000000000000'
        } else if (call.data.startsWith('0x39f05f94')) {
          const value = 'Action(string description,address superToken,address receiver,uint32 startDate,uint32 startMaxDelay,int96 flowRate,uint256 startAmount,uint32 endDate,bytes userData)'
          const hex = Buffer.from(value, 'utf8').toString('hex')
          const padded = hex.padEnd(Math.ceil(hex.length / 64) * 64, '0')
          result = '0x'
            + '0000000000000000000000000000000000000000000000000000000000000020'
            + value.length.toString(16).padStart(64, '0')
            + padded
        }
      }

      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result }))
    })
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')

  try {
    const built = await buildMacroAction({
      rpcUrl: `http://127.0.0.1:${address.port}`,
      chainId: TEST_CHAIN_ID,
      macroAddress: metadata.macroAddress,
      actionName: 'create-flow-schedule',
      action: metadata.action,
      args: {
        superToken: '0x1111111111111111111111111111111111111111',
        receiver: '0x2222222222222222222222222222222222222222',
        flowRate: '123',
      },
    })

    assert.match(built.actionDescription, /^Create a flow/)
    assert.strictEqual(built.actionParams, '0x1234')
    assert.strictEqual(built.primaryType, 'ScheduleFlow')
    assert.match(built.actionTypeDefinition, /^Action\(/)
    assert.match(String(built.actionMessage.description), /^Create a flow/)
    assert.strictEqual(requests.length, 3)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
  }
})

test('intent registry: loads contract_call entry', () => {
  const entry = getIntentRegistryEntry('cctp', 'bridge-usdc')
  assert.strictEqual(entry.kind, 'contract_call')
  assert.strictEqual(entry.call?.method, 'depositForBurn')
})

test('intent registry: loads offchain order entry', () => {
  const entry = getIntentRegistryEntry('cow-swap', 'place-order')
  assert.strictEqual(entry.kind, 'offchain_order')
  assert.strictEqual(entry.order?.standard, 'cow-order')
})

test('intent registry: builds contract_call intent', () => {
  const intent = buildContractCallIntent({
    protocol: 'cctp',
    action: 'bridge-usdc',
    chainId: TEST_CHAIN_ID,
    args: {
      amount: '1000000',
      destinationDomain: 6,
      mintRecipient: '0x0000000000000000000000001111111111111111111111111111111111111111',
      burnToken: '0x2222222222222222222222222222222222222222',
    },
  })

  assert.strictEqual(intent.protocol, 'cctp')
  assert.strictEqual(intent.action, 'bridge-usdc')
  assert.strictEqual(intent.to, '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA')
  assert.ok(intent.data.startsWith('0x'))
  assert.strictEqual(intent.description, 'Bridge 1 USDC to Base for recipient 0x0000...1111')
})

test('intent registry: verifies relayer-rendered description', () => {
  const description = verifyIntentDescription({
    protocol: 'cctp',
    action: 'bridge-usdc',
    args: {
      amount: '1000000',
      destinationDomain: 6,
      mintRecipient: '0x0000000000000000000000001111111111111111111111111111111111111111',
      burnToken: '0x2222222222222222222222222222222222222222',
    },
  })

  assert.strictEqual(description, 'Bridge 1 USDC to Base for recipient 0x0000...1111')
  assert.throws(
    () => verifyIntentDescription({
      protocol: 'cctp',
      action: 'bridge-usdc',
      args: {
        amount: '1000000',
        destinationDomain: 6,
        mintRecipient: '0x0000000000000000000000001111111111111111111111111111111111111111',
        burnToken: '0x2222222222222222222222222222222222222222',
      },
      description: 'Wrong description',
    }),
    /does not match/
  )
})
