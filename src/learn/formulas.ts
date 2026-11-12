// Values worked out from other facts, by name, so a kind file can say which formula gives a field and the part card
// can show it. Each returns NaN or Infinity when the inputs give no answer.
export const FORMULAS: Record<string, { text: string; unit: string; fn: (inputs: Record<string, number>) => number }> = {
	// The smallest sealed box that keeps a driver at Qtc = 0.707 (maximally flat): Vb = Vas / ((Qtc / Qts)² − 1).
	// A driver with Qts at or above 0.707 can't reach it in any sealed box (no answer).
	"sealed-box-min-volume": {
		text: "Vb = Vas / ((0.707 / Qts)² − 1), sealed box at Qtc 0.707",
		unit: "cm³",
		fn: ({ vasL, qts }) => {
			const r = (0.707 / qts) ** 2 - 1
			return r > 0 ? (vasL * 1000) / r : Number.POSITIVE_INFINITY
		},
	},
}
