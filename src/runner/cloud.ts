import type { Participant } from "@mozaik-ai/core"
import { readCachedCredentials } from "@mozaik-ai/cloud-sdk"
import { createCloudExporter, type CloudExporter, type ExporterConfig } from "@mozaik-ai/cloud-sdk/exporter"

const DEFAULT_ENDPOINT = "https://api.app.jigjoy.ai"
const PER_LOOP_WARNING = "mozaik cloud: no API key"

export interface CloudSessionDeps {
	env?: NodeJS.ProcessEnv
	create?: (config: ExporterConfig) => CloudExporter
	readCached?: (endpoint: string) => { projectKey: string } | null
	fetch?: typeof fetch
	log?: (line: string) => void
}

let warningFiltered = false

// One Mozaik Cloud session for the whole run: an exporter participant that sees every event (agent loops and
// ours) under one sessionId, instead of core's separate session per runLoop. Takes the key core would use
// (BRINGUP_CLOUD_KEY, MOZAIK_API_KEY, MOZAIK_PROJECT_KEY, or the paired machine's cached credentials), then
// blanks MOZAIK_API_KEY/MOZAIK_PROJECT_KEY in this process so core's per-loop clients turn themselves off.
// Returns null when there is no key or BRINGUP_CLOUD=off.
export function startCloudSession(participants: () => readonly Participant[], deps: CloudSessionDeps = {}): CloudExporter | null {
	const env = deps.env ?? process.env
	if (env.BRINGUP_CLOUD === "off") return null
	const endpoint = (env.MOZAIK_CLOUD_ENDPOINT || DEFAULT_ENDPOINT).replace(/\/$/, "")
	const projectKey = env.BRINGUP_CLOUD_KEY || env.MOZAIK_API_KEY || env.MOZAIK_PROJECT_KEY || (deps.readCached ?? readCachedCredentials)(endpoint)?.projectKey
	if (!projectKey) return null

	env.MOZAIK_API_KEY = ""
	env.MOZAIK_PROJECT_KEY = ""
	// Each disabled per-loop client warns that there is no key; with the session running that is noise.
	if (env === process.env && !warningFiltered) {
		warningFiltered = true
		const warn = console.warn
		console.warn = (...args: unknown[]) => {
			if (typeof args[0] === "string" && args[0].startsWith(PER_LOOP_WARNING)) return
			warn(...args)
		}
	}

	const log = deps.log ?? ((line: string) => console.log(line))
	return (deps.create ?? createCloudExporter)({
		endpoint,
		projectKey,
		participants,
		mozaikVersion: "4.1.0",
		fetch: deps.fetch,
		// Same wording as core's per-loop links, so the demo relay and the dashboard header pick it up.
		onSessionUrl: (url) => log(`▶ mozaik cloud — watching live: ${url}`),
		onError: (error, dropped) => console.error(`[cloud] ${dropped} event(s) not sent: ${error.message}`),
	})
}
