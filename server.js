/* Servidor del Impostor online · Frikirapper Creator
   - Salas con código de 4 caracteres (para entrar siempre hay que escribir el código)
   - Lista de salas públicas (sin mostrar el código)
   - El servidor decide la palabra y el impostor, así nadie puede hacer trampa
   - También sirve el juego: pon tu HTML como public/index.html */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 3000;
const MAINS = ['FrikirapperCreatorV1.2.html', 'index.html'];
const PUB = MAINS.some(n => fs.existsSync(path.join(__dirname, 'public', n))) ? path.join(__dirname, 'public') : __dirname;
const MAIN = MAINS.find(n => fs.existsSync(path.join(PUB, n))) || 'index.html'; // si no hay carpeta public, sirve el index.html que esté junto a server.js
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' }); return res.end('ok'); }
  const f = path.join(PUB, path.normalize(url === '/' ? '/' + MAIN : url));
  if (!f.startsWith(PUB)) { res.writeHead(403); return res.end('Prohibido'); }
  if (PUB === __dirname && url !== '/' && url !== '/' + MAIN) { res.writeHead(404); return res.end('No encontrado'); }
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Servidor del Impostor funcionando. Pon tu juego en public/index.html'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(d);
  });
});
const wss = new WebSocketServer({ server, maxPayload: 128 * 1024 });

/* ---------- constantes ---------- */
const T_CLUE = 40000, T_DEBATE = 75000, T_VOTE = 40000, T_RESULT = 12000;
const MIN_P = 3, MAX_P = 8, CATS = ['a', 'c', 'r', 'p', 'f'];
const players = new Map(); // pid -> {pid,name,ws,roomId,drop}
const rooms = new Map();   // id -> room
const rnd = n => Math.floor(Math.random() * n), pick = a => a[rnd(a.length)];
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1);[a[i], a[j]] = [a[j], a[i]]; } return a; };
const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9ñ]/g, '');
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
const newCode = () => { const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; let c; do { c = Array.from({ length: 4 }, () => A[rnd(A.length)]).join(''); } while ([...rooms.values()].some(r => r.code === c)); return c; };

/* ---------- envío ---------- */
const send = (p, o) => { try { if (p && p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(o)); } catch (e) { } };
const err = (p, m) => send(p, { t: 'err', m });

function snapshot(room, pid) {
  const g = room.g, me = room.ps.find(x => x.pid === pid);
  const o = {
    id: room.id, code: room.code, name: room.name, pub: room.pub, max: room.max, host: room.host, phase: room.phase, opts: room.opts, me: pid,
    ps: room.ps.map(p => ({ pid: p.pid, name: p.name, on: p.on, alive: p.alive, host: p.pid === room.host })),
    chat: room.chat.slice(-40), g: null, sec: null
  };
  if (g) {
    o.g = { round: g.round, cat: g.cat, order: g.order, turn: g.turn, endAt: g.endAt, clues: g.clues, voted: Object.keys(g.votes), ready: [...g.ready], res: g.res, win: g.win, reveal: room.phase === 'end' ? { imp: g.imp, we: g.we, dec: g.dec } : null };
    if (me && g.inGame.includes(pid)) o.sec = { role: pid === g.imp ? 'imp' : 'crew', word: pid === g.imp ? (g.dec ? g.dec : null) : g.we, cat: g.cat };
  }
  return o;
}
const broadcast = room => room.ps.forEach(m => { const p = players.get(m.pid); if (p && m.on) send(p, { t: 'room', room: snapshot(room, m.pid) }); });
const sys = (room, m) => { room.chat.push({ sys: 1, m, at: Date.now() }); if (room.chat.length > 80) room.chat.shift(); };

