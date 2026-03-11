import 'dotenv/config'
import { type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  parsePreparedUnsignedRequest,
  parseSignedAgentRequest,
  prepareClearSigningRequest,
  signPreparedRequest,
  serializeForJson,
  type ClearSigningSecurityInput,
  type PreparedUnsignedRequest,
  type SignedAgentRequest,
} from './clearSigning.js'
import { sendAgentRequest } from './relayClient.js'
import { buildAction } from './actionBuilders.js'
import config from './config.js'

interface Flags {
  [key: string]: string | boolean | undefined
  'private-key'?: string
  'rpc-url'?: string
  'chain-id'?: string
  'forwarder'?: string
  'macro'?: string
  'macro-kind'?: string
  'relayer-url'?: string
  'action-params'?: string
  'action-description'?: string
  'primary-type'?: string
  'action-type-definition'?: string
  'action-message'?: string
  'super-token'?: string
  'receiver'?: string
  'flow-rate'?: string
  'start-date'?: string
  'end-date'?: string
  'start-max-delay'?: string
  'start-amount'?: string
  'user-data'?: string
  'domain'?: string
  'provider'?: string
  'valid-after'?: string
  'valid-before'?: string
  'nonce-key'?: string
  'signer'?: string
  'dry-run'?: boolean
}

const DEFAULT_CHAIN_ID = parseInt(
  process.env.CHAIN_ID || String(config.chainAddresses[11155420] ? 11155420 : Object.keys(config.chainAddresses)[0] || '11155420')
)
const DEFAULT_SECURITY_DOMAIN = config.security?.domain || 'flowscheduler.xyz'
const DEFAULT_SECURITY_PROVIDER = config.security?.provider || 'macros.superfluid.eth'
const DEFAULT_FORWARDER = config.chainAddresses[DEFAULT_CHAIN_ID]?.forwarder
const DEFAULT_MACRO = config.chainAddresses[DEFAULT_CHAIN_ID]?.macro

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

function resolveSigner(flags: Flags): Address | undefined {
  const privateKey = flags['private-key'] || process.env.PRIVATE_KEY
  const signer = flags.signer
  if (typeof signer === 'string') return signer as Address
  if (typeof privateKey === 'string') return privateKeyToAccount(privateKey as Hex).address
  return undefined
}

function buildSecurity(flags: Flags): ClearSigningSecurityInput {
  return {
    domain: typeof flags.domain === 'string' ? flags.domain : DEFAULT_SECURITY_DOMAIN,
    provider: typeof flags.provider === 'string' ? flags.provider : DEFAULT_SECURITY_PROVIDER,
    validAfter: typeof flags['valid-after'] === 'string' ? BigInt(flags['valid-after']) : 0n,
    validBefore: typeof flags['valid-before'] === 'string' ? BigInt(flags['valid-before']) : 0n,
    nonceKey: typeof flags['nonce-key'] === 'string' ? BigInt(flags['nonce-key']) : undefined,
  }
}

async function build(flags: Flags): Promise<PreparedUnsignedRequest> {
  const rpcUrl = flags['rpc-url'] || process.env.RPC_URL
  if (!rpcUrl || typeof rpcUrl !== 'string') throw new Error('Missing --rpc-url')

  const chainId = parseInt(String(flags['chain-id'] || DEFAULT_CHAIN_ID))
  const chainConfig = config.chainAddresses[chainId]
  const forwarderAddress = (flags.forwarder || chainConfig?.forwarder || DEFAULT_FORWARDER) as Address | undefined
  const macroAddress = (flags.macro || chainConfig?.macro || DEFAULT_MACRO) as Address | undefined
  const signerAddress = resolveSigner(flags)

  if (!forwarderAddress) throw new Error('Missing --forwarder')
  if (!macroAddress) throw new Error('Missing --macro')
  if (!signerAddress) throw new Error('Missing --signer for build')

  const security = buildSecurity(flags)

  console.error('Building action...')
  const action = await buildAction({
    rpcUrl,
    chainId,
    macroAddress,
    flags,
  })
  console.error(`Action: ${action.actionDescription}`)

  console.error('Preparing ClearSigning request...')
  return prepareClearSigningRequest(
    rpcUrl,
    chainId,
    forwarderAddress,
    macroAddress,
    signerAddress,
    action.actionParams,
    action.actionDescription,
    action.primaryType,
    action.actionTypeDefinition,
    action.actionMessage,
    security
  )
}

async function sign(privateKey: Hex, prepared: PreparedUnsignedRequest): Promise<SignedAgentRequest> {
  console.error('Signing request...')
  return signPreparedRequest(privateKey, prepared)
}

async function send(relayerUrl: string, signed: SignedAgentRequest) {
  console.error(`Sending to relayer at ${relayerUrl}...`)
  const response = await sendAgentRequest(relayerUrl, signed)
  console.error(`Success! Request ID: ${response.id}`)
  console.error(`Agent: ${response.agentAddress}`)
  console.error(`Devices notified: ${response.devicesNotified}`)
  return response
}

