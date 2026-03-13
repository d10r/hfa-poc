import { writeFileSync } from 'node:fs'
import path from 'node:path'

interface VeniceMessage {
  role: 'system' | 'user'
  content: string
}

interface VeniceResponseChoice {
  message?: {
    content?: string
  }
}

interface VeniceResponse {
  choices?: VeniceResponseChoice[]
}

const OUTPUT_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), 'generated-intents')

function buildPrompt(intent: string): string {
  return [
    'You are helping build a registry entry for a human-readable blockchain action.',
    'Output strict JSON only.',
    'Return an object with keys: protocol, action, kind, rationale, registry, sources, openQuestions.',
    'Prefer the minimal registry shape needed for a PoC.',
    'If the action is not a direct contract call, use kind "offchain_order".',
    `Intent: ${intent}`,
  ].join('\n')
}

export async function generateRegistryCandidate(intent: string): Promise<string> {
  const apiKey = process.env.VENICE_INFERENCE_KEY || process.env.VENICE_INFERENCE_KEY_SsPHqQjzE6wh09QHyYklj2eXmKHu7qbREcBH_MH8Tk
  if (!apiKey) {
    throw new Error('Missing Venice API key')
  }

  // TODO: switch to official Venice docs once endpoint details are locked in the repo.
  const response = await fetch('https://api.venice.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'zai-org-glm-5',
      temperature: 0,
      messages: [
        { role: 'system', content: 'Return strict JSON only. No markdown fences.' } satisfies VeniceMessage,
        { role: 'user', content: buildPrompt(intent) } satisfies VeniceMessage,
      ],
    }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Venice request failed: ${response.status} ${text}`)
  }

  const payload = await response.json() as VeniceResponse
  const content = payload.choices?.[0]?.message?.content?.trim()
  if (!content) throw new Error('Venice returned no content')
  return content
}

async function main() {
  const intent = process.argv.slice(2).join(' ').trim()
  if (!intent) throw new Error('Usage: npx tsx agent/intentBuilder.ts <intent text>')

  const json = await generateRegistryCandidate(intent)
  const fileName = intent.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'intent'
  const outputPath = path.join(OUTPUT_DIR, `${fileName}.json`)

  // TODO: PoC shortcut. We write raw model output so a human can review/edit it before using it.
  writeFileSync(outputPath, `${json}\n`)
  console.log(outputPath)
}

main().catch(err => {
  console.error('Error:', err.message)
  process.exit(1)
})
