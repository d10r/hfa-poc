import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createPublicClient, http, parseAbi, type Abi, type Address, type Hex } from 'viem'
import { getChainConfig } from './chain.js'

export interface MacroActionMetadata {
  context?: Record<string, string>
  fields: Record<string, string>
}

export interface MacroMetadata {
  chains: Record<string, { macro: Address }>
  security?: {
    domain?: string
  }
  actions: Record<string, MacroActionMetadata>
}

export interface ResolvedMacroMetadata {
  macroAddress: Address
  securityDomain?: string
  action: MacroActionMetadata
}

export interface BuiltMacroAction {
  actionParams: Hex
  actionDescription: string
  primaryType: string
  actionTypeDefinition: string
  actionMessage: Record<string, unknown>
}

const MACRO_METADATA_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), 'macros')

function kebabToPascalCase(value: string): string {
  return value
    .split('-')
    .filter(Boolean)
    .map(part => part[0].toUpperCase() + part.slice(1))
    .join('')
}

function parseFieldSpec(spec: string): { type: string; defaultValue?: string } {
  const [left, defaultValue] = spec.split('=')
  const [type, inlineValue] = left.split(':')
  return {
    type,
    defaultValue: defaultValue ?? inlineValue,
  }
}

function normalizeValue(type: string, value: string): unknown {
  if (value === 'now+3600') return Math.floor(Date.now() / 1000) + 3600
  if (type.startsWith('uint') || type.startsWith('int')) {
    if (type.includes('256') || type.includes('96')) return BigInt(value)
    return parseInt(value)
  }
  if (type === 'bytes32' && value === 'en') {
    return '0x656e000000000000000000000000000000000000000000000000000000000000'
  }
  return value
}

function resolveObject(specs: Record<string, string> | undefined, providedArgs: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  if (!specs) return result

  for (const [key, spec] of Object.entries(specs)) {
    const parsed = parseFieldSpec(spec)
    const provided = providedArgs[key]
    if (provided !== undefined) {
      result[key] = provided
      continue
    }
    if (parsed.defaultValue !== undefined) {
      result[key] = normalizeValue(parsed.type, parsed.defaultValue)
      continue
    }
    throw new Error(`Missing action arg: ${key}`)
  }

  return result
}

export function parseArgsJson(json: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error('Invalid JSON in --args')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--args must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

export function getMacroMetadata(macroName: string, actionName: string, chainId: number): ResolvedMacroMetadata {
  const filePath = path.join(MACRO_METADATA_DIR, `${macroName}.json`)
  let metadata: MacroMetadata
  try {
    metadata = JSON.parse(readFileSync(filePath, 'utf8')) as MacroMetadata
  } catch {
    throw new Error(`Unknown macro: ${macroName}`)
  }
  const chain = metadata.chains[String(chainId)]
  if (!chain) throw new Error(`Macro ${macroName} is not configured for chain ${chainId}`)

  const action = metadata.actions[actionName]
  if (!action) throw new Error(`Unknown action ${actionName} for macro ${macroName}`)

  return {
    macroAddress: chain.macro,
    securityDomain: metadata.security?.domain,
    action,
  }
}

function buildEncodeAbi(functionName: string, action: MacroActionMetadata): Abi {
  const contextInputs = Object.entries(action.context || {}).map(([name, spec]) => ({
    name,
    type: parseFieldSpec(spec).type,
  }))

  const tupleComponents = Object.entries(action.fields).map(([name, spec]) => ({
    name,
    type: parseFieldSpec(spec).type,
  }))

  return [
    {
      type: 'function',
      name: functionName,
      stateMutability: 'view',
      inputs: [
        ...contextInputs,
        {
          name: 'params',
          type: 'tuple',
          components: tupleComponents,
        },
      ],
      outputs: [
        { name: 'description', type: 'string' },
        { name: 'params', type: 'bytes' },
        { name: 'structHash', type: 'bytes32' },
      ],
    },
  ] as Abi
}

export async function buildMacroAction(options: {
  rpcUrl: string
  chainId: number
  macroAddress: Address
  actionName: string
  action: MacroActionMetadata
  args: Record<string, unknown>
}): Promise<BuiltMacroAction> {
  const { rpcUrl, chainId, macroAddress, actionName, action, args } = options
  const functionName = `encode${kebabToPascalCase(actionName)}Params`
  const contextValues = resolveObject(action.context, args)
  const fieldValues = resolveObject(action.fields, args)
  const encodeAbi = buildEncodeAbi(functionName, action)

  const chain = getChainConfig(chainId, rpcUrl)
  const client = createPublicClient({ chain, transport: http() })

  const [description, actionParams] = await client.readContract({
    address: macroAddress,
    abi: encodeAbi,
    functionName,
    args: [
      ...Object.keys(action.context || {}).map(key => contextValues[key]),
      fieldValues,
    ],
  }) as readonly [string, Hex, Hex]

  const metadataAbi = parseAbi([
    'function getPrimaryTypeName(bytes params) view returns (string)',
    'function getActionTypeDefinition(bytes params) view returns (string)',
  ])

  const [primaryType, actionTypeDefinition] = await Promise.all([
    client.readContract({
      address: macroAddress,
      abi: metadataAbi,
      functionName: 'getPrimaryTypeName',
      args: [actionParams],
    }),
    client.readContract({
      address: macroAddress,
      abi: metadataAbi,
      functionName: 'getActionTypeDefinition',
      args: [actionParams],
    }),
  ])

  return {
    actionParams,
    actionDescription: description,
    primaryType,
    actionTypeDefinition,
    actionMessage: {
      description,
      ...fieldValues,
    },
  }
}
