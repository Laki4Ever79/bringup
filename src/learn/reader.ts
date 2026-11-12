import { NoModelKey } from "../dashboard/ask.ts"
import { usageRecord, type UsageRecord } from "../inference/usage.ts"

// The models the part learner starts with: a cheap one reads every page, the strong one only settles disagreements.
// The learn.jsonl log (cost and first-read match rate per model) is what tunes this choice.
export const MODELS_LEARN = { cheap: "gpt-5.4-mini", strong: "gpt-5.4" } as const

export const RETRY_MS = 3000

export interface ReadRequest {
	model: string
	prompt: string
	images: Buffer[]
	maxTokens: number
	// What the read is for: which page, which fields, which pass. Logged, and lets test fakes answer by page.
	meta: { page: number; fields: string[]; pass: "first" | "second" | "strong" }
}

export interface PageReader {
	read(req: ReadRequest): Promise<{ json: unknown; usd: number | null }>
}

// OpenAI Chat Completions with the page images inline. Every call's tokens and price go to onUsage (usage.jsonl,
// source "part-learner").
export function openAiReader(env: Record<string, string | undefined>, fetchImpl: typeof fetch, onUsage: (r: UsageRecord) => void): PageReader {
	return {
		async read(req) {
			if (!env.OPENAI_API_KEY) throw new NoModelKey()
			// One retry after a rate limit or a server error, then the error stands.
			const post = () => fetchImpl("https://api.openai.com/v1/chat/completions", {
				method: "POST",
				signal: AbortSignal.timeout(120_000),
				headers: { "content-type": "application/json", authorization: `Bearer ${env.OPENAI_API_KEY}` },
				body: JSON.stringify({
					model: req.model,
					max_completion_tokens: req.maxTokens,
					response_format: { type: "json_object" },
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: req.prompt }, ...req.images.map((b) => ({ type: "image_url", image_url: { url: `data:image/png;base64,${b.toString("base64")}`, detail: "high" } }))],
						},
					],
				}),
			})
			let res = await post()
			if (res.status === 429 || res.status >= 500) {
				await new Promise((r) => setTimeout(r, RETRY_MS))
				res = await post()
			}
			const body = (await res.json()) as { choices?: { message?: { content?: string } }[]; error?: { message?: string }; usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } }
			const record = usageRecord(req.model, "part-learner", body.usage?.prompt_tokens, body.usage?.prompt_tokens_details?.cached_tokens, body.usage?.completion_tokens)
			onUsage(record)
			if (!res.ok) throw new Error(`${req.model}: ${body.error?.message ?? res.statusText}`)
			const text = body.choices?.[0]?.message?.content ?? ""
			let json: unknown = null
			try {
				json = JSON.parse(text)
			} catch {
				json = null
			}
			return { json, usd: record.usd }
		},
	}
}
