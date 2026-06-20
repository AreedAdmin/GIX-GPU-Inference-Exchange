# @gix/gateway — OpenAI-compatible GIX gateway

A drop-in **OpenAI Chat Completions** API, served by a decentralized GPU and
settled **on-chain**. Wraps `@gix/sdk`'s `runTask` (D2,
`docs/demo-milestone-contract.md` §4).

## Endpoints

| Method | Path                    | Behavior                                                            |
| ------ | ----------------------- | ------------------------------------------------------------------ |
| `POST` | `/v1/chat/completions`  | OpenAI request → `runTask` → OpenAI response (`choices[0].message.content = output`) |
| `GET`  | `/v1/models`            | GIX markets as OpenAI models (model `id` = market name)            |
| `GET`  | `/healthz`              | `{ ok: true }`                                                      |

Every chat response carries GIX provenance as **response headers** (and mirrored
in the body's `x_gix` object):

- `x-gix-job-id` — the settled Job object id
- `x-gix-digest` — the `create_job` tx digest
- `x-gix-verified` — `true`/`false` (output re-hash matched on-chain `output_hash`)
- `x-gix-cost-usdc` — provider payout in MOCK_USDC base units (when observed)

`messages` → prompt: turns are labelled (`System:`/`User:`/`Assistant:`) and the
prompt is primed with a trailing `Assistant:` for the completion.

## Run

```bash
# from services/gateway/
npm install                # links ../../sdk (build it first: cd ../../sdk && npm install && npm run build)
GIX_SUI_PRIVKEY=suiprivkey1...    # consumer signer (required)
GIX_PROVIDER_URL=http://localhost:8080 \
GIX_DEPLOYMENT=../../deployment.json \
GIX_GATEWAY_PORT=8088 \
npm start
```

### Env

| Var                    | Default                        | Meaning                                   |
| ---------------------- | ------------------------------ | ----------------------------------------- |
| `GIX_GATEWAY_PORT`     | `8088`                         | listen port                               |
| `GIX_DEPLOYMENT`       | `../../deployment.json`        | path to deployment.json                   |
| `GIX_PROVIDER_URL`     | `http://localhost:8080`        | provider node base url                    |
| `GIX_RPC_URL`          | network fullnode               | Sui RPC url                               |
| `GIX_PROVIDER_ADDRESS` | `deployment.accounts.providers[0]` | provider operator address             |
| `GIX_MAX_PRICE_USDC`   | `1000000`                      | max MOCK_USDC base units / SCU per request |
| `GIX_SUI_PRIVKEY`      | — (required)                   | consumer signer bech32 key (`suiprivkey1…`) |

## Demo curl

```bash
curl -s http://localhost:8088/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
        "model": "H100-llama3.1-8b-int8",
        "messages": [
          { "role": "system",  "content": "You are concise." },
          { "role": "user",    "content": "What is the capital of France?" }
        ]
      }' -i
```

Response (headers + body):

```
HTTP/1.1 200 OK
x-gix-job-id: 0x…
x-gix-digest: 0x…
x-gix-verified: true
x-gix-cost-usdc: 5
content-type: application/json

{
  "id": "chatcmpl-gix-…",
  "object": "chat.completion",
  "created": 1700000000,
  "model": "H100-llama3.1-8b-int8",
  "choices": [
    { "index": 0, "message": { "role": "assistant", "content": "The capital of France is Paris." }, "finish_reason": "stop" }
  ],
  "usage": { "prompt_tokens": 18, "completion_tokens": 7, "total_tokens": 25 },
  "x_gix": { "job_id": "0x…", "digest": "0x…", "verified": true, "cost_usdc": 5, "provider_pubkey": "…" }
}
```

List models:

```bash
curl -s http://localhost:8088/v1/models
```

## Test

```bash
npm test   # OpenAI mapping (pure) + full server over real http (fake GixRunner, no chain)
```

## Notes

- No streaming in the demo (`"stream": true` → 400). The on-chain purchase is a
  single settled job, so a non-streamed completion matches the flow.
- A `runTask` failure (chain or provider unavailable) → `502 upstream_error`.
- The server depends only on a narrow `GixRunner` interface, so it is unit-tested
  without a chain; `@gix/sdk`'s `GixClient` satisfies it in production.
