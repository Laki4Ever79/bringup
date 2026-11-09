// The spend line in the board and system page headers, from GET /api/runs/:id/spend or a system's `spend`. A run from
// before cost tracking has no usage.jsonl: "not recorded". Unknown calls are counted, never priced at $0.
export function spendLabel(spend, scripted) {
	if (scripted) return "Scripted: free"
	if (!spend || spend.calls === 0) return "Spent: not recorded"
	const calls = `${spend.calls} call${spend.calls === 1 ? "" : "s"}`
	const unknown = spend.unknownCalls > 0 && spend.usd !== null ? `, ${spend.unknownCalls} of unknown cost` : ""
	if (spend.usd === null) return `Spent: unknown · ${calls}`
	const usd = spend.usd < 0.01 ? "<$0.01" : `$${spend.usd.toFixed(2)}`
	return `Spent ${usd} · ${calls}${unknown}`
}
