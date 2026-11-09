// Values no datasheet gives us, used by the mechanics checks and the simulation. Each is an estimate until the bench
// test (project 4) measures it; every report line that uses one says "(estimate: <name> <value>)".
export const ESTIMATES = {
	floorMu: { value: 0.6, why: "rubber tread on wood, laminate or tile: published dry-friction tables give about 0.5–0.8; the low middle is used" },
	rollingCrr: { value: 0.02, why: "small rubber wheels on hard floors: rolling-resistance coefficients of about 0.01–0.03" },
	gearEff: { value: 0.6, why: "small spur gearboxes at high reduction: makers quote roughly 50–70 % overall" },
	plaDensityGcm3: { value: 1.24, why: "PLA filament density as printed solid; infill lowers it, so this overstates the plate's mass slightly" },
	motorOvervoltMax: { value: 1.5, why: "small brushed gearmotors are commonly run up to about 1.5× rated voltage with shorter life; beyond that, no" },
	boardMassGPerCm2: { value: 0.35, why: "a 1.6 mm FR-4 board with small parts weighs roughly 0.3–0.4 g per cm²" },
	standoffMm: { value: 10, why: "board standoffs above the plate, to clear the battery and wiring" },
} as const

export const est = (k: keyof typeof ESTIMATES) => ESTIMATES[k].value
export const estNote = (k: keyof typeof ESTIMATES) => `(estimate: ${k} ${ESTIMATES[k].value})`
