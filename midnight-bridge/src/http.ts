// Express app + routes (spec §9). Localhost-only by binding; no auth in v1
// (documented). Every mutating route is zod-validated -> 400 BAD_REQUEST with
// field detail. All errors use the BridgeError shape.

import express, { type NextFunction, type Request, type Response } from 'express';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { Config } from './config.js';
import type { GameSession } from './game.js';
import { ApiError } from './game.js';
import type { AuditLog } from './audit.js';
import type { TxQueue } from './queue.js';
import type { ChainClient } from './contractClient.js';
import type { BridgeError } from './types.js';

const dealSchema = z.object({ playerIds: z.array(z.number().int().positive()) });
const tokenSchema = z.object({ amount: z.number().int().positive() });
const killSchema = z.object({ killerId: z.number().int().positive(), victimId: z.number().int().positive() });
const voteSchema = z.object({ voterId: z.number().int().positive(), targetId: z.number().int().positive().nullable() });
const ejectSchema = z.object({ round: z.number().int().min(0), ejectedId: z.number().int().positive().nullable() });
const gameoverSchema = z.object({ winner: z.union([z.literal(1), z.literal(2)]), reason: z.enum(['tasks', 'ejection', 'kills', 'sabotage']) });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) {
    const detail = r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ApiError(400, 'BAD_REQUEST', 'invalid request body', detail);
  }
  return r.data;
}

export function buildApp(
  cfg: Config,
  session: GameSession,
  audit: AuditLog,
  queue: TxQueue,
  chain: ChainClient,
  auditHtmlPath: string,
  log: { info: Function; warn: Function },
): express.Express {
  const app = express();
  app.use(express.json());

  // Dashboard assets: compiled audit.js + local Geist woff2 files.
  // audit.js is served no-store so a rebuilt dashboard is never mixed with a
  // stale cached script (that mismatch silently breaks the rendered layout).
  app.use(express.static(dirname(auditHtmlPath), {
    index: false,
    etag: false,
    lastModified: false,
    setHeaders: (res, path) => {
      if (path.endsWith('.js') || path.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
      else res.setHeader('Cache-Control', 'public, max-age=86400'); // fonts
    },
  }));

  // GET /health — liveness + dependency check (Phase 0/3 gate, demo preflight)
  app.get('/health', async (_req, res) => {
    try {
      const h = await chain.health();
      const ok = cfg.MN_MODE === 'mock' || (h.proofServer !== 'down' && h.indexer !== 'down');
      res.status(ok ? 200 : 503).json({
        ok,
        mode: cfg.MN_MODE,
        network: cfg.MN_MODE === 'mock' ? 'Mock (local)' : cfg.MN_NETWORK_ID,
        contractAddress: chain.address,
        walletAddress: h.walletAddress,
        balanceTDust: h.balanceTDust,
        proofServer: h.proofServer,
        indexer: h.indexer,
        queueDepth: queue.depth,
        session: session.state,
        ...(ok ? {} : { code: 'CHAIN_UNAVAILABLE' }),
      });
    } catch (e: any) {
      res.status(503).json({
        ok: false, error: 'chain unavailable', code: 'CHAIN_UNAVAILABLE',
        detail: String(e?.message ?? e),
      } satisfies BridgeError & { ok: boolean });
    }
  });

  // POST /deal — synchronous: the one route that waits for chain confirmation
  app.post('/deal', async (req, res, next) => {
    try {
      const body = parse(dealSchema, req.body);
      const result = await session.deal(body.playerIds);
      res.status(201).json(result);
    } catch (e) {
      next(e);
    }
  });

  // POST /commit — alias route for role & seat commitments check
  app.post('/commit', async (req, res, next) => {
    try {
      const body = parse(dealSchema, req.body);
      const result = await session.commit(body.playerIds);
      res.status(200).json(result);
    } catch (e) {
      next(e);
    }
  });

  // GET /token/balance — Night Coin token balance query
  app.get('/token/balance', async (_req, res, next) => {
    try {
      const result = await session.getTokenBalance();
      res.status(200).json(result);
    } catch (e) {
      next(e);
    }
  });

  // POST /token/stake — deduct entry stake for a match
  app.post('/token/stake', async (req, res, next) => {
    try {
      const body = parse(tokenSchema, req.body);
      const result = await session.stakeTokens(body.amount);
      res.status(200).json(result);
    } catch (e) {
      next(e);
    }
  });

  // POST /token/reward — award victory bounty
  app.post('/token/reward', async (req, res, next) => {
    try {
      const body = parse(tokenSchema, req.body);
      const result = await session.rewardTokens(body.amount);
      res.status(200).json(result);
    } catch (e) {
      next(e);
    }
  });

  // POST /kill — async: validate + enqueue, proof/tx in the queue worker
  app.post('/kill', (req, res, next) => {
    try {
      const body = parse(killSchema, req.body);
      const seqNo = session.kill(body.killerId, body.victimId);
      res.status(202).json({ accepted: true, seqNo });
    } catch (e) {
      next(e);
    }
  });

  // POST /vote — first vote of a round auto-queues startMeeting
  app.post('/vote', (req, res, next) => {
    try {
      const body = parse(voteSchema, req.body);
      const seqNo = session.vote(body.voterId, body.targetId);
      res.status(202).json({ accepted: true, seqNo });
    } catch (e) {
      next(e);
    }
  });

  // POST /eject — ejectedId null = tie/skip -> endMeetingNoEjection
  app.post('/eject', (req, res, next) => {
    try {
      const body = parse(ejectSchema, req.body);
      const { seqNo, willReveal } = session.eject(body.round, body.ejectedId);
      res.status(202).json({ accepted: true, seqNo, willReveal });
    } catch (e) {
      next(e);
    }
  });

  // POST /gameover — queues declareWinner + 5 × auditReveal
  app.post('/gameover', (req, res, next) => {
    try {
      const body = parse(gameoverSchema, req.body);
      const { auditReveals } = session.gameover(body.winner, body.reason);
      res.status(202).json({ accepted: true, auditReveals });
    } catch (e) {
      next(e);
    }
  });

  // POST /reset — dev/demo only (guarded per spec §9)
  app.post('/reset', (_req, res) => {
    if (cfg.NODE_ENV === 'production') {
      res.status(404).json({ error: 'not found', code: 'BAD_REQUEST' } satisfies BridgeError);
      return;
    }
    session.reset();
    res.json({ ok: true });
  });

  // GET /events — SSE stream of AuditEvent (replay + live)
  app.get('/events', (_req, res) => {
    audit.subscribe(res);
  });

  // GET /audit — the judge-facing dashboard
  app.get('/audit', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(readFileSync(auditHtmlPath, 'utf8'));
  });

  // GET /audit/data — verification payload (reveals only after OVER)
  app.get('/audit/data', (_req, res) => {
    res.json(session.auditData());
  });

  // error handler: BridgeError shape everywhere
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiError) {
      const body: BridgeError = { error: err.message, code: err.code };
      if (err.detail) body.detail = err.detail;
      res.status(err.status).json(body);
      return;
    }
    log.warn({ err: String((err as any)?.message ?? err) }, 'unhandled error');
    res.status(500).json({ error: 'internal error', code: 'INTERNAL' } satisfies BridgeError);
  });

  return app;
}
