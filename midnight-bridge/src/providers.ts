// Midnight providers wiring (spec §8.2) — testnet mode only; mock mode never
// imports any @midnight-ntwrk package.
//
// Aligned with the installed @midnight-ntwrk/* 4.1.1 typings:
//   * setNetworkId(id: string)
//   * indexerPublicDataProvider(queryURL, subscriptionURL)
//   * new NodeZkConfigProvider(directory)
//   * httpClientProofProvider(url, zkConfigProvider)
//   * levelPrivateStateProvider({ privateStoragePasswordProvider, accountId })
//
// VERIFY-AGAINST-DOCS (Phase 2 task): the headless deployer wallet. wallet-sdk
// 1.0.0 is a modular facade (shielded/unshielded/dust/hd); copy the exact
// wallet-from-seed helper from the current example-bboard (its testkit wiring)
// and finish buildWallet() below. Everything else here is ready.

import type { Config } from './config.js';

export interface Providers {
  midnight: any;                       // provider bundle passed to deploy/find/call
  health(): Promise<{
    proofServer: 'up' | 'down' | 'n/a';
    indexer: 'up' | 'down' | 'n/a';
    walletAddress: string;
    balanceTDust: string;
  }>;
}

const MANAGED_DIR = new URL('../contract/src/managed', import.meta.url).pathname;

// VERIFY-AGAINST-DOCS: transcribe from example-bboard's wallet helper.
// Must return: { walletProvider, midnightProvider, address, balance } built
// from the 64-hex MN_DEPLOYER_SEED, synced against indexer/node/proof server.
async function buildWallet(cfg: Config): Promise<{
  walletProvider: any; midnightProvider: any; address: string; balance: bigint;
}> {
  const { WalletFacade } = await import('@midnight-ntwrk/wallet-sdk');
  const { HDWallet, Roles } = await import('@midnight-ntwrk/wallet-sdk-hd');
  const { ShieldedWallet } = await import('@midnight-ntwrk/wallet-sdk-shielded');
  const { UnshieldedWallet, createKeystore, PublicKey } = await import('@midnight-ntwrk/wallet-sdk-unshielded-wallet');
  const { DustWallet } = await import('@midnight-ntwrk/wallet-sdk-dust-wallet');
  const ledger = await import('@midnight-ntwrk/ledger-v8');

  const seed = Buffer.from(cfg.MN_DEPLOYER_SEED, 'hex');
  const hdResult = HDWallet.fromSeed(seed);
  if (hdResult.type !== 'seedOk') {
    throw new Error('Failed to derive HDWallet from seed');
  }

  const accountKey = hdResult.hdWallet.selectAccount(0);
  const zswapRole = accountKey.selectRole(Roles.Zswap).deriveKeyAt(0);
  const dustRole = accountKey.selectRole(Roles.Dust).deriveKeyAt(0);
  const unshieldedRole = accountKey.selectRole(Roles.NightExternal).deriveKeyAt(0);

  if (zswapRole.type !== 'keyDerived' || dustRole.type !== 'keyDerived' || unshieldedRole.type !== 'keyDerived') {
    throw new Error('Failed to derive one or more role keys from HDWallet');
  }

  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(zswapRole.key);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(dustRole.key);
  const keystore = createKeystore(unshieldedRole.key, cfg.MN_NETWORK_ID as any);
  const publicKey = PublicKey.fromKeyStore(keystore);
  const dustParams = ledger.LedgerParameters.initialParameters().dust;

  const configuration = {
    networkId: cfg.MN_NETWORK_ID,
    indexerClientConnection: {
      indexerHttpUrl: cfg.MN_INDEXER_URL,
      indexerWsUrl: cfg.MN_INDEXER_WS_URL,
    },
    nodeClientConnection: {
      nodeHttpUrl: cfg.MN_NODE_URL,
    },
    provingServerConnection: {
      provingServerUrl: cfg.MN_PROOF_SERVER_URL,
    },
  } as any;

  const facade = await WalletFacade.init({
    configuration,
    shielded: (c: any) => ShieldedWallet(c).startWithSecretKeys(shieldedSecretKeys),
    unshielded: (c: any) => UnshieldedWallet(c).startWithPublicKey(publicKey),
    dust: (c: any) => DustWallet(c).startWithSecretKey(dustSecretKey, dustParams),
  });

  await facade.start(shieldedSecretKeys, dustSecretKey);
  const state = await facade.waitForSyncedState();
  let currentShieldedState = state.shielded;
  facade.shielded.state.subscribe((s: any) => { currentShieldedState = s; });

  const address = publicKey.address;
  const nativeType = ledger.nativeToken().raw;
  const balance = BigInt(state.unshielded.balances[nativeType] ?? 0n);

  const walletProvider = {
    balanceTx: async (tx: any, ttl?: Date) => {
      const recipe = await facade.balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys, dustSecretKey },
        { ttl: ttl ?? new Date(Date.now() + 3600_000) },
      );
      const signedRecipe = await facade.signRecipe(recipe, (data: Uint8Array) => keystore.signData(data));
      return await facade.finalizeRecipe(signedRecipe);
    },
    getCoinPublicKey: () => currentShieldedState.coinPublicKey as any,
    getEncryptionPublicKey: () => currentShieldedState.encryptionPublicKey as any,
  };

  const midnightProvider = {
    submitTx: async (tx: any) => {
      return await facade.submitTransaction(tx);
    },
  };

  return { walletProvider, midnightProvider, address, balance };
}

