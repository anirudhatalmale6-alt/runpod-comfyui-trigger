# revenueGateRouter → RunPod Serverless (ComfyUI)

> ## ⚠️ Do not deploy a clone of this repository
>
> This is a **source package, not a deployable Trigger.dev project**. It has no
> `trigger.config.ts` at its root, no `tsconfig.json`, and `@trigger.dev/sdk` is
> not a dependency here. Running `npx trigger.dev deploy` inside a clone fails
> with *"Couldn't find your trigger.config.ts file"* — the same error we spent
> the last milestone diagnosing, for a completely unrelated reason.
>
> The two source files belong in **your** repo, next to your existing tasks:
>
> ```bash
> git clone https://github.com/anirudhatalmale6-alt/runpod-comfyui-trigger
> cd runpod-comfyui-trigger
> bash install.sh /path/to/your/repo
> ```
>
> Then deploy from **your** repo root, not from this one.

Asynchronous submit-and-poll integration against the RunPod Serverless API v2,
built to the spec in the brief. Written, compiled and tested; **not deployed** —
see "What I cannot do" below before reading anything else here as finished.

## Files

| file | what it is |
| --- | --- |
| `src/utils/runpodClient.ts` | RunPod v2 client + polling loop. No Trigger.dev import, so it is testable standalone. |
| `src/utils/envReport.ts` | Environment-variable inspection. Presence, length and shape — never values. |
| `src/trigger/revenueGateRouter.ts` | The task. Supplies `wait.for` to the poller and resolves terminal states. |
| `src/trigger/configDoctor.ts` | Zero-cost diagnostic task. Reports what the runtime can see, no GPU job. |
| `test/mockRunpod.ts` | A mock RunPod endpoint: enforces the Bearer token and the `input` wrapper, walks jobs IN_QUEUE → IN_PROGRESS → terminal, and can inject 401s / 500s / malformed bodies. |
| `test/runpod.test.ts`, `test/envReport.test.ts` | 39 tests, all passing. |
| `config/trigger.config.ts` | Updated config — see the `maxDuration` note. |
| `config/package.scripts.json` | The `scripts` block to merge, because yours has none. |
| `.env.example` | Placeholders only. |

## Verified

```
npm test                            39 passed, 0 failed
tsc --noEmit                        clean, inside your real tsconfig
esbuild (CLI's own build options)   BUILD OK, warnings: none
                                    src/utils/runpodClient.ts bundled via the
                                    @/utils/ alias
preflight.sh                        all checks pass
```

The esbuild line matters: `runpodClient.ts` appears in the bundled inputs, which
is the proof the `@/utils/runpodClient` alias resolved rather than being left as
an unresolved external.

## Against your spec

**Phase 1.** Placeholders in files, real values from Trigger.dev environment
variables, `RUNPOD_API_KEY` as a Bearer header, `RUNPOD_ENDPOINT_ID` as the
target. Done. Missing variables raise `AbortTaskRunError` so the run stops with
a readable message instead of burning three retries on a config mistake.

**Phase 2.** `POST /v2/{id}/run` with the payload wrapped in a root-level
`input` object; job id extracted from the 200; polling via
`GET /v2/{id}/status/{job_id}`; every gap between polls is `wait.for({ seconds })`.
No `while` loop and no `setTimeout` — the run checkpoints and suspends.

**Phase 3.** `npm run build` and the deploy are yours to run; see below.

### Three places I did not follow the spec exactly

**1. Terminal states.** The spec says loop "until the status maps strictly to
COMPLETED or FAILED". RunPod also returns **CANCELLED** and **TIMED_OUT**. A
loop that only breaks on COMPLETED/FAILED keeps polling an already-dead job
until your own deadline kills it — you would pay for the wait and get a timeout
error instead of the real reason. All four are terminal here, and there are
tests for the two you did not list.

**2. Polling intervals.** The spec says "regular intervals". The default is
`[5, 5, 10, 10, 15]` seconds with the last value repeating. Since renders exceed
30 seconds and cold starts are longer, a fixed tight interval spends
checkpoints to learn nothing. Pass `intervals` to override if you want it flat.

