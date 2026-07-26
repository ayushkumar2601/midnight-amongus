// GameSession (spec §8.4): seats, seed, shuffle, salts, role map, and the
// belt-and-suspenders validations in front of the contract circuits.
//
// SECRET-HANDLING RULE: roles[] and salts[] are never serialized, logged, or
// returned by any route except: saboteurPlayerId in the /deal response, and
// the full opening in /audit/data + audit_log.json AFTER the session is OVER.

import type { Config } from './config.js';
import type { ChainClient } from './contractClient.js';
import type { TxQueue } from './queue.js';
import type { AuditLog } from './audit.js';
import {
  CircuitError, ROLE_AGENT, ROLE_SABOTEUR, SEATS, SKIP_TARGET,
  type AuditData, type AuditEventKind, type AuditReveal, type DealResult,
  type ErrorCode, type Role, type SeatCreds, type Winner,
} from './types.js';
import {
  fisherYates, makeGameSeed, makeMatchId, makeSalt, toHex,
} from './crypto.js';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
  }
}

type SessionState = 'IDLE' | 'LIVE' | 'MEETING' | 'OVER';

export class GameSession {
  state: SessionState = 'IDLE';
  private seatByPlayerId = new Map<number, number>();
  private playerIdBySeat: number[] = [];
  private roles: Role[] = [];          // SECRET
  private salts: Uint8Array[] = [];    // SECRET
  private gameSeed: Uint8Array = new Uint8Array(32);
  private commitments: Uint8Array[] = [];
  private meetingRound = 0;
  private aliveSeats = new Set<number>();
  private votedSeats = new Set<number>();       // bridge-side nullifier mirror
  private meetingOpen = false;
  private matchId = '';
  private dealResult: DealResult | null = null;
  private dealKey = '';
  private dealInflight: Promise<DealResult> | null = null;
  private winnerDeclared: Winner | null = null;
  private revealsDone = false;
  private nightCoinBalance = 100;

  constructor(
    private readonly cfg: Config,
    private readonly chain: ChainClient,
    private readonly queue: TxQueue,
    private readonly audit: AuditLog,
    private readonly log: { info: Function; warn: Function },
  ) {}

  // ----------------------------- Night Coin Tokens -----------------------------
  async getTokenBalance(): Promise<{ balance: number; symbol: string; mode: string }> {
    return { balance: this.nightCoinBalance, symbol: 'NIGHT', mode: this.cfg.MN_MODE };
  }

  async stakeTokens(amount: number): Promise<{ balance: number; staked: number }> {
    if (amount <= 0) {
      throw new ApiError(400, 'BAD_REQUEST', 'stake amount must be positive');
    }
    if (this.nightCoinBalance < amount) {
      this.nightCoinBalance += amount + 50;
      this.log.info({ newBalance: this.nightCoinBalance }, 'auto-faucet Night Coin top-up');
    }
    this.nightCoinBalance -= amount;
    this.log.info({ amount, remaining: this.nightCoinBalance }, 'staked Night Coin for match entry');
    return { balance: this.nightCoinBalance, staked: amount };
  }

  async rewardTokens(amount: number): Promise<{ balance: number; rewarded: number }> {
    if (amount <= 0) {
      throw new ApiError(400, 'BAD_REQUEST', 'reward amount must be positive');
    }
    this.nightCoinBalance += amount;
    this.log.info({ amount, newBalance: this.nightCoinBalance }, 'awarded Night Coin victory bounty');
    return { balance: this.nightCoinBalance, rewarded: amount };
  }

  // Alias for explicit commitment check / deal
  async commit(playerIds: number[]): Promise<DealResult> {
    return this.deal(playerIds);
  }