/* ---------- salas ---------- */
function listRooms() {
  return [...rooms.values()].filter(r => r.pub).map(r => ({ id: r.id, name: r.name, host: (r.ps.find(p => p.pid === r.host) || {}).name || '', n: r.ps.filter(p => p.on).length, max: r.max, state: r.phase === 'lobby' ? 'lobby' : 'play', cat: r.opts.cat }));
}
function removeFromRoom(p, why) {
  const room = rooms.get(p.roomId); p.roomId = null; if (!room) return;
  const m = room.ps.find(x => x.pid === p.pid); if (!m) return;
  clearTimeout(p.drop);
  if (room.phase === 'lobby') room.ps = room.ps.filter(x => x.pid !== p.pid);
  else { m.on = false; m.alive = false; m.left = true; }
  sys(room, m.name + (why === 'kick' ? ' fue expulsado' : ' salió de la sala'));
  const humans = room.ps.filter(x => !x.left && x.on);
  if (!humans.length) { clearTimeout(room.timer); rooms.delete(room.id); return; }
  if (room.host === p.pid) { room.host = humans[0].pid; sys(room, humans[0].name + ' es ahora el anfitrión'); }
  if (room.phase !== 'lobby' && room.phase !== 'end') afterLeave(room, m);
  broadcast(room);
}
function afterLeave(room, m) {
  const g = room.g; if (!g) return;
  g.inGame = g.inGame; // se conserva para revelar roles
  if (m.pid === g.imp) return endGame(room, 'crew', 'El impostor abandonó la partida');
  const alive = room.ps.filter(x => x.alive);
  if (alive.length <= 2) return endGame(room, 'imp', 'Quedaron muy pocos jugadores');
  if (room.phase === 'clue' && g.turn === m.pid) { g.pos++; nextTurn(room); }
  if (room.phase === 'vote') checkVotesDone(room);
}

/* ---------- partida ---------- */
function startGame(room, pools) {
  const ps = room.ps.filter(p => p.on && !p.left);
  if (ps.length < MIN_P) return 'Se necesitan al menos 3 jugadores conectados';
  const okCats = CATS.filter(c => Array.isArray(pools && pools[c]) && pools[c].length);
  if (!okCats.length) return 'El cliente no envió palabras';
  const cat = room.opts.cat !== 'all' && okCats.includes(room.opts.cat) ? room.opts.cat : pick(okCats);
  const L = pools[cat].filter(x => Array.isArray(x) && typeof x[0] === 'string').slice(0, 2000);
  const we = pick(L);
  let dec = null;
  if (room.opts.dec) { const same = L.filter(x => x[0] !== we[0] && x[1] === we[1]), any = L.filter(x => x[0] !== we[0]); const D = same.length ? same : any; if (D.length) dec = pick(D)[0]; }
  room.g = { cat, we: we[0], dec, imp: pick(ps).pid, round: 1, order: [], pos: 0, turn: null, clues: {}, used: {}, votes: {}, ready: new Set(), res: null, win: null, endAt: 0, inGame: ps.map(p => p.pid) };
  room.ps.forEach(p => { p.alive = ps.some(q => q.pid === p.pid); p.left = false; });
  room.ps.forEach(p => { room.g.clues[p.pid] = []; });
  room.chat = []; sys(room, '🕵️ ¡Empieza la partida! Todos tienen una palabra secreta… menos el impostor.');
  startRound(room);
}
function startRound(room) {
  const g = room.g; clearTimeout(room.timer);
  g.order = shuffle(room.ps.filter(p => p.alive).map(p => p.pid)); g.pos = 0; g.votes = {}; g.ready = new Set(); g.res = null;
  room.phase = 'clue'; nextTurn(room);
}
function nextTurn(room) {
  const g = room.g; clearTimeout(room.timer);
  if (g.pos >= g.order.length) return startDebate(room);
  g.turn = g.order[g.pos]; const m = room.ps.find(p => p.pid === g.turn);
  g.endAt = Date.now() + (m && m.on ? T_CLUE : 3000);
  room.timer = setTimeout(() => { if (room.phase !== 'clue' || g.turn !== m.pid) return; g.clues[m.pid].push({ r: g.round, w: '…' }); sys(room, m.name + ' no dio pista a tiempo'); g.pos++; nextTurn(room); }, g.endAt - Date.now());
  broadcast(room);
}
function startDebate(room) {
  const g = room.g; clearTimeout(room.timer); room.phase = 'debate'; g.turn = null; g.endAt = Date.now() + T_DEBATE; g.ready = new Set();
  room.timer = setTimeout(() => startVote(room), T_DEBATE); broadcast(room);
}
function startVote(room) {
  const g = room.g; clearTimeout(room.timer); room.phase = 'vote'; g.votes = {}; g.endAt = Date.now() + T_VOTE;
  room.timer = setTimeout(() => tally(room), T_VOTE); broadcast(room);
}
function checkVotesDone(room) {
  const g = room.g, need = room.ps.filter(p => p.alive && p.on);
  if (need.length && need.every(p => g.votes[p.pid])) tally(room);
}
function tally(room) {
  const g = room.g; if (room.phase !== 'vote') return; clearTimeout(room.timer);
  const T = {}; Object.values(g.votes).forEach(t => T[t] = (T[t] || 0) + 1);
  const V = {}; Object.entries(g.votes).forEach(([a, b]) => V[a] = b);
  let out = null, tie = false;
  const ks = Object.keys(T);
  if (ks.length) { const mx = Math.max(...Object.values(T)), tied = ks.filter(k => T[k] === mx); tie = tied.length > 1; out = pick(tied); }
  if (out) { const m = room.ps.find(p => p.pid === out); if (m) m.alive = false; }
  let win = null;
  if (out && out === g.imp) win = 'crew'; else if (room.ps.filter(p => p.alive).length <= 2) win = 'imp';
  g.res = { V, T, out, tie, wasImp: out ? out === g.imp : false }; g.win = win; room.phase = 'result'; g.endAt = Date.now() + T_RESULT;
  room.timer = setTimeout(() => { win ? endGame(room, win) : (g.round++, startRound(room)); }, T_RESULT); broadcast(room);
}
function endGame(room, win, why) {
  const g = room.g; clearTimeout(room.timer); g.win = win; room.phase = 'end'; g.endAt = 0; if (why) sys(room, why);
  sys(room, win === 'crew' ? '🎯 ¡Se encontró al impostor!' : '🕵️ ¡Ganó el impostor!'); broadcast(room);
}
function backToLobby(room) {
  clearTimeout(room.timer); room.g = null; room.phase = 'lobby';
  room.ps = room.ps.filter(p => !p.left && p.on); room.ps.forEach(p => { p.alive = true; }); room.chat = []; broadcast(room);
}

