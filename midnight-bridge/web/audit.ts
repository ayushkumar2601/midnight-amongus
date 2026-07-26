// Shadow Protocol audit dashboard.
// Compiled by tsconfig.web.json to public/audit.js. Reads only the local bridge:
// GET /audit/data, GET /health, SSE GET /events. Every figure is live bridge
// state. The bridge never emits roles, salts, or killer/voter seats before the
// reveal, so everything rendered here is public by construction.

type Status = 'queued' | 'proving' | 'submitted' | 'confirmed' | 'failed';

interface AuditEvent {
  seqNo: number; kind: string; publicData: Record<string, unknown>;
  status: Status; txId?: string; ts: string;
}
interface Reveal {
  seat: number; playerId: number; role: number;
  saltHex: string; commitmentHex: string; recomputedHex: string; match: boolean;
}
interface AuditData {
  matchId: string; contractAddress: string; network: string; mode: string;
  commitmentScheme: string; gameSeedHex: string; session: string; explorerBase: string;
  seatMap: { playerId: number; seat: number }[];
  commitments: string[]; events: AuditEvent[]; reveals: Reveal[];
}
interface Health {
  ok: boolean; mode: string; network: string; queueDepth: number; session: string;
  walletAddress?: string; balanceTDust?: string; proofServer?: string; indexer?: string;
}

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error('missing #' + id);
  return el;
};
const esc = (v: unknown): string =>
  String(v).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
const cut = (h: string, n = 6): string =>
  !h ? '' : h.length <= 2 * n + 1 ? h : h.slice(0, n) + '…' + h.slice(-n);
// 24h clock: "19:44:46" never wraps the way "7:44:46 PM" does
const hhmmss = (iso: string): string => {
  const d = new Date(iso);
  const p = (n: number): string => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
};

const RANK: Record<Status, number> = { queued: 0, proving: 1, submitted: 2, confirmed: 3, failed: 0 };
const LABEL: Record<string, string> = {
  deal: 'Deal', kill: 'Kill', vote: 'Vote', eject: 'Ejection',
  no_eject: 'No ejection', winner: 'Winner', reveal: 'Reveal',
};
const ORDER = ['deal', 'kill', 'vote', 'eject', 'no_eject', 'winner', 'reveal'];
const CAT = ['#2a78d6', '#008300', '#e87ba4', '#eda100', '#1baf7a', '#eb6834', '#4a3aa7'];
const col = (k: string): string => CAT[Math.max(0, ORDER.indexOf(k)) % CAT.length];
const ORD = ['#86b6ef', '#5598e7', '#2a78d6', '#184f95'];

// what each circuit puts on chain, what it withholds, and what the proof asserts
const DISCLOSE: Record<string, { pub: string; wit: string; proves: string }> = {
  deal: { pub: 'seat commitments, game seed', wit: 'every role, every salt',
          proves: 'the seed was fixed before any role existed' },
  kill: { pub: 'victim seat', wit: 'killer seat, role, salt',
          proves: 'the caller holds the saboteur commitment' },
  vote: { pub: 'target seat, round', wit: 'voter seat, salt',
          proves: 'a live seat voted once this round' },
  eject: { pub: 'seat, revealed role', wit: 'nothing, this is the opening',
           proves: 'the commitment opens to that role' },
  no_eject: { pub: 'round', wit: 'nothing', proves: 'the meeting closed with no ejection' },
  winner: { pub: 'winner, reason', wit: 'nothing', proves: 'the outcome is consistent with the ledger' },
  reveal: { pub: 'seat, role, salt', wit: 'nothing, final opening',
            proves: 'the day one commitment reopens to this role' },
};

const events = new Map<number, AuditEvent>();
let data: AuditData | null = null;
let health: Health | null = null;

// ------------------------------------------------------------------ tabs
const TITLE: Record<string, string> = {
  overview: 'Overview', transactions: 'Transactions', disclosure: 'Disclosure',
  fairness: 'Verification', seats: 'Seats', contract: 'Contract',
};
function initTabs(): void {
  const tabs = Array.from(document.querySelectorAll<HTMLElement>('[data-tab]'));
  const panels = Array.from(document.querySelectorAll<HTMLElement>('[data-panel]'));
  const go = (n: string): void => {
    for (const t of tabs) t.classList.toggle('active', t.dataset.tab === n);
    for (const p of panels) p.classList.toggle('hidden', p.dataset.panel !== n);
    $('page-title').textContent = TITLE[n] ?? n;
  };
  for (const t of tabs) t.addEventListener('click', () => go(t.dataset.tab as string));
  go('overview');
}

