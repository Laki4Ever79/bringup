export type ProgressStep = "contract" | "board" | "case" | "chassis" | "firmware" | "boot" | "drive" | "testkit" | "link" | "assembly" | "request" | "settled"
export type ProgressStatus = "started" | "ok" | "failed" | "not run"
export interface ProgressLine { at: string; round: number; board: string; step: ProgressStep; status: ProgressStatus; revision?: number; detail?: string }
export interface StepState { status: ProgressStatus; detail?: string; revision?: number; prev?: boolean }
export interface BoardProgress { step: ProgressStep; status: ProgressStatus; detail?: string; revision?: number; steps: Partial<Record<ProgressStep, StepState>> }
export interface ProgressState { round: number; boards: Record<string, BoardProgress>; system: { step: ProgressStep | null; status: ProgressStatus | null; detail?: string }; systemSteps: Partial<Record<ProgressStep, StepState>> }
export interface Badge { text: string; kind: "ok" | "run" | "bad" | "idle"; title: string }
export const STEPS: ProgressStep[]
export function progressState(lines: ProgressLine[]): ProgressState
export function stepOfEvent(event: { type: string; payload?: unknown }): { step: ProgressStep; status: ProgressStatus; revision?: number; detail?: string } | null
export function badgeOf(b: BoardProgress | undefined): Badge | null
export interface ProgressStrip { push(line: ProgressLine): void; state(): ProgressState; dispose(): void }
export function mountProgress(host: HTMLElement, opts?: { onPick?: (board: string) => void; onChange?: (state: ProgressState) => void }): ProgressStrip
