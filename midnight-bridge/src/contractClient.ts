// Chain clients (spec §8.3). Two implementations behind one interface:
//
//  * MockChainClient   — MN_MODE=mock. In-process ledger that enforces the SAME
//    checks as shadow_ledger.compact (phase guards, commitment openings,
//    nullifiers, consistency guards). Lets the whole stack run before the
//    Compact toolchain / faucet / testnet are available.
//
//  * RealChainClient   — MN_MODE=testnet. Wraps the compiled contract's
//    generated bindings + midnight-js providers. Witnesses for killerCreds /
//    voterCreds are read from a per-call context object, following the
//    example-counter witness wiring pattern. VERIFY-AGAINST-DOCS: the generated
//    identifiers in contract/src/managed are authoritative; align the marked
//    call sites with them after `npm run compact`.
//
// No other file touches generated code.

import { CircuitError, SEATS, SKIP_TARGET, type SeatCreds, type TxRef } from './types.js';
import { mockCommit, mockNullifier, sha256, toHex } from './crypto.js';
import type { Providers } from './providers.js';

export interface ChainHealth {
  proofServer: 'up' | 'down' | 'n/a';
  indexer: 'up' | 'down' | 'n/a';
  walletAddress: string;
  balanceTDust: string;
}

export interface ChainClient {
  readonly address: string;
  readonly scheme: 'sha256-mock' | 'compact-persistentCommit';
  commit(role: number, seat: number, gameSeed: Uint8Array, salt: Uint8Array): Uint8Array;
  initGame(seed: Uint8Array, commitments: Uint8Array[]): Promise<TxRef>;
  recordKill(victimSeat: number, killerCreds: SeatCreds): Promise<TxRef>;
  startMeeting(): Promise<TxRef>;
  recordVote(targetSeat: number, voterCreds: SeatCreds): Promise<TxRef>;
  recordEjection(seat: number, role: number, salt: Uint8Array): Promise<TxRef>;
  endMeetingNoEjection(): Promise<TxRef>;
  declareWinner(w: number): Promise<TxRef>;
  auditReveal(seat: number, role: number, salt: Uint8Array): Promise<TxRef>;
  health(): Promise<ChainHealth>;
}

// ---------------------------------------------------------------------------
// Mock implementation
// ---------------------------------------------------------------------------

const PHASE_SETUP = 0, PHASE_LIVE = 1, PHASE_MEETING = 2, PHASE_OVER = 3;
const ROLE_SABOTEUR = 2;

export class MockChainClient implements ChainClient {
  readonly address: string;
  readonly scheme = 'sha256-mock' as const;

  private phase = PHASE_SETUP;
  private meetingRound = 0;
  private gameSeed: Uint8Array = new Uint8Array(32);
  private roleCommitments = new Map<number, string>();
  private alive = new Map<number, boolean>();
  private killCount = 0;
  private voteNullifiers = new Set<string>();
  private voteTally = new Map<number, number>();
  private ejectedRole = new Map<number, number>();
  private revealedRole = new Map<number, number>();
  private winner = 0;
  private txCounter = 0;

  constructor() {
    this.address = 'mock:' + toHex(sha256(new Uint8Array(Buffer.from(String(Date.now()))))).slice(0, 40);
  }

  commit(role: number, seat: number, gameSeed: Uint8Array, salt: Uint8Array): Uint8Array {
    return mockCommit(role, seat, gameSeed, salt);
  }

  private async tx(label: string): Promise<TxRef> {
    // small latency so the dashboard's queued -> proving -> confirmed chips are visible
    await new Promise((r) => setTimeout(r, 250));
    this.txCounter += 1;
    const id = toHex(sha256(new Uint8Array(Buffer.from(`${this.address}:${label}:${this.txCounter}`))));
    return { txId: `mock-${id.slice(0, 48)}`, blockHeight: this.txCounter };
  }

  private assert(cond: boolean, msg: string): asserts cond {
    if (!cond) throw new CircuitError(msg);
  }

  private openMatches(role: number, seat: number, salt: Uint8Array): boolean {
    const stored = this.roleCommitments.get(seat);
    return stored !== undefined && stored === toHex(this.commit(role, seat, this.gameSeed, salt));
  }

  async initGame(seed: Uint8Array, commitments: Uint8Array[]): Promise<TxRef> {
    this.assert(this.phase === PHASE_SETUP, 'initGame callable once, in SETUP');
    this.assert(commitments.length === SEATS, 'need 5 commitments');
    this.gameSeed = seed;
    for (let i = 0; i < SEATS; i++) {
      this.roleCommitments.set(i, toHex(commitments[i]));
      this.alive.set(i, true);
      this.voteTally.set(i, 0);
    }
    this.phase = PHASE_LIVE;
    return this.tx('initGame');
  }

