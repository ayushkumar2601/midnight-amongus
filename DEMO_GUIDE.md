# Among Midnight — Hackathon Demo Video Guide & Walkthrough

Everything has been verified end-to-end across both the **TypeScript `midnight-bridge`** (port `8088`) and the **Python Pygame engine** (`game.py`, `menu.py`, `board.py`, `settings.py`, `midnight_hooks.py`). All 14 bridge tests pass, type compatibility for Python 3.9 through 3.14+ is ensured, and Night Coin (`NIGHT`) tracking & staking are live.

---

## 🎬 Demo Video Workflow & Setup Guide

Here is the recommended step-by-step workflow to record a clean, compelling demo video for the **Gaming Track** of the Midnight Hackathon.

### Phase 1: Environment & Terminal Preparation

Open **three** terminal windows or tabs:
1. **Terminal 1 (Bridge Server & ZK Audit Dashboard)**
2. **Terminal 2 (Python TCP Game Server)**
3. **Terminal 3 (Python Pygame Client — Or multiple for split-screen)**

---

### Phase 2: Launching the Services

#### Step 1: Start the Midnight Bridge (`Terminal 1`)
The bridge connects the local Python game engine to the Midnight/Shadow Protocol ledger (or mock ZK circuit checks).

```bash
cd /Users/ayush/Desktop/Among-Midnight/midnight-bridge
npm run build && node dist/index.js
```
*Look for:* `midnight-bridge up — dashboard: http://127.0.0.1:8088/audit`

> [!TIP]
> Open your browser and navigate to **`http://127.0.0.1:8088/audit`**. Keep this ZK Audit Dashboard visible on one side of your screen during the demo video to show live zero-knowledge transaction verifications!

#### Step 2: Start the Python Multiplayer Server (`Terminal 2`)
This coordinates player positions and basic multiplayer state across clients.

```bash
cd /Users/ayush/Desktop/Among-Midnight
source .venv/bin/activate
python3 server.py
```
*Look for:* `Waiting for a connection, Server Started`

#### Step 3: Launch the Python Game Client(s) (`Terminal 3`)
Launch one or more instances of the game. For solo demonstration, you can configure `SHADOW_PLAYERS=1` or `2` if testing with fewer windows.

```bash
cd /Users/ayush/Desktop/Among-Midnight
source .venv/bin/activate
python3 main.py
```

---

### Phase 3: What to Showcase in the Video (Script Suggestions)

1. **Main Menu & Initial Token Balance**
   - Point out the **Night Coin HUD** in the top right corner: `Night Coin: 100 NIGHT`.
   - Explain how the client automatically synced with `GET /token/balance` via `midnight_hooks.py`.

2. **Match Start & Staking (`/deal` & `/token/stake`)**
   - Enter a game lobby/match.
   - Show that entering a match automatically stakes `10 NIGHT` (`NIGHT_COIN_ENTRY_STAKE`), updating the balance HUD to `90 NIGHT`.
   - Explain that the `hooks.deal_async()` call commits the encrypted game seed and role commitments on-chain (`POST /deal` and `/commit`).
   - Switch briefly to the **ZK Audit Dashboard (`http://127.0.0.1:8088/audit`)** to show the live anchored match ID, commitments, and transaction ID.

3. **In-Game ZK Event Tracking (`/kill`, `/vote`, `/eject`)**
   - During gameplay, perform actions (reporting an emergency meeting, voting, or killing as Imposter).
   - Show how `hooks.kill()`, `hooks.vote()`, and `hooks.eject()` fire asynchronously without lagging or freezing the Pygame render loop (`60 FPS`).

4. **Victory & Token Reward (`/gameover` & `/token/reward`)**
   - Complete tasks or win as Imposter.
   - Show that winning triggers `hooks.gameover()` and immediately awards a `+50 NIGHT` bounty (`NIGHT_COIN_WIN_REWARD`).
   - Notice the HUD updates to `140 NIGHT` and the final audit reveal (`/audit/data`) appears on the bridge dashboard.

---

## 🛠 Status Checklist Summary

| Component | Status | Notes |
| :--- | :--- | :--- |
| **Bridge Port Config** | ✅ Verified | Set to `8088` in `.env`, `config.ts`, and `midnight_hooks.py`. |
| **ZK Endpoints** | ✅ Verified | `/deal`, `/commit`, `/vote`, `/kill`, `/eject`, `/gameover` tested live. |
| **Night Coin (`NIGHT`)** | ✅ Verified | `/token/balance`, `/token/stake` (`-10`), and `/token/reward` (`+50`) working. |
| **Pygame HUD** | ✅ Verified | `Board.draw_night_coin_hud()` renders top-right across menus & gameplay. |
| **Python Hooks Type Safety**| ✅ Verified | Full compatibility with Python 3.9–3.14+ via `Optional` & `__future__` annotations. |
| **Vitest Test Suite** | ✅ Verified | `14 / 14` automated bridge integration tests passing (`100%`). |
