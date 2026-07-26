// Boot: env -> providers -> deploy-or-join -> start HTTP (spec §5, §8).
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import pino from 'pino';
import { loadConfig } from './config.js';
import { TxQueue } from './queue.js';
import { AuditLog } from './audit.js';
import { GameSession } from './game.js';
import { buildApp } from './http.js';
import { MockChainClient, RealChainClient, type ChainClient } from './contractClient.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Minimal .env loader (no extra dependency): KEY=VALUE lines, # comments.
function loadDotEnv(): void {
  const file = join(__dirname, '..', '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trimStart().startsWith('#')) continue;
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) {
      let val = m[2];
      const commentIdx = val.indexOf('#');
      if (commentIdx !== -1) val = val.substring(0, commentIdx);
      process.env[m[1]] = val.trim();
    }
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const cfg = loadConfig();
  const log = pino({ level: cfg.LOG_LEVEL });

  let chain: ChainClient;
  if (cfg.MN_MODE === 'testnet') {
    const { buildProviders } = await import('./providers.js');
    const providers = await buildProviders(cfg, log);
    const real = new RealChainClient(providers);
    await real.init(cfg.MN_CONTRACT_ADDRESS);
    chain = real;
    log.info({ contractAddress: chain.address },
      cfg.MN_CONTRACT_ADDRESS === '' ? 'ShadowLedger deployed fresh' : 'joined existing ShadowLedger');
  } else {
    chain = new MockChainClient();
    log.warn('MN_MODE=mock — simulated ledger (same circuit checks, no real chain). ' +
             'Set MN_MODE=testnet in midnight-bridge/.env for the Midnight testnet.');
  }

  const queue = new TxQueue(log);
  const audit = new AuditLog(log);
  const session = new GameSession(cfg, chain, queue, audit, log);
  const auditHtmlPath = join(__dirname, '..', 'public', 'audit.html');
  const app = buildApp(cfg, session, audit, queue, chain, auditHtmlPath, log);

  const server = createServer(app);
  server.listen(cfg.BRIDGE_PORT, cfg.BRIDGE_BIND, () => {
    log.info({ bind: cfg.BRIDGE_BIND, port: cfg.BRIDGE_PORT, mode: cfg.MN_MODE },
      `midnight-bridge up — dashboard: http://${cfg.BRIDGE_BIND}:${cfg.BRIDGE_PORT}/audit`);
  });
}

main().catch((e) => {
  console.error('[midnight-bridge] fatal:', e?.message ?? e);
  process.exit(1);
});
