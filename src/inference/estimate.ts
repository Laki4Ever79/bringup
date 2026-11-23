import { appendFileSync } from "node:fs"
import type { InferenceInput, InferenceOutput, InferenceRunner, SemanticEvent } from "@mozaik-ai/core"
import { transcriptOf } from "./claude-code-runner.ts"
import { participantOf } from "./usage.ts"

// Free measurement of what each model call would send (BRINGUP_ESTIMATE_TOKENS=<file>, mock runs): one JSON line per
// call with the prompt's size by part, in characters and in tokens estimated at 4 characters a token. It is how the
// parts agent's context trim was measured before and after on mocks, without a paid or subscription run.
export class EstimateRunner implements InferenceRunner {
	constructor(private readonly inner: InferenceRunner, private readonly file: string) {}

	async run(input: InferenceInput): Promise<InferenceOutput> {
		const items = input.context.getItems()
		const { system, prompt } = transcriptOf(items, input.tools)
		const byKind: Record<string, number> = {}
		for (const it of items) {
			const raw = it as unknown as { type: string; role?: string; name?: string }
			const k = raw.type === "function_call_output" ? "tool-result" : raw.type === "function_call" ? `call:${raw.name}` : `${raw.type}:${raw.role ?? ""}`
			byKind[k] = (byKind[k] ?? 0) + JSON.stringify(raw).length
		}
		appendFileSync(this.file, JSON.stringify({ participant: participantOf(input.context.id) ?? input.model, items: items.length, systemChars: system.length, promptChars: prompt.length, estInputTokens: Math.round((system.length + prompt.length) / 4), byKind }) + "\n")
		return this.inner.run(input)
	}

	stream(input: InferenceInput): AsyncGenerator<SemanticEvent> {
		return this.inner.stream(input)
	}
}
