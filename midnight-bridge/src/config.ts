// Env parsing + validation (spec §4.4, §8). zod-validated; fails loudly on boot.
import { z } from 'zod';

const hex = (len: number) =>
  z.string().regex(new RegExp(`^[0-9a-fA-F]{${len}}$`), `expected ${len} hex chars`);

const schema = z.object({
  // --- network ---
  // VERIFY-AGAINST-DOCS: exact enum name in @midnight-ntwrk/midnight-js-network-id
  MN_NETWORK_ID: z.string().default('TestNet'),
  MN_INDEXER_URL: z.string().default(''),
  MN_INDEXER_WS_URL: z.string().default(''),
  MN_NODE_URL: z.string().default(''),
  MN_PROOF_SERVER_URL: z.string().default('http://127.0.0.1:6300'),
  // Block-explorer base for on-chain links on the audit dashboard. Subscan runs
  // the Midnight instance with standard Substrate routes:
  //   tx      -> {base}/extrinsic/{hash}
  //   account -> {base}/account/{address}
  // Used only when MN_MODE=testnet (mock tx hashes exist on no public chain).
  MN_EXPLORER_URL: z.string().default('https://midnight.subscan.io'),
  // --- wallet ---
  MN_DEPLOYER_SEED: hex(64).or(z.literal('')).default(''),
  // --- contract ---
  MN_CONTRACT_ADDRESS: z.string().default(''),   // empty => deploy fresh on boot
  // --- bridge ---
  BRIDGE_PORT: z.coerce.number().int().default(8088),
  BRIDGE_BIND: z.string().default('127.0.0.1'),  // localhost only; never expose
  LOG_LEVEL: z.string().default('info'),
  DEMO_FIXED_SEED: hex(64).or(z.literal('')).default(''), // test-mode deterministic deal (B1)
  // --- mode ---
  // 'testnet' = real Midnight testnet via providers + compiled contract (spec).
  // 'mock'    = in-process simulated ledger enforcing the same circuit checks;
  //             lets the full game + dashboard run before toolchain/faucet are up.
  MN_MODE: z.enum(['mock', 'testnet']).default('mock'),
  // Match size. 5 is the spec-locked size (1 saboteur + 4 agents). 2..4 allowed
  // for dev so you can test with fewer game windows; unused seats become
  // committed AGENT "ghost" seats so the 5-seat contract shape is unchanged.
  MN_REQUIRED_PLAYERS: z.coerce.number().int().min(2).max(5).default(5),
  NODE_ENV: z.string().default('development'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`invalid environment: ${detail}`);
  }
  const cfg = parsed.data;
  if (cfg.MN_MODE === 'testnet') {
    const missing = (['MN_INDEXER_URL', 'MN_INDEXER_WS_URL', 'MN_NODE_URL'] as const)
      .filter((k) => cfg[k] === '');
    if (missing.length > 0) {
      throw new Error(`MN_MODE=testnet requires ${missing.join(', ')} (docs quickstart URLs)`);
    }
    if (cfg.MN_DEPLOYER_SEED === '') {
      throw new Error('MN_MODE=testnet requires MN_DEPLOYER_SEED (64-hex, fund via faucet)');
    }
  }
  return cfg;
}
