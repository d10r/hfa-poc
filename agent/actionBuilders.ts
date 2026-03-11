import { type Address, type Hex } from 'viem'
import { buildFlowSchedulerAction, type FlowSchedulerParams } from './flowScheduler.js'

export interface ActionBuildResult {
  actionParams: Hex
  actionDescription: string
  primaryType: string
  actionTypeDefinition: string
  actionMessage: Record<string, unknown>
}

export interface ActionBuilderFlags {
  [key: string]: string | boolean | undefined
}

interface ActionBuilderContext {
  rpcUrl: string
  chainId: number
  macroAddress: Address
  flags: ActionBuilderFlags
}

function getRequiredString(flags: ActionBuilderFlags, key: string): string {
  const value = flags[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing --${key}`)
  }
  return value
}

function parseJsonObject(value: string, flagName: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error(`Invalid JSON in --${flagName}`)
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`--${flagName} must be a JSON object`)
  }

  return parsed as Record<string, unknown>
}

async function buildRawAction(flags: ActionBuilderFlags): Promise<ActionBuildResult> {
  return {
    actionParams: getRequiredString(flags, 'action-params') as Hex,
    actionDescription: getRequiredString(flags, 'action-description'),
    primaryType: getRequiredString(flags, 'primary-type'),
    actionTypeDefinition: getRequiredString(flags, 'action-type-definition'),
    actionMessage: parseJsonObject(getRequiredString(flags, 'action-message'), 'action-message'),
  }
}

async function buildFlowSchedulerFromFlags(context: ActionBuilderContext): Promise<ActionBuildResult> {
  const { rpcUrl, chainId, macroAddress, flags } = context
  const params: FlowSchedulerParams = {
    superToken: getRequiredString(flags, 'super-token') as Address,
    receiver: getRequiredString(flags, 'receiver') as Address,
    startDate: flags['start-date'] ? parseInt(getRequiredString(flags, 'start-date')) : Math.floor(Date.now() / 1000) + 3600,
    startMaxDelay: flags['start-max-delay'] ? parseInt(getRequiredString(flags, 'start-max-delay')) : 86400,
    flowRate: BigInt(getRequiredString(flags, 'flow-rate')),
    startAmount: flags['start-amount'] ? BigInt(getRequiredString(flags, 'start-amount')) : 0n,
    endDate: flags['end-date'] ? parseInt(getRequiredString(flags, 'end-date')) : 0,
    userData: (flags['user-data'] as Hex | undefined) || '0x',
  }

  return buildFlowSchedulerAction(rpcUrl, chainId, macroAddress, params)
}

export function usesRawActionFlags(flags: ActionBuilderFlags): boolean {
  return typeof flags['action-params'] === 'string'
}

export async function buildAction(context: ActionBuilderContext): Promise<ActionBuildResult> {
  if (usesRawActionFlags(context.flags)) {
    return buildRawAction(context.flags)
  }

  const macroKind = typeof context.flags['macro-kind'] === 'string'
    ? context.flags['macro-kind']
    : 'flow-scheduler'

  if (macroKind === 'flow-scheduler') {
    return buildFlowSchedulerFromFlags(context)
  }

  throw new Error(
    `Unknown --macro-kind ${macroKind}. Use raw action flags (--action-params, --action-description, --primary-type, --action-type-definition, --action-message) or a supported macro kind.`
  )
}
