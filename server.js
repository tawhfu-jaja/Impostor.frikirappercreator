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
const wss = new WebSocketServer({ server, maxPayload: 256 * 1024 });

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
const T_BID = 20000, T_SOLD = 4000, A_SLOTS = 4, A_MAXR = 16, A_MONEY = 20, A_VAL = [2, 3, 5, 7, 10, 14];
const aDone = (a, pid) => a.got[pid].length >= A_SLOTS || a.money[pid] < 1;
const aOther = (r, pid) => { const o = r.ps.find(x => x.pid !== pid); return o ? o.pid : null; };
function aSnap(r, pid) {
  const a = r.a, o = { id: r.id, code: r.code, quick: !!r.quick, phase: r.phase, host: r.host, me: pid, ps: r.ps.map(p => ({ pid: p.pid, name: p.name, on: p.on })), a: null };
  if (a) o.a = { i: a.i, total: a.total, slots: a.slots, item: a.items[Math.min(a.i, a.total - 1)], money: a.money, got: a.got, bid: a.bid, bidder: a.bidder, turn: a.turn, endAt: a.endAt, now: Date.now(), res: a.res, win: a.win, pts: a.pts, why: a.why };
  return o;
}
const aBroadcast = r => r.ps.forEach(m => { const p = players.get(m.pid); if (p && m.on) send(p, { t: 'sa_room', room: aSnap(r, m.pid) }); });
function aStart(r) {
  const ok = (r.pool || []).filter(x => Array.isArray(x) && typeof x[0] === 'string' && x[1] >= 0 && x[1] <= 5);
  if (ok.length < A_SLOTS * 3) return 'No hay suficientes frikirappers para subastar';
  const items = shuffle(ok).slice(0, A_MAXR).map(x => ({ n: clean(x[0], 60), r: x[1] | 0 }));
  const money = {}, got = {}; r.ps.forEach(p => { money[p.pid] = A_MONEY; got[p.pid] = []; });
  r.a = { i: 0, total: items.length, slots: A_SLOTS, items, money, got, bid: 0, bidder: null, turn: null, endAt: 0, res: null, pp: 0, first: pick(r.ps).pid, win: null, pts: null, why: null };
  aRound(r); return null;
}
function aRound(r) {
  const a = r.a; clearTimeout(r.timer); a.bid = 0; a.bidder = null; a.pp = 0; a.res = null; if (aDone(a, a.first)) a.first = aOther(r, a.first) || a.first; a.turn = a.first; r.phase = 'bid';
  aTurnTimer(r); aBroadcast(r);
}
function aTurnTimer(r) { const a = r.a; clearTimeout(r.timer); a.endAt = Date.now() + T_BID; const who = a.turn; r.timer = setTimeout(() => aPass(r, who), T_BID); }
function aSell(r, w) {
  const a = r.a; clearTimeout(r.timer); const it = a.items[a.i]; r.phase = 'sold';
  if (w) { a.money[w] -= a.bid; a.got[w].push(it); a.res = { who: w, bid: a.bid, item: it }; } else a.res = { who: null, bid: 0, item: it };
  a.endAt = Date.now() + T_SOLD; aBroadcast(r);
  r.timer = setTimeout(() => { a.i++; if (a.i >= a.total || r.ps.every(p => aDone(a, p.pid))) return aEnd(r); a.first = aOther(r, a.first) || a.first; aRound(r); }, T_SOLD);
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
  a.pp++; if (a.pp >= 2 || aDone(a, aOther(r, pid))) return aSell(r, null);
  a.turn = aOther(r, pid); aTurnTimer(r); aBroadcast(r);
}
function aBid(r, pid, inc) {
  const a = r.a; if (!a || r.phase !== 'bid' || a.turn !== pid) return; inc = inc | 0; if (![1, 2, 5].includes(inc)) return;
  const nb = a.bid + inc; if (nb > a.money[pid]) return;
  a.bid = nb; a.bidder = pid; a.pp = 0; const o = aOther(r, pid); a.turn = o;
  if (a.money[o] < nb + 1 || aDone(a, o)) return aSell(r, pid);
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

/* ===== FRIKILAND UHC · núcleo compartido (idéntico en cliente y servidor) ===== */
var UH_W=200,UH_H=72;
/* bloques: 0 aire,1 pasto,2 tierra,3 piedra,4 tronco,5 hojas,6 mineral hierro,7 mineral oro,8 mineral diamante,9 tablones,10 adoquín,11 roca madre */
var UH_BN=['','Pasto','Tierra','Piedra','Tronco','Hojas','Hierro','Oro','Diamante','Tablones','Adoquín','Roca madre'];
var UH_HARD=[0,.6,.6,2.5,1.6,.25,4,4.5,5,1.2,2.5,-1];
var UH_NEED=[0,0,0,1,0,0,2,3,3,0,1,99];            /* nivel de pico necesario */
var UH_DROP={1:'dirt',2:'dirt',3:'cobble',4:'log',5:'',6:'iron',7:'gold',8:'diamond',9:'planks',10:'cobble',11:''};
var UH_PLACE={dirt:2,cobble:10,planks:9,log:4};
var UH_SPD=[1,2,3.5,5,7];                           /* velocidad de picar por nivel de pico */
var UH_IT={dirt:['🟫','Tierra'],cobble:['🪨','Adoquín'],log:['🪵','Tronco'],planks:['🟧','Tablones'],stick:['🥢','Palos'],apple:['🍎','Manzana'],iron:['⚙️','Hierro'],gold:['🪙','Oro'],diamond:['💎','Diamante'],
 wpick:['⛏️','Pico madera'],spick:['⛏️','Pico piedra'],ipick:['⛏️','Pico hierro'],dpick:['⛏️','Pico diamante'],
 wsword:['🗡️','Espada madera'],ssword:['🗡️','Espada piedra'],isword:['⚔️','Espada hierro'],dsword:['⚔️','Espada diamante'],
 iarmor:['🛡️','Armadura hierro'],darmor:['🛡️','Armadura diamante'],gapple:['🍏','Manzana dorada']};
var UH_PICK={wpick:1,spick:2,ipick:3,dpick:4},UH_SWORD={wsword:4,ssword:5,isword:6,dsword:7},UH_ARM={iarmor:.3,darmor:.5};
var UH_REC=[['planks','Tablones x4',{log:1},4],['stick','Palos x4',{planks:2},4],
 ['wpick','Pico de madera',{planks:3,stick:2},1],['wsword','Espada de madera',{planks:2,stick:1},1],
 ['spick','Pico de piedra',{cobble:3,stick:2},1],['ssword','Espada de piedra',{cobble:2,stick:1},1],
 ['ipick','Pico de hierro',{iron:3,stick:2},1],['isword','Espada de hierro',{iron:2,stick:1},1],['iarmor','Armadura de hierro',{iron:10},1],
 ['dpick','Pico de diamante',{diamond:3,stick:2},1],['dsword','Espada de diamante',{diamond:2,stick:1},1],['darmor','Armadura de diamante',{diamond:8},1],
 ['gapple','Manzana dorada',{gold:5},1]];
function uhRng(s){s=s>>>0;return function(){s=(s+0x6D2B79F5)>>>0;var t=s;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/4294967296}}
function uhMk(seed){
 var W=UH_W,H=UH_H,r=uhRng(seed),t=new Uint8Array(W*H),surf=new Int16Array(W),i,x,y,p1=r()*6.28,p2=r()*6.28,p3=r()*6.28;
 var ix=function(x,y){return y*W+x},get=function(x,y){return x<0||y<0||x>=W||y>=H?0:t[y*W+x]};
 for(x=0;x<W;x++){surf[x]=Math.round(26+5*Math.sin(x*.05+p1)+3*Math.sin(x*.13+p2)+1.5*Math.sin(x*.31+p3));
  for(y=surf[x];y<H;y++){t[ix(x,y)]=y==surf[x]?1:y<surf[x]+4?2:3}
  t[ix(x,H-1)]=11;if(r()<.5)t[ix(x,H-2)]=11}
 /* cuevas */
 for(i=0;i<34;i++){var cx=r()*W,cy=60*r()+surf[Math.floor(cx)%W]+8,an=r()*6.28,len=40+r()*80,rad=1.5+r()*1.2,k;
  cy=Math.min(cy,H-8);
  for(k=0;k<len;k++){cx+=Math.cos(an);cy+=Math.sin(an)*.8;an+=(r()-.5)*.7;var sx=Math.floor(cx),sy=Math.floor(cy);if(sx<2||sx>=W-2||sy<surf[sx]+6||sy>H-4)continue;
   var rr2=Math.ceil(rad),dx,dy;for(dx=-rr2;dx<=rr2;dx++)for(dy=-rr2;dy<=rr2;dy++){if(dx*dx+dy*dy<=rad*rad+.3){var ax=sx+dx,ay=sy+dy;if(ax>0&&ax<W-1&&ay>surf[ax]+4&&ay<H-2)t[ix(ax,ay)]=0}}}}
 /* minerales (cutclean: se funden solos al picarlos) */
 var vein=function(b,n,ymin,ymax){var c;for(c=0;c<n;c++){var vx=Math.floor(r()*W),vy=Math.floor(ymin+r()*(ymax-ymin)),s=2+Math.floor(r()*4),q;
   for(q=0;q<s;q++){if(get(vx,vy)==3)t[ix(vx,vy)]=b;vx+=Math.floor(r()*3)-1;vy+=Math.floor(r()*3)-1}}};
 vein(6,170,28,H-4);vein(7,60,42,H-3);vein(8,34,52,H-3);
 /* árboles */
 for(x=5;x<W-5;x+=6+Math.floor(r()*6)){var sy2=surf[x],h=4+Math.floor(r()*3),yy,lx,ly;if(get(x,sy2)!=1)continue;
  for(yy=1;yy<=h;yy++)t[ix(x,sy2-yy)]=4;
  for(lx=-2;lx<=2;lx++)for(ly=-2;ly<=1;ly++){var ax2=x+lx,ay2=sy2-h+ly;if(Math.abs(lx)==2&&Math.abs(ly)==2)continue;if(ay2>=0&&get(ax2,ay2)==0)t[ix(ax2,ay2)]=5}}
 return{W:W,H:H,t:t,surf:surf,get:get,set:function(x,y,b){if(x>=0&&y>=0&&x<W&&y<H)t[y*W+x]=b}}}

/* ---------- FRIKILAND UHC (Arcade) ---------- */
const uhs = new Map(); // id -> sala
const UH_SPEED = +process.env.UHC_SPEED || 1, UH_GRACE = 120, UH_SH0 = 240, UH_SH1 = 540, UH_BMIN = 24, UH_MAXP = 8;
const uhBorder = el => { let w = UH_W; if (el >= UH_SH1) w = UH_BMIN; else if (el > UH_SH0) w = UH_W + (UH_BMIN - UH_W) * (el - UH_SH0) / (UH_SH1 - UH_SH0); return { l: UH_W / 2 - w / 2, r: UH_W / 2 + w / 2 }; };
const uhEl = r => r.phase === 'play' ? (Date.now() - r.t0) / 1000 * UH_SPEED : 0;
const uhOk = v => typeof v === 'number' && isFinite(v);
const uhPic = o => { o = o || {}; return { d: typeof o.d === 'string' && o.d.indexOf('data:image/') === 0 && o.d.length < 9000 ? o.d : '', e: clean(o.e, 4), c: /^#[0-9a-f]{3,8}$/i.test(o.c || '') ? o.c : '#5865f2' }; };
function uhSnap(r, pid) {
  const el = uhEl(r), b = uhBorder(el);
  return { id: r.id, code: r.code, quick: !!r.quick, phase: r.phase, host: r.host, me: pid, cdEnd: r.cdEnd || 0, now: Date.now(), el, bl: b.l, br: b.r, grace: UH_GRACE, sh0: UH_SH0, sh1: UH_SH1, spd: UH_SPEED,
    qEnd: r.qT ? r.qEnd : 0, win: r.win || null, ps: r.ps.map((p, i) => ({ i, pid: p.pid, name: p.name, on: p.on, al: !!p.al, k: p.k || 0, pic: p.pic, left: !!p.left, bot: !!p.bot })) };
}
const uhAll = (r, o) => r.ps.forEach(m => { const p = players.get(m.pid); if (p && m.on) send(p, o); });
const uhBroadcast = r => r.ps.forEach(m => { const p = players.get(m.pid); if (p && m.on) send(p, { t: 'uh_room', room: uhSnap(r, m.pid) }); });
const uhWorld = (r, pid) => { const p = players.get(pid); if (p && r.seed) send(p, { t: 'uh_world', seed: r.seed, diffs: r.diffs, chests: r.chests.map(c => ({ id: c.id, x: c.x, y: c.y })) }); };
const uhInv = (r, m) => { const p = players.get(m.pid); if (p) send(p, { t: 'uh_inv', inv: m.inv }); };
const uhMsg = (r, s) => uhAll(r, { t: 'uh_msg', m: s });
const uhTier = (m, T) => { let b = 0; for (const k in T) if (m.inv[k] > 0 && T[k] > b) b = T[k]; return b; };
const uhWeapon = m => { let b = 1, tier = 0; for (const k in UH_SWORD) if (m.inv[k] > 0 && UH_SWORD[k] > b) { b = UH_SWORD[k]; tier = k == 'wsword' ? 1 : k == 'ssword' ? 2 : k == 'isword' ? 3 : 4; } return { dmg: b, tier }; };
const uhArm = m => m.inv.darmor > 0 ? { red: .5, tier: 2 } : m.inv.iarmor > 0 ? { red: .3, tier: 1 } : { red: 0, tier: 0 };
const uhPick = m => { let b = 0; for (const k in UH_PICK) if (m.inv[k] > 0 && UH_PICK[k] > b) b = UH_PICK[k]; return b; };
const uhAdd = (m, it, n) => { if (!it) return; m.inv[it] = (m.inv[it] || 0) + (n || 1); };
function uhCheckWin(r) {
  if (r.phase !== 'play') return;
  const al = r.ps.filter(m => m.al);
  if (al.length > 1) return;
  r.phase = 'end'; r.win = al[0] ? { pid: al[0].pid, name: al[0].name } : null; uhMsg(r, al[0] ? '🏆 ¡' + al[0].name + ' ganó el UHC!' : '💀 Nadie sobrevivió'); uhBroadcast(r);
}
function uhDie(r, m, why, killer) {
  if (!m.al) return; m.al = false; m.hp = 0;
  const items = Object.keys(m.inv).filter(k => m.inv[k] > 0);
  if (items.length) { r.chests.push({ id: crypto.randomBytes(3).toString('hex'), x: m.x, y: m.y, inv: m.inv }); uhAll(r, { t: 'uh_ch', chests: r.chests.map(c => ({ id: c.id, x: c.x, y: c.y })) }); }
  m.inv = {}; uhInv(r, m);
  if (killer && killer !== m) { killer.k = (killer.k || 0) + 1; uhMsg(r, '⚔️ ' + killer.name + ' eliminó a ' + m.name); } else uhMsg(r, '💀 ' + m.name + ' ' + (why || 'murió'));
  uhCheckWin(r); if (r.phase === 'play') uhBroadcast(r);
}
function uhStart(r) {
  const ps = r.ps.filter(m => m.on && !m.left); if (ps.length < 2) return 'Se necesitan al menos 2 jugadores conectados';
  r.ps = ps; r.seed = (Math.random() * 4e9) >>> 0; r.w = uhMk(r.seed); r.diffs = []; r.chests = []; r.win = null;
  const order = shuffle(r.ps), n = order.length;
  order.forEach((m, i) => {
    const x = Math.max(4, Math.min(UH_W - 5, Math.floor(UH_W * (i + .5) / n + (Math.random() - .5) * 6))), sy = r.w.surf[x];
    for (let dx = -1; dx <= 1; dx++) for (let y = sy - 9; y < sy; y++) if (r.w.get(x + dx, y) !== 0) { r.w.set(x + dx, y, 0); r.diffs.push([x + dx, y, 0]); }
    Object.assign(m, { x: x + .5, y: sy - .86, f: 1, hp: 20, inv: {}, al: true, k: 0, a: 0, air: false, peak: 0, lastHit: 0, lastBreak: 0, lastEat: 0, off: 0 });
  });
  r.phase = 'count'; r.cdEnd = Date.now() + (r.quick ? 12000 : 6000); clearTimeout(r.cdT); r.cdT = setTimeout(() => { if (r.phase === 'count') { r.phase = 'play'; r.t0 = Date.now(); uhBroadcast(r); } }, r.cdEnd - Date.now());
  r.ps.forEach(m => uhWorld(r, m.pid)); uhBroadcast(r); return null;
}
function uhNew(p, pic, quick) {
  const r = { id: crypto.randomBytes(4).toString('hex'), code: newCode(), quick: !!quick, host: p.pid, phase: 'lobby', ps: [{ pid: p.pid, name: p.name, on: true, pic: uhPic(pic) }], seed: 0, diffs: [], chests: [], win: null, w: null, t0: 0, cdEnd: 0 };
  uhs.set(r.id, r); p.uroom = r.id; uhBroadcast(r); return r;
}
function uhJoin(p, r, pic) {
  r.ps.push({ pid: p.pid, name: r.ps.some(x => x.name === p.name) ? p.name + ' 2' : p.name, on: true, pic: uhPic(pic) }); p.uroom = r.id; uhBroadcast(r);
  if (r.quick && r.ps.length >= 2 && r.phase === 'lobby' && !r.qT) r.qT = setTimeout(() => { r.qT = 0; if (r.phase === 'lobby') { const e = uhStart(r); if (e) uhAll(r, { t: 'err', m: e }); } }, 8000), r.qEnd = Date.now() + 8000;
}
function uhLeave(p) {
  const r = uhs.get(p.uroom); p.uroom = null; if (!r) return; clearTimeout(p.udrop);
  const m = r.ps.find(x => x.pid === p.pid); if (!m) return;
  if (r.phase === 'lobby' || r.phase === 'end') { r.ps = r.ps.filter(x => x.pid !== p.pid); }
  else { m.left = true; m.on = false; if (m.al) uhDie(r, m, 'abandonó la partida'); }
  if (!r.ps.some(x => x.on && !x.left && !x.bot)) { clearTimeout(r.cdT); clearTimeout(r.qT); uhs.delete(r.id); return; }
  if (r.host === p.pid) r.host = r.ps.find(x => x.on && !x.left && !x.bot).pid;
  uhBroadcast(r);
}
function uhMsgIn(p, m) {
  const r = uhs.get(p.uroom), me = r && r.ps.find(x => x.pid === p.pid);
  switch (m.t) {
    case 'uh_quick': {
      if (r || rooms.get(p.roomId) || aucs.get(p.aroom)) return err(p, 'Ya estás en una sala');
      const w = [...uhs.values()].find(x => x.quick && x.phase === 'lobby' && x.ps.length < UH_MAXP); return w ? uhJoin(p, w, m.pic) : uhNew(p, m.pic, true);
    }
    case 'uh_create': { if (r || rooms.get(p.roomId) || aucs.get(p.aroom)) return err(p, 'Ya estás en una sala'); return uhNew(p, m.pic, false); }
    case 'uh_join': {
      if (r || rooms.get(p.roomId) || aucs.get(p.aroom)) return err(p, 'Ya estás en una sala');
      const code = clean(m.code, 8).toUpperCase(), w = [...uhs.values()].find(x => x.code === code);
      if (!w) return err(p, 'Código incorrecto o sala inexistente'); if (w.phase !== 'lobby' || w.ps.length >= UH_MAXP) return err(p, 'Esa sala ya empezó o está llena');
      return uhJoin(p, w, m.pic);
    }
    case 'uh_solo': {
      if (r || rooms.get(p.roomId) || aucs.get(p.aroom)) return err(p, 'Ya estás en una sala');
      const nr = uhNew(p, m.pic, false); nr.solo = true; uhAddBots(nr, Math.max(1, Math.min(UH_MAXP - 1, +m.n || 4)));
      const e = uhStart(nr); return e ? err(p, e) : null;
    }
    case 'uh_leave': return uhLeave(p);
    case 'uh_start': { if (!r || r.host !== p.pid || r.phase !== 'lobby') return; const e = uhStart(r); return e ? err(p, e) : null; }
    case 'uh_again': { if (!r || r.host !== p.pid || r.phase !== 'end') return; r.ps = r.ps.filter(x => !x.left); r.phase = 'lobby'; const e = uhStart(r); return e ? err(p, e) : null; }
  }
  if (!r || !me || r.phase !== 'play' && !(r.phase === 'count' && m.t === 'uh_pos') || !me.al) return;
  const now = Date.now(), el = uhEl(r), w = r.w, d2 = (x, y) => Math.hypot(x - me.x, y - me.y);
  switch (m.t) {
    case 'uh_pos': {
      if (!uhOk(m.x) || !uhOk(m.y)) return; const x = Math.max(.5, Math.min(UH_W - .5, m.x)), y = Math.max(0, Math.min(UH_H + 2, m.y));
      if (r.phase === 'play') {
        if (m.g) { if (me.air) { const dist = y - me.peak; if (dist > 3.6) { me.hp -= Math.floor(dist - 3); if (me.hp <= 0) { me.x = x; me.y = y; return uhDie(r, me, 'se cayó de muy alto'); } } me.air = false } }
        else { if (!me.air) { me.air = true; me.peak = y } else me.peak = Math.min(me.peak, y) }
      }
      me.x = x; me.y = y; me.f = m.f < 0 ? -1 : 1; me.off = 0; return;
    }
    case 'uh_break': {
      const x = m.x | 0, y = m.y | 0, b = w.get(x, y); if (b <= 0 || b === 11 || d2(x + .5, y + .5) > 6.5) return;
      const tier = uhPick(me); if (tier < UH_NEED[b]) return;
      const mn = UH_HARD[b] / UH_SPD[tier] * .5; if (now - me.lastBreak < mn * 1000) { const q = players.get(me.pid); q && send(q, { t: 'uh_b', x, y, b }); return; }
      me.lastBreak = now; w.set(x, y, 0); r.diffs.push([x, y, 0]); uhAll(r, { t: 'uh_b', x, y, b: 0 });
      let it = UH_DROP[b]; if (b === 5) it = Math.random() < .06 ? 'apple' : ''; uhAdd(me, it, 1); uhInv(r, me); return;
    }
    case 'uh_place': {
      const x = m.x | 0, y = m.y | 0, bl = UH_PLACE[m.it]; if (!bl || !(me.inv[m.it] > 0) || w.get(x, y) !== 0 || x < 0 || y < 0 || x >= UH_W || y >= UH_H || d2(x + .5, y + .5) > 6.5) return;
      if (!(w.get(x + 1, y) || w.get(x - 1, y) || w.get(x, y + 1) || w.get(x, y - 1))) return;
      if (r.ps.some(o => o.al && Math.abs(o.x - (x + .5)) < .4 + .5 && Math.abs(o.y - (y + .5)) < .85 + .5)) return;
      me.inv[m.it]--; w.set(x, y, bl); r.diffs.push([x, y, bl]); uhAll(r, { t: 'uh_b', x, y, b: bl }); uhInv(r, me); return;
    }
    case 'uh_craft': {
      const rc = UH_REC.find(q => q[0] === m.id); if (!rc) return; for (const k in rc[2]) if (!(me.inv[k] >= rc[2][k])) return;
      for (const k in rc[2]) me.inv[k] -= rc[2][k]; uhAdd(me, rc[0], rc[3]); uhInv(r, me); return;
    }
    case 'uh_eat': {
      if (now - me.lastEat < 900) return; const h = m.it === 'gapple' ? 10 : m.it === 'apple' ? 3 : 0; if (!h || !(me.inv[m.it] > 0) || me.hp >= 20) return;
      me.inv[m.it]--; me.hp = Math.min(20, me.hp + h); me.lastEat = now; uhInv(r, me); return;
    }
    case 'uh_hit': {
      if (el < UH_GRACE) { const q = players.get(me.pid); q && send(q, { t: 'uh_msg', m: '🕊️ El PvP aún está desactivado' }); return; }
      const v = r.ps.find(o => o.pid === m.id); if (!v || !v.al || v === me || now - me.lastHit < 420 || Math.hypot(v.x - me.x, v.y - me.y) > 3.8) return;
      me.lastHit = now; me.a++; const wp = uhWeapon(me), ar = uhArm(v); v.hp -= wp.dmg * (1 - ar.red);
      const vq = players.get(v.pid); vq && send(vq, { t: 'uh_kb', kx: v.x >= me.x ? 7 : -7, ky: -5 });
      if (v.hp <= 0) uhDie(r, v, '', me); return;
    }
  }
}
function uhTick() {
  const now = Date.now();
  uhs.forEach(r => {
    if (r.phase !== 'play' && r.phase !== 'count') return;
    const el = uhEl(r), b = uhBorder(el);
    if (r.phase === 'play') {
      r.ps.forEach(m => {
        if (!m.al) return;
        if (!m.on) { m.off += .1; if (m.off > 45) return uhDie(r, m, 'se desconectó'); }
        if (m.x < b.l || m.x > b.r) { m.hp -= 1.5 * .1 * UH_SPEED; if (m.hp <= 0) return uhDie(r, m, 'murió por el borde'); }
      });
      if (r.phase !== 'play') return;
      for (let i = r.chests.length - 1; i >= 0; i--) { const c = r.chests[i], m = r.ps.find(o => o.al && o.on && Math.hypot(o.x - c.x, o.y - c.y) < 1.6); if (m) { for (const k in c.inv) uhAdd(m, k, c.inv[k]); r.chests.splice(i, 1); uhInv(r, m); uhAll(r, { t: 'uh_ch', chests: r.chests.map(q => ({ id: q.id, x: q.x, y: q.y })) }); } }
    }
    const st = { t: 'uh_s', el, bl: b.l, br: b.r, now, p: r.ps.map((m, i) => { const w = m.inv ? uhWeapon(m) : { tier: 0 }, a = m.inv ? uhArm(m) : { tier: 0 }; return [i, +(m.x || 0).toFixed(2), +(m.y || 0).toFixed(2), m.f || 1, Math.max(0, +(m.hp || 0).toFixed(1)), m.a || 0, m.al ? 1 : 0, w.tier, a.tier, m.on ? 1 : 0]; }) };
    uhAll(r, st);
  });
}
setInterval(uhTick, 100);
/* ---------- BOTS del UHC (modo solo / pruebas) ---------- */
const BOT_NAMES = ['Aldo', 'Brisa', 'Kai', 'Lumi', 'Nox', 'Pipa', 'Rex', 'Sol', 'Taro', 'Uma', 'Vex', 'Yuki'], BOT_COL = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22', '#1abc9c'];
const botDo = (r, m, o) => uhMsgIn({ pid: m.pid, name: m.name, uroom: r.id }, o);
const botFeet = m => Math.round(m.y + .86);                       // fila que pisa (los pies siempre en entero)
function botFall(r, m) { let g = 0; while (g++ < 6) { const f = botFeet(m); if (f >= UH_H - 1 || r.w.get(Math.floor(m.x), f) > 0) break; m.y += 1; } m.y = botFeet(m) - .86; }
function botBreak(r, m, x, y) { if (r.w.get(x, y) <= 0) return true; botDo(r, m, { t: 'uh_break', x, y }); return r.w.get(x, y) <= 0; }
function botGo(r, m, gx, gy) {                                      // camina hacia (gx,gy) cavando si hace falta; devuelve false si se atoró
  const G = (x, y) => r.w.get(x, y), feet = botFeet(m), c0 = Math.floor(m.x), dx = gx - m.x, dy = gy - m.y;
  if (Math.abs(dx) < .6 && dy > 1.2) return botBreak(r, m, c0, feet);                                   // objetivo debajo: cavar hacia abajo
  const dir = dx >= 0 ? 1 : -1, nx = Math.max(.6, Math.min(UH_W - .6, m.x + dir * .5)), c = Math.floor(nx), r0 = feet - 1, r1 = feet - 2; m.f = dir;
  if (!G(c, r0) && !G(c, r1)) { m.x = nx; return true; }
  if (G(c, r0) && !G(c, r1) && !G(c, r1 - 1) && !G(c0, r1 - 1)) { m.y -= 1; m.x = nx; return true; }  // sube un escalón
  const L = dy < -1.2 ? [[c0, r1 - 1], [c, r1 - 1], [c, r1]] : [[c, r1], [c, r0]];                       // si el objetivo está arriba, hace escalera
  for (const [x, y] of L) if (G(x, y) > 0) return botBreak(r, m, x, y);
  return true;
}
function botCraft(r, m) {
  const c = id => botDo(r, m, { t: 'uh_craft', id }), n = k => m.inv[k] || 0;
  if (n('log') > 0 && n('planks') < 8) c('planks');
  if (n('planks') >= 2 && n('stick') < 4) c('stick');
  if (!n('wpick') && !n('spick') && !n('ipick') && !n('dpick') && n('planks') >= 3 && n('stick') >= 2) c('wpick');
  if (!n('wsword') && !n('ssword') && !n('isword') && !n('dsword') && n('planks') >= 2 && n('stick') >= 1) c('wsword');
  if (!n('spick') && !n('ipick') && !n('dpick') && n('cobble') >= 3 && n('stick') >= 2) c('spick');
  if (!n('ssword') && !n('isword') && !n('dsword') && n('cobble') >= 2 && n('stick') >= 1) c('ssword');
  if (!n('ipick') && !n('dpick') && n('iron') >= 3 && n('stick') >= 2) c('ipick');
  if (!n('isword') && !n('dsword') && n('iron') >= 2 && n('stick') >= 1) c('isword');
  if (!n('iarmor') && !n('darmor') && n('iron') >= 10) c('iarmor');
  if (!n('dpick') && n('diamond') >= 3 && n('stick') >= 2) c('dpick');
  if (!n('dsword') && n('diamond') >= 2 && n('stick') >= 1) c('dsword');
  if (!n('darmor') && n('diamond') >= 8) c('darmor');
  if (n('gold') >= 5) c('gapple');
}
function uhBot(r, m, now) {
  if (!m.ai || m.ai.s !== r.seed) m.ai = { s: r.seed, dir: Math.random() < .5 ? -1 : 1, craftT: 0, stuck: 0, lx: m.x, ly: m.y, tx: 0 };
  const ai = m.ai, w = r.w, el = uhEl(r), bd = uhBorder(el);
  if (r.phase !== 'play') return botFall(r, m);
  if (m.hp <= 10 && now - m.lastEat > 1000) { if (m.inv.gapple > 0) botDo(r, m, { t: 'uh_eat', it: 'gapple' }); else if (m.hp <= 14 && m.inv.apple > 0) botDo(r, m, { t: 'uh_eat', it: 'apple' }); }
  if (now - ai.craftT > 1200) { ai.craftT = now; botCraft(r, m); }
  const tier = uhPick(m), sw = uhWeapon(m).dmg, n = k => m.inv[k] || 0;
  let foe = null, fd = 1e9; r.ps.forEach(o => { if (o !== m && o.al) { const d = Math.hypot(o.x - m.x, o.y - m.y); if (d < fd) { fd = d; foe = o; } } });
  let ok = true;
  if (m.x < bd.l + 4 || m.x > bd.r - 4) ok = botGo(r, m, UH_W / 2, m.y);                                  // el borde manda
  else if (foe && (el >= UH_GRACE - 10 && sw >= 4 || el >= UH_GRACE + 150)) {                              // cazar
    if (fd <= 3.2 && el >= UH_GRACE) { m.f = foe.x >= m.x ? 1 : -1; botDo(r, m, { t: 'uh_hit', id: foe.pid }); }
    else ok = botGo(r, m, foe.x, foe.y);
  } else if (!tier) {                                                                                       // 1) madera
    let best = null, bd2 = 1e9; const c0 = Math.floor(m.x);
    for (let x = Math.max(1, c0 - 30); x < Math.min(UH_W - 1, c0 + 30); x++) { const s = w.surf[x]; for (let y = s - 8; y < s; y++) if (w.get(x, y) === 4) { const d = Math.abs(x - m.x) + Math.abs(y - m.y) * .5; if (d < bd2) { bd2 = d; best = [x, y]; } } }
    if (!best) ok = botGo(r, m, m.x + ai.dir * 20, m.y);
    else if (Math.hypot(best[0] + .5 - m.x, best[1] + .5 - m.y) <= 5.5) botBreak(r, m, best[0], best[1]);
    else ok = botGo(r, m, best[0] + .5, m.y);
  } else if (tier < 2) {                                                                                    // 2) piedra: cavar hacia abajo
    ok = botBreak(r, m, Math.floor(m.x), botFeet(m));
  } else {                                                                                                  // 3) minar: bajar y hacer túnel buscando minerales
    const s = w.surf[Math.floor(m.x)] || 26, depth = botFeet(m) - s, want = Math.min(UH_H - 8, s + 22);
    ok = depth < 18 ? botBreak(r, m, Math.floor(m.x), botFeet(m)) : botGo(r, m, m.x + ai.dir * 12, botFeet(m));
    void want;
  }
  if (tier >= 2 || n('log') + n('planks') >= 0) {                                                           // recoger minerales cercanos
    const cx = Math.floor(m.x), cy = botFeet(m) - 1; let done = false;
    for (let dx = -3; dx <= 3 && !done; dx++) for (let dy = -3; dy <= 3 && !done; dy++) { const b = w.get(cx + dx, cy + dy); if ((b === 6 || b === 7 || b === 8) && tier >= UH_NEED[b]) { botBreak(r, m, cx + dx, cy + dy); done = true; } }
  }
  botFall(r, m);
  if (Math.abs(m.x - ai.lx) < .1 && Math.abs(m.y - ai.ly) < .1) ai.stuck++; else ai.stuck = 0; ai.lx = m.x; ai.ly = m.y;
  if (!ok || ai.stuck > 12) { ai.dir = -ai.dir; ai.stuck = 0; if (!ok) { const c = Math.floor(m.x), f = botFeet(m); botBreak(r, m, c, f - 1); botBreak(r, m, c, f - 2); } }
}
setInterval(() => { const now = Date.now(); uhs.forEach(r => { if (r.phase !== 'play' && r.phase !== 'count') return; r.ps.forEach(m => { if (m.bot && m.al) { try { uhBot(r, m, now); } catch (e) { } } }); }); }, 200);
function uhAddBots(r, n) {
  shuffle(BOT_NAMES).slice(0, n).forEach((nm, i) => r.ps.push({ pid: 'bot' + crypto.randomBytes(5).toString('hex'), name: '🤖 ' + nm, on: true, bot: true, pic: { d: '', e: '🤖', c: BOT_COL[i % BOT_COL.length] } }));
}


/* ---------- mensajes ---------- */
function onMsg(p, m) {
  if (m.t.indexOf('sa_') === 0) return aMsg(p, m);
  if (m.t.indexOf('uh_') === 0) return uhMsgIn(p, m);
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
  let tokens = 80, last = Date.now();
  ws.on('message', raw => {
    const now = Date.now(); tokens = Math.min(80, tokens + (now - last) / 20); last = now; if (--tokens < 0) return;
    let m; try { m = JSON.parse(raw); } catch (e) { return; } if (!m || typeof m.t !== 'string') return;
    if (m.t === 'hello') {
      const name = clean(m.name, 16) || 'Jugador'; const old = m.pid && players.get(String(m.pid));
      if (old) { p = old; clearTimeout(p.drop); if (p.ws && p.ws !== ws) { try { p.ws.close(); } catch (e) { } } p.ws = ws; p.name = name; }
      else { p = { pid: crypto.randomBytes(12).toString('hex'), name, ws, roomId: null, drop: null }; players.set(p.pid, p); }
      send(p, { t: 'hello', pid: p.pid });
      const room = rooms.get(p.roomId); if (room) { const mm = room.ps.find(x => x.pid === p.pid); if (mm) { mm.on = true; sys(room, mm.name + ' volvió a conectarse'); broadcast(room); } else p.roomId = null; }
      const ar = aucs.get(p.aroom); if (ar) { const am = ar.ps.find(x => x.pid === p.pid); if (am) { am.on = true; aBroadcast(ar); } else p.aroom = null; }
      const ur = uhs.get(p.uroom); if (ur) { const um = ur.ps.find(x => x.pid === p.pid); if (um) { um.on = true; um.off = 0; uhBroadcast(ur); if (ur.seed) uhWorld(ur, p.pid); } else p.uroom = null; }
      return;
    }
    if (!p) return; onMsg(p, m);
  });
  ws.on('close', () => {
    if (!p || p.ws !== ws) return; const room = rooms.get(p.roomId), ar = aucs.get(p.aroom), ur = uhs.get(p.uroom);
    if (!room && !ar && !ur) { players.delete(p.pid); return; }
    if (ur) { const um = ur.ps.find(x => x.pid === p.pid); if (um) { um.on = false; uhBroadcast(ur); } }
    if (room) { const mm = room.ps.find(x => x.pid === p.pid); if (mm) { mm.on = false; broadcast(room); } }
    if (ar) { const am = ar.ps.find(x => x.pid === p.pid); if (am) { am.on = false; aBroadcast(ar); } }
    const T = room ? (room.phase === 'lobby' ? 20000 : 90000) : ar ? (ar.phase === 'lobby' ? 20000 : 60000) : (ur.phase === 'lobby' ? 20000 : 60000);
    p.drop = setTimeout(() => { if (p.ws === ws || !p.ws || p.ws.readyState !== 1) { if (rooms.get(p.roomId)) removeFromRoom(p, 'leave'); if (aucs.get(p.aroom)) aLeave(p); if (uhs.get(p.uroom)) uhLeave(p); players.delete(p.pid); } }, T);
  });
  ws.on('error', () => { });
});
setInterval(() => { wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; try { ws.ping(); } catch (e) { } }); }, 30000);
if (require.main === module) server.listen(PORT, () => console.log('Impostor server en el puerto ' + PORT));
module.exports = { server, wss, rooms, players };
