export interface GeomBoard { name?: string; xMm: number; yMm: number; rotDeg: number; outline: { widthMm: number; heightMm: number }; carries?: string }
export const CABLE_SLACK_MM: number
export function cableLength(points: { xMm: number; yMm: number }[]): number
export function footprint(b: GeomBoard): { xMm: number; yMm: number }
export function boardsOverlap(p: GeomBoard, q: GeomBoard): boolean
export function offPlate(b: GeomBoard, plate: { lengthMm: number; widthMm: number }): boolean
export const CABLE_PF_PER_M: number
export const BOARD_PF: number
export const DEVICE_PF: number
export const PULLUP_OHM: number
export function i2cCableLimit(khz: number, devices: number): { maxPf: number; maxMm: number }
export const STANDOFF_DEFAULT_MM: number
export const STANDOFF_RANGE_MM: [number, number]
export const STANDOFF_USUAL_MM: [number, number]
export function canonicalJson(v: unknown): string
export function designHash(d: { assembly?: unknown; links?: unknown } | null | undefined): string
export interface GeomMount { xMm: number; yMm: number; zMm?: number; sizeMm: number[] }
export const WHEEL_CLEARANCE_MM: number
export function wheelsRubPlate(plateWidthMm: number, trackMm: number, wheelWidthMm: number): boolean
export function plateMaxWidthMm(trackMm: number, wheelWidthMm: number): number
export function plateLimitForBrief(maxSizeMm: [number, number], wheelWidthMm?: number): [number, number]
export function motorUnderPlateMm(plateWidthMm: number, m: GeomMount): number
export function motorHalfUnder(plateWidthMm: number, m: GeomMount): boolean
export function mountOnPlate(m: GeomMount, lengthMm: number, widthMm: number): boolean
export function blocksSensor(m: GeomMount & { zMm: number }, sensor: GeomMount & { zMm: number }): boolean
export const SENSOR_BRACKET_WALL_MM: number
export function reachesSensorBracket(m: GeomMount, sensor: GeomMount): boolean
export const HAT_STACK_MM: number
export const HAT_STACK_SOURCE: { url: string; where: string }
export function hatBaseZ(baseZ: number): number
export function snapCarriers<T extends GeomBoard & { name: string }>(boards: T[], moved?: string): T[]
