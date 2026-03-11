import type { Address } from 'viem'

export interface MacroConfig {
  name: string
  chainAddresses: Record<number, {
    macro: Address
    forwarder: Address
  }>
  security?: {
    domain: string
    provider: string
  }
}

const config: MacroConfig = {
  name: 'FlowScheduler712Macro',
  chainAddresses: {
    11155420: {
      macro: '0x7b043b577A10b06296FE0bD0402F5025d97A3839',
      forwarder: '0x712F1ccD0472025EC75bB67A92AA6406cDA0031D',
    },
  },
  security: {
    domain: 'flowscheduler.xyz',
    provider: 'macros.superfluid.eth',
  },
}

export const chainId = parseInt(process.env.CHAIN_ID || '11155420')

export const forwarderAddress = config.chainAddresses[chainId]?.forwarder
export const macroAddress = config.chainAddresses[chainId]?.macro

export default config
