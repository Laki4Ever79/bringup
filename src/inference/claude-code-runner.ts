import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
	FunctionCallItem,
	ModelMessageItem,
	SemanticEvent,
	type ContextItem,
	type InferenceInput,
	type InferenceOutput,
	type InferenceRunner,
} from "@mozaik-ai/core"

// Bringup's agents on the Claude subscription this machine's Claude Code is logged in with (BRINGUP_PROVIDER=
// claude-code; the user, 15 Nov: "using the same subscription you use"). Each agent turn is one headless
// `claude -p` call with no tools of its own: the agent's context goes in as a transcript, its tools as JSON schemas in
// the system prompt, and the answer comes back through --json-schema as { message, calls }, which become Mozaik's
// model message and function-call items, so the agents, change control and the checks work unchanged.
// Development only: a Bringup other people use needs its own API key. It shares the subscription's limits with the
// Claude Code sessions on this machine. Cost in dollars: none (the subscription); tokens are logged like any run's.

export const CC_MODELS = { strong: "cc-sonnet", fast: "cc-haiku" } as const
const CLI_MODEL: Record<string, string> = { "cc-sonnet": "sonnet", "cc-haiku": "haiku", "cc-opus": "opus" }

const OUTPUT_SCHEMA = {
	type: "object",
	properties: {
		message: { type: ["string", "null"], description: "what you say this turn (null when you only call tools)" },
		calls: {
			type: "array",
			description: "the tools to call this turn, in order; empty when you are done",
			items: { type: "object", properties: { name: { type: "string" }, arguments: { type: "object" } }, required: ["name", "arguments"] },
		},
	},
	required: ["calls"],
}

type Item = ContextItem & { type?: string; role?: string; content?: { text?: string }; name?: string; args?: string; callId?: string; output?: { text?: string } | string }
const text = (c: unknown) => (typeof c === "string" ? c : ((c as { text?: string })?.text ?? ""))

// The agent's context as a system prompt (system and developer messages, the tools) and a transcript (the rest).
export function transcriptOf(items: ContextItem[], tools: InferenceInput["tools"] = []): { system: string; prompt: string } {
	const sys: string[] = []
	const turns: string[] = []
	for (const raw of items as Item[]) {
		if (raw.type === "message" && (raw.role === "system" || raw.role === "developer")) sys.push(text(raw.content))
		else if (raw.type === "message" && raw.role === "user") turns.push(`[user]\n${text(raw.content)}`)
		else if (raw.type === "message" && raw.role === "assistant") turns.push(`[you]\n${text(raw.content)}`)
		else if (raw.type === "function_call") turns.push(`[you called ${raw.name}] ${raw.args}`)
		else if (raw.type === "function_call_output") turns.push(`[result of your call]\n${text(raw.output)}`)
	}
	const toolList = (tools ?? [])
		.map((t) => {
			const f = t as unknown as { name: string; description?: string; parameters?: unknown }
			return `- ${f.name}: ${f.description ?? ""}\n  arguments (JSON schema): ${JSON.stringify(f.parameters ?? {})}`
		})
		.join("\n")
	sys.push(
		`You act only through the tools below, and you call them by WRITING them into your JSON answer, never as native tool calls (none are available in this session, and that's expected). Answer in the JSON format you are given: "calls" lists the tool calls for this turn, each { "name": <a tool below>, "arguments": <an object matching its schema exactly> }; "message" is what you say. The calls are carried out after your answer and their results come back to you next turn. When nothing more is needed, return no calls.\n\nTools:\n${toolList || "(none)"}`,
	)
	return { system: sys.join("\n\n"), prompt: `${turns.join("\n\n")}\n\n[your turn]` }
}

function claude(args: string[], stdin: string, timeoutMs: number): Promise<{ code: number | null; out: string; err: string }> {
	return new Promise((res) => {
		// Never let a key in the environment switch the CLI from the subscription to API billing.
		const env = { ...process.env }
		delete env.ANTHROPIC_API_KEY
		delete env.ANTHROPIC_BASE_URL
		const p = spawn(process.env.BRINGUP_CLAUDE_BIN ?? "claude", args, { stdio: ["pipe", "pipe", "pipe"], env, cwd: process.env.BRINGUP_CLAUDE_CWD ?? "/tmp" })
		let out = "", err = ""
		p.stdout.on("data", (d) => (out += d))
		p.stderr.on("data", (d) => (err += d))
		const t = setTimeout(() => { p.kill("SIGKILL"); res({ code: null, out, err: `${err}\ntimed out after ${timeoutMs} ms` }) }, timeoutMs)
		p.on("close", (code) => { clearTimeout(t); res({ code, out, err }) })
		p.stdin.end(stdin)
	})
}

export class ClaudeCodeRunner implements InferenceRunner {
	constructor(private readonly timeoutMs = 240_000) {}

