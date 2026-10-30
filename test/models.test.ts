import { test } from "node:test"
import assert from "node:assert/strict"
import { modelFor } from "../src/inference/models.ts"

test("mock models are per role", () => {
	assert.equal(modelFor("parts", true, {}), "mock-parts")
})

test("anthropic key selects Claude models from the event gateway", () => {
	const env = { ANTHROPIC_API_KEY: "x", OPENAI_API_KEY: "y" }
	assert.equal(modelFor("architect", false, env), "claude-sonnet-4-6")
	assert.equal(modelFor("firmware", false, env), "claude-haiku-4-5")
})

test("openai is the fallback provider", () => {
	assert.equal(modelFor("architect", false, { OPENAI_API_KEY: "y" }), "gpt-5.4")
	assert.equal(modelFor("parts", false, { OPENAI_API_KEY: "y" }), "gpt-5.4-mini")
})

test("BRINGUP_PROVIDER overrides the choice", () => {
	assert.equal(modelFor("architect", false, { ANTHROPIC_API_KEY: "x", BRINGUP_PROVIDER: "openai" }), "gpt-5.4")
})