/* ---------- SUBASTA 1vs1 (Arcade) ---------- */
const aucs = new Map(); // id -> sala de subasta
const T_BID = 20000, T_SOLD = 4000, A_ROUNDS = 5, A_MONEY = 20, A_VAL = [2, 3, 5, 7, 10, 14];
const aOther = (r, pid) => { const o = r.ps.find(x => x.pid !== pid); return o ? o.pid : null; };
function aSnap(r, pid) {
  const a = r.a, o = { id: r.id, code: r.code, quick: !!r.quick, phase: r.phase, host: r.host, me: pid, ps: r.ps.map(p => ({ pid: p.pid, name: p.name, on: p.on })), a: null };
  if (a) o.a = { i: a.i, total: a.total, item: a.items[Math.min(a.i, a.total - 1)], money: a.money, got: a.got, bid: a.bid, bidder: a.bidder, turn: a.turn, endAt: a.endAt, now: Date.now(), res: a.res, win: a.win, pts: a.pts, why: a.why };
  return o;
}
const aBroadcast = r => r.ps.forEach(m => { const p = players.get(m.pid); if (p && m.on) send(p, { t: 'sa_room', room: aSnap(r, m.pid) }); });
function aStart(r) {
  const ok = (r.pool || []).filter(x => Array.isArray(x) && typeof x[0] === 'string' && x[1] >= 0 && x[1] <= 5);
  if (ok.length < A_ROUNDS) return 'No hay suficientes frikirappers para subastar';
  const items = shuffle(ok).slice(0, A_ROUNDS).map(x => ({ n: clean(x[0], 60), r: x[1] | 0 }));
  const money = {}, got = {}; r.ps.forEach(p => { money[p.pid] = A_MONEY; got[p.pid] = []; });
  r.a = { i: 0, total: A_ROUNDS, items, money, got, bid: 0, bidder: null, turn: null, endAt: 0, res: null, pp: 0, first: pick(r.ps).pid, win: null, pts: null, why: null };
  aRound(r); return null;
}
function aRound(r) {
  const a = r.a; clearTimeout(r.timer); a.bid = 0; a.bidder = null; a.pp = 0; a.res = null; a.turn = a.first; r.phase = 'bid';
  aTurnTimer(r); aBroadcast(r);
}
function aTurnTimer(r) { const a = r.a; clearTimeout(r.timer); a.endAt = Date.now() + T_BID; const who = a.turn; r.timer = setTimeout(() => aPass(r, who), T_BID); }
function aSell(r, w) {
  const a = r.a; clearTimeout(r.timer); const it = a.items[a.i]; r.phase = 'sold';
  if (w) { a.money[w] -= a.bid; a.got[w].push(it); a.res = { who: w, bid: a.bid, item: it }; } else a.res = { who: null, bid: 0, item: it };
  a.endAt = Date.now() + T_SOLD; aBroadcast(r);
  r.timer = setTimeout(() => { a.i++; if (a.i >= a.total) return aEnd(r); a.first = aOther(r, a.first) || a.first; aRound(r); }, T_SOLD);
}
function aEnd(r, why, forceWin) {
  const a = r.a; clearTimeout(r.timer); const pts = {}; r.ps.forEach(p => { pts[p.pid] = (a.got[p.pid] || []).reduce((s, x) => s + (A_VAL[x.r] || 2), 0); });
  const [p1, p2] = r.ps.map(p => p.pid); let win = 'tie';
  if (forceWin) win = forceWin; else if (p1 && p2) { if (pts[p1] !== pts[p2]) win = pts[p1] > pts[p2] ? p1 : p2; else if (a.money[p1] !== a.money[p2]) win = a.money[p1] > a.money[p2] ? p1 : p2; }
  a.pts = pts; a.win = win; a.why = why || null; r.phase = 'end'; a.endAt = 0; aBroadcast(r);
}
function aPass(r, pid) {
  const a = r.a; if (!a || r.phase !== 'bid' || a.turn !== pid) return;
  if (a.bidder) return aSell(r, a.bidder);
  a.pp++; if (a.pp >= 2) return aSell(r, null);
  a.turn = aOther(r, pid); aTurnTimer(r); aBroadcast(r);
}
function aBid(r, pid, inc) {
  const a = r.a; if (!a || r.phase !== 'bid' || a.turn !== pid) return; inc = inc | 0; if (![1, 2, 5].includes(inc)) return;
  const nb = a.bid + inc; if (nb > a.money[pid]) return;
  a.bid = nb; a.bidder = pid; a.pp = 0; const o = aOther(r, pid); a.turn = o;
  if (a.money[o] < nb + 1) return aSell(r, pid);
  aTurnTimer(r); aBroadcast(r);
}
function aLeave(p) {
  const r = aucs.get(p.aroom); p.aroom = null; if (!r) return; clearTimeout(p.adrop);
  const m = r.ps.find(x => x.pid === p.pid); if (!m) return;
  if (r.phase === 'lobby') { r.ps = r.ps.filter(x => x.pid !== p.pid); if (!r.ps.length) { aucs.delete(r.id); return; } r.host = r.ps[0].pid; return aBroadcast(r); }
  const o = aOther(r, p.pid);
  if (r.phase !== 'end' && o) { r.ps = r.ps.filter(x => x.pid !== p.pid); aEnd(r, m.name + ' abandonó la subasta', o); const op = players.get(o); if (op) op.aroom = r.id; r.left = true; }
  else { r.ps = r.ps.filter(x => x.pid !== p.pid); if (!r.ps.length) { clearTimeout(r.timer); aucs.delete(r.id); } else aBroadcast(r); }
}
function aNew(p, pool, pub, quick) {
  const r = { id: crypto.randomBytes(4).toString('hex'), code: newCode(), pub: !!pub, quick: !!quick, host: p.pid, phase: 'lobby', pool: Array.isArray(pool) ? pool.slice(0, 600) : [], ps: [{ pid: p.pid, name: p.name, on: true }], a: null, timer: null };
  aucs.set(r.id, r); p.aroom = r.id; aBroadcast(r); return r;
}
function aJoin(p, r) {
  r.ps.push({ pid: p.pid, name: r.ps.some(x => x.name === p.name) ? p.name + ' 2' : p.name, on: true }); p.aroom = r.id;
  const e = aStart(r); if (e) { err(p, e); aLeave(p); }
}
function aMsg(p, m) {
  const r = aucs.get(p.aroom);
  switch (m.t) {
    case 'sa_quick': {
      if (r || rooms.get(p.roomId)) return err(p, 'Ya estás en una sala');
      const w = [...aucs.values()].find(x => x.quick && x.phase === 'lobby' && x.ps.length === 1);
      return w ? aJoin(p, w) : aNew(p, m.pool, true, true);
    }
    case 'sa_create': { if (r || rooms.get(p.roomId)) return err(p, 'Ya estás en una sala'); return aNew(p, m.pool, false, false); }
    case 'sa_join': {
      if (r || rooms.get(p.roomId)) return err(p, 'Ya estás en una sala');
      const code = clean(m.code, 8).toUpperCase(), w = [...aucs.values()].find(x => x.code === code);
      if (!w) return err(p, 'Código incorrecto o sala inexistente'); if (w.phase !== 'lobby' || w.ps.length >= 2) return err(p, 'Esa sala ya está llena');
      return aJoin(p, w);
    }
    case 'sa_leave': return aLeave(p);
    case 'sa_bid': return r && aBid(r, p.pid, m.inc);
    case 'sa_pass': return r && aPass(r, p.pid);
    case 'sa_again': { if (!r || r.phase !== 'end' || r.host !== p.pid || r.ps.length < 2 || r.ps.some(x => !x.on)) return; const e = aStart(r); return e ? err(p, e) : null; }
  }
}

