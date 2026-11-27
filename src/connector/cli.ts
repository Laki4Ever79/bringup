// `login` and `logout`, one implementation for both front doors: a clone's `npm run bringup -- login` (src/main.ts)
// and an npm install's `npx bringup-mcp login` (bin/bringup-mcp.js). Public, in the engine: never imports
// src/dashboard or cloud/.
import { STUDIO } from "../brand/names.js"
import { login, logout, openInBrowser, STUDIO_URL, tokenPath } from "./login.ts"

// argv starts at the subcommand: ["login", "--url", "https://..."] or ["logout"]. Returns the exit code.
export async function connectorCli(argv: string[], say: { out: (m: string) => void; err: (m: string) => void } = { out: (m) => console.log(m), err: (m) => console.error(m) }): Promise<number> {
	if (argv[0] === "logout") {
		say.out(logout() ? `bringup: disconnected from ${STUDIO} (removed ${tokenPath()})` : `bringup: this machine wasn't connected to ${STUDIO}`)
		return 0
	}
	const at = argv.indexOf("--url")
	const url = at > 0 ? argv[at + 1] : STUDIO_URL
	if (!url) {
		say.err(`bringup: login needs ${STUDIO}'s address: --url <https://...> or BRINGUP_STUDIO_URL`)
		return 1
	}
	try {
		const { account } = await login(url, (u) => openInBrowser(u), { say: say.out })
		say.out(`bringup: this machine is connected to ${STUDIO}${account ? ` as ${account}` : ""}; runs stream there unless --offline (token in ${tokenPath()})`)
		return 0
	} catch (e) {
		say.err(`bringup: login failed: ${(e as Error).message}`)
		return 1
	}
}
