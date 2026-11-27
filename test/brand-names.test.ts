// The product's names in one place (src/brand/names.js): brandText writes the product's words in the configured names,
// never the lowercase identifiers a rename changes by hand (docs/rename.md).
import assert from "node:assert/strict"
import test from "node:test"
import { brandText, PRODUCT, STUDIO } from "../src/brand/names.js"

test("the defaults change nothing; other names replace the product's words, not its identifiers", () => {
	if (!process.env.BRINGUP_PRODUCT_NAME) assert.deepEqual([PRODUCT, STUDIO], ["Bringup", "Bringup Studio"])
	const text = "Bringup Studio shows what Bringup's agents made. Run `npx bringup-mcp login` (BRINGUP_STUDIO_URL); see github.com/Laki4Ever79/bringup."
	assert.equal(brandText(text, { product: "Bringup", studio: "Bringup Studio" }), text)
	assert.equal(brandText(text, { product: "Acme", studio: "Acme Studio" }), "Acme Studio shows what Acme's agents made. Run `npx bringup-mcp login` (BRINGUP_STUDIO_URL); see github.com/Laki4Ever79/bringup.")
	assert.equal(brandText("Bringup Studio", { product: "Acme", studio: "Acme Cloud" }), "Acme Cloud", "the paid page may have its own name")
})