	async run(input: InferenceInput): Promise<InferenceOutput> {
		const { system, prompt } = transcriptOf(input.context.getItems(), input.tools)
		const model = CLI_MODEL[input.model] ?? "sonnet"
		const base = ["-p", "--output-format", "json", "--model", model, "--tools", "", "--no-session-persistence", "--system-prompt", system]
		let r = await claude([...base, "--json-schema", JSON.stringify(OUTPUT_SCHEMA)], prompt, this.timeoutMs)
		// The CLI gives up after its own schema retries on a long answer (rover run cc-eurobot-14, 16 Nov 2026: the reviewer's
		// submit_review failed it six times and the whole review was lost). Ask once more for the same JSON as plain text.
		let fallback = false
		if (r.code !== 0 && /error_max_structured_output_retries|structured_output_retry_exhausted/.test(r.out + r.err)) {
			r = await claude(base, `${prompt}\n\nAnswer with exactly one JSON object and nothing else: {"message": string or null, "calls": [{"name": <tool>, "arguments": {...}}]}.`, this.timeoutMs)
			fallback = true
		}
		if (r.code !== 0) throw new Error(`claude -p failed (${r.code}): ${(r.err || r.out).trim().split("\n").slice(-3).join(" ")}`)
		const d = JSON.parse(r.out) as { is_error?: boolean; result?: string; structured_output?: { message?: string | null; calls?: { name: string; arguments: unknown }[] }; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }; modelUsage?: Record<string, { outputTokens?: number }>; num_turns?: number }
		if (fallback && !d.is_error && !d.structured_output) {
			const parsed = answerFromText(String(d.result ?? ""))
			if (parsed) d.structured_output = parsed
		}
		if (d.is_error || !d.structured_output) throw new Error(`claude -p gave no structured answer: ${String(d.result ?? "").slice(0, 200)}`)
		const names = new Set((input.tools ?? []).map((t) => (t as unknown as { name: string }).name))
		const items: InferenceOutput["items"] = []
		const so = d.structured_output
		if (so.message) items.push(ModelMessageItem.rehydrate({ text: so.message }))
		for (const c of so.calls ?? []) {
			// A tool the agent doesn't have becomes words, so the loop goes on and the agent hears what went wrong.
			if (!names.has(c.name)) { items.push(ModelMessageItem.rehydrate({ text: `(asked for a tool I don't have: ${c.name})` })); continue }
			items.push(FunctionCallItem.rehydrate({ callId: randomUUID(), name: c.name, args: JSON.stringify(c.arguments ?? {}) }))
		}
		if (!items.length) items.push(ModelMessageItem.rehydrate({ text: "done" }))
		const u = d.usage ?? {}
		const inTok = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
		// Anthropic's own usage block goes on, so usage.jsonl keeps cache reads and writes apart from plain input (real runs
		// up to 20b logged them folded into inputTokens), and the model that answered: the CLI's alias names no version.
		return { items, tokenUsage: { inputTokens: inTok, outputTokens: u.output_tokens ?? 0, totalTokens: inTok + (u.output_tokens ?? 0) } as never, rowResponse: { provider: "claude-code", model, usage: d.usage, servedBy: servedBy(d.modelUsage, model), requests: d.num_turns } }
	}

	async *stream(input: InferenceInput): AsyncGenerator<SemanticEvent> {
		yield SemanticEvent.create("inference.output", input.model, await this.run(input))
	}
}

// The model id that answered, from the CLI's per-model usage (keyed by full model id): the one of the asked family
// (sonnet, haiku, opus) with the most output, as the CLI may also make small calls of its own on another model.
export function servedBy(modelUsage: Record<string, { outputTokens?: number }> | undefined, family: string): string | undefined {
	const ids = Object.entries(modelUsage ?? {}).sort((a, b) => (b[1]?.outputTokens ?? 0) - (a[1]?.outputTokens ?? 0)).map(([id]) => id)
	return ids.find((id) => id.includes(family)) ?? ids[0]
}

// The answer's JSON from a plain-text reply: the last {...} that parses and has a calls array (inside a code fence or not).
export function answerFromText(text: string): { message?: string | null; calls: { name: string; arguments: unknown }[] } | null {
	const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1])
	const candidates = [...fenced.reverse(), text]
	for (const c of candidates) {
		for (let start = c.lastIndexOf("{"); start >= 0; start = c.lastIndexOf("{", start - 1)) {
			for (let end = c.length; end > start; end = c.lastIndexOf("}", end - 1)) {
				const slice = c.slice(start, end + 1)
				try {
					const v = JSON.parse(slice) as { calls?: unknown }
					if (v && Array.isArray(v.calls)) return v as { message?: string | null; calls: { name: string; arguments: unknown }[] }
				} catch {}
				if (end <= start + 1) break
			}
		}
	}
	return null
}
