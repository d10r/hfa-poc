import type { Chain } from 'viem'

export function getChainConfig(chainId: number, rpcUrl: string): Chain {
  return {
    id: chainId,
    name: `Chain ${chainId}`,
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  }
}
