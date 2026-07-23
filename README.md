# Zero to Master of LLM Gateway

Build an enterprise LLM API gateway from scratch in TypeScript. This repo ships the companion code for the first five chapters (`chapter01`–`chapter05`), evolving from v0.1 to v0.5: passthrough → multi-provider routing → Anthropic protocol adapter → internal key auth → two-phase billing.

Stack: Node.js 20+ · Hono · better-sqlite3 + Drizzle · js-tiktoken

## Chapters

| Chapter | Version | Directory | What you get |
|---------|---------|-----------|--------------|
| Ch 1 | v0.1 | [`chapter01`](./chapter01) | 30-line Hono passthrough; OpenAI-protocol inbound, forwarded as-is |
| Ch 2 | v0.2 | [`chapter02`](./chapter02) | IR + `ProviderAdaptor`; route OpenAI / DeepSeek by `model` |
| Ch 3 | v0.3 | [`chapter03`](./chapter03) | Bidirectional Anthropic Messages translation + `/v1/messages` bypass |
| Ch 4 | v0.4 | [`chapter04`](./chapter04) | Internal keys (`sk-gw-`), Org / User / Key + SQLite |
| Ch 5 | v0.5 | [`chapter05`](./chapter05) | Token counting, price table, multipliers, two-phase billing, UsageRecord |

## Chapter 1 · What is an LLM gateway (v0.1)

Minimal starting point: accept OpenAI-protocol requests and forward them to an upstream OpenAI-compatible API. No routing, auth, or billing — on purpose, so the limits of direct upstream calls are obvious.

```bash
cd chapter01
cp .env.example .env   # set OPENAI_API_KEY / OPENAI_BASE_URL
npm install && npm run dev
```

```bash
curl http://localhost:3000/healthz
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-anything" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"ping"}]}'
```

## Chapter 2 · One endpoint, multiple providers (v0.2)

Introduce a shared IR (OpenAI Chat Completions as the internal gold standard) and the `ProviderAdaptor` abstraction. Clients only change the `model` field; the gateway routes by prefix to OpenAI or DeepSeek.

```bash
cd chapter02
cp .env.example .env   # set OPENAI_API_KEY and DEEPSEEK_API_KEY
npm install && npm run dev
```

```bash
# gpt-* → OpenAI; deepseek-* → DeepSeek
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
```

## Chapter 3 · Anthropic protocol adapter (v0.3)

OpenAI-compatible providers only need a baseURL swap. Anthropic Messages differs structurally in six places (system, tools, stop_reason, streaming events, and more). This chapter ships a bidirectional `AnthropicAdaptor` and keeps a native `/v1/messages` bypass.

```bash
cd chapter03
cp .env.example .env   # set at least ANTHROPIC_API_KEY
npm install && npm run dev
```

```bash
# Main path: client sends OpenAI protocol; model=claude-* routes to Anthropic
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-5","max_tokens":256,"messages":[{"role":"user","content":"hi"}]}'
```

## Chapter 4 · Stop sharing the master key (v0.4)

Upstream keys and internal keys get separate lifecycles. Introduce SQLite + Drizzle (`orgs` / `users` / `keys`), Bearer auth middleware, admin API, and a CLI to issue keys. The DB stores only `sha256(plaintext key)`.

```bash
cd chapter04
cp .env.example .env   # change ADMIN_TOKEN; set at least one upstream key
npm install && npm run migrate && npm run dev

# Issue the first internal key
npm run issue-key -- --org "Acme" --user "alice" --name "dev"
```

Clients then call the gateway with `Authorization: Bearer sk-gw-...`. After revoke, requests get 401 immediately.

## Chapter 5 · Who spent my money (v0.5)

Layer billing on top of auth: local tiktoken estimate + upstream usage reconciliation, price table, user × channel × model multipliers, `preConsume` / `postConsume` / `refund` two-phase billing, and `usage_records` ledger.

```bash
cd chapter05
cp .env.example .env
npm install && npm run migrate && npm run dev
```

Default prices are seeded on startup. After a request with an internal key, aggregate spend by user / model / day via the admin API.

## Quick start

Each chapter is a standalone package:

```bash
cd chapter0N
cp .env.example .env
npm install
# chapter04 / chapter05 also need:
#   npm run migrate
npm run dev
```

Requires Node.js 20+. Chapters 4–5 need a local C++ toolchain to build `better-sqlite3` (included on macOS; on Linux install `build-essential`).

## References

[Book LLM Gateway](https://github.com/diguike/book-llm-gateway)
