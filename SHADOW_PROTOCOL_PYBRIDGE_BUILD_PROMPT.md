# SHADOW PROTOCOL (Python Bridge Edition) — Master AI Build Prompt
## Retrofitting Midnight's cryptographic fairness onto the AI0702/Among-Us-clone

> **How to use this file:** Clone `https://github.com/AI0702/Among-Us-clone`, drop this file in the repo root, open in VS Code, and tell your AI agent (Claude Code / Cursor):
> *"Read SHADOW_PROTOCOL_PYBRIDGE_BUILD_PROMPT.md in full. It is your PRD and task list. Follow the LOCKED SCOPE. Work through phases in order; pass each phase's acceptance tests before continuing."*
>
> **Build window:** July 17–19 (~72h). This file supersedes the web-native plan — you are keeping the pygame game as the client and adding a **TypeScript Midnight bridge** beside it.

---

## 0. THE PITCH (this is your story — it's stronger than you think)

Open the demo video with this, verbatim if you like:

> *"This open-source Among Us clone has a rigged dealer: in multiplayer, the impostor is just the player with the highest player ID — predictable, riggable, invisible to players. Every centralized social-deduction game has this problem; you just can't usually read the source. Shadow Protocol retrofits Midnight onto a classic game server so the deal, every kill, every vote, and every ejection is bound to zero-knowledge commitments on-chain. The server still runs the game — it just can no longer lie about it. At game over, anyone can audit the whole match."*

