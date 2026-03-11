import { serializeForJson, type SignedAgentRequest } from './clearSigning.js'

export interface RelayResponse {
  id: string
  agentAddress: string
  devicesNotified: number
  createdAt?: number
}

export async function sendAgentRequest(
  relayerUrl: string,
  request: SignedAgentRequest
): Promise<RelayResponse> {
  const res = await fetch(`${relayerUrl}/agent-relay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: serializeForJson(request),
  })
  if (!res.ok) {
    const err = await res.json()
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}
