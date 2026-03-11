import { createPublicClient, http, type Address, type Hex, parseAbiParameters } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { getChainConfig } from './chain.js'

export interface ClearSigningSecurityInput {
  domain: string
  provider: string
  validAfter: bigint
  validBefore: bigint
  nonceKey?: bigint
}

export interface ClearSigningSecurity extends Omit<ClearSigningSecurityInput, 'nonceKey'> {
  nonce: bigint
}

export interface ClearSigningTypedDataMessage extends Record<string, unknown> {
  action: Record<string, unknown>
  domain: string
  nonce: bigint
  provider: string
  validAfter: bigint
  validBefore: bigint
}

export interface PreparedUnsignedRequest {
  forwarderAddress: Address
  macroAddress: Address
  signer: Address
  params: Hex
  typedData: {
    domain: {
      name: string
      version: string
      chainId: number
      verifyingContract: Address
    }
    types: Record<string, readonly { name: string; type: string }[]>
    primaryType: string
    message: ClearSigningTypedDataMessage
  }
  message: ClearSigningTypedDataMessage
  actionDescription: string
}

export interface SignedAgentRequest {
  forwarderAddress: Address
  macroAddress: Address
  signer: Address
  signature: Hex
  params: Hex
  message: ClearSigningTypedDataMessage
  actionDescription: string
}

const CLEAR_SIGNING_FORWARDER_ABI = [
  {
    type: 'function',
    name: 'getNonce',
    stateMutability: 'view',
    inputs: [
      { name: 'sender', type: 'address' },
      { name: 'key', type: 'uint192' },
    ],
    outputs: [{ name: 'nonce', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'encodeParams',
    stateMutability: 'pure',
    inputs: [
      { name: 'params', type: 'bytes', internalType: 'bytes' },
      {
        name: 'security',
        type: 'tuple',
        internalType: 'struct IClearSigningForwarder.Security',
        components: [
          { name: 'domain', type: 'string' },
          { name: 'provider', type: 'string' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
        ],
      },
    ],
    outputs: [{ name: '', type: 'bytes' }],
  },
] as const

const EIP712_DOMAIN_NAME = 'ClearSigning'
const EIP712_DOMAIN_VERSION = '1'

export const getChain = getChainConfig

export async function getNonce(
  client: ReturnType<typeof createPublicClient>,
  forwarderAddress: Address,
  sender: Address,
  nonceKey: bigint = 0n
): Promise<bigint> {
  return await client.readContract({
    address: forwarderAddress,
    abi: CLEAR_SIGNING_FORWARDER_ABI,
    functionName: 'getNonce',
    args: [sender, nonceKey],
  })
}

export async function encodeForwarderParams(
  client: ReturnType<typeof createPublicClient>,
  forwarderAddress: Address,
  actionParams: Hex,
  security: ClearSigningSecurity
): Promise<Hex> {
  return await client.readContract({
    address: forwarderAddress,
    abi: CLEAR_SIGNING_FORWARDER_ABI,
    functionName: 'encodeParams',
    args: [
      actionParams,
      {
        domain: security.domain,
        provider: security.provider,
        validAfter: security.validAfter,
        validBefore: security.validBefore,
        nonce: security.nonce,
      },
    ],
  })
}

export function buildTypedData(
  chainId: number,
  forwarderAddress: Address,
  primaryType: string,
  actionTypeDefinition: string,
  message: ClearSigningTypedDataMessage
) {
  return {
    domain: {
      name: EIP712_DOMAIN_NAME,
      version: EIP712_DOMAIN_VERSION,
      chainId,
      verifyingContract: forwarderAddress,
    },
    types: {
      [primaryType]: [
        { name: 'action', type: 'Action' },
        { name: 'domain', type: 'string' },
        { name: 'nonce', type: 'uint256' },
        { name: 'provider', type: 'string' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
      ],
      Action: parseAbiParameters(actionTypeDefinition.slice(7, -1)).map(p => ({
        name: p.name || '',
        type: p.type,
      })),
    },
    primaryType,
    message,
  }
}

export async function prepareClearSigningRequest(
  rpcUrl: string,
  chainId: number,
  forwarderAddress: Address,
  macroAddress: Address,
  signerAddress: Address,
  actionParams: Hex,
  actionDescription: string,
  primaryType: string,
  actionTypeDefinition: string,
  actionMessage: Record<string, unknown>,
  security: ClearSigningSecurityInput
): Promise<PreparedUnsignedRequest> {
  const chain = getChain(chainId, rpcUrl)
  const client = createPublicClient({ chain, transport: http() })

  const nonceKey = security.nonceKey ?? 0n
  const nonce = await getNonce(client, forwarderAddress, signerAddress, nonceKey)

  const securityWithNonce: ClearSigningSecurity = {
    domain: security.domain,
    provider: security.provider,
    validAfter: security.validAfter,
    validBefore: security.validBefore,
    nonce,
  }

  const params = await encodeForwarderParams(client, forwarderAddress, actionParams, securityWithNonce)

  const message: ClearSigningTypedDataMessage = {
    action: actionMessage,
    domain: security.domain,
    nonce,
    provider: security.provider,
    validAfter: security.validAfter,
    validBefore: security.validBefore,
  }

  const typedData = buildTypedData(
    chainId,
    forwarderAddress,
    primaryType,
    actionTypeDefinition,
    message
  )

  return {
    forwarderAddress,
    macroAddress,
    signer: signerAddress,
    params,
    typedData,
    message,
    actionDescription,
  }
}

export async function signPreparedRequest(
  privateKey: Hex,
  prepared: PreparedUnsignedRequest
): Promise<SignedAgentRequest> {
  const account = privateKeyToAccount(privateKey)

  if (account.address.toLowerCase() !== prepared.signer.toLowerCase()) {
    throw new Error(
      `Signer address mismatch: private key resolves to ${account.address}, but prepared request is for ${prepared.signer}`
    )
  }

  const signature = await account.signTypedData(prepared.typedData)

  return {
    forwarderAddress: prepared.forwarderAddress,
    macroAddress: prepared.macroAddress,
    signer: prepared.signer,
    signature,
    params: prepared.params,
    message: prepared.message,
    actionDescription: prepared.actionDescription,
  }
}

export function serializeForJson<T>(obj: T): string {
  return JSON.stringify(obj, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2)
}

function bigintFieldsToStrings(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map(bigintFieldsToStrings)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, bigintFieldsToStrings(child)])
    )
  }
  return value
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected object value')
  }
  return value as Record<string, unknown>
}

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') return BigInt(value)
  if (typeof value === 'string') return BigInt(value)
  throw new Error(`Expected bigint-compatible value, got ${typeof value}`)
}

