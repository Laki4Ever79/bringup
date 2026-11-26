import assert from "node:assert/strict"
import { test } from "node:test"
import { modelFor } from "../src/inference/models.ts"
import { modelsFor, providerModel, providerProblem, PROVIDERS, resolveProvider } from "../src/inference/providers.ts"
import { callModel, NoModelKey } from "../src/runner/ask.ts"

test("the old setups pick the same provider and models as before", () => {
	assert.equal(resolveProvider({ OPENAI_API_KEY: "k" })?.id, "openai")
	assert.equal(resolveProvider({ ANTHROPIC_API_KEY: "k" })?.id, "anthropic")
	assert.equal(resolveProvider({ BRINGUP_PROVIDER: "claude-code" })?.id, "claude-code")
	assert.equal(modelFor("architect", false, { OPENAI_API_KEY: "k" }), "gpt-5.4")
	assert.equal(modelFor("parts", false, { OPENAI_API_KEY: "k" }), "gpt-5.4-mini")
	assert.equal(modelFor("reviewer", false, { ANTHROPIC_API_KEY: "k" }), "claude-sonnet-4-6")
	assert.equal(modelFor("parts", false, { BRINGUP_PROVIDER: "claude-code" }), "cc-haiku")
	assert.equal(modelFor("parts", true, {}), "mock-parts")
})

test("BRINGUP_AI picks any provider; the model comes from BRINGUP_AI_MODEL where the provider has no default", () => {
	const env = { BRINGUP_AI: "openrouter", OPENROUTER_API_KEY: "k", BRINGUP_AI_MODEL: "vendor/big", BRINGUP_AI_FAST_MODEL: "vendor/small" }
	assert.equal(providerProblem(env), null)
	assert.equal(modelFor("architect", false, env), "vendor/big")
	assert.equal(modelFor("firmware", false, env), "vendor/small")
	assert.equal(providerModel(false, { ...env, BRINGUP_AI_FAST_MODEL: undefined }), "vendor/big")
	assert.equal(modelFor("architect", false, { ...env, BRINGUP_MODELS: "fast" }), "vendor/small")
})

test("each missing piece is named in words a user can act on", () => {
	assert.match(providerProblem({})!, /no AI is configured: set BRINGUP_AI/)
	assert.match(providerProblem({ BRINGUP_AI: "nope" })!, /not a provider Bringup knows/)
	assert.match(providerProblem({ BRINGUP_AI: "openrouter" })!, /needs OPENROUTER_API_KEY \(get one at https:\/\/openrouter\.ai\/keys\)/)
	assert.match(providerProblem({ BRINGUP_AI: "openrouter", OPENROUTER_API_KEY: "k" })!, /needs BRINGUP_AI_MODEL/)
	assert.match(providerProblem({ BRINGUP_AI: "compatible", BRINGUP_AI_KEY: "k", BRINGUP_AI_MODEL: "m" })!, /needs BRINGUP_AI_URL/)
	// A local server needs no key.
	assert.equal(providerProblem({ BRINGUP_AI: "ollama", BRINGUP_AI_MODEL: "llama4" }), null)
	assert.throws(() => modelFor("parts", false, {}), /no AI is configured/)
})

test("a model Mozaik doesn't list runs on the chosen provider's server, listed ahead of the built-ins", () => {
	const local = modelsFor({ BRINGUP_AI: "ollama", BRINGUP_AI_MODEL: "qwen-local" })
	const m = local[0] as unknown as { specification: { name: string; provider: string }; endpoint: { clientConfig: { baseURL: string; apiKey: string } } }
	assert.equal(m.specification.name, "qwen-local")
	assert.equal(m.specification.provider, "ollama")
	assert.equal(m.endpoint.clientConfig.baseURL, "http://localhost:11434/v1")
	const custom = modelsFor({ BRINGUP_AI: "compatible", BRINGUP_AI_URL: "https://my.host/v1", BRINGUP_AI_KEY: "k", BRINGUP_AI_MODEL: "x" })[0] as unknown as typeof m
	assert.equal(custom.endpoint.clientConfig.baseURL, "https://my.host/v1")
	assert.equal(custom.endpoint.clientConfig.apiKey, "k")
	// A model Mozaik already lists on the provider's own API keeps its built-in entry.
	const openai = modelsFor({ OPENAI_API_KEY: "k" })
	assert.equal(openai.filter((x) => x.specification.name === "gpt-5.4").length, 1)
	assert.ok(Object.keys(PROVIDERS).includes("bringup"))
})

test("one-off questions go to the chosen provider's chat endpoint with its key", async () => {
	const calls: { url: string; auth: string; model: string }[] = []
	const fake = (async (url: string, init: RequestInit) => {
		const h = init.headers as Record<string, string>
		calls.push({ url, auth: h.authorization, model: JSON.parse(String(init.body)).model })
		return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 })
	}) as unknown as typeof fetch
	const env = { BRINGUP_AI: "openrouter", OPENROUTER_API_KEY: "or-key", BRINGUP_AI_MODEL: "vendor/big" }
	assert.equal(await callModel({ system: "s", user: "u" }, env, fake), "ok")
	assert.deepEqual(calls[0], { url: "https://openrouter.ai/api/v1/chat/completions", auth: "Bearer or-key", model: "vendor/big" })
	await callModel({ system: "s", user: "u" }, { GEMINI_API_KEY: "g" }, fake)
	assert.equal(calls[1].url, "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions")
	await assert.rejects(callModel({ system: "s", user: "u" }, {}, fake), NoModelKey)
})
