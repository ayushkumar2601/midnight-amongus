# Shadow Protocol — Midnight Integration

A zero-knowledge **cryptographic fairness / anti-cheat layer** retrofitted onto
this Among-Us-style LAN game for the MLH Midnight hackathon (Gaming track),
with **zero changes to the game's UI or gameplay**.

## The pitch

The base repo's multiplayer dealer is literally rigged: **the impostor is the
player with the highest `player_id`** (it was in `game.py`, and it's deleted
now). Every centralized game has this problem — you just can't usually read
the source. Shadow Protocol binds the role deal, every kill, every vote, and
every ejection to zero-knowledge commitments on the Midnight network. The game
still runs in real time; it just **can no longer lie about it**. At game over,
an on-chain audit reveal lets anyone verify the entire match.

**Claim discipline:** the server can no longer *forge or rewrite* anything.
We do **not** claim it cannot *see* secrets (v1 limitation — see Trust model).

## Architecture

```
┌────────────────┐  pickle over TCP :4321   ┌───────────────────────┐
│ pygame clients │◄────────────────────────►│  server.py (relay)     │
│ (unchanged UI, │                          └───────────────────────┘
│  Py 3.11)      │
└──────┬─────────┘
       │ HTTP JSON, localhost :5310  (fire-and-forget from midnight_hooks.py)
       ▼
┌────────────────────────────────┐
│ midnight-bridge  (Node 20, TS) │
│  • seat map, roles, salts (RAM)│
│  • tx queue (serialized+retry) │──► proof server (Docker :6300)
│  • ZK proof generation         │
│  • contract client             │──► Midnight testnet (ShadowLedger contract)
│  • audit dashboard  /audit     │
└────────────────────────────────┘
```

Note: in this repo `server.py` is a dumb pickle relay — game logic is
client-authoritative. The hooks therefore fire from the **acting client**
(killer posts the kill, voter posts the vote, the ejected player's client
posts the ejection), and the bridge deduplicates across clients
(same-lobby `/deal` calls coalesce; duplicate `/eject`/`/vote`/`/gameover`
posts get 4xx and are dropped).

## Trust model (v1)

| Threat | Base repo | Shadow Protocol v1 | Mechanism |
|---|---|---|---|
| Rigged role assignment | Rigged by design (highest player_id) | Impossible | Deterministic Fisher–Yates from on-chain committed `gameSeed`, audited at game end |
| Fake kill by a non-saboteur | Undetectable | Impossible | `recordKill` circuit requires ZK proof killer's committed role = SABOTEUR |
| Vote stuffing / double voting | Undetectable | Impossible | Per-meeting ZK nullifiers in contract state |
| Lying about an ejected player's role | Undetectable | Impossible | Ejection must open the day-one commitment |
| Rewriting match history | Trivial | Impossible | Append-only chain record + full audit reveal |
| Server/bridge reading secrets | Yes | **Still yes — documented v1 limitation** | Roadmap: browser clients holding own private state + Lace wallets |

## Quickstart

### 1. Bridge (works out of the box in mock mode)

```bash
cd midnight-bridge
npm install
npm run dev          # boots on http://127.0.0.1:5310 (MN_MODE=mock)
```

Open the audit dashboard: **http://127.0.0.1:5310/audit**

`MN_MODE=mock` runs an in-process simulated ledger that enforces the **same
circuit checks** as the Compact contract (commitment openings, nullifiers,
phase guards) — the full game + dashboard work with no chain. Flip to the real
testnet when the toolchain is ready (below).

### 2. Game (Python 3.11 — asyncore was removed in 3.12)

```bash
python3.11 -m venv .venv
.venv\Scripts\activate            # Windows
pip install -r requirements.txt
python server.py                  # LAN relay on :4321
python main.py                    # one per player; choose 'Local'
```

The deal fires automatically when the lobby reaches `SHADOW_PLAYERS` players
(default 5 = spec-locked: 1 Saboteur + 4 Agents). For dev with fewer windows:

```bash
# both sides must agree
set SHADOW_PLAYERS=2              # Python clients
# and in midnight-bridge/.env: MN_REQUIRED_PLAYERS=2
```

Until the deal is anchored on-chain, **nobody is the saboteur** — the match
cannot start unanchored. If the bridge is down, the game plays roleless and
logs `fairness layer unreachable`; no silent fallback to the old dealer.

### 3. Real Midnight testnet (Phase 2 — VERIFY-AGAINST-DOCS)

```bash
# Compact toolchain (see docs.midnight.network for current installer)
curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/midnightntwrk/compact/releases/latest/download/compact-installer.sh | sh
compact update && compact compile --version   # pin version into the contract pragma

# proof server
docker compose -f proof-server-local.yml up -d

# compile contract + bindings
cd midnight-bridge && npm run build:chain
```

