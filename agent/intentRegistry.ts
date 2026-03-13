import { readFileSync } from 'node:fs'
import path from 'node:path'
import { encodeFunctionData, formatUnits, type Abi, type Address, type Hex } from 'viem'

export interface IntentActionRegistryEntry {
  kind: 'contract_call' | 'offchain_order'
  chains?: Record<string, { to: Address }>
  call?: {
    method: string
    abi: Abi
    args: Record<string, string>
  }
  describe: {
    template: string
    fields?: string[]
    formats?: Record<string, string>
  }
  metadata?: {
    symbols?: Record<string, string>
    labels?: Record<string, string>
  }
  order?: {
    standard: string
    fields: Record<string, string>
  }
}

export interface IntentRegistryEntry {
  protocol: string
  actions: Record<string, IntentActionRegistryEntry>
}

export interface BuiltContractCallIntent {
  protocol: string
  action: string
  chainId: number
  to: Address
  data: Hex
  value: bigint
  description: string
  args: Record<string, unknown>
}

const REGISTRY_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), 'intents')

function readRegistry(protocol: string): IntentRegistryEntry {
  const filePath = path.join(REGISTRY_DIR, `${protocol}.json`)
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as IntentRegistryEntry
  } catch {
    throw new Error(`Unknown intent protocol: ${protocol}`)
  }
}

function parseArgType(type: string, value: unknown): unknown {
  if (type.startsWith('uint') || type.startsWith('int')) {
    if (typeof value === 'bigint') return value
    if (typeof value === 'number') return BigInt(value)
    if (typeof value === 'string') return BigInt(value)
  }
  return value
}

function coerceArgs(spec: Record<string, string>, args: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, type] of Object.entries(spec)) {
    const value = args[key]
    if (value === undefined) throw new Error(`Missing action arg: ${key}`)
    result[key] = parseArgType(type, value)
  }
  return result
}

function shortAddress(value: string): string {
  return value.length < 12 ? value : `${value.slice(0, 6)}...${value.slice(-4)}`
}

function formatAmount(raw: unknown, decimals: number): string {
  const value = typeof raw === 'bigint' ? raw : BigInt(String(raw))
  const formatted = formatUnits(value, decimals)
  return formatted.replace(/\.0+$|(?<=\.\d*?)0+$/g, '')
}

function formatFieldValue(field: string, value: unknown, entry: IntentActionRegistryEntry): string {
  const format = entry.describe.formats?.[field]
  if (!format) {
    if (typeof value === 'bigint') return value.toString()
    if (typeof value === 'number') return String(value)
    if (typeof value === 'string' && value.startsWith('0x') && value.length === 42) return shortAddress(value)
    return String(value)
  }

  if (format.startsWith('amount:')) {
    const rest = format.slice('amount:'.length)
    const [decimalsText, symbolKey] = rest.split(':')
    const amount = formatAmount(value, parseInt(decimalsText))
    const suffix = symbolKey ? ` ${entry.metadata?.symbols?.[symbolKey] || symbolKey}` : ''
    return `${amount}${suffix}`
  }

  if (format === 'address') return shortAddress(String(value))
  if (format === 'domain') return entry.metadata?.labels?.[String(value)] || String(value)
  if (format === 'token') return entry.metadata?.symbols?.[String(value)] || shortAddress(String(value))

  return String(value)
}

export function renderIntentDescription(
  template: string,
  args: Record<string, unknown>,
  entry: IntentActionRegistryEntry
): string {
  return template.replace(/\{([^}]+)\}/g, (_, key: string) => formatFieldValue(key, args[key], entry))
}

export function getIntentRegistryEntry(protocol: string, action: string): IntentActionRegistryEntry {
  const registry = readRegistry(protocol)
  const entry = registry.actions[action]
  if (!entry) throw new Error(`Unknown action ${action} for protocol ${protocol}`)
  return entry
}

export function buildContractCallIntent(options: {
  protocol: string
  action: string
  chainId: number
  args: Record<string, unknown>
}): BuiltContractCallIntent {
  const { protocol, action, chainId, args } = options
  const entry = getIntentRegistryEntry(protocol, action)
  if (entry.kind !== 'contract_call' || !entry.call) {
    throw new Error(`Action ${protocol}/${action} is not a contract_call intent`)
  }

  const chain = entry.chains?.[String(chainId)]
  if (!chain) throw new Error(`Action ${protocol}/${action} is not configured for chain ${chainId}`)

  const coercedArgs = coerceArgs(entry.call.args, args)
  const data = encodeFunctionData({
    abi: entry.call.abi,
    functionName: entry.call.method,
    args: Object.keys(entry.call.args).map(key => coercedArgs[key]),
  })

  return {
    protocol,
    action,
    chainId,
    to: chain.to,
    data,
    value: typeof args.value === 'string' ? BigInt(args.value) : 0n,
    description: renderIntentDescription(entry.describe.template, args, entry),
    args,
  }
}

export function verifyIntentDescription(options: {
  protocol: string
  action: string
  args: Record<string, unknown>
  description?: string
}): string {
  const entry = getIntentRegistryEntry(options.protocol, options.action)
  const expected = renderIntentDescription(entry.describe.template, options.args, entry)
  if (options.description && options.description !== expected) {
    throw new Error('Intent description does not match registry rendering')
  }
  return expected
}
