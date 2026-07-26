// Bridge tests (spec §15.3) at HTTP level against the mock chain client, which
// enforces the same circuit checks as shadow_ledger.compact — so C-series
// invariants are exercised here too (C2/C5/C9 analogues via B4/B5/B7).
import { beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { loadConfig } from '../src/config.js';
import { MockChainClient } from '../src/contractClient.js';
import { TxQueue } from '../src/queue.js';
import { AuditLog } from '../src/audit.js';
import { GameSession } from '../src/game.js';
import { buildApp } from '../src/http.js';
import { CircuitError } from '../src/types.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const FIXED_SEED = 'ab'.repeat(32);
const PLAYERS = [4213, 88231, 90111, 152003, 731188];

function makeStack(env: Record<string, string> = {}) {
  const cfg = loadConfig({
    MN_MODE: 'mock', DEMO_FIXED_SEED: FIXED_SEED, ...env,
  } as NodeJS.ProcessEnv);
  const chain = new MockChainClient();
  const queue = new TxQueue(silent, 3);
  const audit = new AuditLog(silent);
  const session = new GameSession(cfg, chain, queue, audit, silent);
  const htmlPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'audit.html');
  const app = buildApp(cfg, session, audit, queue, chain, htmlPath, silent);
  return { cfg, chain, queue, audit, session, app };
}

async function req(app: express.Express, method: string, path: string, body?: unknown) {
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json: json as any };
  } finally {
    server.close();
  }
}

const drain = () => new Promise((r) => setTimeout(r, 900));