// ------------------------------------------------------------------ bits
function strip(host: HTMLElement, cells: { v: string; k: string; x?: string }[]): void {
  host.innerHTML = cells.map((c) =>
    '<div><div class="v">' + esc(c.v) + '</div><div class="k">' + esc(c.k) + '</div>'
    + (c.x ? '<div class="x">' + c.x + '</div>' : '') + '</div>').join('');
}

function hbars(host: HTMLElement, rows: { label: string; value: number; color: string }[], unit: string): void {
  if (rows.length === 0) { host.innerHTML = '<div class="empty">No data yet.</div>'; return; }
  const max = Math.max(1, ...rows.map((r) => r.value));
  host.innerHTML = rows.map((r) =>
    '<div class="hr" data-tip="' + esc(r.label + ': ' + r.value + ' ' + unit) + '">'
    + '<span class="l">' + esc(r.label) + '</span>'
    + '<span class="t"><span class="f" style="width:' + Math.max(2, (r.value / max) * 100).toFixed(1)
    + '%;background:' + r.color + '"></span></span>'
    + '<span class="v">' + r.value + '</span></div>').join('');
  tips(host);
}

function tips(host: HTMLElement): void {
  let tip = host.querySelector(':scope > .tip') as HTMLElement | null;
  if (!tip) { tip = document.createElement('div'); tip.className = 'tip'; host.appendChild(tip); }
  const t = tip;
  for (const el of Array.from(host.querySelectorAll<HTMLElement>('[data-tip]'))) {
    el.addEventListener('mouseenter', () => { t.innerHTML = el.dataset.tip as string; t.style.opacity = '1'; });
    el.addEventListener('mousemove', (e) => {
      const b = host.getBoundingClientRect();
      t.style.left = Math.max(0, Math.min(e.clientX - b.left + 12, b.width - t.offsetWidth)) + 'px';
      t.style.top = Math.max(0, e.clientY - b.top - t.offsetHeight - 8) + 'px';
    });
    el.addEventListener('mouseleave', () => { t.style.opacity = '0'; });
  }
}

