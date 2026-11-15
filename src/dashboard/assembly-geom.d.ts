export interface GeomBoard { xMm: number; yMm: number; rotDeg: number; outline: { widthMm: number; heightMm: number } }
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
