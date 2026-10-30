import { ModelMessageItem, SemanticEvent, type InferenceInput, type InferenceOutput, type InferenceRunner } from "@mozaik-ai/core"

// Mozaik 4.1's runLoop swallows loop errors (issue #114): a provider error, or a response with
// neither a tool call nor an answer, kills the loop silently and the agent never finishes its turn.
// This wrapper turns both into an assistant message, so the loop ends normally and the failure is
// reported instead of stalling the run.
export class SafeRunner implements InferenceRunner {
	constructor(
		private readonly inner: InferenceRunner,
		private readonly onFailure: (model: string, error: string) => void,
	) {}

	async run(input: InferenceInput): Promise<InferenceOutput> {
		try {
			const output = await this.inner.run(input)
			const usable = output.items.some((i) => i.type === "function_call" || (i.type === "message" && i.role === "assistant"))
			return usable ? output : { ...output, items: [ModelMessageItem.rehydrate({ text: "The model returned no answer for this turn." })] }
		} catch (error) {
			this.onFailure(input.model, String(error))
			return { items: [ModelMessageItem.rehydrate({ text: `inference failed: ${String(error)}` })], tokenUsage: undefined, rowResponse: { error: String(error) } }
		}
	}

	async *stream(input: InferenceInput): AsyncGenerator<SemanticEvent> {
		yield SemanticEvent.create("inference.output", input.model, await this.run(input))
	}
}