  // ------------------------------- deal (P1) -------------------------------
  // Synchronous by design: the match must not start unanchored. Concurrent
  // /deal calls from the game clients (every client posts the same lobby) are
  // coalesced onto one on-chain initGame; identical repeats get the cached
  // DealResult so all clients agree on the saboteur.
  async deal(playerIds: number[]): Promise<DealResult> {
    const ids = [...playerIds].sort((a, b) => a - b);
    const key = ids.join(',');

    if (this.state !== 'IDLE') {
      if (this.dealResult && key === this.dealKey) return this.dealResult; // idempotent replay
      throw new ApiError(409, 'WRONG_STATE', 'session not IDLE (POST /reset first in dev)');
    }
    if (this.dealInflight) {
      if (key !== this.dealKey) {
        throw new ApiError(409, 'WRONG_STATE', 'a deal for a different lobby is in flight');
      }
      return this.dealInflight;
    }

    if (ids.length !== this.cfg.MN_REQUIRED_PLAYERS) {
      throw new ApiError(422, 'BAD_REQUEST',
        `need exactly ${this.cfg.MN_REQUIRED_PLAYERS} playerIds, got ${ids.length}`);
    }
    if (new Set(ids).size !== ids.length || ids.some((i) => !Number.isInteger(i) || i <= 0)) {
      throw new ApiError(422, 'BAD_REQUEST', 'playerIds must be unique positive integers');
    }

    this.dealKey = key;
    this.dealInflight = this.doDeal(ids);
    try {
      return await this.dealInflight;
    } finally {
      this.dealInflight = null;
    }
  }

  private async doDeal(ids: number[]): Promise<DealResult> {
    // 1. seats by ascending player_id (spec §6.1); ghost AGENT seats pad to 5
    //    when MN_REQUIRED_PLAYERS < 5 (dev mode only — spec-exact at 5).
    const realSeats = ids.length;
    this.playerIdBySeat = [...ids];
    this.seatByPlayerId = new Map(ids.map((id, seat) => [id, seat]));

    // 2. seed — DEMO_FIXED_SEED (test mode, B1 determinism) or CSPRNG+time
    this.gameSeed = makeGameSeed(this.cfg.DEMO_FIXED_SEED);

    // 3. deterministic Fisher–Yates over the real seats: 1 SABOTEUR, rest AGENT
    const pool: Role[] = [ROLE_SABOTEUR, ...Array<Role>(realSeats - 1).fill(ROLE_AGENT)];
    const dealt = fisherYates(pool, this.gameSeed);
    this.roles = [...dealt, ...Array<Role>(SEATS - realSeats).fill(ROLE_AGENT)];

    // 4. salts + commitments per §6.3 (scheme provided by the active chain client)
    this.salts = Array.from({ length: SEATS }, () => makeSalt());
    this.commitments = this.roles.map((role, seat) =>
      this.chain.commit(role, seat, this.gameSeed, this.salts[seat]));

    // 5. ON-CHAIN FIRST — anti-rig ordering: the seed + commitments are
    //    confirmed on the ledger before any role is returned to the game.
    const seqNo = this.queue.nextSeqNo();
    const ev = this.audit.record(seqNo, 'deal', {
      seatMap: this.playerIdBySeat.map((playerId, seat) => ({ playerId, seat })),
      commitments: this.commitments.map(toHex),
      gameSeedHex: toHex(this.gameSeed),
    });
    let txId: string;
    try {
      this.audit.setStatus(seqNo, 'proving');
      const ref = await this.chain.initGame(this.gameSeed, this.commitments);
      txId = ref.txId;
      this.audit.setStatus(seqNo, 'confirmed', txId);
    } catch (e: any) {
      this.audit.setStatus(seqNo, 'failed', undefined, String(e?.message ?? e));
      throw new ApiError(503, 'CHAIN_UNAVAILABLE',
        'deal failed — match must not start unanchored', String(e?.message ?? e));
    }

    this.aliveSeats = new Set(Array.from({ length: realSeats }, (_, s) => s));
    this.meetingRound = 0;
    this.votedSeats.clear();
    this.meetingOpen = false;
    this.state = 'LIVE';
    this.matchId = makeMatchId(this.gameSeed, this.chain.address);

    const saboteurSeat = this.roles.findIndex((r) => r === ROLE_SABOTEUR);
    this.dealResult = {
      matchId: this.matchId,
      contractAddress: this.chain.address,
      seatMap: this.playerIdBySeat.map((playerId, seat) => ({ playerId, seat })),
      saboteurPlayerId: this.playerIdBySeat[saboteurSeat],
      commitments: this.commitments.map(toHex),
      gameSeedHex: toHex(this.gameSeed),
      txId,
    };
    this.log.info({ matchId: this.matchId, contract: this.chain.address, txId },
      'match anchored');   // never log saboteurPlayerId
    return this.dealResult;
  }

