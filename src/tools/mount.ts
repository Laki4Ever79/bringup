import { resolve } from "node:path"

// A docker -v argument for a host directory, always absolute: docker reads a relative source as a volume name and
// refuses it ("includes invalid characters for a local volume name"; rover run cc-rover-8 on the Claude subscription,
// 16 Nov 2026: `--out out/cc-rover-8` made the reviewer's power simulation fail on it).
export const mount = (host: string, container: string) => `${resolve(host)}:${container}`
