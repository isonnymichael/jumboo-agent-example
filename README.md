# jumboo-agent-example

A reference **autonomous agent backend** for the [Jumboo](https://jumboo.xyz)
protocol. It automates the whole "solve a task and get paid" loop behind a
single `POST /solve`:

1. **clone** the task's GitHub repo
2. **solve** the linked issue (pluggable AI driver)
3. **commit + push** as the agent's machine user
4. **open a pull request** carrying the Jumboo marker block
5. **poll the oracle** for the attestation (signed after a human merges the PR)
6. **submit it on-chain** (`JumbooValidationRegistry.submitValidation`) to
   release the escrow

It also enforces a simple **x402 payment gate** on the Hire flow: the agent's
operator can trigger it for free, the task creator can hire it via an HTTP 402
payment handshake, and everyone else is refused.

The protocol-critical parts (signing the marker, polling the oracle, claiming
the escrow) use the published **[`@jumboo/agent-sdk`](https://www.npmjs.com/package/@jumboo/agent-sdk)**.
This repo is the reference output of the scaffold —
`npm create @jumboo/agent my-agent` generates a project just like it.

> This is example/reference code meant to be easy to read and adapt. It is not
> hardened for production — see the marked TODOs (especially the x402 payment
> check in `src/auth.js`).

## Architecture

```
                     POST /solve { taskId }
Caller wallet ──────────────────────────────────► ┌──────────────────────────────┐
  X-Jumboo-Address / X-Jumboo-Signature           │  jumboo-agent-example        │
  (EIP-191 over "jumboo-solve:<taskId>")          │                              │
                                                  │  auth.js   who is calling?   │
        operator  ── free (Compete) ────────────► │   ├─ operator → free         │
        creator   ── 402 → X-PAYMENT (Hire) ────► │   ├─ creator  → x402 gate    │
        others    ── 403 ──────────────────────X  │   └─ others   → refused      │
                                                  │                              │
   ┌── chain.js reads ────────────────────────────┤  job.js    async pipeline    │
   │  tasks(taskId)            [TaskRegistry]      │   1 clone repo (git)         │
   │  getAgent(AGENT_ID)       [IdentityRegistry]  │   2 branch jumboo/task-…     │
   │                                              │    3 solver.js drivers:       │
   │                                              │    echo|claude|codex|opencode │
   │   GitHub ◄── github.js ──────────────────────┤   4 commit + push (fork      │
   │    issue fetch, fork, PR w/ marker block     │       fallback)              │
   │                                              │    5 sign taskId (hot wallet) │
   │   Oracle ◄── GET /attestations/:task/:agent ─┤   6 open PR + markers         │
   │    (signs EIP-712 after a HUMAN merges)      │    7 poll oracle → claim      │
   │                                              │                              │
   └── chain.js writes ───────────────────────────┤  submitValidation(...)       │
      [ValidationRegistry] → escrow → operator     └──────────────────────────────┘
```

The PR body carries the exact marker block the Jumboo oracle verifies:

```
Jumboo-Task: 0x<32-byte taskId>
Jumboo-Agent: <agentId>
Jumboo-Signature: 0x<EIP-191 signature of the RAW taskId bytes, by the agent's hot wallet>
```

## Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Master fingerprint, solver driver, job count |
| `POST` | `/solve` | Body `{ "taskId": "0x<64 hex>", "agentId": <n> }` + auth headers → `202 { jobId }` |
| `GET` | `/jobs/:id` | Job status JSON (`queued → cloning → solving → pushing → opening-pr → awaiting-merge → claiming → done \| failed:<step>`) |

## Setup

```bash
npm install
cp .env.example .env
npm start               # boots right away — GET /health works
```

Out of the box the server boots with no registration, so you can see `/health`
immediately. A fresh **master mnemonic** is all it needs — every agent you
register derives from it. To compete for real:

1. **Register your agent(s)** at [jumboo.xyz](https://jumboo.xyz) → **Create
   Agent**. Each agent's hot wallet is HD-derived from your `AGENT_MASTER_MNEMONIC`
   (the frontend derives the address to register). This one backend serves **all**
   of them — nothing to paste per agent. The frontend's Compete/Hire buttons call
   `/solve` with the chosen `agentId`.
2. Pick a solver in `.env` (`SOLVER=opencode` by default; also `claude` / `codex`
   / `antigravity` — the tool must be installed on the host).
3. Fund the claim-gas wallet (`AGENT_TX_KEY`, or each agent's own derived wallet),
   set `DRY_RUN=0`, then `npm start`.

## Environment

Copy `.env.example` to `.env` and fill it in. All variables:

| Var | Default | Description |
|---|---|---|
| `PORT` | `8917` | HTTP port |
| `RPC_URL` | — | Ethereum JSON-RPC endpoint |
| `AGENT_MASTER_MNEMONIC` | — | HD master phrase — every agent's hot wallet derives from it (register more agents, no config change) |
| `AGENT_TX_KEY` | derived | Optional funded wallet paying claim gas for all agents; else each agent's own derived wallet pays |
| `GITHUB_TOKEN` | empty | Machine-user PAT (clone auth, issue fetch, fork, PR) |
| `GITHUB_USERNAME` | `jumboo-agent` | Machine-user login (commit author, fork owner) |
| `ORACLE_URL` | — | Jumboo oracle base URL |
| `TASK_REGISTRY_ADDRESS` | — | JumbooTaskRegistry address |
| `IDENTITY_REGISTRY_ADDRESS` | — | JumbooIdentityRegistry address |
| `VALIDATION_REGISTRY_ADDRESS` | — | JumbooValidationRegistry address |
| `WORKDIR` | `./workspace` | Clone directory (one subdir per job) |
| `SOLVER` | `opencode` | Solver: `echo` / `claude` / `codex` / `opencode` / `antigravity` / `custom` |
| `SOLVER_COMMAND` / `SOLVER_ARGS` / `SOLVER_PROMPT_VIA` | preset | Optional overrides for the chosen CLI agent |
| `HIRE_PRICE_AMOUNT` | `0.50` | Authoritative x402 hire price (amount) |
| `HIRE_PRICE_ASSET` | `USDC` | x402 asset |
| `HIRE_PRICE_NETWORK` | `sepolia` | x402 network |
| `DRY_RUN` | `1` | `1` = skip PR creation + attestation polling; log markers |
| `ATTESTATION_POLL_SEC` | `60` | Oracle polling interval |

## Solver drivers (`src/solver.js`)

`SOLVER` picks who fixes the issue:

- **`opencode`** (default here), **`claude`**, **`codex`**, **`antigravity`** —
  spawn that AI coding-agent CLI headless in the cloned repo. Each preset runs
  the tool **fully autonomously** (its "skip permissions" flag, e.g.
  `opencode run --auto`, `claude -p --dangerously-skip-permissions`). The tool
  must be installed + logged in on the host. Flags are overridable via
  `SOLVER_ARGS` / `SOLVER_COMMAND` / `SOLVER_PROMPT_VIA`.
- **`echo`** — no AI. Writes `SOLUTION.md`; for testing the pipeline (used by
  the DRY_RUN walkthrough below).
- **`custom`** — write your own: implement `solve()` in `src/solver.js`.

The marker signing, oracle polling, and on-chain claim are handled by
`@jumboo/agent-sdk` (`buildMarker`, `claim`), so the driver only has to edit
files in the repo.

## Access policy — who may call `/solve`

Every call must carry caller-auth headers (`X-Jumboo-Address`,
`X-Jumboo-Signature` — an EIP-191 `personal_sign` over the exact string
`jumboo-solve:<taskId>`). Then:

| Caller | Result |
|---|---|
| **Agent operator** (`getAgent(agentId).operatorWallet`) | **Free** — the Compete path |
| **Task creator** (`tasks(taskId).creator`) | **HTTP 402** — the Hire path; pay the quoted fee, retry with `X-PAYMENT` |
| **Anyone else** | **403** — third parties cannot burn the operator's compute |

Also rejected: unknown task (404), task not open (409), agent inactive (409),
bad signature (401).

> ⚠️ The demo `X-PAYMENT` check only verifies the caller echoed the quoted
> terms. Production must verify actual settlement through an x402 facilitator —
> see the loud TODO in `src/auth.js`.

## Usage examples

The examples assume a local test stack (a hardhat node + the Jumboo oracle) and
agent #1, whose operator is the well-known hardhat account
`0x70997970C51812dc3A010C7d01b50e0d17dc79C8`.

### 1. Operator Compete (free)

Produce the caller signature with the **operator** key (use the helper
`node test/sign-solve.js <taskId> <key>`), then call `/solve`:

```bash
curl -X POST http://localhost:8917/solve \
  -H "Content-Type: application/json" \
  -H "X-Jumboo-Address: 0x70997970C51812dc3A010C7d01b50e0d17dc79C8" \
  -H "X-Jumboo-Signature: 0x<signature>" \
  -d '{"taskId":"0x<taskId>","agentId":1}'
# → 202 {"jobId":"...","status":"queued"}

curl http://localhost:8917/jobs/<jobId>   # watch the pipeline progress
```

### 2. Creator Hire via x402

The **task creator** signs the same message with their own key, then calls
`/solve` **without** `X-PAYMENT`:

```bash
curl -X POST http://localhost:8917/solve \
  -H "Content-Type: application/json" \
  -H "X-Jumboo-Address: 0x<creator>" \
  -H "X-Jumboo-Signature: 0x<creatorSignature>" \
  -d '{"taskId":"0x<taskId>","agentId":1}'
```

Response — **HTTP 402 Payment Required** with the authoritative terms:

```json
{
  "error": "Payment required: no X-PAYMENT header",
  "x402Version": 1,
  "accepts": [
    {
      "scheme": "exact",
      "network": "sepolia",
      "asset": "USDC",
      "amount": "0.50",
      "payTo": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      "resource": "/solve",
      "description": "Hire agent #1 to attempt task 0x<taskId>"
    }
  ]
}
```

Pay, then retry with `X-PAYMENT` = base64 of the accepted terms:

```bash
X_PAYMENT=$(printf '{"scheme":"exact","asset":"USDC","amount":"0.50","payTo":"0x70997970C51812dc3A010C7d01b50e0d17dc79C8"}' | base64 -w0)

curl -X POST http://localhost:8917/solve \
  -H "Content-Type: application/json" \
  -H "X-Jumboo-Address: 0x<creator>" \
  -H "X-Jumboo-Signature: 0x<creatorSignature>" \
  -H "X-PAYMENT: $X_PAYMENT" \
  -d '{"taskId":"0x<taskId>","agentId":1}'
# → 202 {"jobId":"...","status":"queued"}
```

## Local testing with DRY_RUN

`DRY_RUN=1` runs the real pipeline (clone → solve → commit → push) against any
git remote — including a local `file://` bare repo — but skips PR creation and
attestation polling, logging the marker block instead. Combined with
`SOLVER=echo` you can exercise everything without GitHub or an AI:

```bash
# one-time: a local bare repo to act as "GitHub"
git init --bare test-remote.git
# seed it with one commit (clone to a temp dir, add a README, commit, push)

# create a task on the local chain pointing at it (prints the taskId)
node test/create-task.js

npm start   # .env: SOLVER=echo, DRY_RUN=1
```

Then run the Compete/Hire curl examples above. Verify the pushed branch with
`git --git-dir=test-remote.git branch` and inspect `GET /jobs/:id` — a finished
dry-run job has `dryRun: true`, the pushed `branch`, and the `markerBlock` the
PR would have carried.

## Project layout

```
src/
  index.js    Express app: /health, /solve, /jobs/:id
  config.js   loads + validates .env
  auth.js     caller signature check + Compete/Hire (x402) access gate
  chain.js    read tasks & agent identity (claim is done via @jumboo/agent-sdk)
  github.js   minimal GitHub REST helpers (issue, fork, PR) + repo-URL parsing
  job.js      the clone → solve → push → PR → poll → claim pipeline (uses the SDK)
  solver.js   pluggable drivers: echo, claude, codex, opencode, antigravity, custom
test/
  sign-solve.js   produce the /solve caller-auth headers from a private key
  create-task.js  create a local test task and print its taskId
```
