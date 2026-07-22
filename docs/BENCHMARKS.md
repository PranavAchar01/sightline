# Model benchmarks

Measured against a realistic support screenshot — an Acme Cloud billing page with a
red `Payment declined - code AVS_MISMATCH` banner, a card ending 4417, ZIP 94108, and
reference `TXN-8891-QW42`. Run from a laptop on residential wifi, single samples, so
treat these as ratios rather than absolutes.

## Ambient caption — `detail: low`

| Model | Latency | Result |
|---|---|---|
| **gpt-5.4-mini** | **1529ms** | correct |
| gpt-5.4-nano | 2521ms | **misread "Acme" as "Acne"** |
| gpt-5.2 | 3276ms | correct, but emitted markdown |
| gpt-5.4 | 3994ms | correct (see caveat below) |

nano is both slower and less accurate — the intuition that the smallest model is the
fastest does not survive contact with OCR-ish work.

### Reasoning effort (gpt-5.4-mini)

| Effort | Latency |
|---|---|
| default | 904ms |
| `none` | 1121ms |
| `low` | 2112ms |
| `minimal` | rejected — not supported on this model |

Default is already the fast path. Explicitly setting `low` more than doubles latency
for no accuracy gain on this task.

## Deep tier — `detail: high`, reading an exact reference number

| Model | Latency | Read `TXN-8891-QW42` exactly? |
|---|---|---|
| **gpt-5.4-mini** | **1007ms** | yes |
| gpt-5.2 | 1106ms | yes |
| gpt-5.4 | — | **`Model not found`** |

## Agent turn through the proxy — time to first token

This is the number that decides whether the call feels conversational. Measured with
the frame already attached and a tool definition present, exactly as ElevenLabs sends
it.

| Model | TTFT | Answer quality |
|---|---|---|
| **gpt-5.4-mini** | **1107ms** | correct diagnosis, told the user to click Edit card |
| gpt-5.2 | 2679ms | correct, more verbose |
| gpt-5-mini | — | returned no content |

## Decisions this drove

- **`gpt-5.4-mini` everywhere** — captions, deep reads, and the agent's own reasoning.
  It won every category outright.
- **`gpt-5.4` is listed by `/v1/models` but is not servable** — `Model not found` on
  both APIs. Anything defaulting to it would have failed at runtime, not at deploy.
- **Suppress markdown explicitly.** Every model wrapped answers like
  `**TXN-8891-QW42**`, and ElevenLabs reads those asterisks aloud. Both
  `lib/vision.ts` and the proxy's injected instruction now demand plain speech.

## Reproduce

```bash
node --env-file=.env.local scripts/benchmark.mjs
```