  // ------------------------------- kill (P2) -------------------------------
  kill(killerId: number, victimId: number): number {
    if (this.state !== 'LIVE') throw new ApiError(409, 'WRONG_STATE', `session is ${this.state}`);
    const killerSeat = this.requireSeat(killerId);
    const victimSeat = this.requireSeat(victimId);
    if (killerId === victimId) throw new ApiError(422, 'BAD_REQUEST', 'killer == victim');
    // Belt (contract is suspenders):
    if (this.roles[killerSeat] !== ROLE_SABOTEUR) {
      throw new ApiError(409, 'NOT_SABOTEUR', 'killerId is not the dealt saboteur');
    }
    if (!this.aliveSeats.has(killerSeat)) throw new ApiError(409, 'DEAD_ACTOR', 'killer is dead');
    if (!this.aliveSeats.has(victimSeat)) throw new ApiError(409, 'DEAD_TARGET', 'victim already dead');

    this.aliveSeats.delete(victimSeat);
    const creds = this.creds(killerSeat);
    return this.enqueueTx('kill', { victimSeat }, () => this.chain.recordKill(victimSeat, creds));
  }

  // ------------------------------- vote (P3) -------------------------------
  vote(voterId: number, targetId: number | null): number {
    if (this.state !== 'LIVE' && this.state !== 'MEETING') {
      throw new ApiError(409, 'WRONG_STATE', `session is ${this.state}`);
    }
    const voterSeat = this.requireSeat(voterId);
    const targetSeat = targetId === null ? SKIP_TARGET : this.requireSeat(targetId);
    if (!this.aliveSeats.has(voterSeat)) throw new ApiError(409, 'DEAD_ACTOR', 'dead seats cannot vote');
    if (targetSeat !== SKIP_TARGET && !this.aliveSeats.has(targetSeat)) {
      throw new ApiError(409, 'DEAD_TARGET', 'vote target is dead');
    }
    if (this.votedSeats.has(voterSeat)) {
      throw new ApiError(409, 'DUPLICATE', 'voter already voted this round');
    }
    this.votedSeats.add(voterSeat);

    // first vote of a round auto-queues startMeeting (spec §9 /vote)
    if (!this.meetingOpen) {
      this.meetingOpen = true;
      this.state = 'MEETING';
      this.enqueueTx('vote', { note: 'startMeeting', round: this.meetingRound },
        () => this.chain.startMeeting());
    }
    const creds = this.creds(voterSeat);
    // Public data discloses the target only — never the voter seat.
    return this.enqueueTx('vote',
      { targetSeat: targetSeat === SKIP_TARGET ? 'skip' : targetSeat, round: this.meetingRound },
      () => this.chain.recordVote(targetSeat, creds));
  }

  // ------------------------------- eject (P4) ------------------------------
  eject(round: number, ejectedId: number | null): { seqNo: number; willReveal: boolean } {
    if (round !== this.meetingRound) {
      throw new ApiError(422, 'BAD_REQUEST',
        `stale round ${round}, current is ${this.meetingRound}`);
    }
    if (this.state !== 'MEETING') {
      // Covers both wrong-state calls and the no-votes edge where the meeting
      // never opened on-chain: nothing to record. (Duplicate /eject posts from
      // other game clients land here too, after the first advanced the round.)
      throw new ApiError(409, 'WRONG_STATE', `session is ${this.state}, not MEETING`);
    }

    const finishMeeting = () => {
      this.meetingRound += 1;
      this.votedSeats.clear();
      this.meetingOpen = false;
      this.state = 'LIVE';
    };

    if (ejectedId === null) {
      const seqNo = this.enqueueTx('no_eject', { round }, () => this.chain.endMeetingNoEjection());
      finishMeeting();
      return { seqNo, willReveal: false };
    }

    const seat = this.requireSeat(ejectedId);
    if (!this.aliveSeats.has(seat)) throw new ApiError(409, 'DEAD_TARGET', 'seat already dead');
    this.aliveSeats.delete(seat);
    const role = this.roles[seat];
    const salt = this.salts[seat];
    // The reveal opens the day-one commitment: role goes public here BY DESIGN.
    const seqNo = this.enqueueTx('eject', { seat, round, revealedRole: role },
      () => this.chain.recordEjection(seat, role, salt));
    finishMeeting();
    return { seqNo, willReveal: true };
  }

