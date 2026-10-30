// One build at a time per artifact. Requests that arrive while a build runs collapse into a
// single follow-up build at the newest revision; requests older than the last build are dropped.
export class Rebuilder {
	private running = false
	private pending: number | null = null
	private lastBuilt = -1

	constructor(private readonly build: (revision: number) => Promise<void>) {}

	get idle(): boolean {
		return !this.running && this.pending === null
	}

	request(revision: number): void {
		if (revision <= this.lastBuilt) return
		this.pending = Math.max(this.pending ?? revision, revision)
		if (!this.running) void this.loop()
	}

	private async loop(): Promise<void> {
		this.running = true
		while (this.pending !== null) {
			const revision = this.pending
			this.pending = null
			this.lastBuilt = revision
			try {
				await this.build(revision)
			} catch (error) {
				console.error(`[rebuilder] build ${revision} failed:`, error)
			}
		}
		this.running = false
	}
}
