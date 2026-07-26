// Deterministic primitives for the deal (spec §6.2, §6.3).
//
// The DRBG + Fisher–Yates here are the anti-rig core: the same gameSeed always
// produces the same deal (test B1), and the seed is on-chain before any role
// leaves the bridge.
//
// Commitment scheme note: in MN_MODE=testnet the BINDING commitments are
// Compact's persistentCommit, computed via the compiled contract's runtime
// (see contractClient.ts). The sha256 scheme below is the mock-mode stand-in
// and is clearly labelled 'sha256-mock' in /audit/data so the dashboard
// recomputes with the matching routine.

import { createHash, randomBytes } from 'node:crypto';

export function sha256(...parts: Uint8Array[]): Uint8Array {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
}

export const toHex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
export const fromHex = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'hex'));
const ascii = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'ascii'));

export function makeGameSeed(fixedSeedHex: string): Uint8Array {
  if (fixedSeedHex !== '') return fromHex(fixedSeedHex);
  const now = BigInt(Date.now());
  const nowBuf = Buffer.alloc(8);
  nowBuf.writeBigUInt64BE(now);
  return sha256(new Uint8Array(randomBytes(32)), new Uint8Array(nowBuf));
}

export const makeSalt = (): Uint8Array => new Uint8Array(randomBytes(32));

// Counter-mode sha256 DRBG keyed by the game seed. Deterministic byte stream.
export function drbg(seed: Uint8Array): () => number {
  let counter = 0;
  let pool: Uint8Array = new Uint8Array(0);
  let offset = 0;
  return () => {
    if (offset >= pool.length) {
      const ctr = Buffer.alloc(4);
      ctr.writeUInt32BE(counter++);
      pool = sha256(seed, new Uint8Array(ctr));
      offset = 0;
    }
    return pool[offset++];
  };
}

// Unbiased bounded draw (rejection sampling over one byte; bounds here are <= 5).
function drawBelow(next: () => number, bound: number): number {
  const limit = 256 - (256 % bound);
  for (;;) {
    const b = next();
    if (b < limit) return b % bound;
  }
}

// Fisher–Yates over `items`, deterministic in `seed`. Same seed => same deal.
export function fisherYates<T>(items: T[], seed: Uint8Array): T[] {
  const out = items.slice();
  const next = drbg(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = drawBelow(next, i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// --- mock-mode commitment scheme (labelled 'sha256-mock' in /audit/data) ---
const COMMIT_DOMAIN = ascii('shadow-protocol:commit:v1');
const NULLIFIER_DOMAIN = ascii('shadow-protocol:nullifier:v1');
const VOTE_TAG = ascii('vote');

export function mockCommit(
  role: number, seat: number, gameSeed: Uint8Array, salt: Uint8Array,
): Uint8Array {
  return sha256(COMMIT_DOMAIN, new Uint8Array([role, seat]), gameSeed, salt);
}

export function mockNullifier(salt: Uint8Array, meetingRound: number): Uint8Array {
  const round = Buffer.alloc(4);
  round.writeUInt32BE(meetingRound);
  return sha256(NULLIFIER_DOMAIN, salt, new Uint8Array(round), VOTE_TAG);
}

// matchId = hex(sha256(gameSeed || contractAddress))[0:16] (spec §6.1)
export function makeMatchId(gameSeed: Uint8Array, contractAddress: string): string {
  return toHex(sha256(gameSeed, ascii(contractAddress))).slice(0, 16);
}