  // ----------------------------- gameover (P5) -----------------------------
  gameover(winner: Winner, reason: string): { auditReveals: number } {
    if (this.state === 'OVER') throw new ApiError(409, 'WRONG_STATE', 'already OVER');
    if (this.state === 'IDLE') throw new ApiError(409, 'WRONG_STATE', 'no match in progress');

    this.state = 'OVER';
    this.winnerDeclared = winner;
    this.enqueueTx('winner', { winner, reason }, () => this.chain.declareWinner(winner));
    for (let seat = 0; seat < SEATS; seat++) {
      const role = this.roles[seat];
      const salt = this.salts[seat];
      this.enqueueTx('reveal', { seat, role, saltHex: toHex(salt) },
        () => this.chain.auditReveal(seat, role, salt));
    }
    this.revealsDone = true;
    this.audit.writeAuditLogFile({
      matchId: this.matchId,
      contractAddress: this.chain.address,
      gameSeedHex: toHex(this.gameSeed),
      seatMap: this.playerIdBySeat.map((playerId, seat) => ({ playerId, seat })),
      roles: this.roles,
      saltsHex: this.salts.map(toHex),
      commitmentsHex: this.commitments.map(toHex),
      winner,
      reason,
      events: this.audit.all(),
    });
    return { auditReveals: SEATS };
  }

  // ------------------------------- audit data ------------------------------
  auditData(): AuditData {
    const over = this.state === 'OVER' && this.revealsDone;
    const reveals: AuditReveal[] = over
      ? this.roles.map((role, seat) => {
          const recomputed = this.chain.commit(role, seat, this.gameSeed, this.salts[seat]);
          return {
            seat,
            playerId: this.playerIdBySeat[seat] ?? -1,
            role,
            saltHex: toHex(this.salts[seat]),
            commitmentHex: toHex(this.commitments[seat]),
            recomputedHex: toHex(recomputed),
            match: toHex(recomputed) === toHex(this.commitments[seat]),
          };
        })
      : [];
    return {
      matchId: this.matchId,
      contractAddress: this.chain.address,
      network: this.cfg.MN_MODE === 'mock' ? 'Mock (local)' : this.cfg.MN_NETWORK_ID,
      mode: this.cfg.MN_MODE,
      commitmentScheme: this.chain.scheme,
      gameSeedHex: this.state === 'IDLE' ? '' : toHex(this.gameSeed),
      session: this.state,
      explorerBase: this.cfg.MN_MODE === 'testnet' ? this.cfg.MN_EXPLORER_URL : '',
      seatMap: this.playerIdBySeat.map((playerId, seat) => ({ playerId, seat })),
      commitments: this.commitments.map(toHex),
      events: this.audit.all(),
      reveals,
    };
  }

  // Dev/demo only (spec §9 POST /reset): clears RAM session, not the chain.
  reset(): void {
    this.state = 'IDLE';
    this.seatByPlayerId.clear();
    this.playerIdBySeat = [];
    this.roles = [];
    this.salts = [];
    this.commitments = [];
    this.meetingRound = 0;
    this.aliveSeats.clear();
    this.votedSeats.clear();
    this.meetingOpen = false;
    this.dealResult = null;
    this.dealKey = '';
    this.winnerDeclared = null;
    this.revealsDone = false;
    this.audit.reset();
  }

  // -------------------------------- helpers --------------------------------
  private requireSeat(playerId: number): number {
    const seat = this.seatByPlayerId.get(playerId);
    if (seat === undefined) {
      throw new ApiError(404, 'UNKNOWN_PLAYER', `player ${playerId} not in seat map`);
    }
    return seat;
  }

  private creds(seat: number): SeatCreds {
    return { role: this.roles[seat], seat, salt: this.salts[seat] };
  }

  private enqueueTx(
    kind: AuditEventKind,
    publicData: Record<string, unknown>,
    run: () => Promise<{ txId: string }>,
  ): number {
    const seqNo = this.queue.nextSeqNo();
    this.audit.record(seqNo, kind, publicData);
    this.queue.enqueue({
      seqNo,
      run,
      onStatus: (status, txId, detail) => this.audit.setStatus(seqNo, status, txId, detail),
    });
    return seqNo;
  }
}
