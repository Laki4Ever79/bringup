import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join as joinPath } from "node:path"
import { createHuman, type SemanticEvent } from "@mozaik-ai/core"
import { join } from "../src/runtime.ts"

export function tempDir(): string {
	return mkdtempSync(joinPath(tmpdir(), "bringup-"))
}

// Joins a participant that records every event it sees, in delivery order.
export function recorder(): SemanticEvent[] {
	const seen: SemanticEvent[] = []
	join(
		createHuman({
			name: "recorder",
			capabilities: [],
			handlers: [{ specification: { isSatisfiedBy: () => true } as never, processor: { apply: ({ event }) => void seen.push(event) } }],
		}),
	)
	return seen
}

export async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
	const start = Date.now()
	while (!check()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out")
		await new Promise((r) => setTimeout(r, 10))
	}
}
