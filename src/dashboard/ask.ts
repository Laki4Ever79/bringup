import "dotenv/config"
import { modelFor } from "../inference/models.ts"
import { changeLog } from "./changelog.js"

// "Ask about the changes": one model call that answers from the run's own record (contract.changed with its
// reason, before/after and cause, the engineer's requests, and the contract at the two revisions asked about),
// citing revisions. The hub calls it; the key stays on this machine. Scripted runs never get here.

const MAX_WRITES = 40
const MAX_REQUESTS = 20
const MAX_SNAPSHOT_CHARS = 6000

export interface AskPrompt {
	system: string
	user: string
}

type Ev = { type: string; payload?: any }
type Snapshot = { revision: number; values: Record<string, unknown> } | null

const SYSTEM = `You answer an engineer's questions about one run of Bringup, where agents design a small hardware product against a shared, versioned design contract. Answer only from the record below: the contract writes (who changed which field, the change, the writer's own reason, and what caused it), the engineer's requests, and the contract at two revisions. Cite revisions for every claim, like "rev 20: the architect set the outline to 40 × 30 mm because …". When a reason or cause says "not recorded (older run)", say that the run did not record it; never guess a motive. Be brief: a few sentences or a short list, in plain text (no Markdown headings or tables).`

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… (cut)` : s)

// The revisions whose snapshots give an older trace's writes their change (each write's revision and the one before).
export function revisionsToLoad(events: Ev[]): number[] {
	const writes = events.filter((e) => e.type === "contract.changed" && !("after" in e.payload)).slice(-MAX_WRITES)
	return [...new Set(writes.flatMap((e) => [e.payload.revision - 1, e.payload.revision]))].filter((r) => r > 0).sort((a, b) => a - b)
}

export function askPrompt(o: { question: string; events: Ev[]; from: Snapshot; to: Snapshot; brief: string; snapshots?: Map<number, unknown> }): AskPrompt {
	const requests = o.events.filter((e) => e.type === "change.requested").slice(-MAX_REQUESTS)
	const all = changeLog(o.events as never, 0, Infinity, (o.snapshots ?? new Map()) as never)
	const writes = all.slice(-MAX_WRITES)
	const lines = [
		`Design: ${o.brief}`,
		"",
		requests.length ? "Engineer requests:" : "Engineer requests: none",
		...requests.map((e) => `- ${e.payload.id}: ${e.payload.text}`),
		"",
		`Contract writes (oldest first; ${writes.length === all.length ? `all ${all.length}` : `the latest ${writes.length} of ${all.length}`}):`,
		...writes.flatMap((w) => [
			`- rev ${w.revision} · ${w.field} v${w.version - 1} → v${w.version} · by ${w.by}`,
			`  change: ${w.diff.length ? w.diff.slice(0, 8).join("; ") : "not recorded (older run)"}`,
			`  reason: ${w.reason ?? "not recorded (older run)"}`,
			`  cause: ${w.cause.text}`,
		]),
		"",
		...[o.from, o.to].filter((s): s is NonNullable<Snapshot> => Boolean(s)).flatMap((s) => [`Contract at rev ${s.revision}:`, clip(JSON.stringify(s.values), MAX_SNAPSHOT_CHARS), ""]),
		`Question: ${o.question}`,
	]
	return { system: SYSTEM, user: lines.join("\n") }
}

export class NoModelKey extends Error {
	readonly code = "NO_KEY"
	constructor() {
		super("no model key on this machine: set OPENAI_API_KEY (or ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL) in .env")
	}
}

// One call to the provider the runs use (src/inference/models.ts), with the reviewer's (strong) model.
export async function callModel(p: AskPrompt, env: Record<string, string | undefined> = process.env, fetchImpl: typeof fetch = fetch): Promise<string> {
	const model = modelFor("reviewer", false, env)
	const anthropic = model.startsWith("claude")
	if (anthropic ? !env.ANTHROPIC_API_KEY : !env.OPENAI_API_KEY) throw new NoModelKey()
	const signal = AbortSignal.timeout(90_000)
	if (anthropic) {
		const base = (env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/$/, "")
		const res = await fetchImpl(`${base}/v1/messages`, {
			method: "POST",
			signal,
			headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01" },
			body: JSON.stringify({ model, max_tokens: 800, system: p.system, messages: [{ role: "user", content: p.user }] }),
		})
		const body = (await res.json()) as { content?: { text?: string }[]; error?: { message?: string } }
		if (!res.ok) throw new Error(`${model}: ${body.error?.message ?? res.statusText}`)
		return (body.content ?? []).map((c) => c.text ?? "").join("").trim()
	}
	const res = await fetchImpl("https://api.openai.com/v1/chat/completions", {
		method: "POST",
		signal,
		headers: { "content-type": "application/json", authorization: `Bearer ${env.OPENAI_API_KEY}` },
		body: JSON.stringify({ model, messages: [{ role: "system", content: p.system }, { role: "user", content: p.user }] }),
	})
	const body = (await res.json()) as { choices?: { message?: { content?: string } }[]; error?: { message?: string } }
	if (!res.ok) throw new Error(`${model}: ${body.error?.message ?? res.statusText}`)
	return (body.choices?.[0]?.message?.content ?? "").trim()
}
