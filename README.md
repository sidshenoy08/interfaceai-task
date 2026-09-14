# Computer-Use Automation System

A small, real end-to-end system for interface.ai's take-home: an LLM discovers how to accomplish a
goal against a live UI, the successful run is recorded as a typed, reusable **capability
artifact**, and that artifact is replayed **deterministically** (no LLM) in production, with
explicit handling of business outcomes, recoverable conditions, and hard failures — including a
real human-in-the-loop escalation and control-handoff path.

See `/REPORT.md` for the design write-up (architecture, artifact schema, determinism & error
handling, heterogeneity/multi-tenant story, escalation model, safety model, and cuts).

## Stack

- TypeScript + Node, run directly via [`tsx`](https://github.com/privatenumber/tsx) (no build step needed for the demo).
- [Playwright](https://playwright.dev/) (Chromium) for browser automation.
- OpenAI (`gpt-4o` by default) for the discovery agent's decision loop.
- The proxy target is a small **mock legacy core-banking console** included in this repo
  (`src/target-app`) — a server-rendered app with nested tables, no test ids, and no semantic
  markup, deliberately styled after the "legacy web app" case described in the brief. There is no
  need for a real bank system, a public site, or any credentials.

## Setup

```bash
npm install
npx playwright install chromium   # one-time browser download
cp .env.example .env
```

Edit `.env` and set `OPENAI_API_KEY` to your own key. Everything else has a sensible default:

```ini
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o
TARGET_APP_PORT=4000
OPERATOR_PORT=4001
HEADED=true          # set to "false" to run the browser headless
```

`HEADED=true` opens a visible Chromium window so you can watch the agent work — this is also what
makes the human-escalation demo below meaningful (a real visible session a human can watch/inspect
via the operator console, described below).

### Running without live services

- The **target app** is fully local and self-contained (`npm run target-app`) — no external
  service, no network access, no real data.
- **Deterministic replay** (`npm run replay`) never calls an LLM and needs no API key at all — only
  the target app running locally. This is the path meant to run unattended/at scale.
- Only **discovery** (`npm run discover`) needs `OPENAI_API_KEY`, since that's the one place a real
  model has to be in the loop (by design — see the brief's "the discovery run has to be real").

## Demo path

Open two terminals.

**Terminal 1 — start the mock target app:**

```bash
npm run target-app
```

**Terminal 2 — run the agent on a goal, then replay the resulting artifact:**

```bash
# 1. Discovery: a real LLM drives the browser to accomplish the goal, and on
#    success records a capability artifact under /artifacts.
npm run discover -- --goal "Look up member 12345 and read their current savings balance."

# 2. Deterministic replay of that artifact, with no LLM involved. `lookup-member-balance`
#    is the capability id the model chose during discovery (see the printed artifact path,
#    or /artifacts/*.latest.json).
npm run replay -- --artifact lookup-member-balance --input memberId=12345

# 3. Replay again with an id that doesn't exist — a *business outcome*, not a crash:
npm run replay -- --artifact lookup-member-balance --input memberId=99999
```

Every run's structured log (and any screenshots) land under `/evidence/<discovery|replay>-<runId>/`.
`/evidence` in this repo already contains a full set of real runs from development — see
"Evidence in this repo" below.

### Second capability: an irreversible action, gated

```bash
npm run discover -- --goal "Open a new savings sub-account for member 12345 with an initial deposit of \$100, confirm, and complete opening the account."

# Blocked: this artifact contains an irreversible step and is not "approved".
npm run replay -- --artifact open-savings-sub-account --input memberId=12345 --input initialDeposit=250

# Explicit override to actually run it unattended:
npm run replay -- --artifact open-savings-sub-account --input memberId=12345 --input initialDeposit=250 --confirm-irreversible

# A validation business outcome, short-circuiting before the irreversible step ever runs:
npm run replay -- --artifact open-savings-sub-account --input memberId=12345 --input initialDeposit=5 --confirm-irreversible
```

### Human escalation & handoff

Replay accepts a test-only `--inject <mode>` flag that rewrites the first bare navigation to carry
a fault flag the target app understands, so you can see error handling without needing to write a
new target-app route each time:

- `--inject interstitial`: the target app shows an unexpected-but-*known* "session renewed"
  interstitial. The artifact already has a detector + auto-dismiss action for it, so replay
  recovers **without** any human involvement — the "recoverable condition" tier.
- `--inject outage`: the target app shows a "temporarily unavailable" page the artifact has
  **no** detector for — a genuine unknown state. Replay escalates to a human operator:

```bash
npm run replay -- --artifact lookup-member-balance --input memberId=12345 --inject outage
```

The process will pause and print an escalation reason. Open **http://localhost:4001/operator** —
you'll see the live screenshot of the *same* browser session the automation was using, the reason
it stopped, and a form to act on it directly (click / type / navigate by role + accessible name).
On this outage page there's a "Retry" link: set Action=`click`, Role=`link`, Name=`Retry`, submit,
confirm the real page loads, then click **Resume automation**. Replay re-attempts the exact step
that failed and continues from there. The human's action is recorded in the run's evidence log
alongside everything the agent did.

## Evidence in this repo

`/evidence` already contains real runs (structured JSONL logs + screenshots) from development,
covering every path described above:

| Directory | What it shows |
|---|---|
| `discovery-...-93iigs` | Real LLM discovery run producing `lookup-member-balance` |
| `discovery-...-zaohwl` | Real LLM discovery run producing `open-savings-sub-account`, including a `confirm_intent` call before the irreversible submit |
| `replay-...-z9cwkd` | `lookup-member-balance` — success |
| `replay-...-5kiu48` | `lookup-member-balance` — business outcome (`member_not_found`) |
| `replay-...-pciczq` | `lookup-member-balance` — recoverable interstitial, auto-dismissed, no human involved |
| `replay-...-78ulif` | `lookup-member-balance` — hard failure → **human escalation & handoff via the operator console** → resume → success |
| `replay-...-6hgel3` | `open-savings-sub-account` — blocked: irreversible step, not approved |
| `replay-...-kptkf7` | `open-savings-sub-account` — business outcome (`invalid_deposit`), approved via `--confirm-irreversible` |
| `replay-...-s0u87f` | `open-savings-sub-account` — full success, actually opens the account |

`/artifacts` contains the two saved capability artifacts referenced above.

## Tests

```bash
npm test
```

Unit tests cover the pure-logic modules where correctness matters most and doesn't require a
browser: the policy engine's risk classification and confirmation gating, redaction, and
input-parameter validation/coercion.

## Project layout

```
src/
  target-app/     mock legacy core-banking console (the proxy target)
  observation/    surface perception: accessibility-flavored snapshot + locator resolution
  agent/          discovery loop: LLM tool-calling against the live page
  artifact/       capability artifact schema, storage/versioning, review-time enrichment
  replay/         deterministic replay engine, condition evaluation, param validation
  guardrails/     allowlist + risk policy, redaction
  escalation/     control-transfer state machine + operator console
  evidence/       structured run logging
  cli.ts          discover / replay entry point
artifacts/        saved capability artifacts (JSON)
evidence/         per-run structured logs + screenshots
config/           allowlist.json (safety policy config)
```