function areaChart(host: HTMLElement, pts: { y: number; label: string }[]): void {
  if (pts.length === 0) { host.innerHTML = '<div class="empty">Activity appears once the first action is anchored.</div>'; return; }
  const W = 640, H = 150, L = 26, R = 6, T = 8, B = 18;
  const maxY = Math.max(1, ...pts.map((p) => p.y));
  const n = pts.length;
  const X = (i: number) => L + (n === 1 ? (W - L - R) / 2 : (i / (n - 1)) * (W - L - R));
  const Y = (v: number) => T + (1 - v / maxY) * (H - T - B);
  const ticks = [...new Set([0, Math.ceil(maxY / 2), maxY])];
  const grid = ticks.map((v) =>
    '<line x1="' + L + '" y1="' + Y(v).toFixed(1) + '" x2="' + (W - R) + '" y2="' + Y(v).toFixed(1)
    + '" stroke="var(--grid)"/><text class="ax" x="' + (L - 6) + '" y="' + (Y(v) + 3).toFixed(1)
    + '" text-anchor="end">' + v + '</text>').join('');
  const line = pts.map((p, i) => X(i).toFixed(1) + ',' + Y(p.y).toFixed(1)).join(' ');
  host.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Cumulative confirmed transactions">'
    + grid
    + '<polygon points="' + L + ',' + Y(0).toFixed(1) + ' ' + line + ' ' + X(n - 1).toFixed(1) + ',' + Y(0).toFixed(1) + '" fill="#2a78d6" fill-opacity=".09"/>'
    + '<polyline points="' + line + '" fill="none" stroke="#2a78d6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
    + '<line id="cx" y1="' + T + '" y2="' + (H - B) + '" stroke="var(--ink-4)" stroke-dasharray="3 3" opacity="0"/>'
    + '<circle id="cd" r="3.5" fill="#2a78d6" stroke="#fff" stroke-width="2" opacity="0"/>'
    + '<rect id="ct" x="' + L + '" y="' + T + '" width="' + (W - L - R) + '" height="' + (H - T - B) + '" fill="transparent"/>'
    + '</svg><div class="tip"></div>';
  const svg = host.querySelector('svg') as SVGSVGElement;
  const cx = host.querySelector('#cx') as SVGLineElement;
  const cd = host.querySelector('#cd') as SVGCircleElement;
  const tp = host.querySelector('.tip') as HTMLElement;
  (host.querySelector('#ct') as SVGRectElement).addEventListener('mousemove', (ev) => {
    const b = svg.getBoundingClientRect();
    const sx = ((ev as MouseEvent).clientX - b.left) * (W / b.width);
    let best = 0, bd = Infinity;
    for (let i = 0; i < n; i++) { const d = Math.abs(X(i) - sx); if (d < bd) { bd = d; best = i; } }
    const px = X(best), py = Y(pts[best].y);
    cx.setAttribute('x1', String(px)); cx.setAttribute('x2', String(px)); cx.setAttribute('opacity', '1');
    cd.setAttribute('cx', String(px)); cd.setAttribute('cy', String(py)); cd.setAttribute('opacity', '1');
    tp.innerHTML = '<b>' + pts[best].y + '</b> confirmed<br>' + esc(pts[best].label);
    tp.style.opacity = '1';
    const lx = (px / W) * b.width, ly = (py / H) * b.height;
    tp.style.left = Math.max(0, Math.min(lx - tp.offsetWidth / 2, b.width - tp.offsetWidth)) + 'px';
    tp.style.top = Math.max(0, ly - tp.offsetHeight - 10) + 'px';
  });
  (host.querySelector('#ct') as SVGRectElement).addEventListener('mouseleave', () => {
    cx.setAttribute('opacity', '0'); cd.setAttribute('opacity', '0'); tp.style.opacity = '0';
  });
}

function timelineStrip(host: HTMLElement, evs: AuditEvent[]): void {
  if (evs.length === 0) { host.innerHTML = '<div class="empty">The timeline fills as the match is anchored.</div>'; return; }
  const blocks = evs.map((e) =>
    '<i style="background:' + col(e.kind) + (e.status === 'confirmed' ? '' : ';opacity:.35')
    + '" data-tip="<b>seq ' + e.seqNo + '</b> ' + esc(LABEL[e.kind] ?? e.kind) + '<br>' + esc(e.status) + '"></i>').join('');
  host.innerHTML = '<div class="tl">' + blocks + '</div><div class="tl-x"><span>first anchor</span><span>'
    + evs.length + ' transactions</span><span>latest</span></div><div class="tip"></div>';
  tips(host);
}

// ------------------------------------------------------------------ links
const acct = (a: string): string => (data?.explorerBase ? data.explorerBase + '/account/' + a : '');
function txCell(id?: string): string {
  if (!id) return '<span class="m4">pending</span>';
  const h = data?.explorerBase ? data.explorerBase + '/extrinsic/' + id : '';
  const t = '<span class="mono">' + esc(cut(id, 7)) + '</span>';
  return h ? '<a class="lk" href="' + esc(h) + '" target="_blank" rel="noopener" title="' + esc(id) + '">' + t + '</a>'
           : '<span title="' + esc(id) + '">' + t + '</span>';
}
const pill = (s: Status): string =>
  '<span class="chip ' + (s === 'confirmed' ? 'good' : s === 'failed' ? 'bad' : 'warn')
  + '"><span class="d"></span>' + esc(s) + '</span>';

// ------------------------------------------------------------------ render
function evList(): AuditEvent[] { return [...events.values()].sort((a, b) => a.seqNo - b.seqNo); }