export function parsePreparedUnsignedRequest(json: string): PreparedUnsignedRequest {
  const parsed = JSON.parse(json) as PreparedUnsignedRequest & {
    message: Record<string, unknown>
    typedData: PreparedUnsignedRequest['typedData'] & { message: Record<string, unknown> }
  }

  return {
    ...parsed,
    message: {
      ...parsed.message,
      nonce: toBigInt(parsed.message.nonce),
      validAfter: toBigInt(parsed.message.validAfter),
      validBefore: toBigInt(parsed.message.validBefore),
      action: asRecord(bigintFieldsToStrings(parsed.message.action)),
    },
    typedData: {
      ...parsed.typedData,
      message: {
        ...parsed.typedData.message,
        nonce: toBigInt(parsed.typedData.message.nonce),
        validAfter: toBigInt(parsed.typedData.message.validAfter),
        validBefore: toBigInt(parsed.typedData.message.validBefore),
        action: asRecord(bigintFieldsToStrings(parsed.typedData.message.action)),
      },
    },
  }
}

export function parseSignedAgentRequest(json: string): SignedAgentRequest {
  const parsed = JSON.parse(json) as SignedAgentRequest & {
    message: Record<string, unknown>
  }

  return {
    ...parsed,
    message: {
      ...parsed.message,
      nonce: toBigInt(parsed.message.nonce),
      validAfter: toBigInt(parsed.message.validAfter),
      validBefore: toBigInt(parsed.message.validBefore),
      action: asRecord(bigintFieldsToStrings(parsed.message.action)),
    },
  }
}
