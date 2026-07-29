# Pi / OMP fork differences and sync workflow

Paseo integrates two "Pi-compatible" agent runtimes as separate direct providers:
**Pi** (`providers/pi/`, the upstream `@earendil-works/pi-coding-agent` CLI, invoked as
`pi --mode rpc`) and **OMP** ("Oh My Pi", `providers/omp/`, invoked as `omp --mode rpc-ui`).
Per [docs/providers.md](providers.md), other Pi-compatible forks can extend either base —
`extends: "omp"` for OMP-derived forks, `extends: "pi"` for anything else that speaks Pi's
wire protocol. This doc tracks where the two built-in forks have actually diverged in
capability and where Paseo's adapters have drifted out of sync with each other, since that
drift is easy to miss: the two provider directories only share the provider-neutral JSONL
child-process transport (`jsonl-rpc-process.ts`), not application logic.

This file exists separately from `providers.md`/`architecture.md` because it is specifically
about **keeping the Pi and OMP adapters honest with each other and with their upstream
binaries**, not about the general "how to add a provider" or "how the daemon is laid out"
material those two files already own.

## What "fork" means here (two distinct meanings — don't conflate them)

1. **Pi vs. OMP as sibling wire-compatible forks.** OMP is a fork of Pi's RPC protocol and
   `models.json` schema, evolving independently. Paseo ships one adapter per binary
   (`providers/pi/`, `providers/omp/`) with separate `rpc-types.ts`, `runtime.ts`, `agent.ts`.
   This is the fork relationship this doc is mainly about.
2. **This checkout's own git remotes.** `origin` is `rohan-patra/paseo` (a personal fork),
   `upstream` is `getpaseo/paseo`. Local branches `swarm/app`, `swarm/manager`, `swarm/pi-core`,
   `swarm/protocol`, `swarm/qa` are per-domain working branches for coordinated agent swarms
   against this fork. There is **no committed automation** in this checkout for syncing
   `origin` from `upstream` (no `sync-upstream` script, no scheduled workflow found under
   `.github/workflows/` or `scripts/`) — merging upstream changes back into this fork today is
   a manual `git fetch upstream && git merge/rebase` exercise. If the plan under review assumes
   an automated upstream-sync step exists, verify that assumption against `.github/workflows/`
   and `scripts/` before relying on it; as of this inspection it does not.

## Divergence: per-model thinking levels

|                             | Pi adapter                                                                | OMP adapter                                                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Static level list           | `PI_THINKING_OPTIONS` (`providers/pi/agent.ts`), 7 levels                 | `OMP_THINKING_OPTIONS` (`providers/omp/map-omp-model.ts`), same 7 levels                                                                                                      |
| Per-model filtering         | **None.** `fetchCatalog` exposes all 7 whenever `model.reasoning` is true | `resolveOmpThinkingConfig` filters to `model.thinking.efforts` / `model.thinking.defaultLevel`, falling back to the full set only for older OMP binaries that don't report it |
| Model type carries the map  | `PiModel` (`providers/pi/rpc-types.ts`) has no thinking-map field         | `OmpModel` carries `thinking.efforts` / `thinking.defaultLevel`                                                                                                               |
| RPC introspection available | Pi RPC has `get_available_thinking_levels`, unused by the adapter         | n/a (OMP filters from the catalog response instead)                                                                                                                           |