/* ---------- mensajes ---------- */
function onMsg(p, m) {
  if (m.t.indexOf('sa_') === 0) return aMsg(p, m);
  const room = rooms.get(p.roomId), me = room && room.ps.find(x => x.pid === p.pid), g = room && room.g;
  switch (m.t) {
    case 'list': return send(p, { t: 'rooms', rooms: listRooms() });
    case 'create': {
      if (room) return err(p, 'Ya estás en una sala');
      const r = { id: crypto.randomBytes(4).toString('hex'), code: newCode(), name: clean(m.name, 24) || 'Sala de ' + p.name, pub: !!m.pub, max: Math.min(MAX_P, Math.max(MIN_P, +m.max || 6)), host: p.pid, phase: 'lobby', opts: { cat: 'all', dec: 1 }, ps: [{ pid: p.pid, name: p.name, on: true, alive: true }], g: null, chat: [], timer: null };
      rooms.set(r.id, r); p.roomId = r.id; sys(r, '🏠 Sala creada. Comparte el código ' + r.code + ' para que se unan.'); return broadcast(r);
    }
    case 'join': {
      if (room) return err(p, 'Ya estás en una sala');
      const code = clean(m.code, 8).toUpperCase(); let r = m.id ? rooms.get(String(m.id)) : [...rooms.values()].find(x => x.code === code);
      if (!r || r.code !== code) return err(p, 'Código incorrecto o sala inexistente');
      if (r.phase !== 'lobby') return err(p, 'La partida ya empezó');
      if (r.ps.filter(x => x.on).length >= r.max) return err(p, 'La sala está llena');
      let nm = p.name, i = 2; while (r.ps.some(x => x.name === nm)) nm = p.name + ' ' + i++;
      r.ps.push({ pid: p.pid, name: nm, on: true, alive: true }); p.roomId = r.id; sys(r, nm + ' se unió'); return broadcast(r);
    }
    case 'leave': return room ? removeFromRoom(p, 'leave') : null;
    case 'kick': { if (!room || room.host !== p.pid || room.phase !== 'lobby') return; const t = players.get(String(m.id)); if (t && t.roomId === room.id && t.pid !== p.pid) { send(t, { t: 'kicked' }); removeFromRoom(t, 'kick'); } return; }
    case 'opts': { if (!room || room.host !== p.pid || room.phase !== 'lobby') return; if (m.cat === 'all' || CATS.includes(m.cat)) room.opts.cat = m.cat; room.opts.dec = m.dec ? 1 : 0; return broadcast(room); }
    case 'start': { if (!room || room.host !== p.pid || room.phase !== 'lobby') return; const e = startGame(room, m.pools); return e ? err(p, e) : null; }
    case 'again': { if (!room || room.host !== p.pid || room.phase !== 'end') return; return backToLobby(room); }
    case 'chat': {
      if (!room || !me) return; const t = clean(m.m, 140); if (!t) return;
      const now = Date.now(); if (p.lastChat && now - p.lastChat < 600) return; p.lastChat = now;
      if (room.phase === 'clue' || room.phase === 'vote' || room.phase === 'result') { if (room.phase !== 'result' && room.g && !me.alive) return; }
      if (room.g && room.phase !== 'lobby' && room.phase !== 'end' && !me.alive) return;
      room.chat.push({ pid: p.pid, name: me.name, m: t, at: now }); if (room.chat.length > 80) room.chat.shift(); return broadcast(room);
    }
    case 'clue': {
      if (!room || room.phase !== 'clue' || !g || g.turn !== p.pid) return; const w = clean(m.w, 24);
      if (!w) return err(p, 'Escribe una palabra'); if (/\s/.test(w)) return err(p, 'Solo UNA palabra por turno');
      if (g.used[norm(w)]) return err(p, 'Esa palabra ya se dijo: usa otra');
      g.used[norm(w)] = 1; g.clues[p.pid].push({ r: g.round, w }); g.pos++; return nextTurn(room);
    }
    case 'ready': { if (!room || room.phase !== 'debate' || !me || !me.alive) return; g.ready.add(p.pid); const need = room.ps.filter(x => x.alive && x.on).length; if (g.ready.size >= Math.ceil(need * 0.6)) return startVote(room); return broadcast(room); }
    case 'vote': {
      if (!room || room.phase !== 'vote' || !me || !me.alive) return; const t = room.ps.find(x => x.pid === String(m.id));
      if (!t || !t.alive || t.pid === p.pid) return; g.votes[p.pid] = t.pid; broadcast(room); return checkVotesDone(room);
    }
  }
}

