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
import { getMacroMetadata, buildMacroAction, parseArgsJson } from './macroMetadata.js'
import { sendAgentRequest } from './relayClient.js'
import config from './config.js'

interface Flags {
  [key: string]: string | boolean | undefined
}

const DEFAULT_CHAIN_ID = parseInt(process.env.CHAIN_ID || '11155420')
const DEFAULT_SECURITY_PROVIDER = config.security?.provider || 'macros.superfluid.eth'

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
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing --${key}`)
  }
  return value
}

function resolveSigner(flags: Flags): Address | undefined {
  const privateKey = flags['private-key'] || process.env.PRIVATE_KEY
  const signer = flags.signer
  if (typeof signer === 'string') return signer as Address
  if (typeof privateKey === 'string') return privateKeyToAccount(privateKey as Hex).address
  return undefined
}

async function build(flags: Flags): Promise<PreparedUnsignedRequest> {
  const rpcUrl = typeof flags['rpc-url'] === 'string' ? flags['rpc-url'] : process.env.RPC_URL
  if (!rpcUrl) throw new Error('Missing --rpc-url')

  const chainId = parseInt(String(flags['chain-id'] || DEFAULT_CHAIN_ID))
  const macroName = getRequiredString(flags, 'macro')
  const actionName = getRequiredString(flags, 'action')
  const args = parseArgsJson(getRequiredString(flags, 'args'))
  const signer = resolveSigner(flags)
  if (!signer) throw new Error('Missing --signer for build')

  const metadata = getMacroMetadata(macroName, actionName, chainId)
  const forwarderAddress = (flags.forwarder || config.forwarderByChain[chainId]) as Address | undefined
  if (!forwarderAddress) throw new Error('Missing --forwarder')

  const security: ClearSigningSecurityInput = {
    domain: typeof flags.domain === 'string' ? flags.domain : metadata.securityDomain || macroName,
    provider: typeof flags.provider === 'string' ? flags.provider : DEFAULT_SECURITY_PROVIDER,
    validAfter: typeof flags['valid-after'] === 'string' ? BigInt(flags['valid-after']) : 0n,
    validBefore: typeof flags['valid-before'] === 'string' ? BigInt(flags['valid-before']) : 0n,
    nonceKey: typeof flags['nonce-key'] === 'string' ? BigInt(flags['nonce-key']) : undefined,
  }

  console.error(`Building ${macroName}/${actionName} action...`)
  const action = await buildMacroAction({
    rpcUrl,
    chainId,
    macroAddress: metadata.macroAddress,
    actionName,
    action: metadata.action,
    args,
  })
  console.error(`Action: ${action.actionDescription}`)

  console.error('Preparing ClearSigning request...')
  return prepareClearSigningRequest(
    rpcUrl,
    chainId,
    forwarderAddress,
    metadata.macroAddress,
    signer,
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
  --macro <name>          Macro metadata name, e.g. flow-scheduler
  --action <name>         Action name, e.g. create-flow-schedule
  --args <json>           Action arguments as JSON object
  --private-key <hex>     Private key (or set PRIVATE_KEY env)
  --rpc-url <url>         RPC URL (or set RPC_URL env)
  --chain-id <number>     Chain ID (default: 11155420)
  --forwarder <address>   Forwarder contract address
  --relayer-url <url>     Relayer API URL
  --signer <address>      Signer address (optional if private key is set)

Security options:
  --domain <string>       Security domain override
  --provider <string>     Security provider override
  --valid-after <unix>    Valid after timestamp
  --valid-before <unix>   Valid before timestamp
  --nonce-key <number>    Nonce key (default: 0)
  --dry-run               Only output JSON, don't send to relayer

Examples:
  npx tsx agent/request.ts submit \
    --macro flow-scheduler \
    --action create-flow-schedule \
    --args '{"superToken":"0x...","receiver":"0x...","flowRate":"11574074074074"}' \
    --private-key 0x... \
    --rpc-url https://optimism-sepolia.rpc.x.superfluid.dev \
    --relayer-url http://localhost:3000
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
    console.log(serializeForJson(await sign(privateKey, parsePreparedUnsignedRequest(await getStdin()))))
    return
  }

  if (command === 'send') {
    const relayerUrl = flags['relayer-url'] || process.env.RELAYER_URL
    if (!relayerUrl || typeof relayerUrl !== 'string') throw new Error('Missing --relayer-url or RELAYER_URL env')
    await send(relayerUrl, parseSignedAgentRequest(await getStdin()))
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
  for await (const chunk of process.stdin) chunks.push(chunk)
  return chunks.join('')
}

main().catch(err => {
  console.error('Error:', err.message)
  process.exit(1)
})
