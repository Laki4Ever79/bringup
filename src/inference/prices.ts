// USD per million tokens, standard tier, for the models src/inference/models.ts picks. Checked on PRICES_CHECKED at
// https://developers.openai.com/api/docs/pricing and https://platform.claude.com/docs/en/about-claude/pricing.
// gpt-5.4 is the under-272K-context price (our prompts are far below it). Claude cache writes (5-minute) cost
// cacheWritePerM; OpenAI has no write charge. usage.ts reads Anthropic's own usage block, because Mozaik's TokenUsage
// folds cache writes and reads into one "cached" count and leaves them out of inputTokens.
export const PRICES_CHECKED = "2026-11-25"

export interface Price { inputPerM: number; cachedInputPerM: number; outputPerM: number; cacheWritePerM?: number }
// over: a long-prompt tier (Haiku 5.5): a request whose whole input passes `inputTokens` is priced at `price` instead.
export const PRICES: Record<string, Price & { over?: { inputTokens: number; price: Price } }> = {
	"gpt-5.4": { inputPerM: 2.5, cachedInputPerM: 0.25, outputPerM: 15 },
	"gpt-5.4-mini": { inputPerM: 0.75, cachedInputPerM: 0.075, outputPerM: 4.5 },
	"claude-sonnet-4-6": { inputPerM: 3, cachedInputPerM: 0.3, outputPerM: 15, cacheWritePerM: 3.75 },
	"claude-haiku-4-5": { inputPerM: 1, cachedInputPerM: 0.1, outputPerM: 5, cacheWritePerM: 1.25 },
	// What the subscription serves since Nov 2026 (usage.jsonl servedBy): a run's API-equivalent cost (apiUsd).
	"claude-sonnet-5-5": { inputPerM: 2, cachedInputPerM: 0.2, outputPerM: 10, cacheWritePerM: 2.5 },
	"claude-haiku-5-5": {
		inputPerM: 0.1, cachedInputPerM: 0.01, outputPerM: 0.5, cacheWritePerM: 0.125,
		over: { inputTokens: 100_000, price: { inputPerM: 0.5, cachedInputPerM: 0.05, outputPerM: 2.5, cacheWritePerM: 0.625 } },
	},
	// The Claude subscription through the local Claude Code (inference/claude-code-runner.ts): no per-token charge.
	"cc-sonnet": { inputPerM: 0, cachedInputPerM: 0, outputPerM: 0 },
	"cc-haiku": { inputPerM: 0, cachedInputPerM: 0, outputPerM: 0 },
	"cc-opus": { inputPerM: 0, cachedInputPerM: 0, outputPerM: 0 },
}
