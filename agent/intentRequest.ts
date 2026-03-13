import 'dotenv/config'
import { type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { hashTypedData, serializeTypedData } from 'viem'
import { buildContractCallIntent } from './intentRegistry.js'

interface Flags {
  [key: string]: string | boolean | undefined
}

function parseFlags(args: string[]): { command: string; flags: Flags } {
  const command = args[0] || 'submit'
  const flags: Flags = {}
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = args[i + 1]
    if (next && !next.startsWith('--')) {
      flags[key] = next
      i++
    } else if (key === 'dry-run') {
      flags['dry-run'] = true
    }
  }
  return { command, flags }
}

function getRequiredString(flags: Flags, key: string): string {
  const value = flags[key]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Missing --${key}`)
  return value
}

function parseArgsJson(json: string): Record<string, unknown> {
  const parsed = JSON.parse(json) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('--args must be a JSON object')
  return parsed as Record<string, unknown>
}

async function buildRequest(flags: Flags) {
  const chainId = parseInt(flags['chain-id'] as string || process.env.CHAIN_ID || '11155420')
  const protocol = getRequiredString(flags, 'protocol')
  const action = getRequiredString(flags, 'action')
  const args = parseArgsJson(getRequiredString(flags, 'args'))
  const privateKey = (flags['private-key'] || process.env.PRIVATE_KEY) as Hex | undefined
  if (!privateKey) throw new Error('Missing --private-key or PRIVATE_KEY env')

  const signer = privateKeyToAccount(privateKey)
  const intent = buildContractCallIntent({ protocol, action, chainId, args })

  const typedData = {
    domain: {
      name: 'HumanFriendlyIntent',
      version: '1',
      chainId,
      verifyingContract: intent.to,
    },
    primaryType: 'IntentEnvelope',
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
      protocol: intent.protocol,
      action: intent.action,
      to: intent.to,
      data: intent.data,
      value: intent.value,
      description: intent.description,
    },
  } as const

  const signature = await signer.signTypedData({
    domain: typedData.domain,
    primaryType: typedData.primaryType,
    types: typedData.types,
    message: typedData.message,
  })

  return {
    requestKind: 'contract_call' as const,
    signatureKind: 'eip712' as const,
    signer: signer.address as Address,
    signature,
    intent: {
      protocol: intent.protocol,
      action: intent.action,
      chainId: intent.chainId,
      to: intent.to,
      data: intent.data,
      value: intent.value.toString(),
      args: intent.args,
    },
    message: {
      action: {
        description: intent.description,
      },
      typedData: serializeTypedData(typedData),
      typedDataHash: hashTypedData(typedData),
    },
    actionDescription: intent.description,
  }
}

async function send(relayerUrl: string, request: unknown) {
  const res = await fetch(`${relayerUrl}/intent-relay`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  })
  if (!res.ok) {
    const err = await res.json()
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

async function main() {
  const { command, flags } = parseFlags(process.argv.slice(2))
  if (command === 'build') {
    console.log(JSON.stringify(await buildRequest(flags), null, 2))
    return
  }
  const request = await buildRequest(flags)
  if (flags['dry-run']) {
    console.log(JSON.stringify(request, null, 2))
    return
  }
  const relayerUrl = (flags['relayer-url'] || process.env.RELAYER_URL || 'http://localhost:3000') as string
  console.log(JSON.stringify(await send(relayerUrl, request), null, 2))
}

main().catch(err => {
  console.error('Error:', err.message)
  process.exit(1)
})
