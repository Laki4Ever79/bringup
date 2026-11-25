// Values no datasheet gives us, used by the mechanics checks and the simulation. Each is an estimate until the bench
// test (project 4) measures it; every report line that uses one says "(estimate: <name> <value>)".
export const ESTIMATES = {
	floorMu: { value: 0.6, why: "rubber tread on wood, laminate or tile: published dry-friction tables give about 0.5–0.8; the low middle is used" },
	casterMu: { value: 0.02, why: "a swivel caster rolls and turns rather than grips: its drag is about a rolling-resistance coefficient (0.01–0.03), so it barely brakes; the simulation slides it at this friction" },
	rollingCrr: { value: 0.02, why: "small rubber wheels on hard floors: rolling-resistance coefficients of about 0.01–0.03" },
	plaDensityGcm3: { value: 1.24, why: "PLA filament density as printed solid; infill lowers it, so this overstates the plate's mass slightly" },
	motorOvervoltMax: { value: 1.3, why: "small brushed gearmotors take some overvoltage at a cost in brush and gear life; 1.3× keeps a 3 V motor off a full 4.2 V cell (1.4×)" },
	boardMassGPerCm2: { value: 0.35, why: "a 1.6 mm FR-4 board with small parts weighs roughly 0.3–0.4 g per cm²" },
	packInternalOhm: { value: 0.15, why: "only for a pack without internalOhm in the catalog (each catalog pack has its own, 25 Nov 2026): small 1S LiPo cells with protection circuits measure roughly 0.1–0.2 Ω" },
	standoffMm: { value: 10, why: "board standoffs above the plate, to clear the battery and wiring" },
	printBedMm: { value: 256, why: "a common prosumer printer's bed, 256 × 256 × 256 mm (Bambu Lab X1/P1); a smaller printer needs smaller printed parts" },
} as const

export const est = (k: keyof typeof ESTIMATES) => ESTIMATES[k].value
export const estNote = (k: keyof typeof ESTIMATES) => `(estimate: ${k} ${ESTIMATES[k].value})`