This is a real, currently-shipped asymmetry, not a hypothetical: OMP already does the
capability-aware thing Pi's own upstream RPC surface supports (`get_available_thinking_levels`,
plus `getSupportedThinkingLevels`/`clampThinkingLevel` in `agent-session.js` and
`@earendil-works/pi-ai`'s `models.js`), and Pi's Paseo adapter simply doesn't call it. See
[docs/providers.md](providers.md#pi-per-model-thinking-levels-are-not-yet-capability-aware) for
the full mechanism (opt-in `xhigh`/`max`, opt-out `null`, and clamp-on-mismatch semantics).

## Divergence: native steer / follow-up

|                              | Pi adapter                                                                                                     | OMP adapter                                                                                                                                           |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime session interface    | `PiRuntimeSession` has no `steer`/`followUp` methods                                                           | `OmpRuntimeSession` has real `steer(message, images?)` / `followUp(message, images?)`                                                                 |
| Surfaced to users            | Not surfaced at all; `startTurn` throws `"A Pi turn is already active"` for any prompt while a turn is running | `/steer` and `/follow-up` slash commands recognized in `tryHandleOutOfBand`, calling the runtime methods directly                                     |
| First-class composer support | No                                                                                                             | No — even OMP's version is slash-command-triggered only; there is no protocol-level queue-mode toggle or surfaced `queue_update` state in Paseo today |

Treat OMP's implementation as the reference shape for adding this to Pi, not as a finished UX
to copy wholesale — it's a partial integration on both forks. See
[docs/providers.md](providers.md#pi-has-no-native-steerfollow-up-wiring-omp-already-does) for the
upstream RPC verbs (`steer`, `follow_up`, `set_steering_mode`, `set_follow_up_mode`,
`queue_update`) and delivery-timing semantics.

## Divergence: abort does not clear queues

Neither adapter's `interrupt()` clears queued steer/follow-up messages, because upstream
`AgentSession.abort()` itself only aborts the active run and does not call
`clearSteeringQueue()`/`clearFollowUpQueue()`/`clearAllQueues()`. This is identical on both
forks (same `pi-agent-core` lineage) and is not currently exercised on OMP either — OMP's
`/steer`/`/follow-up` slash commands are the only place either adapter queues anything today.
See [docs/providers.md](providers.md#the-abort-rpc-does-not-clear-queued-steerfollow-up-messages)
for the concrete implication for interrupt UX once queuing exists on Pi.

## The existing (ad hoc) cross-fork sync mechanism: `COMPAT(...)` comments

The only sync discipline that exists today is a comment convention, not tooling:

```ts
// COMPAT(piGetStateFallback): added in v0.1.105 — older Oh My Pi binaries
// lack the `get_session_stats` RPC command; fall back to extracting
// context window usage from `get_state`. Remove after 2027-01-10 once the
// supported Oh My Pi floor includes `get_session_stats`.
```

Both `providers/pi/cli-runtime.ts` and `providers/omp/cli-runtime.ts` carry a matching
`COMPAT(...GetStateFallback)` block with a version-floor date, and `providers/omp/agent.ts` has
a separate `COMPAT(ompDelayedLocalOnlyResult)` block. This is a real, working pattern —
capability probes fail soft and fall back, with a dated removal marker — but it is **manual and
per-call-site**; there is no automated test that pins "supported Pi/OMP binary floor" or fails
CI when a `Remove after <date>` marker goes stale.

**Bug found while writing this doc, not introduced by it:** the `COMPAT(piGetStateFallback)`
comment inside `providers/pi/cli-runtime.ts` (the _Pi_ adapter) says "older **Oh My Pi**
binaries" / "supported **Oh My Pi** floor" — copy-pasted from the OMP adapter's identical
comment without updating the product name. It doesn't change runtime behavior (the code paths
are independent), but it will actively mislead anyone using this comment to reason about which
binary's version floor is being tracked. Fix the wording (`Pi` not `Oh My Pi`) when this file is
next touched; flagged here rather than fixed directly per this task's docs-only scope.

## Verification checklist for a plan touching Pi/OMP thinking levels, steer/follow-up, or abort

Use the debugging playbook in `CLAUDE.md` (direct wire probe + `/verify` boundary check) for all
of these; do not rely on unit tests alone to claim done.

- [ ] **Thinking levels are capability-aware, not just clamped.** For a model whose
      `thinkingLevelMap` excludes `xhigh`/`max` (or maps a level to `null`), confirm the Paseo
      model picker does not offer that level at all — not "offers it, then Pi clamps it
      silently." Verify by probing Pi RPC directly: `get_available_models` then
      `get_available_thinking_levels` for that model, and diff against what
      `fetchCatalog`/`PI_THINKING_OPTIONS` currently returns.
- [ ] **Selecting a since-removed/unsupported level surfaces a notice.** If a session's cached
      `thinkingOptionId` is no longer in the model's supported set (e.g. after `setModel`
      switches to a model with a smaller map), confirm `setThinkingOption`/model switch returns
      an `AgentProviderNotice` instead of silently reporting the old id as still selected.
- [ ] **Steer delivery timing matches the documented contract.** A `steer()` message must land
      after the current assistant turn's tool calls finish but before the next LLM call — not
      immediately, and not only after the whole turn ends. Confirm with a raw RPC probe sending
      `steer` mid-tool-call and inspecting event ordering, not just that the message eventually
      appears in history.
- [ ] **Follow-up delivery timing matches the documented contract.** A `follow_up()` message
      must be delivered only when the agent has no more tool calls or steering messages queued
      (i.e., it would otherwise stop). Confirm a follow-up does not preempt an in-flight steer.
- [ ] **Interrupt + queued messages is an explicit product decision, not an accident.** With a
      steer or follow-up message queued, call `interrupt()`/`abort` and confirm the observed
      behavior (message discarded vs. replayed on the next prompt) matches what the plan
      documents — do not accept "whatever the upstream default does" as the answer without
      writing it down, since upstream's default is to _not_ clear the queue.
- [ ] **`agent_settled` semantics stay centralized.** If the plan adds any provider-side
      tracking of whether a Pi/OMP turn has "settled" (for steer/follow-up completion, or for
      abort acknowledgment), confirm it feeds `AgentRunState` (`agent-run-state.ts`) rather than
      introducing a second settlement signal inside `providers/pi/agent.ts` or
      `providers/omp/agent.ts`. `AgentManager`'s cancellation result
      (`AgentRunCancellationResult`) must stay the single source of truth for callers like
      reload/replace/rewind/stop.
- [ ] **Both forks reviewed together, not just the one the plan targets.** Any change to Pi's
      thinking-level or steer/follow-up handling should be diffed against OMP's existing
      implementation of the same feature (`map-omp-model.ts`, `omp/agent.ts`
      `tryHandleOutOfBand`) so the two adapters don't drift further apart with two different
      answers to the same question.
- [ ] **Verify at the public boundary**, per `CLAUDE.md`: run the daemon, drive a real `pi`
      (and, if touched, `omp`) binary end-to-end, and inspect the actual `agent_stream` /
      timeline events the client receives — not just that `providers/pi/agent.test.ts` passes
      against a fake runtime.
- [ ] **Re-check the `COMPAT(...)` floor dates** touched by the change; if a plan bumps a
      minimum Pi/OMP version, update the corresponding `Remove after <date>` marker and comment
      text (and fix the pre-existing `Pi`/`"Oh My Pi"` mislabel in
      `providers/pi/cli-runtime.ts` while in the area).