  async recordKill(victimSeat: number, creds: SeatCreds): Promise<TxRef> {
    this.assert(this.phase === PHASE_LIVE, 'kills only while LIVE');
    this.assert(creds.role === ROLE_SABOTEUR, 'killer must be SABOTEUR');
    this.assert(this.openMatches(creds.role, creds.seat, creds.salt), 'killer commitment mismatch');
    this.assert(this.alive.get(creds.seat) === true, 'killer is dead');
    this.assert(victimSeat < SEATS, 'bad victim seat');
    this.assert(this.alive.get(victimSeat) === true, 'victim already dead');
    this.assert(victimSeat !== creds.seat, 'self-kill');
    this.alive.set(victimSeat, false);
    this.killCount += 1;
    return this.tx('recordKill');
  }

  async startMeeting(): Promise<TxRef> {
    this.assert(this.phase === PHASE_LIVE, 'meeting starts from LIVE');
    this.phase = PHASE_MEETING;
    for (let i = 0; i < SEATS; i++) this.voteTally.set(i, 0);
    return this.tx('startMeeting');
  }

  async recordVote(targetSeat: number, creds: SeatCreds): Promise<TxRef> {
    this.assert(this.phase === PHASE_MEETING, 'votes only in MEETING');
    this.assert(this.openMatches(creds.role, creds.seat, creds.salt), 'voter commitment mismatch');
    this.assert(this.alive.get(creds.seat) === true, 'dead seats cannot vote');
    this.assert(
      targetSeat === SKIP_TARGET || (targetSeat < SEATS && this.alive.get(targetSeat) === true),
      'bad or dead vote target');
    const nullifier = toHex(mockNullifier(creds.salt, this.meetingRound));
    this.assert(!this.voteNullifiers.has(nullifier), 'double vote');
    this.voteNullifiers.add(nullifier);
    if (targetSeat !== SKIP_TARGET) {
      this.voteTally.set(targetSeat, (this.voteTally.get(targetSeat) ?? 0) + 1);
    }
    return this.tx('recordVote');
  }

  async recordEjection(seat: number, role: number, salt: Uint8Array): Promise<TxRef> {
    this.assert(this.phase === PHASE_MEETING, 'ejection only from MEETING');
    this.assert(seat < SEATS, 'bad seat');
    this.assert(this.openMatches(role, seat, salt), 'ejection reveal does not open commitment');
    this.assert(this.alive.get(seat) === true, 'seat already dead');
    this.alive.set(seat, false);
    this.ejectedRole.set(seat, role);
    this.meetingRound += 1;
    this.phase = PHASE_LIVE;
    return this.tx('recordEjection');
  }

  async endMeetingNoEjection(): Promise<TxRef> {
    this.assert(this.phase === PHASE_MEETING, 'no meeting to end');
    this.meetingRound += 1;
    this.phase = PHASE_LIVE;
    return this.tx('endMeetingNoEjection');
  }

  async declareWinner(w: number): Promise<TxRef> {
    this.assert(this.phase !== PHASE_OVER, 'already OVER');
    this.assert(w === 1 || w === 2, 'winner must be 1 or 2');
    for (const role of this.ejectedRole.values()) {
      if (role === ROLE_SABOTEUR) this.assert(w === 1, 'saboteur was ejected: agents must win');
    }
    this.winner = w;
    this.phase = PHASE_OVER;
    return this.tx('declareWinner');
  }

  async auditReveal(seat: number, role: number, salt: Uint8Array): Promise<TxRef> {
    this.assert(this.phase === PHASE_OVER, 'audit only after OVER');
    this.assert(seat < SEATS, 'bad seat');
    this.assert(this.openMatches(role, seat, salt), 'audit reveal does not open commitment');
    this.revealedRole.set(seat, role);
    return this.tx('auditReveal');
  }

  async health(): Promise<ChainHealth> {
    return { proofServer: 'n/a', indexer: 'n/a', walletAddress: 'mock-wallet', balanceTDust: 'n/a' };
  }
}

// ---------------------------------------------------------------------------
// Real testnet implementation
// ---------------------------------------------------------------------------

// Per-call witness context: the generated contract API takes witness functions
// at construction time; they read whatever creds the GameSession set for the
// in-flight call. The tx queue is strictly serial (one in-flight tx), so a
// single slot is race-free.
export interface WitnessContext { current?: SeatCreds }

export class RealChainClient implements ChainClient {
  readonly scheme = 'compact-persistentCommit' as const;
  address = '';