**Positioning:** this is a **cryptographic fairness / anti-cheat audit layer for existing games**, demonstrated on a real game. That's an original angle for the Gaming track (most entries will be built-from-scratch toys) and it honestly matches what the architecture delivers. Do NOT claim the server can't *see* secrets (it can — it's a pygame server); claim it can't *forge or rewrite* them.

### Honest trust model (put this table in the README)
| Threat | Without Shadow Protocol | With Shadow Protocol |
|---|---|---|
| Rigged role assignment | Silent (highest player_id!) | Impossible — roles forced by committed on-chain `gameSeed`, audited at game end |
| Server fakes a kill by a non-impostor | Silent | Impossible — kill records require ZK proof the killer's committed role = IMPOSTOR |
| Vote stuffing / double votes | Silent | Impossible — per-round ZK nullifiers on-chain |
| Server rewrites match history | Silent | Impossible — append-only chain record, endgame audit reveal |
| Server *reads* roles/positions | Yes | Still yes (v1 — documented; full-privacy web client is roadmap) |

---

## 1. WHAT THE BASE REPO GIVES YOU (verified by code reading)

- **Stack:** Python + pygame + pytmx; LAN multiplayer via TCP sockets on **port 4321**, `asyncore.dispatcher`, **pickle**-serialized state arrays (26-element per-player payloads), `BUFFERSIZE 8192`. Server keeps `minionmap` (player_id → `Minion`) and broadcasts world state.
- **Roles:** `Minion.imposter` bool; **multiplayer assignment = highest `player_id` becomes impostor** (your motivating bug); freeplay sets `self.player.imposter = True` in `runfreeplay()`.
- **Kills:** in `Game.update()` — collision + `K_RETURN`, cooldown `(self.killcooldown - self.killcooldown_start) > 15000`, sets `self.player.victim_id = hit.player_id` / `bot.alive_status = False`.
- **Meetings/voting:** emergency button + body report (`emerg_meeting_report_status`), checkbox votes, `self.player.voted`, `self.player.got_votes`, ejection at `got_votes >= 2` → `alive_status = False`, eject screen.
- **Win checks:** tasks done (`missions_done == 8`), impostor ejected, all crew dead, reactor-sabotage timer.
- **License:** Unlicense — free to use/modify. **Disclose the base repo prominently anyway** (README + video: "game engine derived from AI0702/Among-Us-clone (Unlicense); all Midnight integration built during the hackathon"). Check your event's starter-code rules TODAY — most allow disclosed pre-existing open source, judged only on new work.

### ⚠️ Two landmines in the base repo — fix in Phase 0
1. **`asyncore` was removed in Python 3.12.** Run everything in a **Python 3.11 venv**, or `pip install pyasyncore` shim. Decide in Phase 0, not when the server mysteriously won't import on Day 2.
2. **Innersloth IP:** rename the game everywhere to *Shadow Protocol*, replace/recolor the most recognizable assets (title screen, crewmate sprites at minimum — even a palette/hue shift script over the sprite sheets counts), and never say "Among Us" in the submission except when crediting the base repo. Roles are **Agent / Saboteur** in all UI text.

---

## 2. ARCHITECTURE

```
┌────────────────┐  pickle/TCP :4321   ┌──────────────────┐
│ pygame clients │◄───────────────────►│  server.py        │
│ (reskinned)    │                     │  (game authority) │
└────────────────┘                     └────────┬─────────┘
                                                │ HTTP JSON :5310 (localhost)
                                                ▼
                                      ┌──────────────────────┐   ┌──────────────┐
                                      │ midnight-bridge (TS) │──►│ proof server  │
                                      │ seat wallets, salts, │   │ Docker :6300  │
                                      │ proofs, tx queue     │   └──────────────┘
                                      │ + audit dashboard    │──► Midnight testnet
                                      └──────────────────────┘   (ShadowLedger contract)
```

- **`server.py` stays the real-time game authority** (movement, tasks, meetings). You add ~6 hook calls into it.
- **`midnight-bridge/` (new, TypeScript/Node)** owns everything Midnight: contract deploy/join, per-seat headless SDK wallets + salts (custodied v1 — document it), proof generation, an **async tx queue** so chain latency never blocks the 60fps game, and a small web **audit dashboard**.
- **`dashboard`** (served by the bridge at `:5310/audit`): live feed of chain events + endgame audit table. This is your judge-facing screen, since pygame can't show an explorer nicely. Plain HTML/JS, one page, dark theme.

**Golden rule:** every bridge call from Python is **fire-and-forget with a local queue** (`requests.post` in a thread / queue worker). Proofs take seconds; the game must never stall. Dashboard shows events as `⏳ anchoring… → ✓ verified (tx …)`.

---

## 3. LOCKED SCOPE

- **5 players** (humans + the repo's bots), **1 Saboteur (impostor), 4 Agents (crew)**. Keep tasks/sabotage as-is from the repo — free content.
- Midnight integration = exactly **6 on-chain events**, no more:
  1. **Deal** — seed + role commitments before game start
  2. **Kill records** — ZK-bound to killer's committed role
  3. **Vote records** — nullifier-enforced one-vote-per-player-per-meeting
  4. **Ejection + role reveal** — commitment opened publicly
  5. **Winner declaration** — checked against recorded state
  6. **Endgame audit reveal** — all roles + salts opened, dashboard verifies every commitment
- **CUT:** analyst/medic roles, night-phase redesign, hidden resources, Lace browser wallet for players (bridge custodies seat keys), any web game client, voice chat (`server_voice.py` — don't touch it).

---

## 4. THE CONTRACT — `midnight-bridge/contract/src/shadow_ledger.compact`

> ⚠️ Design pseudocode in Compact style. Before writing: install the toolchain, then pattern-match syntax against the **current** language reference (`docs.midnight.network/compact`), std-lib exports (`persistentCommit`, `persistentHash`, `disclose`), and `github.com/midnightntwrk/example-bboard`. Keep these shapes; fix the syntax. Add the right `pragma language_version` for your installed compiler.

### Ledger (public) state
```
gamePhase: Uint<8>                       // 0 SETUP, 1 LIVE, 2 MEETING, 3 OVER
meetingRound: Counter
gameSeed: Bytes<32>
roleCommitments: Map<Uint<8>, Bytes<32>> // seat -> persistentCommit([role, seat, gameSeed], salt)
alive: Map<Uint<8>, Boolean>
killLog: List<[Uint<8>, Uint<8>]>        // (victimSeat, meetingRound-epoch) — killer NOT disclosed
voteNullifiers: Set<Bytes<32>>
voteTally: Map<Uint<8>, Uint<8>>
ejected: Map<Uint<8>, Uint<8>>           // seat -> revealed role
winner: Uint<8>                          // 0 none, 1 agents, 2 saboteur
```

### Circuits
1. `initGame(seed: Bytes<32>, commitments: Vector<5, Bytes<32>>)` — deployer-key only, once, in SETUP. Sets seed + commitments, all alive, phase LIVE.
2. `recordKill(victim: Uint<8>)` — **witness:** `(killerRole, killerSeat, salt)`. Proves `roleCommitments[killerSeat]` opens to `[SABOTEUR, killerSeat, gameSeed]` with `salt`, killer alive, victim alive, phase LIVE. Effects: `alive[disclose(victim)] = false`, append killLog. **Killer seat is never disclosed** — the chain proves "a legitimate saboteur did this" without saying who (nice ZK moment; the pygame players saw the body, not the chain).
3. `recordVote(target: Uint<8>)` — **witness:** `(voterRole, voterSeat, salt)`. Proves voter's commitment opens + alive + nullifier `persistentHash(salt, meetingRound, "vote")` unused. Effects: nullifier in, `voteTally[disclose(target)] += 1`. Phase MEETING.
4. `recordEjection(seat: Uint<8>, role: Uint<8>, salt: Bytes<32>)` — deployer key; verifies opening of `roleCommitments[seat]` to `[role, seat, gameSeed]`; sets `ejected`, `alive=false`, reveals role, ends meeting, resets tally, increments round.
5. `declareWinner(w: Uint<8>)` — deployer key; contract sanity-checks (e.g. saboteur-ejected ⇒ w=1 required; not more) and sets phase OVER.
6. `auditReveal(seat, role, salt)` — opens remaining commitments at game end.

### Contract invariants → tests
- `initGame` twice fails; non-deployer fails.
- `recordKill` with an AGENT-role witness fails (this is test #1 in your video-worthy list).
- Double vote in same meeting fails; same voter next meeting succeeds.
- Kill/vote by or against dead seats fails; wrong-phase calls fail.
- `recordEjection` with wrong role/salt fails (server cannot lie about a revealed role).
- No circuit discloses a role except ejection/audit reveals.

---

## 5. THE BRIDGE — `midnight-bridge/` (TypeScript)

Structure: `contract/` (compact + generated bindings), `src/server.ts` (Express/Fastify HTTP API), `src/game.ts` (seats, salts, deal logic), `src/queue.ts` (serialized tx worker w/ retries), `src/audit.ts` + `public/audit.html` (dashboard), `.env.example`.

**HTTP API (localhost only):**
| Route | Body | Action |
|---|---|---|
| `POST /deal` | `{playerIds: number[]}` | Map player_ids→seats 0–4, make `gameSeed` (bridge entropy + timestamp; commit BEFORE dealing), **derive saboteur = Fisher–Yates over seats seeded by `gameSeed`** (replaces highest-player_id!), generate salts, `initGame` on-chain, return `{seatMap, saboteurPlayerId}` to server.py |
| `POST /kill` | `{killerId, victimId}` | queue `recordKill` with killer-seat witness |
| `POST /vote` | `{voterId, targetId, round}` | queue `recordVote` |
| `POST /eject` | `{seat, round}` | queue `recordEjection` (bridge knows role+salt) |
| `POST /gameover` | `{winner}` | queue `declareWinner` + `auditReveal` for all seats |
| `GET /audit` | — | dashboard page (chain event feed, commitment table, ✓/✗ verification, tx links) |
| `GET /health` | — | proof server + node + contract status (use in Phase 0 gate) |

- **Wallets:** one deployer/admin wallet funded with tDUST; per-seat proofs can run from seat-derived headless wallets or the admin wallet — whichever the SDK makes easy. Custody documented as v1.
- **Match versions to the current `example-bboard` `package.json`** for all `@midnight-ntwrk/*` deps. Proof server via `docker compose` (`midnightnetwork/proof-server`, port 6300).

## 6. PYTHON HOOKS — minimal diff into the base repo

Create `midnight_hooks.py` (thread-pooled `requests.post`, 2s timeout, silent-fail with console warn — chain problems must never crash the game):

1. **Deal:** in multiplayer setup, DELETE the highest-player_id impostor logic → call `hooks.deal(player_ids)`; server assigns `imposter=True` to the returned `saboteurPlayerId`. If bridge unreachable: abort start with clear error (fairness is the product; no silent fallback).
2. **Kill:** where `victim_id` is processed server-side → `hooks.kill(killer_id, victim_id)`.
3. **Vote:** where `voted`/`got_votes` update on the server → `hooks.vote(voter_id, target_id, round)`.
4. **Ejection:** where `got_votes >= 2` triggers ejection → `hooks.eject(seat, round)`.
5. **Game over:** at each win-condition branch → `hooks.gameover(winner)`.
6. **(Polish, optional)** small "⛓ verified" toast in pygame HUD when the bridge confirms a tx — visible cryptography inside the game.

Also in Phase 0: pin **Python 3.11 venv** (asyncore!), `requirements.txt`, reskin pass (names, title, sprite hue-shift).

---

## 7. TEST CASES

### Contract (simulator — highest priority)
| # | Case | Expect |
|---|---|---|
| C1 | initGame twice / non-deployer | reject |
| C2 | recordKill with AGENT witness | proof fails |
| C3 | recordKill valid saboteur | victim dead, killLog+1, killer seat NOT in public state |
| C4 | recordKill on dead victim / by dead killer / wrong phase | reject |
| C5 | double vote same meeting | reject (nullifier) |
| C6 | same voter next meeting | accepted |
| C7 | recordEjection wrong role/salt | reject |
| C8 | ejection of saboteur then declareWinner(2) | reject; (1) accepted |
| C9 | audit: all reveals match commitments | pass |
| C10 | grep generated output: no role disclosure outside eject/audit | pass |

### Bridge + integration
| # | Case | Expect |
|---|---|---|
| B1 | /deal same seed twice (test mode) | identical saboteur seat (determinism) |
| B2 | 20 rapid /kill+/vote posts | queue serializes, all land, order preserved |
| B3 | proof server down mid-game | queue retries+backoff; game unaffected; dashboard shows pending |
| B4 | /kill with killerId that isn't the dealt saboteur | bridge refuses (belt) AND contract would reject (suspenders) |
| B5 | game-loop latency with hooks active | frame time unchanged (hooks are async) |
| B6 | full bot game start→finish | dashboard audit table 100% ✓ green |

### Repo-specific regressions
| # | Case | Expect |
|---|---|---|
| R1 | Python 3.11 venv: server + 2 clients LAN game | works (asyncore alive) |
| R2 | old highest-player_id impostor path | fully removed (grep) |
| R3 | vote tie / `got_votes>=2` edge with 5 players | matches on-chain tally; ejection rule documented |
| R4 | no "Among Us"/Innersloth strings or unmodified logos in UI | pass |

---

## 8. 72-HOUR PLAN

**Phase 0 — Jul 17 morning (gate: everything runs):** Py3.11 venv, base game runs LAN with 2 clients; compact toolchain installed, stock example compiles; proof server Docker up; deploy stock example to testnet (faucet tDUST NOW); scaffold `midnight-bridge/`.
**Phase 1 — Jul 17 rest:** contract written + simulator tests C1–C10 green.
**Phase 2 — Jul 18 morning:** bridge API + queue + deploy; tests B1–B4.
**Phase 3 — Jul 18 afternoon:** Python hooks in, old dealer logic out; full bot game writes all 6 event types to testnet (B5–B6, R1–R3).
**Phase 4 — Jul 18 evening:** audit dashboard polished (this is a judge deliverable, not a debug page); reskin pass (R4).
**Phase 5 — Jul 19 morning:** E2E rehearsal ×3; record full backup screen capture; fix leaks (grep logs for role strings).
**Phase 6 — Jul 19 afternoon (protect 4h):** README (trust table, base-repo disclosure, quickstart on clean machine, test tables), ≤2-min video (name the event first seconds; open with the rigged-dealer line; show: deal commitments → kill with "proven saboteur, identity not disclosed" → vote nullifier rejecting a double-vote → ejection reveal → all-green audit), DEMO_SCRIPT.md, submit.

**Cut order if behind:** vote nullifier circuit → keep votes as deployer-recorded events; sabotage/task chain events (never planned — don't add); pygame HUD toast; per-seat wallets → single admin wallet for all proofs. **Never cut:** deal commitments, recordKill role proof, audit dashboard, video, README disclosure.

## 9. HARD DON'TS
- Don't block the pygame loop on any chain call, ever.
- Don't ship the highest-player_id dealer in any code path.
- Don't log or broadcast roles/salts anywhere except the ejection/audit flows.
- Don't run Python ≥3.12 (asyncore) without the shim decision made in Phase 0.
- Don't leave Innersloth assets/name in the submission; don't hide the base repo — disclose it proudly as the "before" of your story.
- Don't claim the server can't see secrets; claim it can't forge or rewrite them — and show the trust table.
- Don't trust remembered Compact syntax; re-check the current docs + example-bboard before writing the contract.
