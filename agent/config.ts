import type { Address } from 'viem'

export interface MacroConfig {
  name: string
  chainAddresses: Record<number, {
    macro: Address
    forwarder: Address
  }>
  eip712Domain: {
    name: string
    version: string
  }
  security?: {
    domain: string
    provider: string
  }
  actionTypeDefinition?: string
}

const config: MacroConfig = {
  name: 'FlowScheduler712Macro',
  chainAddresses: {
    11155420: {
      macro: '0x7b043b577A10b06296FE0bD0402F5025d97A3839',
      forwarder: '0x712F1ccD0472025EC75bB67A92AA6406cDA0031D',
    },
  },
  eip712Domain: {
    name: 'ClearSigning',
    version: '1',
  },
  security: {
    domain: 'flowscheduler.xyz',
    provider: 'macros.superfluid.eth',
  },
  actionTypeDefinition: 'Action(string description,address superToken,address receiver,uint32 startDate,uint32 startMaxDelay,int96 flowRate,uint256 startAmount,uint32 endDate,bytes userData)',
}

export const chainId = parseInt(process.env.CHAIN_ID || '11155420')

export const forwarderAddress = config.chainAddresses[chainId]?.forwarder
export const macroAddress = config.chainAddresses[chainId]?.macro

export default config
