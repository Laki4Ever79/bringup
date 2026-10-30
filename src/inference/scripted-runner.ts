import { randomUUID } from "node:crypto"
import {
	FunctionCallItem,
	SemanticEvent,
	type ContextItem,
	type InferenceInput,
	type InferenceOutput,
	type InferenceRunner,
} from "@mozaik-ai/core"

type InferenceItem = InferenceOutput["items"][number]

export type Script = (items: ContextItem[]) => InferenceItem[]

// Keyless inference: each agent's model name (mock-<role>) selects a deterministic script.
export class ScriptedRunner implements InferenceRunner {
	constructor(private readonly scripts: Record<string, Script>) {}

	async run(input: InferenceInput): Promise<InferenceOutput> {
		const script = this.scripts[input.model]
		if (!script) throw new Error(`no script for ${input.model}`)
		await new Promise((r) => setTimeout(r, 5))
		return { items: script(input.context.getItems()), tokenUsage: undefined, rowResponse: { mock: true, model: input.model } }
	}

	async *stream(input: InferenceInput): AsyncGenerator<SemanticEvent> {
		yield SemanticEvent.create("inference.output", input.model, await this.run(input))
	}
}

export function toolCall(name: string, args: object): FunctionCallItem {
	return FunctionCallItem.rehydrate({ callId: randomUUID(), name, args: JSON.stringify(args) })
}
