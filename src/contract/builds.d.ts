export const BUILDS: Record<"board" | "enclosure" | "firmware" | "testkit" | "chassis" | "drive" | "arm" | "armsim" | "cncsim", { inputs: string[]; requires: string[]; optional?: string }>
