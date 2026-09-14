# Design Report — Computer-Use Automation System

## 1. Architecture

Single Node/TypeScript process.
Six modules, each owning one concern:

- **`observation`** — perceives the surface and turns it into a compact "accessibility-flavored"
  snapshot (role, accessible name, candidate locator strategies) and resolves a locator strategy
  chain back into a live Playwright handle. This is the single seam the rest of the system depends
  on; nothing else imports Playwright's DOM APIs directly.
- **`agent`** — the discovery loop: observe → send snapshot + screenshot to the LLM as tool-calling
  turns → execute the chosen primitive → record it as a step. The LLM never touches the DOM
  directly; it only sees refs from the last snapshot and calls typed tools (`click`, `type`,
  `select`, `extract_text`, `navigate`, `confirm_intent`, `assert_checkpoint`, `finish`,
  `escalate`).
- **`artifact`** — the schema, JSON file storage with per-capability versioning, and a review-time
  enrichment step (`harden.ts`) that attaches known business outcomes/interstitials before an
  artifact is approved.
- **`replay`** — the deterministic executor: same step primitives as discovery, no LLM, explicit
  three-way result contract.
- **`guardrails`** — the allowlist and risk-classification policy, redaction.
- **`escalation`** — a control-transfer state machine plus a minimal operator console.

Key trade-off: I run the browser **headed** and put the automation and the operator console **in the
same process, sharing the same `Page` object**. That one decision is what makes "the human operates
the same live session, not a fresh one" true by construction rather than by careful bookkeeping —
escalation just blocks the calling coroutine on a promise; there's no session hand-off protocol to
get wrong. The cost is that this doesn't scale past one concurrent run per process.

## 2. Artifact schema

The schema (`src/artifact/schema.ts`) is built around the idea that an artifact is a **callable
contract**, not a step recording:

- `inputs` / `outputs`: typed, named fields (with a `sensitive` flag) — what a caller supplies and
  gets back, independent of how the flow gets there.
- `steps`: each has an `action`, a `target` (a **locator fallback chain**, not a single selector),
  and a `value` that is either a `{ literal }` or a `{ param }` reference. Keeping this explicit
  (rather than string-templating) means you can tell from the artifact alone which literals were
  baked in during discovery vs. which are caller-supplied.
- `checkpoints`: a condition asserted after a specific step, with an explicit `onFail` policy
  (`retry` / `escalate` / `fail`) — a checkpoint is a decision about what to do when reality doesn't
  match expectations, not just a boolean assertion.
- `businessOutcomes` / `interstitials`: named, detectable conditions with their own semantics
  (terminal-and-legitimate vs. recoverable-and-dismissible) — see Section 3.
- `riskLevel` (category) and per-step `risk` (derived, see Section 6), plus `status: draft |
  approved` — versioned artifacts are stored as `<id>.v<N>.json` with a `<id>.latest.json` pointer.

Locators are the part I went deepest on, because. A step's `target` is a small ordered list
of independent strategies (`role`, `css`, `text`, `tableCell`), tried in order at replay time until
one resolves — not because any single one is unreliable, but because *which one is reliable depends
on what the element actually is*, and that's knowable at record time but not guessable from outside.

## 3. Determinism & error handling

Replay never calls an LLM; every action comes from the artifact, and the only branching is what the
artifact itself declares (checkpoints, business outcomes, interstitials). Determinism here is less
about "the code has no randomness" and more about **getting the locator strategy right**, which
turned out to be the majority of real bugs during development:

- A browser's real *accessible name* computation does **not** use a form control's HTML `name`
  attribute. A legacy `<input name="q">` with no label has an accessible name of `""`, so a
  `role=textbox name="q"` locator silently resolves to nothing. 
  Fix: separate "real accessible name" (aria-label, placeholder, or — for links/buttons/headings — visible text/value) 
  from the raw `name` attribute, and only use the raw attribute for a scoped `[name=...]` CSS fallback,
  never for role or text matching.
- Text-substring matching (`getByText`) is only safe for elements whose visible content *is* their
  name. Used against an unlabeled `<select name="type">`, it matched a `<td>Account Type</td>` label
  cell elsewhere on the page instead. 
  Fix: the `text` strategy is only ever generated when a real accessible name exists.
