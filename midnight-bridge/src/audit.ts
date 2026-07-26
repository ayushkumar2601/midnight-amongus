// Audit event log + SSE fan-out + audit_log.json writer (spec §12).
// Rule: publicData NEVER contains roles, salts, killer seats, or voter seats
// before reveal time. Reveals appear only after the session is OVER.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Response } from 'express';
import type {
  AuditEvent, AuditEventKind, AuditEventStatus,
} from './types.js';

export class AuditLog {
  private events: AuditEvent[] = [];
  private subscribers = new Set<Response>();

  constructor(private readonly log: { info: Function; warn: Function }) {}

  record(seqNo: number, kind: AuditEventKind, publicData: Record<string, unknown>): AuditEvent {
    const ev: AuditEvent = {
      seqNo, kind, publicData, status: 'queued', ts: new Date().toISOString(),
    };
    this.events.push(ev);
    this.broadcast(ev);
    return ev;
  }

  setStatus(seqNo: number, status: AuditEventStatus, txId?: string, detail?: string): void {
    const ev = this.events.find((e) => e.seqNo === seqNo);
    if (!ev) return;
    ev.status = status;
    if (txId) ev.txId = txId;
    if (detail) ev.publicData = { ...ev.publicData, detail };
    this.broadcast(ev);
  }

  all(): AuditEvent[] {
    return this.events;
  }

  // --- SSE (spec §9 GET /events): replay full log on connect, then stream ---
  subscribe(res: Response): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    for (const ev of this.events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
    this.subscribers.add(res);
    res.on('close', () => this.subscribers.delete(res));
  }

  private broadcast(ev: AuditEvent): void {
    const line = `data: ${JSON.stringify(ev)}\n\n`;
    for (const res of this.subscribers) {
      try {
        res.write(line);
      } catch {
        this.subscribers.delete(res);
      }
    }
  }

  // --- audit_log.json: full opening written ONLY at game over (spec §11.4) ---
  writeAuditLogFile(payload: Record<string, unknown>): void {
    const file = join(process.cwd(), 'audit_log.json');
    try {
      writeFileSync(file, JSON.stringify(payload, null, 2));
      this.log.info({ file }, 'audit_log.json written');
    } catch (e) {
      this.log.warn({ err: String(e) }, 'failed to write audit_log.json');
    }
  }

  reset(): void {
    this.events = [];
  }
}
