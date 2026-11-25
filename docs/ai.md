# Choosing the AI

Bringup's agents run on whichever AI you choose. Without one, `--mock` runs scripted agents for free.

Set `BRINGUP_AI` and that provider's key in `.env` (or the MCP server's environment), then check with `npm run doctor`.

| `BRINGUP_AI` | What it is | Also set |
|---|---|---|
| `openai` | OpenAI | `OPENAI_API_KEY` |
| `anthropic` | Anthropic | `ANTHROPIC_API_KEY` |
| `gemini` | Google Gemini | `GEMINI_API_KEY` |
| `claude-code` | Your Claude subscription, through this machine's Claude Code login | nothing |
| `openrouter` | One key for many models | `OPENROUTER_API_KEY`, `BRINGUP_AI_MODEL` |
| `mistral` | Mistral | `MISTRAL_API_KEY`, `BRINGUP_AI_MODEL` |
| `ollama` | Local models, free and offline | `BRINGUP_AI_MODEL` (and `OLLAMA_URL` if not on localhost:11434) |
| `lmstudio` | Local models | `BRINGUP_AI_MODEL` (and `LMSTUDIO_URL` if not on localhost:1234) |
| `compatible` | Any OpenAI-compatible server | `BRINGUP_AI_URL`, `BRINGUP_AI_KEY`, `BRINGUP_AI_MODEL` |
| `bringup` | Bringup AI, included with a paid plan | `BRINGUP_AI_KEY` from your account |

`BRINGUP_AI_MODEL` is the model for the agents that plan and judge the design; `BRINGUP_AI_FAST_MODEL`, if set, is the
model for the others (by default the same one). Without `BRINGUP_AI`, the first key found is used (OpenAI, Anthropic,
Gemini, OpenRouter, Mistral).

Models differ a lot at this work: the agents call tools for many turns and must keep a whole design consistent. Small
local models are good for trying it out; for designs you'll build, use a strong model.