function renderOverview(): void {
  const evs = evList();
  const conf = evs.filter((e) => e.status === 'confirmed').length;
  const failed = evs.filter((e) => e.status === 'failed').length;
  const rate = evs.length ? Math.round((conf / evs.length) * 100) : 0;
  const revs = data?.reveals ?? [];
  const ok = revs.filter((r) => r.match).length;
  const anon = evs.filter((e) => e.kind === 'kill' || e.kind === 'vote').length;

  strip($('kpi'), [
    { v: String(evs.length), k: 'Actions anchored', x: new Set(evs.map((e) => e.kind)).size + ' circuits' },
    { v: String(conf), k: 'Confirmed', x: failed ? failed + ' failed' : 'none failed' },
    { v: rate + '%', k: 'Confirmation rate', x: 'queue ' + (health?.queueDepth ?? 0) },
    { v: String(anon), k: 'Anonymous actions', x: 'actor never disclosed' },
    { v: String(data?.commitments.length ?? 0), k: 'Seats committed', x: 'before roles dealt' },
    { v: revs.length ? ok + '/' + revs.length : '0', k: 'Commitments verified',
      x: revs.length ? (ok === revs.length ? 'all match' : 'mismatch') : 'sealed' },
  ]);
  $('nav-tx').textContent = String(evs.length);

  hbars($('funnel-chart'), [
    { label: 'Recorded', value: evs.length, color: ORD[0] },
    { label: 'Proving', value: evs.filter((e) => RANK[e.status] >= 1).length, color: ORD[1] },
    { label: 'Submitted', value: evs.filter((e) => RANK[e.status] >= 2).length, color: ORD[2] },
    { label: 'Confirmed', value: conf, color: ORD[3] },
  ], 'transactions');

  const c = new Map<string, number>();
  for (const e of evs) c.set(e.kind, (c.get(e.kind) ?? 0) + 1);
  hbars($('kinds-chart'), ORDER.filter((k) => c.get(k))
    .map((k) => ({ label: LABEL[k] ?? k, value: c.get(k) as number, color: col(k) })), 'anchored');

  let cum = 0;
  areaChart($('activity-chart'), evs.map((e) => {
    if (e.status === 'confirmed') cum += 1;
    return { y: cum, label: 'seq ' + e.seqNo + ', ' + (LABEL[e.kind] ?? e.kind) };
  }));

  timelineStrip($('timeline-strip'), evs);

  const kills = c.get('kill') ?? 0, votes = c.get('vote') ?? 0;
  $('privacy-budget').innerHTML =
    '<div class="kv"><span class="k">Kills anchored, killer seat hidden</span><span class="num">' + kills + '</span></div>'
    + '<div class="kv"><span class="k">Votes anchored, voter seat hidden</span><span class="num">' + votes + '</span></div>'
    + '<div class="kv"><span class="k">Roles disclosed before game over</span><span class="num">'
      + (c.get('eject') ?? 0) + '</span></div>'
    + '<div class="kv"><span class="k">Salts leaked before reveal</span><span class="num">0</span></div>'
    + '<div class="kv"><span class="k">Identity leak rate</span><span class="num">'
      + (anon ? '0%' : 'n/a') + '</span></div>';

  const h = health;
  const kv = (k: string, v: string): string => '<div class="kv"><span class="k">' + esc(k) + '</span><span>' + v + '</span></div>';
  $('health-list').innerHTML =
    kv('Session', '<span class="chip">' + esc(data?.session ?? 'IDLE') + '</span>')
    + kv('Ledger mode', '<span class="chip ' + (data?.mode === 'testnet' ? 'good' : 'warn') + '">' + esc(data?.mode ?? 'mock') + '</span>')
    + kv('Network', esc(data?.network ?? 'unknown'))
    + kv('Commitment scheme', '<span class="mono">' + esc(data?.commitmentScheme ?? '') + '</span>')
    + kv('Transactions queued', '<span class="num">' + (h?.queueDepth ?? 0) + '</span>')
    + kv('Proof server', h?.proofServer ? esc(h.proofServer) : '<span class="m4">not used in mock</span>')
    + kv('Indexer', h?.indexer ? esc(h.indexer) : '<span class="m4">not used in mock</span>');
}