- Extracting a data cell from a legacy table needed a `tableCell` strategy (find the row containing
  a label cell, take the sibling at a column index) — but the naive version used substring `hasText`
  matching, which under **nested** tables (the norm for this kind of legacy layout) matched an
  *outer* wrapper cell whose full descendant text happened to contain the label too. Fixed by
  anchoring to exact trimmed text and using direct-child XPath axes (`parent::tr`, `./td`) instead
  of Playwright's descendant-based `has:` matching.

All three were caught by actually running the real discovery agent against the real target app and
reading what it did, not by inspection — which is the argument for why the discovery run has to be
real. Beyond locators, replay's per-step result feeds into a three-way contract, checked after every
step (business outcome first — terminal; then interstitial — recoverable, auto-dismissed via the
step declared in the artifact, then re-checked; then the checkpoint for that step, if any). A
step whose *action* can't even be performed (locator resolves to nothing) gets one retry, and — since
the reason may be exactly the kind of thing a person would recognize instantly and a program
wouldn't — is otherwise routed to human escalation rather than immediately failed hard.

Deliberate scope decision: a single discovery run only ever sees the happy path. It cannot
responsibly *guess* every business outcome or interstitial a legacy app can produce from one
transcript — that's institutional knowledge about the app, not something inferable from a
transcript. So discovery records the mechanical flow; known exceptional states are attached at
review time (`artifact/harden.ts`), before an artifact is marked `approved`. This is currently
simulated (applied automatically, keyed by capability id) rather than a real reviewer UI — see
Section 7 — and that simulation already exposed its own fragility: the LLM-chosen capability id
isn't stable across runs of "the same" goal (`open-sub-account` vs. `open-savings-sub-account`
were both produced for near-identical prompts), so id-keyed enrichment is brittle by construction.
A real version would key off something a reviewer assigns, not model output.

## 4. Heterogeneity & multi-tenant