  private deployed: any;
  private contractModule: any;

  constructor(
    private readonly providers: Providers,
    private readonly witnessCtx: WitnessContext = {},
  ) {}

  // VERIFY-AGAINST-DOCS: aligned with the installed midnight-js-contracts
  // 4.1.1 API, which takes a `compiledContract` built with the compact-js
  // CompiledContract module (make + withWitnesses). The generated identifiers
  // in contract/src/managed (produced by `npm run compact`) are authoritative;
  // finish this against example-bboard's contract wiring during Phase 2.
  async init(existingAddress: string): Promise<void> {
    const managed: any = await import(
      // compiled by `npm run compact`; path per spec §5
      new URL('../contract/src/managed/contract/index.js', import.meta.url).href
    );
    this.contractModule = managed;
    const creds = () => {
      const c = this.witnessCtx.current;
      if (!c) throw new Error('witness called with no creds in context');
      // Witness shape [role, seat, salt] per spec §7.2.
      return [BigInt(c.role), BigInt(c.seat), c.salt];
    };
    const compactJs: any = await import('@midnight-ntwrk/compact-js');
    const compiledContract = compactJs.CompiledContract
      .make('shadowLedger', managed.Contract)
      .pipe(
        compactJs.CompiledContract.withWitnesses({
          killerCreds: (privateState: unknown) => [privateState, creds()],
          voterCreds: (privateState: unknown) => [privateState, creds()],
        }),
      );

    const contracts: any = await import('@midnight-ntwrk/midnight-js-contracts');
    if (existingAddress !== '') {
      this.deployed = await contracts.findDeployedContract(this.providers.midnight, {
        compiledContract,
        contractAddress: existingAddress,
      });
      this.address = existingAddress;
    } else {
      this.deployed = await contracts.deployContract(this.providers.midnight, {
        compiledContract,
      });
      this.address = this.deployed.deployTxData.public.contractAddress;
    }
  }

  commit(role: number, seat: number, gameSeed: Uint8Array, salt: Uint8Array): Uint8Array {
    // VERIFY-AGAINST-DOCS: the generated pureCircuits export exposes
    // persistentCommit-based helpers; align the call with the managed output.
    // Shape (spec §6.3): persistentCommit([role, seat, gameSeed], salt).
    const pure = this.contractModule?.pureCircuits;
    if (pure?.pureOpenCommitment) {
      return pure.pureOpenCommitment(BigInt(role), BigInt(seat), gameSeed, salt);
    }
    if (pure?.openCommitment) {
      return pure.openCommitment({ gameSeed }, BigInt(role), BigInt(seat), salt);
    }
    throw new Error('managed bindings missing pureCircuits.pureOpenCommitment — recheck compact output');
  }

  private async call(name: string, args: unknown[], creds?: SeatCreds): Promise<TxRef> {
    this.witnessCtx.current = creds;
    try {
      const tx = await this.deployed.callTx[name](...args);
      return {
        txId: tx.public.txId ?? tx.public.txHash ?? 'unknown',
        blockHeight: tx.public.blockHeight,
      };
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      // Proof verification / circuit assertion failures are non-retryable.
      if (/assert|verif|constraint|witness/i.test(msg)) throw new CircuitError(msg);
      throw e;
    } finally {
      this.witnessCtx.current = undefined;
    }
  }

  initGame(seed: Uint8Array, c: Uint8Array[]): Promise<TxRef> {
    return this.call('initGame', [seed, c[0], c[1], c[2], c[3], c[4]]);
  }
  recordKill(victimSeat: number, killerCreds: SeatCreds): Promise<TxRef> {
    return this.call('recordKill', [BigInt(victimSeat)], killerCreds);
  }
  startMeeting(): Promise<TxRef> { return this.call('startMeeting', []); }
  recordVote(targetSeat: number, voterCreds: SeatCreds): Promise<TxRef> {
    return this.call('recordVote', [BigInt(targetSeat)], voterCreds);
  }
  recordEjection(seat: number, role: number, salt: Uint8Array): Promise<TxRef> {
    return this.call('recordEjection', [BigInt(seat), BigInt(role), salt]);
  }
  endMeetingNoEjection(): Promise<TxRef> { return this.call('endMeetingNoEjection', []); }
  declareWinner(w: number): Promise<TxRef> { return this.call('declareWinner', [BigInt(w)]); }
  auditReveal(seat: number, role: number, salt: Uint8Array): Promise<TxRef> {
    return this.call('auditReveal', [BigInt(seat), BigInt(role), salt]);
  }

  async health(): Promise<ChainHealth> {
    return this.providers.health();
  }
}