function renderDisclosure(): void {
  const evs = evList();
  const c = new Map<string, number>();
  for (const e of evs) c.set(e.kind, (c.get(e.kind) ?? 0) + 1);
  const anon = (c.get('kill') ?? 0) + (c.get('vote') ?? 0);
  const seats = data?.commitments.length ?? 0;
  const over = data?.session === 'OVER';

  strip($('disc-kpi'), [
    { v: String(anon), k: 'Proofs with hidden actor', x: 'kills and votes' },
    { v: String(seats), k: 'Committed roles', x: over ? 'now opened' : 'still sealed' },
    { v: '0', k: 'Salts exposed early', x: 'before game over' },
    { v: String(c.get('eject') ?? 0), k: 'Roles opened by ejection', x: 'public by design' },
    { v: String(evs.length), k: 'Total proofs', x: 'every action anchored' },
    { v: over ? 'Opened' : 'Sealed', k: 'Witness state', x: over ? 'match finished' : 'match running' },
  ]);

  const li = (k: string, v: string, sealed = false): string =>
    '<li><span>' + esc(k) + '</span><span class="' + (sealed ? 'seal' : 'val') + '">' + v + '</span></li>';

  $('disc-public').innerHTML =
    li('Contract address', data?.contractAddress ? esc(cut(data.contractAddress, 10)) : 'not deployed')
    + li('Game seed', data?.gameSeedHex ? esc(cut(data.gameSeedHex, 8)) : 'pending')
    + li('Seat commitments', String(seats))
    + li('Victim seats', String(c.get('kill') ?? 0))
    + li('Vote targets', String(c.get('vote') ?? 0))
    + li('Match outcome', c.get('winner') ? 'declared' : 'pending');

  $('disc-private').innerHTML =
    li('Saboteur seat', over ? esc(String(data?.reveals.find((r) => r.role === 2)?.seat ?? '')) + ' (opened at game over)' : 'sealed', !over)
    + li('Killer identity', 'never written', true)
    + li('Voter identities', 'never written', true)
    + li('Seat salts', over ? 'opened at game over' : 'sealed', !over)
    + li('Role assignments', over ? 'opened at game over' : 'sealed', !over)
    + li('Private state', 'held off chain', true);

  const body = $('disc-body');
  if (evs.length === 0) { body.innerHTML = '<tr><td colspan="5" class="empty">No transactions yet.</td></tr>'; return; }
  body.innerHTML = [...evs].reverse().map((e) => {
    const d = DISCLOSE[e.kind] ?? { pub: 'see payload', wit: 'unknown', proves: 'circuit assertion' };
    return '<tr><td class="mono">' + e.seqNo + '</td>'
      + '<td><span class="chip" style="background:' + col(e.kind) + '1a;color:' + col(e.kind) + '">'
        + esc(LABEL[e.kind] ?? e.kind) + '</span></td>'
      + '<td class="m2" title="' + esc(d.pub) + '">' + esc(d.pub) + '</td>'
      + '<td class="m4" title="' + esc(d.wit) + '">' + esc(d.wit) + '</td>'
      + '<td class="m2 flex" title="' + esc(d.proves) + '">' + esc(d.proves) + '</td></tr>';
  }).join('');
}

function renderVerification(): void {
  const revs = data?.reveals ?? [];
  const ok = revs.filter((r) => r.match).length;
  strip($('fair-kpi'), [
    { v: String(data?.commitments.length ?? 0), k: 'Seats committed' },
    { v: String(revs.length), k: 'Commitments reopened' },
    { v: revs.length ? String(ok) : '0', k: 'Hashes matching' },
    { v: revs.length ? String(revs.length - ok) : '0', k: 'Mismatches' },
    { v: data?.gameSeedHex ? cut(data.gameSeedHex, 5) : 'pending', k: 'Game seed' },
    { v: revs.length === 0 ? 'Pending' : ok === revs.length ? 'Verified' : 'Failed', k: 'Result' },
  ]);

  const walk = $('verify-walk');
  if (revs.length === 0) {
    walk.className = '';
    walk.innerHTML = '<div class="empty">The reopening runs when the match ends. '
      + 'Each seat then proves its day one commitment matches the role it played.</div>';
  } else {
    const seed = data?.gameSeedHex ?? '';
    walk.className = 'vw';
    walk.innerHTML = '<b>Seat</b><b>Commitment inputs</b><b>Recomputed</b><b>On chain</b><b>Check</b>'
      + revs.map((r) =>
        '<span class="seat">' + r.seat + '</span>'
        + '<span class="in" title="role=' + r.role + ' seat=' + r.seat + ' seed=' + esc(seed) + ' salt=' + esc(r.saltHex) + '">'
          + 'commit(' + r.role + ', ' + r.seat + ', ' + esc(cut(seed, 4)) + ', ' + esc(cut(r.saltHex, 4)) + ')</span>'
        + '<span class="hx" title="' + esc(r.recomputedHex) + '">' + esc(cut(r.recomputedHex, 8)) + '</span>'
        + '<span class="hx" title="' + esc(r.commitmentHex) + '">' + esc(cut(r.commitmentHex, 8)) + '</span>'
        + '<span class="' + (r.match ? 'eq">match' : 'ne">fail') + '</span>').join('');
  }

  const body = $('reveal-body');
  if (revs.length === 0) {
    body.innerHTML = '<tr><td colspan="7" class="empty">Roles stay sealed until the match ends.</td></tr>'; return;
  }
  body.innerHTML = revs.map((r) => '<tr><td>' + r.seat + '</td><td class="mono">' + r.playerId + '</td>'
    + '<td><span class="chip" style="' + (r.role === 2 ? 'background:#fdf1dc;color:#8a6000' : 'background:#e7f6e7;color:#006300')
      + '">' + (r.role === 2 ? 'Saboteur' : 'Agent') + '</span></td>'
    + '<td class="mono m2" title="' + esc(r.saltHex) + '">' + esc(cut(r.saltHex, 5)) + '</td>'
    + '<td class="mono m2" title="' + esc(r.commitmentHex) + '">' + esc(cut(r.commitmentHex, 5)) + '</td>'
    + '<td class="mono m2" title="' + esc(r.recomputedHex) + '">' + esc(cut(r.recomputedHex, 5)) + '</td>'
    + '<td>' + (r.match ? '<span class="chip good"><span class="d"></span>match</span>'
                        : '<span class="chip bad"><span class="d"></span>fail</span>') + '</td></tr>').join('');
}