Then in `midnight-bridge/.env`: set `MN_MODE=testnet`, fill
`MN_INDEXER_URL` / `MN_INDEXER_WS_URL` / `MN_NODE_URL` from the docs
quickstart, generate a 64-hex `MN_DEPLOYER_SEED`, and fund it with tDUST from
the faucet. **Do this on Day 1 — faucet/latency problems are the #1 Midnight
hackathon killer.**

Two marked `VERIFY-AGAINST-DOCS` sites must be finished against the current
`midnightntwrk/example-bboard` once the generated bindings exist:

- `src/providers.ts` → `buildWallet()` (wallet-sdk 1.0.0 facade wiring)
- `src/contractClient.ts` → `RealChainClient` generated-binding call sites
- `contract/src/shadow_ledger.compact` → align pragma/syntax with your
  installed compiler (checks and effects are binding; identifiers may move)

## What was changed in the game (all marked `# [MIDNIGHT]`)

| Patch | File | What |
|---|---|---|
| P1 Deal | `game.py` | Rigged "highest player_id" dealer **deleted**; roles come only from the bridge `/deal` (seed + commitments on-chain first) |
| P2 Kill | `game.py` | Killer's client posts `/kill` after the existing kill handling |
| P3 Vote | `game.py` | Voter's client posts `/vote` once per meeting (colour → player_id) |
| P4 Eject | `game.py` | Ejected client posts `/eject`; meeting close posts the no-ejection case; bridge dedupes by round |
| P5 Game over | `game.py` | Each win branch posts `/gameover` (tasks / ejection / kills / sabotage) |
| — | `server.py` | `pyasyncore` import shim for Python 3.12+ only |
| — | `midnight_hooks.py` | **The only new Python file**: fire-and-forget queue worker, 5 s timeouts, capped backoff, never raises into the pygame loop |

No pickle payload shapes, sprites, screens, sounds, or menus were touched.

## HTTP API summary (bridge, localhost :5310)

| Route | Behaviour |
|---|---|
| `GET /health` | liveness + deps + queue depth + session state |
| `POST /deal` | **synchronous**; anchors seed+commitments on-chain, then returns `seatMap` + `saboteurPlayerId` (201). Same-lobby repeats return the cached result |
| `POST /kill` | 202 enqueue; 409 `NOT_SABOTEUR` / `DEAD_*`, 404 unknown, 422 self-kill |
| `POST /vote` | 202; first vote of a round auto-opens the meeting; 409 `DUPLICATE` |
| `POST /eject` | 202 (`ejectedId: null` = no ejection); 422 stale round |
| `POST /gameover` | 202; queues `declareWinner` + 5 × `auditReveal`, writes `audit_log.json` |
| `POST /reset` | dev only; clears RAM session |
| `GET /events` | SSE stream of audit events (dashboard feed) |
| `GET /audit` | judge-facing dashboard |
| `GET /audit/data` | verification payload; `reveals: []` until OVER — no role/salt ever leaks early |

## Tests

```bash
cd midnight-bridge && npm test     # 14 passing: B1–B8 + C-series analogues
```

Covers: deal determinism with `DEMO_FIXED_SEED` (B1), FIFO queue (B2),
belt+suspenders non-saboteur kill rejection (B4/C2), vote nullifier dedupe
(B5/C5) and next-meeting re-vote (C6), bad deal payloads (B6), wrong-state
calls (B7), no secret leakage before OVER (B8), saboteur-ejected winner
consistency (C9), and 5/5 audit reveal verification.

## Versions

`@midnight-ntwrk/*` midnight-js packages pinned to **4.1.1**,
`@midnight-ntwrk/wallet-sdk` **1.0.0** (matching example-bboard as of
2026-07-17). Node 20+, TypeScript 5.9, Python **3.11** (3.12+ needs the
bundled `pyasyncore` shim).

## Known limitations (v1, documented)

- **Bridge custody:** the bridge holds all salts, so it can generate any
  seat's proofs; the chain still prevents anything inconsistent with the
  day-one commitments (an AGENT seat can never produce a valid kill).
- **Pickle over LAN** is inherited from the base repo — trusted-LAN demo only.
  The base game also syncs the `imposter` flag in its 26-field payload to all
  clients; that is a base-game flaw, disclosed here, out of scope to fix.
- **Task-completion wins** are attested by the game (the contract cannot see
  tasks); the contract still enforces saboteur-ejected ⇒ agents win.
- **Bridge crash mid-match:** pending events are lost (RAM state);
  `audit_log.json` has everything up to the last write.

## Roadmap

Web client with player-held salts + Lace wallets · mental-poker trustless
dealing · per-seat wallets.

## Credit

Engine derived from [AI0702/Among-Us-clone](https://github.com/AI0702/Among-Us-clone)
(Unlicense). All Midnight integration built during the hackathon.
