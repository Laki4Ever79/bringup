// The product's names: the one place to change them. A rename (being weighed, 27 Nov 2026; nothing decided) is this
// file: every user-visible mention on the design page, in Studio (cloud/: landing, plans, account, welcome, paywalls,
// the page titles) and in the connector's messages comes from PRODUCT and STUDIO, either directly or through
// brandText, which the hub and Studio apply to the pages and page modules they serve. What can't follow from here (the
// CLI's name, the npm package, the MCP server and tool names, environment variables, URLs) is listed in
// docs/rename.md. Plain ES module: the engine, Studio and the page (served at /brand/names.js) all import it.
//
// BRINGUP_PRODUCT_NAME / BRINGUP_STUDIO_NAME preview another name without changing anything (the hub and Studio read
// them at start); unset, the names below.
const env = globalThis.process?.env ?? {}
export const DEFAULT_PRODUCT = "Bringup"
export const PRODUCT = env.BRINGUP_PRODUCT_NAME || DEFAULT_PRODUCT
export const STUDIO = env.BRINGUP_STUDIO_NAME || `${PRODUCT} Studio`

// Text written with the product's own words ("Bringup", "Bringup Studio", "Bringup's") in the configured names. Only the
// capitalised word: the lowercase identifiers (bringup-mcp, `npm run bringup`, BRINGUP_*, bringup.* keys, URLs) are
// names a rename changes by hand (docs/rename.md), never by a text swap.
export function brandText(text, names = { product: PRODUCT, studio: STUDIO }) {
	const s = String(text)
	if (names.product === DEFAULT_PRODUCT && names.studio === `${DEFAULT_PRODUCT} Studio`) return s
	return s.replace(/\bBringup Studio\b/g, names.studio).replace(/\bBringup\b/g, names.product)
}
