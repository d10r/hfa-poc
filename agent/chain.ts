import type { Chain } from 'viem'

export function getChainConfig(chainId: number, rpcUrl?: string): Chain {
  const chains: Record<number, Chain> = {
    11155420: {
      id: 11155420,
      name: 'Optimism Sepolia',
      nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl || 'https://sepolia.optimism.io'] } },
    },
  }

  return chains[chainId] || {
    id: chainId,
    name: `Chain ${chainId}`,
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl || ''] } },
  }
}
