import 'dotenv/config'
import { createPublicClient, http, type Address, type Hex, type Chain, encodeAbiParameters, parseAbiParameters, hashTypedData } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import config, { forwarderAddress as defaultForwarder, macroAddress as defaultMacro } from './config.js'

const LANG_EN = '0x656e000000000000000000000000000000000000000000000000000000000000' as Hex

const EIP712_DOMAIN_NAME = 'ClearSigning'
const EIP712_DOMAIN_VERSION = '1'

const SECURITY_DOMAIN = config.security?.domain || 'flowscheduler.xyz'
const SECURITY_PROVIDER = config.security?.provider || 'macros.superfluid.eth'

const ACTION_TYPE_DEFINITION = config.actionTypeDefinition || 
  'Action(string description,address superToken,address receiver,uint32 startDate,uint32 startMaxDelay,int96 flowRate,uint256 startAmount,uint32 endDate,bytes userData)'

const SCHEDULE_FLOW_TYPE = [
  { name: 'action', type: 'Action' },
  { name: 'domain', type: 'string' },
  { name: 'nonce', type: 'uint256' },
  { name: 'provider', type: 'string' },
  { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' },
] as const

function getChain(chainId: number): Chain {
  const chains: Record<number, Chain> = {
    11155420: {
      id: 11155420,
      name: 'Optimism Sepolia',
      nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [process.env.RPC_URL || 'https://sepolia.optimism.io'] } },
    },
  }
  return chains[chainId] || { id: chainId, name: `Chain ${chainId}`, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [process.env.RPC_URL || ''] } } }
}

function requireEnv(name: string): string {
  const v = process.env[name]
  if (v == null || v === '') throw new Error(`Missing env: ${name}`)
  return v
}

export interface FlowSchedulerParams {
  superToken: Address
  receiver: Address
  startDate: number
  startMaxDelay: number
  flowRate: bigint
  startAmount: bigint
  endDate: number
  userData: Hex
}

