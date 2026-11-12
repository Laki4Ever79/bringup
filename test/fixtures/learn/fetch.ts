import { readFileSync } from "node:fs"
import { join } from "node:path"

const FIX = import.meta.dirname

// A fetch that serves fixture files by their name at any host, and counts requests.
export function fixtureFetch(files: Record<string, string> = { "brg-amp1.pdf": "brg-amp1.pdf", "brg-spk40.pdf": "brg-spk40.pdf", "landing.html": "landing.html" }) {
	const calls: string[] = []
	const f = (async (input: string | URL | Request) => {
		const url = String(input instanceof Request ? input.url : input)
		calls.push(url)
		const name = Object.keys(files).find((k) => url.endsWith(`/${k}`))
		if (!name) return new Response("not found", { status: 404 })
		const body = readFileSync(join(FIX, files[name]))
		return new Response(body, { status: 200, headers: { "content-type": name.endsWith(".pdf") ? "application/pdf" : "text/html" } })
	}) as typeof fetch
	return { fetch: f, calls }
}
