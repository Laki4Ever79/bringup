export function driveSvg(trajectory: number[][], o: { edgeMm: number }): string
export function driveRows(drive: { result?: string; segments?: { name: string; pass: boolean; detail: string }[] } | null | undefined): { name: string; verdict: "pass" | "FAIL"; detail: string }[]
