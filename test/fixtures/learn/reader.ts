import type { PageReader, ReadRequest } from "../../../src/learn/reader.ts"

type Answer = { value: unknown; unit?: string; region: [number, number, number, number]; quote?: string }
// Scripted answers by pass, page and field. Returns every scripted field the request asks for.
export function fakeReader(script: Partial<Record<"first" | "second" | "strong", Record<number, Record<string, Answer>>>>, usd: number | null = 0.001) {
	const calls: ReadRequest[] = []
	const reader: PageReader = {
		async read(req) {
			calls.push(req)
			const page = script[req.meta.pass as keyof typeof script]?.[req.meta.page] ?? {}
			const facts = req.meta.fields.filter((f) => page[f]).map((f) => ({ field: f, ...page[f], quote: page[f].quote ?? String(page[f].value) }))
			return { json: { facts }, usd }
		},
	}
	return { reader, calls }
}