/* ---------- conexiones ---------- */
wss.on('connection', ws => {
  let p = null; ws.isAlive = true; ws.on('pong', () => ws.isAlive = true);
  let tokens = 20, last = Date.now();
  ws.on('message', raw => {
    const now = Date.now(); tokens = Math.min(20, tokens + (now - last) / 100); last = now; if (--tokens < 0) return;
    let m; try { m = JSON.parse(raw); } catch (e) { return; } if (!m || typeof m.t !== 'string') return;
    if (m.t === 'hello') {
      const name = clean(m.name, 16) || 'Jugador'; const old = m.pid && players.get(String(m.pid));
      if (old) { p = old; clearTimeout(p.drop); if (p.ws && p.ws !== ws) { try { p.ws.close(); } catch (e) { } } p.ws = ws; p.name = name; }
      else { p = { pid: crypto.randomBytes(12).toString('hex'), name, ws, roomId: null, drop: null }; players.set(p.pid, p); }
      send(p, { t: 'hello', pid: p.pid });
      const room = rooms.get(p.roomId); if (room) { const mm = room.ps.find(x => x.pid === p.pid); if (mm) { mm.on = true; sys(room, mm.name + ' volvió a conectarse'); broadcast(room); } else p.roomId = null; }
      const ar = aucs.get(p.aroom); if (ar) { const am = ar.ps.find(x => x.pid === p.pid); if (am) { am.on = true; aBroadcast(ar); } else p.aroom = null; }
      return;
    }
    if (!p) return; onMsg(p, m);
  });
  ws.on('close', () => {
    if (!p || p.ws !== ws) return; const room = rooms.get(p.roomId), ar = aucs.get(p.aroom);
    if (!room && !ar) { players.delete(p.pid); return; }
    if (room) { const mm = room.ps.find(x => x.pid === p.pid); if (mm) { mm.on = false; broadcast(room); } }
    if (ar) { const am = ar.ps.find(x => x.pid === p.pid); if (am) { am.on = false; aBroadcast(ar); } }
    const T = room ? (room.phase === 'lobby' ? 20000 : 90000) : (ar.phase === 'lobby' ? 20000 : 60000);
    p.drop = setTimeout(() => { if (p.ws === ws || !p.ws || p.ws.readyState !== 1) { if (rooms.get(p.roomId)) removeFromRoom(p, 'leave'); if (aucs.get(p.aroom)) aLeave(p); players.delete(p.pid); } }, T);
  });
  ws.on('error', () => { });
});
setInterval(() => { wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; try { ws.ping(); } catch (e) { } }); }, 30000);
if (require.main === module) server.listen(PORT, () => console.log('Impostor server en el puerto ' + PORT));
module.exports = { server, wss, rooms, players };