**3. A deadline, which the spec has none of.** Without one, a job stuck
`IN_QUEUE` polls until `maxDuration` kills the task — and the GPU job keeps
running and billing after you have stopped listening. Default 600s, and on
expiry the RunPod job is **cancelled** before the error is raised. Tested,
including that a failed cancel does not mask the real error.

## The `maxDuration` conflict — read this

Your config currently has `maxDuration: 300`. The polling deadline defaults to
**600**. Those numbers are the wrong way round: the task can be killed mid-poll,
losing a job that was about to complete.

`config/trigger.config.ts` raises `maxDuration` to 3600. Keep this invariant:

> `maxDuration` must comfortably exceed the `deadlineSeconds` given to the task.

**Open question I could not settle from the installed packages:** whether time
spent inside `wait.for` counts toward `maxDuration`, or whether `maxDuration` is
compute time only and suspended waits are excluded. The config above is safe
either way, which is why I set it rather than waiting for the answer — but if
you know, tell me and I will tune it properly instead of over-provisioning.

## Installing

```bash
cp src/utils/runpodClient.ts        "$REPO/src/utils/"
cp src/trigger/revenueGateRouter.ts "$REPO/src/trigger/"
cp .env.example                     "$REPO/.env.example"
# merge config/package.scripts.json into your package.json
# replace proj_YOUR_PROJECT_REF in config/trigger.config.ts, then copy it over
```

Then set `RUNPOD_API_KEY` and `RUNPOD_ENDPOINT_ID` in Trigger.dev under
Project Settings → Environment Variables for the Production environment, and:

```bash
npm run build
bash scripts/preflight.sh
npx trigger.dev@3.3.17 deploy --config="./trigger.config.ts" --skip-update-check
```

## What I cannot do

Stated plainly, because your escrow gate depends on it.

- **I cannot log into your Trigger.dev dashboard**, so I cannot take the
  screenshot of a green run history that the payment gate requires. I have no
  dashboard access of any kind and never will.
- **I cannot log into the RunPod console**, so Phase 1 step 1 — visually
  confirming the worker endpoint is online — is not something I can do.
- **I cannot fire the test invocation** from the Trigger.dev test console.
- **I cannot run the deploy**: it needs your access token, and you chose to keep
  tokens offline. That arrangement was right and I am not asking you to change
  it.

So everything in Phase 3 and the acceptance screenshot are yours to run. What I
can do is make sure that when you run them, they work — which is what the mock
server and the 27 tests are for. If any of them fails, paste the output and I
will fix it.

## What is not tested

- **Never called against the real RunPod API.** Every test runs against
  `test/mockRunpod.ts`. The mock implements the documented contract, so if RunPod
  deviates from its own docs the tests will not catch it.
- **No real ComfyUI prompt graph has been through this.** The prompt is passed
  through opaquely by design, but that means a malformed graph fails at the
  worker, not here.
- **Cold-start behaviour is simulated**, not observed.
- **`wait.for` has never actually executed** — tests inject a stub so they run
  instantly. The call signature is verified against the installed SDK 3.3.17
  (`wait.for({ seconds })`), and it typechecks, but its runtime behaviour under
  Trigger.dev is unproven until you deploy.


## configDoctor — run this when a run fails on configuration

Trigger `config-doctor` from the test console. It submits no RunPod job and
spends no GPU time. It answers the three things behind nearly every "but I did
set it":

1. **Which environment did this actually run in?** Trigger.dev environment
   variables are scoped per environment — a value set in Development is simply
   not present in Production. Every message names the environment.
2. **Is the variable there at all?**
3. **Is it there but empty, or padded with whitespace from a paste?** A trailing
   newline on an API key goes into the `Authorization` header verbatim and gets
   rejected, which looks like a bad key rather than a bad paste.

It never logs a value — only name, presence and character count. The length is
usually enough to spot a truncated paste on its own, and there is a test
asserting no value can leak into the log projection.

`revenueGateRouter` now names the environment in its own abort message too, and
lists which required variables *are* set, so a half-configured environment is
obvious from the failure alone.
