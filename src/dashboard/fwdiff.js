// The firmware viewer's diff (the board page's Firmware tab): what changed between two firmware revisions, file by
// file (by content hash, from /api/runs/<id>/firmware) and line by line (a longest-common-subsequence diff).

const lines = (text) => {
	const l = String(text ?? "").split("\n")
	if (l.length && l.at(-1) === "") l.pop() // a final newline ends the last line; it isn't a line of its own
	return l
}

// Every line of both texts, in order: {op: "same" | "del" | "add", a: line in the old text, b: line in the new, text}.
// Removed lines come before the lines that replace them. Past about 4 million line pairs (two 2000-line files) it
// falls back to "all removed, all added" rather than freeze the page.
export function lineDiff(oldText, newText) {
	const A = lines(oldText), B = lines(newText)
	const n = A.length, m = B.length
	if (n * m > 4_000_000) return [...A.map((text, i) => ({ op: "del", a: i + 1, b: null, text })), ...B.map((text, j) => ({ op: "add", a: null, b: j + 1, text }))]
	// L[i][j]: the longest common subsequence of A[i..] and B[j..], in one flat array.
	const W = m + 1
	const L = new Uint32Array((n + 1) * W)
	for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * W + j] = A[i] === B[j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1])
	const out = []
	let i = 0, j = 0
	while (i < n || j < m) {
		if (i < n && j < m && A[i] === B[j]) { out.push({ op: "same", a: i + 1, b: j + 1, text: A[i] }); i++; j++ }
		else if (j >= m || (i < n && L[(i + 1) * W + j] >= L[i * W + j + 1])) { out.push({ op: "del", a: i + 1, b: null, text: A[i] }); i++ }
		else { out.push({ op: "add", a: null, b: j + 1, text: B[j] }); j++ }
	}
	return out
}

// The changes with `context` lines around each, merged where they meet: [{skippedBefore, lines}], plus the kept lines
// after the last hunk in `skippedAfter` on the last one. No changes: no hunks.
export function hunks(diff, context = 3) {
	const changed = diff.flatMap((l, k) => (l.op === "same" ? [] : [k]))
	if (!changed.length) return []
	const ranges = []
	for (const k of changed) {
		const from = Math.max(0, k - context), to = Math.min(diff.length - 1, k + context)
		const last = ranges.at(-1)
		if (last && from <= last.to + 1) last.to = Math.max(last.to, to)
		else ranges.push({ from, to })
	}
	return ranges.map((r, i) => ({ skippedBefore: r.from - (i ? ranges[i - 1].to + 1 : 0), skippedAfter: i === ranges.length - 1 ? diff.length - 1 - r.to : 0, lines: diff.slice(r.from, r.to + 1) }))
}

// Two revisions' file lists ({path, hash, generated}), as one list by path: "added", "removed", "changed" or "same".
// With no older revision (the first one), every file is "same".
export function compareFiles(older, newer) {
	const a = new Map((older ?? newer).map((f) => [f.path, f]))
	const b = new Map(newer.map((f) => [f.path, f]))
	return [...new Set([...a.keys(), ...b.keys()])].sort().map((path) => {
		const x = a.get(path), y = b.get(path)
		const status = !x ? "added" : !y ? "removed" : x.hash !== y.hash ? "changed" : "same"
		return { path, status, generated: (y ?? x).generated }
	})
}