describe('bridge API', () => {
  let stack: ReturnType<typeof makeStack>;
  beforeEach(() => { stack = makeStack(); });

  it('B1: two deals with the same DEMO_FIXED_SEED are identical (determinism)', async () => {
    const a = await req(stack.app, 'POST', '/deal', { playerIds: PLAYERS });
    expect(a.status).toBe(201);
    const b = makeStack();
    const r2 = await req(b.app, 'POST', '/deal', { playerIds: PLAYERS });
    expect(r2.status).toBe(201);
    expect(r2.json.seatMap).toEqual(a.json.seatMap);
    expect(r2.json.saboteurPlayerId).toBe(a.json.saboteurPlayerId);
  });

  it('deal is idempotent for the same lobby (client coalescing)', async () => {
    const a = await req(stack.app, 'POST', '/deal', { playerIds: PLAYERS });
    const b = await req(stack.app, 'POST', '/deal', { playerIds: [...PLAYERS].reverse() });
    expect(b.status).toBe(201);
    expect(b.json.txId).toBe(a.json.txId);
  });

  it('B2: rapid valid events all 202, seqNos strictly increasing FIFO', async () => {
    const deal = await req(stack.app, 'POST', '/deal', { playerIds: PLAYERS });
    const sab = deal.json.saboteurPlayerId as number;
    const crew = PLAYERS.filter((p) => p !== sab);
    const seqs: number[] = [];
    for (const victim of crew.slice(0, 3)) {
      const r = await req(stack.app, 'POST', '/kill', { killerId: sab, victimId: victim });
      expect(r.status).toBe(202);
      seqs.push(r.json.seqNo);
    }
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    await drain();
    const events = stack.audit.all().filter((e) => e.kind === 'kill');
    expect(events.every((e) => e.status === 'confirmed')).toBe(true);
  });

  it('B4: /kill with a non-saboteur killer -> 409 NOT_SABOTEUR (belt) and the mock circuit also rejects an agent witness (suspenders)', async () => {
    const deal = await req(stack.app, 'POST', '/deal', { playerIds: PLAYERS });
    const sab = deal.json.saboteurPlayerId as number;
    const crew = PLAYERS.filter((p) => p !== sab);
    const r = await req(stack.app, 'POST', '/kill', { killerId: crew[0], victimId: crew[1] });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('NOT_SABOTEUR');
    // suspenders (= C2): agent creds cannot satisfy the kill circuit
    await expect(stack.chain.recordKill(0, { role: 1, seat: 1, salt: new Uint8Array(32) }))
      .rejects.toThrow(CircuitError);
  });

  it('B5: duplicate voter same round -> 409 DUPLICATE', async () => {
    const deal = await req(stack.app, 'POST', '/deal', { playerIds: PLAYERS });
    const sab = deal.json.saboteurPlayerId as number;
    const crew = PLAYERS.filter((p) => p !== sab);
    const first = await req(stack.app, 'POST', '/vote', { voterId: crew[0], targetId: sab });
    expect(first.status).toBe(202);
    const dup = await req(stack.app, 'POST', '/vote', { voterId: crew[0], targetId: crew[1] });
    expect(dup.status).toBe(409);
    expect(dup.json.code).toBe('DUPLICATE');
  });

  it('C6 analogue: same voter can vote again next meeting', async () => {
    const deal = await req(stack.app, 'POST', '/deal', { playerIds: PLAYERS });
    const sab = deal.json.saboteurPlayerId as number;
    const crew = PLAYERS.filter((p) => p !== sab);
    await req(stack.app, 'POST', '/vote', { voterId: crew[0], targetId: null });
    await drain();
    const eject = await req(stack.app, 'POST', '/eject', { round: 0, ejectedId: null });
    expect(eject.status).toBe(202);
    await drain();
    const again = await req(stack.app, 'POST', '/vote', { voterId: crew[0], targetId: null });
    expect(again.status).toBe(202);
  });

  it('B6: /deal with 4 ids, 6 ids, duplicate ids -> 422 with detail', async () => {
    for (const ids of [PLAYERS.slice(0, 4), [...PLAYERS, 999999], [PLAYERS[0], ...PLAYERS.slice(0, 4)]]) {
      const r = await req(makeStack().app, 'POST', '/deal', { playerIds: ids });
      expect(r.status).toBe(422);
      expect(r.json.code).toBe('BAD_REQUEST');
    }
  });

  it('B7: wrong-state calls — /kill when IDLE, /gameover twice', async () => {
    const idleKill = await req(stack.app, 'POST', '/kill', { killerId: 1, victimId: 2 });
    expect(idleKill.status).toBe(409);
    expect(idleKill.json.code).toBe('WRONG_STATE');

    await req(stack.app, 'POST', '/deal', { playerIds: PLAYERS });
    const g1 = await req(stack.app, 'POST', '/gameover', { winner: 2, reason: 'kills' });
    expect(g1.status).toBe(202);
    expect(g1.json.auditReveals).toBe(5);
    const g2 = await req(stack.app, 'POST', '/gameover', { winner: 2, reason: 'kills' });
    expect(g2.status).toBe(409);
    expect(g2.json.code).toBe('WRONG_STATE');
  });

  it('B8: /audit/data before OVER has no reveals and leaks no role/salt', async () => {
    const deal = await req(stack.app, 'POST', '/deal', { playerIds: PLAYERS });
    const sab = deal.json.saboteurPlayerId as number;
    const crew = PLAYERS.filter((p) => p !== sab);
    await req(stack.app, 'POST', '/kill', { killerId: sab, victimId: crew[0] });
    const r = await req(stack.app, 'GET', '/audit/data');
    expect(r.status).toBe(200);
    expect(r.json.reveals).toEqual([]);
    const raw = JSON.stringify(r.json);
    expect(raw).not.toMatch(/"role"/);
    expect(raw).not.toMatch(/"salt/i);
    expect(raw).not.toMatch(/saboteur/i);
    expect(raw).not.toMatch(/killerSeat|voterSeat/);
  });

  it('C9 analogue: saboteur ejected then declareWinner(2) rejected, (1) accepted', async () => {
    const deal = await req(stack.app, 'POST', '/deal', { playerIds: PLAYERS });
    const sab = deal.json.saboteurPlayerId as number;
    const crew = PLAYERS.filter((p) => p !== sab);
    await req(stack.app, 'POST', '/vote', { voterId: crew[0], targetId: sab });
    await drain();
    const eject = await req(stack.app, 'POST', '/eject', { round: 0, ejectedId: sab });
    expect(eject.status).toBe(202);
    expect(eject.json.willReveal).toBe(true);
    await drain();
    // wrong winner is rejected by the (mock) contract consistency guard
    await expect(stack.chain.declareWinner(2)).rejects.toThrow(CircuitError);
    await expect(stack.chain.declareWinner(1)).resolves.toBeTruthy();
  });

  it('gameover produces 5/5 verified reveals in /audit/data', async () => {
    await req(stack.app, 'POST', '/deal', { playerIds: PLAYERS });
    await req(stack.app, 'POST', '/gameover', { winner: 2, reason: 'kills' });
    await drain();
    await drain();
    const r = await req(stack.app, 'GET', '/audit/data');
    expect(r.json.reveals).toHaveLength(5);
    expect(r.json.reveals.every((x: any) => x.match === true)).toBe(true);
    expect(r.json.reveals.filter((x: any) => x.role === 2)).toHaveLength(1);
  });

  it('/eject with a stale round -> 422 (duplicate protection across clients)', async () => {
    const deal = await req(stack.app, 'POST', '/deal', { playerIds: PLAYERS });
    const sab = deal.json.saboteurPlayerId as number;
    const crew = PLAYERS.filter((p) => p !== sab);
    await req(stack.app, 'POST', '/vote', { voterId: crew[0], targetId: null });
    await drain();
    await req(stack.app, 'POST', '/eject', { round: 0, ejectedId: null });
    const stale = await req(stack.app, 'POST', '/eject', { round: 0, ejectedId: null });
    expect(stale.status).toBe(422);
  });

  it('/health reports mode + session', async () => {
    const r = await req(stack.app, 'GET', '/health');
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.mode).toBe('mock');
    expect(r.json.session).toBe('IDLE');
  });

  it('dev-mode /reset returns the session to IDLE', async () => {
    await req(stack.app, 'POST', '/deal', { playerIds: PLAYERS });
    const r = await req(stack.app, 'POST', '/reset');
    expect(r.status).toBe(200);
    const h = await req(stack.app, 'GET', '/health');
    expect(h.json.session).toBe('IDLE');
  });
});
