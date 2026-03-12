import type { Address } from 'viem'

export interface SignerConfig {
  forwarderByChain: Record<number, Address>
  security?: {
    provider: string
  }
}

const config: SignerConfig = {
  forwarderByChain: {
    11155420: '0x712F1ccD0472025EC75bB67A92AA6406cDA0031D',
  },
  security: {
    provider: 'macros.superfluid.eth',
  },
}

export default config
