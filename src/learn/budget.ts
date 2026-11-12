import { PRICES } from "../inference/prices.ts"
import type { PageReader, ReadRequest } from "./reader.ts"

// The part learner's spending cap for one design run (the user, 12 Nov: capped runs while this is developed).
export const DEFAULT_LEARN_CAP_USD = 2

export function learnCap(env: Record<string, string | undefined>): number {
	const n = Number(env.BRINGUP_LEARN_CAP_USD)
	return Number.isFinite(n) && n > 0 ? n : DEFAULT_LEARN_CAP_USD
}

export class BudgetExhausted extends Error {
	constructor(readonly spent: number, readonly cap: number) {
		super(`spending cap reached ($${spent.toFixed(3)} of $${cap.toFixed(2)})`)
	}
}

// A call is allowed only if its worst-case estimate still fits, and that estimate is reserved before the call, so
// calls running at the same time (several needs learn at once) can't together cross the cap. When the call ends the
// reservation is replaced by its real cost; a call whose real price is unknown keeps its estimate, never counted as
// free.
export class Budget {
	spent = 0
	constructor(readonly cap: number) {}
	canSpend(estimateUsd: number): boolean {
		return this.spent + estimateUsd <= this.cap + 1e-12
	}
	// Reserves the estimate if it fits; false (nothing reserved) if not.
	reserve(estimateUsd: number): boolean {
		if (!this.canSpend(estimateUsd)) return false
		this.spent += estimateUsd
		return true
	}
	// Ends a reservation: the real cost replaces the estimate (or the estimate stays, when the cost is unknown).
	settle(estimateUsd: number, usd: number | null): void {
		this.spent += (usd ?? estimateUsd) - estimateUsd
	}
	charge(usd: number | null, estimateUsd: number): void {
		this.spent += usd ?? estimateUsd
	}
	get exhausted(): boolean {
		return this.spent >= this.cap
	}
}

// Worst case for one page read: each image about 1,500 input tokens (a datasheet page at 110 dpi in high detail),
// 1,000 tokens of prompt, and every allowed output token. A model with no known price is priced like the strong one.
export function estimateUsd(model: string, images: number, maxTokens: number): number {
	const p = PRICES[model] ?? PRICES["gpt-5.4"]
	return ((images * 1500 + 1000) * p.inputPerM + maxTokens * p.outputPerM) / 1_000_000
}

export class BudgetedReader implements PageReader {
	constructor(
		private readonly inner: PageReader,
		readonly budget: Budget,
	) {}
	async read(req: ReadRequest) {
		const est = estimateUsd(req.model, req.images.length, req.maxTokens)
		if (!this.budget.reserve(est)) throw new BudgetExhausted(this.budget.spent, this.budget.cap)
		// Settled even when the call fails: a failed call may still have been billed, so it keeps its estimate.
		let usd: number | null = null
		try {
			const r = await this.inner.read(req)
			usd = r.usd
			return r
		} finally {
			this.budget.settle(est, usd)
		}
	}
}