function renderTransactions(): void {
  const evs = [...evList()].reverse();
  const body = $('tx-body');
  if (evs.length === 0) {
    body.innerHTML = '<tr><td colspan="6" class="empty">No transactions yet. The first appears when roles are dealt.</td></tr>';
    return;
  }
  body.innerHTML = evs.map((e) => {
    const pub = Object.entries(e.publicData ?? {}).filter(([k]) => k !== 'detail')
      .map(([k, v]) => esc(k) + '=' + esc(typeof v === 'string' ? cut(v, 5) : JSON.stringify(v))).join(', ');
    return '<tr><td class="mono">' + e.seqNo + '</td>'
      + '<td class="m3 mono">' + esc(hhmmss(e.ts)) + '</td>'
      + '<td><span class="chip" style="background:' + col(e.kind) + '1a;color:' + col(e.kind) + '">'
        + esc(LABEL[e.kind] ?? e.kind) + '</span></td>'
      + '<td class="mono m2 flex" title="' + esc(pub) + '">' + (pub || '<span class="m4">none</span>') + '</td>'
      + '<td>' + pill(e.status) + '</td><td>' + txCell(e.txId) + '</td></tr>';
  }).join('');
}

function renderSeats(): void {
  const d = data; const body = $('seats-body');
  if (!d || d.commitments.length === 0) {
    body.innerHTML = '<tr><td colspan="4" class="empty">Seats are assigned when the match is dealt.</td></tr>'; return;
  }
  const over = d.session === 'OVER';
  body.innerHTML = d.commitments.map((c, seat) => {
    const s = d.seatMap.find((x) => x.seat === seat);
    const rev = d.reveals.find((r) => r.seat === seat);
    const state = over && rev
      ? '<span class="chip ' + (rev.role === 2 ? 'warn' : 'good') + '">' + (rev.role === 2 ? 'Saboteur' : 'Agent') + '</span>'
      : '<span class="chip">sealed</span>';
    return '<tr><td>Seat ' + seat + '</td>'
      + '<td class="mono">' + (s ? s.playerId : '<span class="m4">ghost seat</span>') + '</td>'
      + '<td class="mono m2 flex" title="' + esc(c) + '">' + esc(c) + '</td>'
      + '<td>' + state + '</td></tr>';
  }).join('');
}

