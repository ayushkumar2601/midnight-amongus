// Canonical shared types — Shadow Protocol spec §8.5.

export type Role = 1 | 2;                       // 1 AGENT, 2 SABOTEUR
export type Winner = 1 | 2;                     // 1 agents, 2 saboteur

export const ROLE_AGENT: Role = 1;
export const ROLE_SABOTEUR: Role = 2;
export const SEATS = 5;
export const SKIP_TARGET = 255;                 // contract-level skip sentinel

export interface DealRequest  { playerIds: number[] }          // exactly N, unique, ints > 0

export interface DealResult {
  matchId: string;
  contractAddress: string;
  seatMap: { playerId: number; seat: number }[];
  saboteurPlayerId: number;                     // ONLY field the game keeps secretly
  commitments: string[];
  gameSeedHex: string;
  txId: string;
}

export interface KillRequest  { killerId: number; victimId: number }
export interface VoteRequest  { voterId: number; targetId: number | null }  // null = skip
export interface EjectRequest { round: number; ejectedId: number | null }   // null = tie/skip
export interface GameOverRequest {
  winner: Winner;
  reason: 'tasks' | 'ejection' | 'kills' | 'sabotage';
}

export type ErrorCode =
  | 'BAD_REQUEST' | 'WRONG_STATE' | 'UNKNOWN_PLAYER' | 'NOT_SABOTEUR'
  | 'DEAD_ACTOR' | 'DEAD_TARGET' | 'DUPLICATE' | 'CHAIN_UNAVAILABLE' | 'INTERNAL';

export interface BridgeError { error: string; code: ErrorCode; detail?: string }

export type AuditEventKind =
  | 'deal' | 'kill' | 'vote' | 'eject' | 'no_eject' | 'winner' | 'reveal';

export type AuditEventStatus =
  | 'queued' | 'proving' | 'submitted' | 'confirmed' | 'failed';

export interface AuditEvent {
  seqNo: number;
  kind: AuditEventKind;
  publicData: Record<string, unknown>;          // NEVER roles/salts/killer/voter seats
  status: AuditEventStatus;
  txId?: string;
  ts: string;
}

export interface TxRef { txId: string; blockHeight?: number }

export interface SeatCreds { role: Role; seat: number; salt: Uint8Array }

export interface AuditReveal {
  seat: number;
  playerId: number;
  role: Role;
  saltHex: string;
  commitmentHex: string;
  recomputedHex: string;
  match: boolean;
}

export interface AuditData {
  matchId: string;
  contractAddress: string;
  network: string;
  mode: 'mock' | 'testnet';
  commitmentScheme: 'sha256-mock' | 'compact-persistentCommit';
  gameSeedHex: string;
  session: string;
  explorerBase: string;                         // '' in mock mode; set in testnet
  seatMap: { playerId: number; seat: number }[];
  commitments: string[];
  events: AuditEvent[];
  reveals: AuditReveal[];                       // [] until OVER
}

// Thrown by chain clients when a circuit assertion / proof verification fails.
// Non-retryable by definition (spec §13.1): logic bug or forgery attempt.
export class CircuitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CircuitError';
  }
}
