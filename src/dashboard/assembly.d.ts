type Ev = { at: string; type: string; payload?: Record<string, unknown> }
export interface BoardAssembly {
	outline: { widthMm: number; heightMm: number } | null
	state: "empty" | "placed" | "routed" | "cased"
	revision: number
	boardRevision: number | null
	enclosureRevision: number | null
	pulses: { target: { board: string }; caption: string }[]
}
export function assemblyAt(traces: Record<string, Ev[]>, upTo?: string): Record<string, BoardAssembly>
export function timeSpan(traces: Record<string, Ev[]>): [string, string] | null