function printHelp() {
  console.log(`
Usage: npx tsx agent/request.ts <command> [options]

Commands:
  build              Build unsigned request JSON
  sign               Sign prepared JSON from stdin (requires --private-key)
  send               Send signed JSON from stdin to relayer (requires --relayer-url)
  submit             Build, sign, and send in one step (default)

Core options:
  --private-key <hex>      Private key (or set PRIVATE_KEY env)
  --rpc-url <url>          RPC URL (or set RPC_URL env)
  --chain-id <number>      Chain ID (default: 11155420 for OP Sepolia)
  --forwarder <address>    Forwarder contract address
  --macro <address>        Macro contract address
  --relayer-url <url>      Relayer API URL
  --signer <address>       Signer address (optional if private key is set)
  --macro-kind <kind>      Builder mode (default: flow-scheduler)

Generic raw action mode:
  --action-params <hex>    Pre-encoded macro action params
  --action-description <text>
                           Human-readable action description
  --primary-type <name>    EIP-712 primary type for the action
  --action-type-definition <sig>
                           EIP-712 Action struct definition
  --action-message <json>  JSON object for the action message

FlowScheduler helper mode:
  --super-token <address>  SuperToken address
  --receiver <address>     Receiver address
  --flow-rate <wei/sec>    Flow rate in wei per second
  --start-date <unix>      Start date (unix timestamp, 0 for immediate)
  --end-date <unix>        End date (unix timestamp, 0 for indefinite)
  --start-max-delay <sec>  Max delay for start (default: 86400)
  --start-amount <wei>     Initial transfer amount
  --user-data <hex>        User data bytes

Security options:
  --domain <string>        Security domain (default: flowscheduler.xyz)
  --provider <string>      Security provider (default: macros.superfluid.eth)
  --valid-after <unix>     Valid after timestamp
  --valid-before <unix>    Valid before timestamp
  --nonce-key <number>     Nonce key (default: 0)
  --dry-run                Only output JSON, don't send to relayer

Examples:
  # One-shot submit with FlowScheduler helper mode
  npx tsx agent/request.ts submit \
    --private-key 0x... \
    --rpc-url https://optimism-sepolia.rpc.x.superfluid.dev \
    --chain-id 11155420 \
    --forwarder 0x... \
    --macro 0x... \
    --super-token 0x... \
    --receiver 0x... \
    --flow-rate 11574074074074 \
    --relayer-url http://localhost:3000

  # Build only with generic raw action mode
  npx tsx agent/request.ts build \
    --rpc-url ... \
    --forwarder 0x... \
    --macro 0x... \
    --action-params 0x... \
    --action-description "Do something" \
    --primary-type MyAction \
    --action-type-definition 'Action(string description,uint256 amount)' \
    --action-message '{"description":"Do something","amount":"123"}'

  # Sign prepared JSON
  ... build ... | npx tsx agent/request.ts sign --private-key 0x...

  # Send signed JSON
  ... sign ... | npx tsx agent/request.ts send --relayer-url http://localhost:3000
`)
}

async function main() {
  const args = process.argv.slice(2)

  if (args.length === 0 || args[0] === '--help' || args[0] === 'help') {
    printHelp()
    process.exit(0)
  }

  const { command, flags } = parseFlags(args)

  if (command === 'build') {
    console.log(serializeForJson(await build(flags)))
    return
  }

  if (command === 'sign') {
    const privateKey = (flags['private-key'] || process.env.PRIVATE_KEY) as Hex | undefined
    if (!privateKey) throw new Error('Missing --private-key or PRIVATE_KEY env')

    const prepared = parsePreparedUnsignedRequest(await getStdin())
    console.log(serializeForJson(await sign(privateKey, prepared)))
    return
  }

  if (command === 'send') {
    const relayerUrl = flags['relayer-url'] || process.env.RELAYER_URL
    if (!relayerUrl || typeof relayerUrl !== 'string') throw new Error('Missing --relayer-url or RELAYER_URL env')

    const signed = parseSignedAgentRequest(await getStdin())
    await send(relayerUrl, signed)
    return
  }

  if (command === 'submit' || command === '') {
    const privateKey = (flags['private-key'] || process.env.PRIVATE_KEY) as Hex | undefined
    if (!privateKey) throw new Error('Missing --private-key or PRIVATE_KEY env')

    const relayerUrl = (flags['relayer-url'] || process.env.RELAYER_URL || 'http://localhost:3000') as string
    const prepared = await build({
      ...flags,
      signer: typeof flags.signer === 'string' ? flags.signer : privateKeyToAccount(privateKey).address,
    })
    const signed = await sign(privateKey, prepared)

    if (flags['dry-run']) {
      console.log(serializeForJson(signed))
      return
    }

    console.log(serializeForJson(await send(relayerUrl, signed)))
    return
  }

  throw new Error(`Unknown command: ${command}`)
}

async function getStdin(): Promise<string> {
  const chunks: string[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk)
  }
  return chunks.join('')
}

main().catch(err => {
  console.error('Error:', err.message)
  process.exit(1)
})
