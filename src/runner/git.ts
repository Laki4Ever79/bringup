import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"

// The few git commands a linked folder needs, all local: init, add, commit, show, log. Never push, never touch
// remotes or config (the author is given per command), never rewrite history.

const AUTHOR = ["-c", "user.name=Bringup", "-c", "user.email=bringup@localhost", "-c", "commit.gpgsign=false"]

export function git(dir: string, args: string[]): string {
	return execFileSync("git", ["-C", dir, ...AUTHOR, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
}

export function hasGit(): boolean {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" })
		return true
	} catch {
		return false
	}
}

// A repo of its own: the folder itself has .git (a folder inside some other repo gets its own, so Bringup never
// commits into the surrounding project).
export function ensureRepo(dir: string): void {
	if (!existsSync(join(dir, ".git"))) git(dir, ["init", "-q"])
}

export interface BaseCommit {
	hash: string
	// The contract revision the commit was generated from (its Bringup-Revision trailer).
	revision: number
}

// The newest commit Bringup made: what it generated last, the base every edit is compared with.
export function lastBringupCommit(dir: string): BaseCommit | null {
	let out = ""
	try {
		out = git(dir, ["log", "-1", "--author=bringup@localhost", "--format=%H%n%B"])
	} catch {
		return null // no commits yet
	}
	const [hash, ...body] = out.trim().split("\n")
	const rev = /^Bringup-Revision: (\d+)$/m.exec(body.join("\n"))
	return hash && rev ? { hash, revision: Number(rev[1]) } : null
}

// A file's bytes at a commit, or null if it isn't there.
export function showAt(dir: string, commit: string, path: string): Buffer | null {
	try {
		return execFileSync("git", ["-C", dir, "show", `${commit}:${path}`], { stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 })
	} catch {
		return null
	}
}

// Commits exactly these paths (never `add -A`: the user's other files, staged or not, are theirs). With no paths it
// still records the settled revision, as an empty commit made without touching the index.
export function commitPaths(dir: string, paths: string[], message: string): string {
	if (paths.length > 0) {
		git(dir, ["add", "--", ...paths])
		git(dir, ["commit", "-q", "--allow-empty", "--only", "-m", message, "--", ...paths])
		return git(dir, ["rev-parse", "HEAD"]).trim()
	}
	let parent: string | null = null
	try {
		parent = git(dir, ["rev-parse", "-q", "--verify", "HEAD"]).trim()
	} catch {
		parent = null
	}
	const tree = parent ? git(dir, ["rev-parse", `${parent}^{tree}`]).trim() : git(dir, ["hash-object", "-t", "tree", "-w", "--stdin"]).trim()
	const commit = execFileSync("git", ["-C", dir, ...AUTHOR, "commit-tree", tree, ...(parent ? ["-p", parent] : []), "-F", "-"], { input: message, encoding: "utf8" }).trim()
	git(dir, ["update-ref", "HEAD", commit])
	return commit
}
