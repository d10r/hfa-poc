import { createPublicClient, http, type Address, type Hex } from 'viem'
import { getChainConfig } from './chain.js'

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

export interface PreparedFlowSchedulerAction {
  actionParams: Hex
  actionDescription: string
  primaryType: string
  actionTypeDefinition: string
  actionMessage: {
    description: string
    superToken: Address
    receiver: Address
    startDate: number
    startMaxDelay: number
    flowRate: bigint
    startAmount: bigint
    endDate: number
    userData: Hex
  }
}

const LANG_EN = '0x656e000000000000000000000000000000000000000000000000000000000000' as Hex

const FLOW_SCHEDULER_MACRO_ABI = [
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

export const FLOW_SCHEDULER_ACTION_TYPE_DEFINITION =
  'Action(string description,address superToken,address receiver,uint32 startDate,uint32 startMaxDelay,int96 flowRate,uint256 startAmount,uint32 endDate,bytes userData)'

export const FLOW_SCHEDULER_PRIMARY_TYPE = 'ScheduleFlow'

export const getFlowSchedulerChain = getChainConfig

export async function buildFlowSchedulerAction(
  rpcUrl: string,
  chainId: number,
  macroAddress: Address,
  params: FlowSchedulerParams
): Promise<PreparedFlowSchedulerAction> {
  const chain = getFlowSchedulerChain(chainId, rpcUrl)
  const client = createPublicClient({ chain, transport: http() })

  const [description, actionParams] = await client.readContract({
    address: macroAddress,
    abi: FLOW_SCHEDULER_MACRO_ABI,
    functionName: 'encodeCreateFlowScheduleParams',
    args: [LANG_EN, params],
  })

  const actionMessage = {
    description,
    superToken: params.superToken,
    receiver: params.receiver,
    startDate: params.startDate,
    startMaxDelay: params.startMaxDelay,
    flowRate: params.flowRate,
    startAmount: params.startAmount,
    endDate: params.endDate,
    userData: params.userData,
  }

  return {
    actionParams,
    actionDescription: description,
    primaryType: FLOW_SCHEDULER_PRIMARY_TYPE,
    actionTypeDefinition: FLOW_SCHEDULER_ACTION_TYPE_DEFINITION,
    actionMessage,
  }
}