**Surface abstraction.** The seam is exactly `observation/`: `Snapshot`/`ObservedElement` on the
perceive side, `LocatorStrategy` on the act side. Everything above that — the agent's tool
interface, the artifact schema, the replay engine, guardrails, escalation — depends only on those
two shapes, never on Playwright directly. A legacy web app with framesets/iframes needs the
snapshot walker to recurse into frames and the resolver to target the right frame context — more
surface area for the same module, not a new module. A desktop app needs an entirely different
snapshot walker (OS accessibility APIs — UIAutomation on Windows, AXAPI on macOS) producing the
same `ObservedElement` shape, and a resolver whose "locator" is a platform accessibility handle
instead of a Playwright `Locator`. Two additional `LocatorStrategy` variants already point this
direction: `tableCell` targets structural layout the way a screen reader would ("the field next to
this label"), and desktop UIs need the same kind of structural fallback since they have no DOM at
all.

**Multi-tenant reuse.** The schema already forces the right shape for this: literal-vs-parameter
values (Section 2) mean a URL like `/members/12345` is already recorded as
`{ literal: "http://tenant-a.example.com/members" } + { param: "memberId" }` at the navigate/type
level — the "canonicalize `/item/12345` → `/item/:id`" idea from the stretch goals is close to
free here rather than a separate pass. For two tenants running the *same* vendor product,
configured/branded differently, the design I'd build is a **base artifact + per-tenant overrides**: 
the base recording stays as-is; an override file for a given tenant patches specific fields 
(a `LocatorStrategy` whose text differs under different branding, an added/removed interstitial, 
a different base URL) without re-recording the flow. Drift detection is a natural extension of 
`resolveLocator`'s existing attempt log (`ResolveAttempt[]`, already returned on every resolution): 
running the same artifact against many tenant instances and tracking which fallback strategy actually 
won, per tenant, turns into a health signal for free — a strategy that used to resolve via `role` and 
now only resolves via the `css` fallback (or not at all) for one tenant is exactly the 
"per-tenant/version drift" signal to flag for review, without needing new instrumentation.

## 5. Escalation & handoff

"Stuck" is detected three ways: the LLM explicitly calls the `escalate` tool during discovery
(it's told to do this rather than guess); a step's action can't be performed even after one retry
during replay; or a checkpoint fails and its declared `onFail` is `escalate` (the default, and the
only sane default for anything not already known to be transient).

The control-transfer model is a single `EscalationController` per run holding one field —
`controller: "automation" | "human"` — plus a reference to the live `Page`. `escalate()` flips it to
`"human"`, records the intervention request (capability, goal, step index, current URL, a reason,
a screenshot), and suspends the caller on a promise that only resolves when `resume()` is called.
Nothing else can run in the meantime; there is exactly one live session and exactly one thing
allowed to act on it at a time. The operator console (`escalation/server.ts`) is a bare HTML page —
deliberately, per the brief's scope note — but every action it exposes runs against that same
`Page`, and every human action is recorded into the run's evidence log (`human_action` entries),
distinct from the agent's own `action` entries, alongside the pre-escalation state. On resume:
discovery re-observes and continues its normal loop; replay re-attempts the *specific* step or
re-checks the *specific* checkpoint that failed, not the whole flow — the human is fixing a
localized problem (dismiss a dialog, retry a page), not restarting the capability.

The operator console is a plain form (click/type/navigate by
role+name), not a rendered co-browsing view with cursor/DOM diffing — explicitly out of scope.

## 6. Safety

Two independent layers. An **allowlist** (`config/allowlist.json`) restricts both origins and
action *types* — navigating outside the allowed origin, or attempting an action type not in the
list, is rejected before it reaches the page, both during discovery (fed back to the LLM as a tool
error) and replay (a hard failure). Separately, a **risk policy** derived from what an action's
visible text actually says, not from what the LLM claims: `click` doesn't ask the model to
self-report a risk level at all, on the theory that a model motivated to make progress is not a
reliable judge of its own risk. Risk is escalated to `irreversible` only when the element's real
name (or the LLM's stated intent) contains a specific configured phrase (`"confirm and open
account"`, `"delete"`, ...). This needed one real correction during development: an early version
included the bare word `"confirm"` as a hint and false-positived on "Continue to **confirm**ation
screen" — a purely navigational step — which is exactly the failure mode a keyword-based safety
net has to watch for, and the fix (require the literal action phrase, not a fragment of it) is now
covered by a unit test.

An irreversible action requires the agent to call `confirm_intent` with matching text *before* the
click executes; skipping straight to the click is blocked and the model is told why. At replay
time, an artifact containing any step whose derived risk is `irreversible` requires `status:
"approved"` or an explicit `--confirm-irreversible` flag to run unattended — gated on what the
recording actually *does*, not on the capability's self-declared category, so a "reach the
confirmation screen and stop" recording (no irreversible step) isn't penalized for being *about* an
irreversible-sounding capability.

Redaction is pattern-based (SSN/credit-card/email shapes) applied to everything written to a log or
an artifact, plus a full-value redaction for any field whose name matches a configured sensitive
pattern. Typing into a field the policy considers sensitive requires the discovery agent to supply
a `paramName` instead of a literal — the literal value is never stored in the artifact at all, only
a reference to a caller-supplied parameter.

**Limits.** The risk model is a keyword allowlist, not semantic understanding — an action phrased
to avoid every configured hint would slip through undetected; a real system would want this backed
by a human-reviewed classification per action type, not just per phrase. Redaction is a fixed
pattern list, not a general PII/DLP engine. There's no persistent audit store beyond the per-run
JSONL log.

## 7. Cuts

- **Desktop / legacy-frameset support**: designed (Section 4), not implemented — the brief doesn't
  expect it.
- **Multi-tenant override/drift infrastructure**: designed, not built — explicitly out of scope.
- **Review-time enrichment (`harden.ts`) is simulated**, not a real reviewer workflow — it's a
  hardcoded, id-keyed dictionary.
- **Operator console** is a bare form, not a co-browsing view.
- **Assisted LLM fallback on replay failure** given a choice between spending remaining time on that 
  or on making the human-escalation path fully real, I chose the latter.
- **Confidence/approval scoring** beyond the binary `draft`/`approved` gate, and **multi-run
  stability** testing (stretch goals) — not attempted, in favor of depth on the required core.
- Small, honest gap: `open-savings-sub-account`'s discovery run never declared an output (e.g. the
  new account number) — a goal that asked for it explicitly would have produced one; nothing
  prevents it, it just wasn't asked for.

Next, with more time: a real reviewer UI for business-outcome/interstitial enrichment (replacing
`harden.ts`); the base-artifact-plus-overrides mechanism for cross-tenant reuse, with the
drift-detection signal described in Section 4 actually wired up and reported; and bounded, logged
LLM-assisted recovery for a single replay step as an explicit, policy-checked fallback before
escalating to a human.