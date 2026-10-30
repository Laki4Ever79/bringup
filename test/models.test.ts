import { test } from "node:test"
import assert from "node:assert/strict"
import { modelFor } from "../src/inference/models.ts"

test("mock models are per role", () => {
	assert.equal(modelFor("parts", true, {}), "mock-parts")
})

test("OpenAI stays the default even when the gateway key is present", () => {
	const env = { ANTHROPIC_API_KEY: "x", OPENAI_API_KEY: "y" }
	assert.equal(modelFor("architect", false, env), "gpt-5.4")
	assert.equal(modelFor("firmware", false, env), "gpt-5.4-mini")
})

test("BRINGUP_PROVIDER=anthropic opts into the gateway's Claude models", () => {
	const env = { ANTHROPIC_API_KEY: "x", OPENAI_API_KEY: "y", BRINGUP_PROVIDER: "anthropic" }
	assert.equal(modelFor("architect", false, env), "claude-sonnet-4-6")
	assert.equal(modelFor("firmware", false, env), "claude-haiku-4-5")
})

test("Claude is used when it is the only key", () => {
	assert.equal(modelFor("architect", false, { ANTHROPIC_API_KEY: "x" }), "claude-sonnet-4-6")
})

test("openai is the fallback provider", () => {
	assert.equal(modelFor("architect", false, { OPENAI_API_KEY: "y" }), "gpt-5.4")
	assert.equal(modelFor("parts", false, { OPENAI_API_KEY: "y" }), "gpt-5.4-mini")
})

test("BRINGUP_PROVIDER overrides the choice", () => {
	assert.equal(modelFor("architect", false, { ANTHROPIC_API_KEY: "x", BRINGUP_PROVIDER: "openai" }), "gpt-5.4")
})

test("the brief reviewer gets the strong model", () => {
	assert.equal(modelFor("reviewer", false, { OPENAI_API_KEY: "y" }), "gpt-5.4")
})