export async function buildProviders(
  cfg: Config,
  log: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void },
): Promise<Providers> {
  const { setNetworkId } = await import('@midnight-ntwrk/midnight-js-network-id');
  // NetworkId is a plain string in 4.1.1; docs quickstart gives the exact value.
  setNetworkId(cfg.MN_NETWORK_ID);

  const { indexerPublicDataProvider } = await import('@midnight-ntwrk/midnight-js-indexer-public-data-provider');
  const { NodeZkConfigProvider } = await import('@midnight-ntwrk/midnight-js-node-zk-config-provider');
  const { httpClientProofProvider } = await import('@midnight-ntwrk/midnight-js-http-client-proof-provider');
  const { levelPrivateStateProvider } = await import('@midnight-ntwrk/midnight-js-level-private-state-provider');

  const publicDataProvider = indexerPublicDataProvider(cfg.MN_INDEXER_URL, cfg.MN_INDEXER_WS_URL);
  const zkConfigProvider = new NodeZkConfigProvider(MANAGED_DIR);
  const proofProvider = httpClientProofProvider(cfg.MN_PROOF_SERVER_URL, zkConfigProvider as any);

  const { walletProvider, midnightProvider, address, balance } = await buildWallet(cfg);
  log.info({ walletAddress: address, balanceTDust: String(balance) }, 'deployer wallet ready');
  if (balance === 0n) {
    throw new Error(`deployer balance is 0 — fund ${address} via the testnet faucet`);
  }

  const privateStateProvider = levelPrivateStateProvider({
    privateStoragePasswordProvider: async () => cfg.MN_DEPLOYER_SEED,
    accountId: address,
  } as any);

  const midnight = {
    publicDataProvider,
    zkConfigProvider,
    proofProvider,
    privateStateProvider,
    walletProvider,
    midnightProvider,
  };

  const ping = async (url: string): Promise<'up' | 'down'> => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      return res.status < 500 ? 'up' : 'down';
    } catch {
      return 'down';
    }
  };

  return {
    midnight,
    health: async () => ({
      proofServer: await ping(cfg.MN_PROOF_SERVER_URL),
      indexer: await ping(cfg.MN_INDEXER_URL),
      walletAddress: address,
      balanceTDust: String(balance),
    }),
  };
}