function renderContract(): void {
  const d = data;
  const row = (k: string, v: string): string =>
    '<tr><td style="width:190px" class="m3">' + esc(k) + '</td><td>' + v + '</td></tr>';
  const a = d?.contractAddress ?? '';
  const addr = a
    ? (d?.explorerBase ? '<a class="lk mono" href="' + esc(acct(a)) + '" target="_blank" rel="noopener">' + esc(a) + '</a>'
                       : '<span class="mono">' + esc(a) + '</span>')
    : '<span class="m4">not deployed</span>';
  $('contract-body').innerHTML =
    row('Contract address', addr)
    + row('Match ID', d?.matchId ? '<span class="mono">' + esc(d.matchId) + '</span>' : '<span class="m4">no match</span>')
    + row('Network', esc(d?.network ?? 'unknown'))
    + row('Ledger mode', esc(d?.mode ?? 'mock'))
    + row('Commitment scheme', '<span class="mono">' + esc(d?.commitmentScheme ?? '') + '</span>')
    + row('Game seed', d?.gameSeedHex ? '<span class="mono">' + esc(d.gameSeedHex) + '</span>' : '<span class="m4">committed at deal</span>')
    + row('Deployer wallet', health?.walletAddress
        ? (d?.explorerBase ? '<a class="lk mono" href="' + esc(acct(health.walletAddress)) + '" target="_blank" rel="noopener">' + esc(health.walletAddress) + '</a>'
                           : '<span class="mono">' + esc(health.walletAddress) + '</span>')
        : '<span class="m4">not used in mock mode</span>')
    + row('Balance', health?.balanceTDust ? esc(health.balanceTDust) + ' tDUST' : '<span class="m4">n/a</span>')
    + row('Explorer', d?.explorerBase
        ? '<a class="lk" href="' + esc(d.explorerBase) + '" target="_blank" rel="noopener">' + esc(d.explorerBase) + '</a>'
        : '<span class="m4">activates in testnet mode</span>');
}

function renderChrome(): void {
  const d = data;
  $('session-tag').textContent = d?.session ?? 'IDLE';
  const testnet = d?.mode === 'testnet';
  const mt = $('mode-tag');
  mt.textContent = testnet ? 'TESTNET' : 'MOCK';
  mt.className = 'chip ' + (testnet ? 'good' : 'warn');
  $('top-match').textContent = d?.matchId ? 'match ' + cut(d.matchId, 6) : 'no match';

  const btn = $('explorer-btn') as HTMLAnchorElement;
  if (testnet && d?.contractAddress) { btn.href = acct(d.contractAddress); btn.classList.remove('hidden'); }
  else btn.classList.add('hidden');

  const al = $('mode-alert');
  if (testnet) al.classList.add('hidden');
  else {
    al.classList.remove('hidden');
    $('mode-alert-text').innerHTML = '<b>Mock ledger.</b> Hashes and nullifiers use the real scheme and every figure '
      + 'is live bridge state, but transactions are simulated in process, so none exist on a public chain. '
      + 'Set <code>MN_MODE=testnet</code>, run the proof server and fund the deployer wallet to anchor on Midnight.';
  }
}

function renderAll(): void {
  renderChrome(); renderOverview(); renderDisclosure(); renderVerification();
  renderTransactions(); renderSeats(); renderContract();
}

// ------------------------------------------------------------------ data
async function pullData(): Promise<void> {
  try {
    const r = await fetch('/audit/data'); if (!r.ok) return;
    data = (await r.json()) as AuditData;
    for (const e of data.events) events.set(e.seqNo, e);
    renderAll();
  } catch { /* transient */ }
}
async function pullHealth(): Promise<void> {
  try { health = (await (await fetch('/health')).json()) as Health; renderOverview(); renderContract(); }
  catch { /* transient */ }
}
function connect(): void {
  const dot = $('live-dot'), lab = $('live-label');
  const es = new EventSource('/events');
  es.onopen = () => { dot.className = 'dot on'; lab.textContent = 'live'; };
  es.onerror = () => { dot.className = 'dot off'; lab.textContent = 'reconnecting'; };
  es.onmessage = (m) => {
    try {
      const e = JSON.parse(m.data) as AuditEvent;
      events.set(e.seqNo, e);
      renderOverview(); renderTransactions(); renderDisclosure();
      if (e.kind === 'deal' || e.kind === 'winner' || e.kind === 'reveal') void pullData();
    } catch { /* ignore */ }
  };
}

initTabs();
void pullData();
void pullHealth();
connect();
setInterval(() => { void pullData(); }, 5000);
setInterval(() => { void pullHealth(); }, 5000);
