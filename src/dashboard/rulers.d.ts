export function tickStep(pxPerMm: number): { major: number; minor: number }
export function axisMap(o: { view: number[]; width: number; height: number; origin: { x: number; y: number } }): { pxPerMm: number; xPx(mm: number): number; yPx(mm: number): number; xMm(px: number): number; yMm(px: number): number }
export function rulerTicks(from: number, to: number, step: { major: number; minor: number }): { mm: number; major: boolean; label?: string }[]