export async function signAndPrepare(
  params: FlowSchedulerParams,
  privateKey: Hex,
  chainId: number,
  forwarderAddress: Address,
  macroAddress: Address,
  validAfter: bigint = 0n,
  validBefore: bigint = 0n
): Promise<{
  forwarderAddress: Address
  macroAddress: Address
  signer: Address
  signature: Hex
  params: Hex
  message: Record<string, unknown>
  actionDescription: string
}> {
  const chain = getChain(chainId)
  const account = privateKeyToAccount(privateKey)
  const publicClient = createPublicClient({ chain, transport: http() })

  const encodeAbi = [
    {
      type: 'function',
      name: 'encodeCreateFlowScheduleParams',
      stateMutability: 'view',
      inputs: [
        { name: 'lang', type: 'bytes32' },
        {
          name: 'cfsParams',
          type: 'tuple',
          components: [
            { name: 'superToken', type: 'address' },
            { name: 'receiver', type: 'address' },
            { name: 'startDate', type: 'uint32' },
            { name: 'startMaxDelay', type: 'uint32' },
            { name: 'flowRate', type: 'int96' },
            { name: 'startAmount', type: 'uint256' },
            { name: 'endDate', type: 'uint32' },
            { name: 'userData', type: 'bytes' },
          ],
        },
      ],
      outputs: [
        { name: 'description', type: 'string' },
        { name: 'actionParams', type: 'bytes' },
        { name: 'structHash', type: 'bytes32' },
      ],
    },
  ] as const

  console.error(`Calling encodeCreateFlowScheduleParams on macro ${macroAddress}...`)
  const [description, actionParams] = await publicClient.readContract({
    address: macroAddress,
    abi: encodeAbi,
    functionName: 'encodeCreateFlowScheduleParams',
    args: [LANG_EN, params],
  })
  console.error(`Description: ${description}`)

  const clearSigningForwarderAbi = [
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

  const nonceKey = 0n
  console.error(`Getting nonce for ${account.address}...`)
  const nonce = await publicClient.readContract({
    address: forwarderAddress,
    abi: clearSigningForwarderAbi,
    functionName: 'getNonce',
    args: [account.address, nonceKey],
  })
  console.error(`Nonce: ${nonce}`)

  console.error(`Encoding params...`)
  const payload = await publicClient.readContract({
    address: forwarderAddress,
    abi: clearSigningForwarderAbi,
    functionName: 'encodeParams',
    args: [
      actionParams,
      {
        domain: SECURITY_DOMAIN,
        provider: SECURITY_PROVIDER,
        validAfter,
        validBefore,
        nonce,
      },
    ],
  })

  const message = {
    action: {
      description,
      superToken: params.superToken,
      receiver: params.receiver,
      startDate: params.startDate,
      startMaxDelay: params.startMaxDelay,
      flowRate: params.flowRate,
      startAmount: params.startAmount,
      endDate: params.endDate,
      userData: params.userData,
    },
    domain: SECURITY_DOMAIN,
    nonce,
    provider: SECURITY_PROVIDER,
    validAfter,
    validBefore,
  }

  const typedData = {
    domain: {
      name: EIP712_DOMAIN_NAME,
      version: EIP712_DOMAIN_VERSION,
      chainId,
      verifyingContract: forwarderAddress,
    },
    types: {
      ScheduleFlow: SCHEDULE_FLOW_TYPE,
      Action: parseAbiParameters(ACTION_TYPE_DEFINITION.slice(7, -1)).map(p => ({
        name: p.name || '',
        type: p.type,
      })),
    },
    primaryType: 'ScheduleFlow' as const,
    message,
  }

  console.error(`Signing typed data...`)
  const signature = await account.signTypedData(typedData)

  return {
    forwarderAddress,
    macroAddress,
    signer: account.address,
    signature,
    params: payload,
    message,
    actionDescription: description,
  }
}

export async function sendToRelay(data: {
  forwarderAddress: Address
  macroAddress: Address
  signer: Address
  signature: Hex
  params: Hex
  message: Record<string, unknown>
  actionDescription: string
}, relayerUrl: string): Promise<{ id: string; agentAddress: string; devicesNotified: number }> {
  const res = await fetch(`${relayerUrl}/agent-relay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!res.ok) {
    const err = await res.json()
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

async function main() {
  const args = process.argv.slice(2)
  
  if (args.length === 0 || args[0] === '--help') {
    console.log(`
Usage: npx tsx agent/sign.ts [options]

Options:
  --private-key <hex>      Private key (or set PRIVATE_KEY env)
  --rpc-url <url>          RPC URL (or set RPC_URL env)
  --chain-id <number>      Chain ID (default: 11155420 for OP Sepolia)
  --forwarder <address>    Forwarder contract address
  --macro <address>        Macro contract address
  --relayer-url <url>      Relayer API URL (default: http://localhost:3000)
  --super-token <address>  SuperToken address
  --receiver <address>     Receiver address
  --flow-rate <wei/sec>    Flow rate in wei per second
  --start-date <unix>      Start date (unix timestamp, 0 for none)
  --end-date <unix>        End date (unix timestamp, 0 for none)
  --dry-run                Only output JSON, don't send to relayer

Example:
  npx tsx agent/sign.ts \\
    --private-key 0x... \\
    --forwarder 0x... \\
    --macro 0x... \\
    --super-token 0x... \\
    --receiver 0x... \\
    --flow-rate 11574074074074 \\
    --start-date $(date -d '+1 hour' +%s)
`)
    process.exit(0)
  }

  const flagMap: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2)
      if (key === 'dry-run') {
        flagMap[key] = 'true'
      } else if (args[i + 1] && !args[i + 1].startsWith('--')) {
        flagMap[key] = args[i + 1]
        i++
      }
    }
  }

  const privateKey = (flagMap['private-key'] || process.env.PRIVATE_KEY) as Hex | undefined
  const rpcUrl = flagMap['rpc-url'] || process.env.RPC_URL
  const chainId = parseInt(flagMap['chain-id'] || '11155420')
  const forwarderAddress = (flagMap['forwarder'] || defaultForwarder) as Address | undefined
  const macroAddress = (flagMap['macro'] || defaultMacro) as Address | undefined
  const relayerUrl = flagMap['relayer-url'] || process.env.RELAYER_URL || 'http://localhost:3000'
  const superToken = flagMap['super-token'] as Address | undefined
  const receiver = flagMap['receiver'] as Address | undefined
  const flowRate = flagMap['flow-rate'] ? BigInt(flagMap['flow-rate']) : undefined
  const startDate = flagMap['start-date'] ? parseInt(flagMap['start-date']) : Math.floor(Date.now() / 1000) + 3600
  const endDate = flagMap['end-date'] ? parseInt(flagMap['end-date']) : 0
  const dryRun = flagMap['dry-run'] === 'true'

  if (!privateKey) throw new Error('Missing --private-key or PRIVATE_KEY env')
  if (!forwarderAddress) throw new Error('Missing --forwarder')
  if (!macroAddress) throw new Error('Missing --macro')
  if (!superToken) throw new Error('Missing --super-token')
  if (!receiver) throw new Error('Missing --receiver')
  if (flowRate === undefined) throw new Error('Missing --flow-rate')

  const params: FlowSchedulerParams = {
    superToken,
    receiver,
    startDate,
    startMaxDelay: 86400,
    flowRate,
    startAmount: 0n,
    endDate,
    userData: '0x',
  }

  const result = await signAndPrepare(
    params,
    privateKey,
    chainId,
    forwarderAddress,
    macroAddress
  )

  const output = {
    forwarderAddress: result.forwarderAddress,
    macroAddress: result.macroAddress,
    signer: result.signer,
    signature: result.signature,
    params: result.params,
    message: JSON.parse(JSON.stringify(result.message, (_, v) => typeof v === 'bigint' ? v.toString() : v)),
    actionDescription: result.actionDescription,
  }

  console.log(JSON.stringify(output, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2))

  if (!dryRun) {
    console.error(`\nSending to relayer at ${relayerUrl}...`)
    const response = await sendToRelay(output as any, relayerUrl)
    console.error(`Success! Request ID: ${response.id}`)
    console.error(`Agent: ${response.agentAddress}`)
    console.error(`Devices notified: ${response.devicesNotified}`)
  }
}

main().catch(err => {
  console.error('Error:', err.message)
  process.exit(1)
})
