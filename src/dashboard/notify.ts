// "Approvals where you are": when interception holds a change for the engineer (--engineer-approval), the hub pushes
// it to a phone through ntfy (https://ntfy.sh), with Approve and Reject buttons that POST to the hub's decision route.
//
// Opt-in: off unless BRINGUP_NTFY_TOPIC is set. ntfy.sh is a public service: anyone who knows a topic name can read it
// and post to it, so the topic must be unguessable (e.g. bringup-<20 random characters>), and a push carries only the
// field and a short summary, never the brief or contract values. The buttons need the hub reachable from the phone
// (the hub's --lan, which also prints the token they carry). BRINGUP_NTFY_SERVER points at a self-hosted ntfy instead.

export type TraceNotifier = (runId: string, line: string) => Promise<void>

const SUMMARY_CHARS = 100
// Lines older than this when the hub reads them are a replayed trace, not a change waiting now.
const FRESH_MS = 60_000

export function ntfyNotifier(opts: { topic: string; server?: string; hubUrl: string; token: string; fetch?: typeof fetch; now?: () => number }): TraceNotifier {
	const send = opts.fetch ?? fetch
	const now = opts.now ?? Date.now
	const server = (opts.server ?? "https://ntfy.sh").replace(/\/+$/, "")
	const sent = new Set<string>()
	return async (runId, line) => {
		let e: { type?: string; at?: string; payload?: { proposalId?: string; field?: string; by?: string; reason?: string; needsEngineer?: boolean } }
		try {
			e = JSON.parse(line)
		} catch {
			return
		}
		const p = e.payload
		if (e.type !== "change.proposed" || !p?.needsEngineer || typeof p.proposalId !== "string" || sent.has(p.proposalId)) return
		if (now() - Date.parse(e.at ?? "") > FRESH_MS) return
		sent.add(p.proposalId)
		const reason = (p.reason ?? "").replace(/\s+/g, " ").trim()
		const summary = reason.length > SUMMARY_CHARS ? `${reason.slice(0, SUMMARY_CHARS - 1)}…` : reason
		const decide = (label: string, approve: boolean) => ({
			action: "http",
			label,
			url: `${opts.hubUrl}/api/runs/${encodeURIComponent(runId)}/decisions`,
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Bringup-Token": opts.token },
			body: JSON.stringify({ proposalId: p.proposalId, approve, reason: approve ? "approved from the phone" : "rejected from the phone" }),
			clear: true,
		})
		try {
			await send(`${server}/`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					topic: opts.topic,
					title: `Bringup: approve a change to ${p.field}?`,
					message: `${p.by ?? "an agent"} wants to change ${p.field}${summary ? `: ${summary}` : ""}`,
					tags: ["hammer_and_wrench"],
					actions: [decide("Approve", true), decide("Reject", false)],
				}),
			})
		} catch {
			// ntfy unreachable: the change stays held, and the dashboard can still decide it.
		}
	}
}

export function notifierFromEnv(env: Record<string, string | undefined>, opts: { hubUrl: string; token: string; fetch?: typeof fetch; now?: () => number }): TraceNotifier | null {
	const topic = env.BRINGUP_NTFY_TOPIC?.trim()
	return topic ? ntfyNotifier({ ...opts, topic, server: env.BRINGUP_NTFY_SERVER?.trim() || undefined }) : null
}
