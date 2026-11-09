// USD per million tokens, standard tier, for the models src/inference/models.ts picks. Checked on PRICES_CHECKED at
// https://developers.openai.com/api/docs/pricing and https://platform.claude.com/docs/en/about-claude/pricing.
// gpt-5.4 is the under-272K-context price (our prompts are far below it). Anthropic cache writes are not priced
// separately: Mozaik's TokenUsage reports only cache hits, which are priced as cachedInputPerM.
export const PRICES_CHECKED = "2026-11-09"

export const PRICES: Record<string, { inputPerM: number; cachedInputPerM: number; outputPerM: number }> = {
	"gpt-5.4": { inputPerM: 2.5, cachedInputPerM: 0.25, outputPerM: 15 },
	"gpt-5.4-mini": { inputPerM: 0.75, cachedInputPerM: 0.075, outputPerM: 4.5 },
	"claude-sonnet-4-6": { inputPerM: 3, cachedInputPerM: 0.3, outputPerM: 15 },
	"claude-haiku-4-5": { inputPerM: 1, cachedInputPerM: 0.1, outputPerM: 5 },
}
