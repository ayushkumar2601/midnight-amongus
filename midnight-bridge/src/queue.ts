// Serialized tx queue (spec §13.1). Single worker, strict FIFO by seqNo, one
// in-flight tx at a time (avoids nonce/ordering races). Each job:
// build witness -> prove -> submit -> confirm, emitting a status transition at
// every step. Transient failures retry with exponential backoff (1s..30s cap,
// max 10 attempts) then mark failed and CONTINUE — one poisoned tx must not
// stall the match record. CircuitError is non-retryable by definition.

import { CircuitError, type AuditEventStatus, type TxRef } from './types.js';

export interface TxJob {
  seqNo: number;
  run: () => Promise<TxRef>;
  onStatus: (status: AuditEventStatus, txId?: string, detail?: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class TxQueue {
  private jobs: TxJob[] = [];
  private running = false;
  private seq = 0;

  constructor(
    private readonly log: { warn: Function; error: Function },
    private readonly maxAttempts = 10,
  ) {}

  nextSeqNo(): number {
    return this.seq++;
  }

  get depth(): number {
    return this.jobs.length + (this.running ? 1 : 0);
  }

  enqueue(job: TxJob): void {
    this.jobs.push(job);
    job.onStatus('queued');
    if (this.depth > 20) {
      this.log.warn({ depth: this.depth }, 'tx queue depth > 20 — proofs slower than game pace');
    }
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const job = this.jobs.shift();
        if (!job) break;
        await this.process(job);
      }
    } finally {
      this.running = false;
    }
  }

  private async process(job: TxJob): Promise<void> {
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      try {
        job.onStatus('proving');
        const ref = await job.run();
        job.onStatus('confirmed', ref.txId);
        return;
      } catch (e: any) {
        if (e instanceof CircuitError) {
          // Logic bug or forgery attempt: never retry (spec §13.1).
          this.log.error({ seqNo: job.seqNo, err: e.message }, 'circuit rejection — non-retryable');
          job.onStatus('failed', undefined, e.message);
          return;
        }
        const backoff = Math.min(1000 * 2 ** attempt, 30_000);
        this.log.warn(
          { seqNo: job.seqNo, attempt, backoff, err: String(e?.message ?? e) },
          'tx attempt failed — retrying');
        await sleep(backoff);
      }
    }
    job.onStatus('failed', undefined, `gave up after ${this.maxAttempts} attempts`);
  }
}
