'use strict';

/**
 * 象棋擂台 —— 多人实时对弈 / 观战 / 弹幕聊天
 * 零依赖 Node.js 服务：静态资源 + JSON API + 长轮询同步 + 权威棋规引擎
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8000);
const PUBLIC_DIR = path.join(__dirname, 'public');

const MOVE_LIMIT_MS = 90 * 1000;        // 每步思考时间
const LONGPOLL_MS = 12000;              // 长轮询最长挂起
const PRESENCE_MS = 25 * 1000;          // 在线判定窗口
const ROOM_TTL_MS = 3 * 60 * 60 * 1000; // 活跃房间保留
const MAX_ROOMS = 300;
const MAX_CHAT = 60;
const MAX_MOVES = 400;

/* ------------------------------------------------------------------ */
/* 棋规引擎                                                            */
/* ------------------------------------------------------------------ */

const BACK_RANK = ['R', 'N', 'B', 'A', 'K', 'A', 'B', 'N', 'R'];

function newBoard() {
  const b = Array.from({ length: 10 }, () => Array(9).fill(null));
  for (let c = 0; c < 9; c++) {
    b[0][c] = { t: BACK_RANK[c], c: 'b' };
    b[9][c] = { t: BACK_RANK[c], c: 'r' };
  }
  b[2][1] = { t: 'C', c: 'b' };
  b[2][7] = { t: 'C', c: 'b' };
  b[7][1] = { t: 'C', c: 'r' };
  b[7][7] = { t: 'C', c: 'r' };
  for (const c of [0, 2, 4, 6, 8]) {
    b[3][c] = { t: 'P', c: 'b' };
    b[6][c] = { t: 'P', c: 'r' };
  }
  return b;
}

function cloneBoard(b) {
  return b.map((row) => row.map((p) => (p ? { t: p.t, c: p.c } : null)));
}

function inPalace(color, r, c) {
  if (c < 3 || c > 5) return false;
  return color === 'r' ? r >= 7 && r <= 9 : r >= 0 && r <= 2;
}

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** 生成伪合法走法（未过滤自将） */
function genMoves(b, r, c) {
  const p = b[r][c];
  if (!p) return [];
  const out = [];
  const push = (rr, cc) => {
    if (rr < 0 || rr > 9 || cc < 0 || cc > 8) return;
    const q = b[rr][cc];
    if (q && q.c === p.c) return;
    out.push([rr, cc]);
  };

  switch (p.t) {
    case 'K': {
      for (const [dr, dc] of DIRS) {
        if (inPalace(p.c, r + dr, c + dc)) push(r + dr, c + dc);
      }
      // 白脸将：同列且中间无子，可直接"飞"吃对方将
      const dir = p.c === 'r' ? -1 : 1;
      for (let rr = r + dir; rr >= 0 && rr <= 9; rr += dir) {
        const q = b[rr][c];
        if (q) {
          if (q.t === 'K' && q.c !== p.c) out.push([rr, c]);
          break;
        }
      }
      break;
    }
    case 'A': {
      for (const [dr, dc] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        if (inPalace(p.c, r + dr, c + dc)) push(r + dr, c + dc);
      }
      break;
    }
    case 'B': {
      for (const [dr, dc] of [[2, 2], [2, -2], [-2, 2], [-2, -2]]) {
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || rr > 9 || cc < 0 || cc > 8) continue;
        if (p.c === 'r' ? rr < 5 : rr > 4) continue; // 象不过河
        if (b[r + dr / 2][c + dc / 2]) continue;     // 塞象眼
        push(rr, cc);
      }
      break;
    }
    case 'N': {
      for (const [dr, dc] of [[2, 1], [2, -1], [-2, 1], [-2, -1], [1, 2], [-1, 2], [1, -2], [-1, -2]]) {
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || rr > 9 || cc < 0 || cc > 8) continue;
        const lr = r + (Math.abs(dr) === 2 ? dr / 2 : 0);
        const lc = c + (Math.abs(dc) === 2 ? dc / 2 : 0);
        if (b[lr][lc]) continue; // 蹩马腿
        push(rr, cc);
      }
      break;
    }
    case 'R': {
      for (const [dr, dc] of DIRS) {
        let rr = r + dr;
        let cc = c + dc;
        while (rr >= 0 && rr <= 9 && cc >= 0 && cc <= 8) {
          const q = b[rr][cc];
          if (!q) {
            out.push([rr, cc]);
          } else {
            if (q.c !== p.c) out.push([rr, cc]);
            break;
          }
          rr += dr;
          cc += dc;
        }
      }
      break;
    }
    case 'C': {
      for (const [dr, dc] of DIRS) {
        let rr = r + dr;
        let cc = c + dc;
        let screen = false;
        while (rr >= 0 && rr <= 9 && cc >= 0 && cc <= 8) {
          const q = b[rr][cc];
          if (!screen) {
            if (!q) out.push([rr, cc]);
            else screen = true;
          } else if (q) {
            if (q.c !== p.c) out.push([rr, cc]);
            break;
          }
          rr += dr;
          cc += dc;
        }
      }
      break;
    }
    case 'P': {
      const dir = p.c === 'r' ? -1 : 1;
      push(r + dir, c);
      const crossed = p.c === 'r' ? r <= 4 : r >= 5;
      if (crossed) {
        push(r, c - 1);
        push(r, c + 1);
      }
      break;
    }
    default:
      break;
  }
  return out;
}

function findKing(b, color) {
  const back = color === 'r' ? 9 : 0;
  for (let dr = 0; dr < 3; dr++) {
    const r = color === 'r' ? back - dr : back + dr;
    for (let c = 3; c <= 5; c++) {
      const p = b[r][c];
      if (p && p.t === 'K' && p.c === color) return [r, c];
    }
  }
  for (let i = 0; i < 10; i++) {
    for (let j = 0; j < 9; j++) {
      const p = b[i][j];
      if (p && p.t === 'K' && p.c === color) return [i, j];
    }
  }
  return null;
}

function attacked(b, r, c, byColor) {
  for (let i = 0; i < 10; i++) {
    for (let j = 0; j < 9; j++) {
      const p = b[i][j];
      if (!p || p.c !== byColor) continue;
      for (const [rr, cc] of genMoves(b, i, j)) {
        if (rr === r && cc === c) return true;
      }
    }
  }
  return false;
}

function kingSafeAfter(b, color, from, to) {
  const nb = cloneBoard(b);
  nb[to[0]][to[1]] = nb[from[0]][from[1]];
  nb[from[0]][from[1]] = null;
  const k = findKing(nb, color);
  if (!k) return null;
  return attacked(nb, k[0], k[1], color === 'r' ? 'b' : 'r') ? null : nb;
}

function legalMovesFrom(b, color, r, c) {
  const p = b[r][c];
  if (!p || p.c !== color) return [];
  const res = [];
  for (const to of genMoves(b, r, c)) {
    if (kingSafeAfter(b, color, [r, c], to)) res.push(to);
  }
  return res;
}

function legalMoveMap(b, color) {
  const map = {};
  for (let i = 0; i < 10; i++) {
    for (let j = 0; j < 9; j++) {
      const p = b[i][j];
      if (!p || p.c !== color) continue;
      const ms = legalMovesFrom(b, color, i, j);
      if (ms.length) map[i + ',' + j] = ms;
    }
  }
  return map;
}

/* ------------------------------------------------------------------ */
/* 房间状态                                                            */
/* ------------------------------------------------------------------ */

/** @type {Map<string, any>} */
const rooms = new Map();
/** roomId -> Set<resolve> 长轮询挂起者 */
const waiters = new Map();

function rid() {
  return crypto.randomBytes(4).toString('hex');
}
function token() {
  return crypto.randomBytes(12).toString('hex');
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function cleanName(raw, fallback) {
  if (typeof raw !== 'string') return fallback;
  const s = raw.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 12);
  return s || fallback;
}

function createRoom(name, hostName) {
  const id = rid();
  const room = {
    id,
    name: cleanName(name, '无名棋室'),
    createdAt: Date.now(),
    lastActive: Date.now(),
    board: newBoard(),
    turn: 'r',
    status: 'waiting', // waiting | playing | over
    winner: null,
    endReason: '',
    check: false,
    players: {
      r: { token: token(), name: hostName, lastSeen: Date.now() },
      b: null,
    },
    spectators: new Map(), // token -> { name, lastSeen }
    chat: [],
    chatRate: new Map(),
    moves: [],
    moveCount: 0,
    lastMove: null,
    turnStartedAt: Date.now(),
    rematch: [],
    seq: 1,
    legalCache: null,
  };
  rooms.set(id, room);
  return room;
}

function other(color) {
  return color === 'r' ? 'b' : 'r';
}

function bump(room) {
  room.seq += 1;
  room.lastActive = Date.now();
  room.legalCache = null;
  const set = waiters.get(room.id);
  if (set && set.size) {
    for (const resolve of set) resolve();
    set.clear();
  }
}

function waitForChange(room, since, timeoutMs) {
  if (room.seq !== since) return Promise.resolve();
  return new Promise((resolve) => {
    let set = waiters.get(room.id);
    if (!set) {
      set = new Set();
      waiters.set(room.id, set);
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      set.delete(finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    set.add(finish);
  });
}

function touch(room, viewerToken) {
  const now = Date.now();
  if (room.players.r && room.players.r.token === viewerToken) room.players.r.lastSeen = now;
  if (room.players.b && room.players.b.token === viewerToken) room.players.b.lastSeen = now;
  const spec = room.spectators.get(viewerToken);
  if (spec) spec.lastSeen = now;
}

function isOnline(member) {
  return !!member && Date.now() - member.lastSeen < PRESENCE_MS;
}

function roleOf(room, viewerToken) {
  if (room.players.r && room.players.r.token === viewerToken) return 'r';
  if (room.players.b && room.players.b.token === viewerToken) return 'b';
  if (room.spectators.has(viewerToken)) return 'spec';
  return null;
}

function timeLeft(room) {
  if (room.status !== 'playing') return MOVE_LIMIT_MS;
  return Math.max(0, MOVE_LIMIT_MS - (Date.now() - room.turnStartedAt));
}

function boardJSON(board) {
  return board.map((row) => row.map((p) => (p ? p.c + p.t : null)));
}

function snapshot(room, viewerToken) {
  const myColor = roleOf(room, viewerToken) || 'spec';
  let legal = null;
  if ((myColor === 'r' || myColor === 'b') && room.status === 'playing' && room.turn === myColor) {
    if (!room.legalCache || room.legalCache.seq !== room.seq || room.legalCache.color !== myColor) {
      room.legalCache = { seq: room.seq, color: myColor, map: legalMoveMap(room.board, myColor) };
    }
    legal = room.legalCache.map;
  }

  const specNames = [];
  for (const s of room.spectators.values()) if (isOnline(s)) specNames.push(s.name);

  return {
    seq: room.seq,
    id: room.id,
    name: room.name,
    status: room.status,
    turn: room.turn,
    winner: room.winner,
    endReason: room.endReason,
    check: room.check,
    board: boardJSON(room.board),
    lastMove: room.lastMove,
    moveCount: room.moveCount,
    players: {
      r: room.players.r
        ? { name: room.players.r.name, online: isOnline(room.players.r) }
        : null,
      b: room.players.b
        ? { name: room.players.b.name, online: isOnline(room.players.b) }
        : null,
    },
    spectatorsCount: specNames.length,
    spectators: specNames.slice(0, 8),
    timeLeft: timeLeft(room),
    limit: MOVE_LIMIT_MS,
    chat: room.chat.slice(-40),
    rematch: room.rematch.slice(),
    myColor,
    legal,
    serverNow: Date.now(),
  };
}

function pushChat(room, role, name, text) {
  room.chat.push({
    id: room.seq,
    role,
    name,
    text,
    at: Date.now(),
  });
  if (room.chat.length > MAX_CHAT) room.chat.splice(0, room.chat.length - MAX_CHAT);
}

function resetGame(room) {
  room.board = newBoard();
  room.turn = 'r';
  room.status = room.players.b ? 'playing' : 'waiting';
  room.winner = null;
  room.endReason = '';
  room.check = false;
  room.moves = [];
  room.moveCount = 0;
  room.lastMove = null;
  room.turnStartedAt = Date.now();
  room.rematch = [];
}

function applyMove(room, color, from, to) {
  if (room.status !== 'playing') return '对局尚未开始或已结束';
  if (room.turn !== color) return '还没轮到你走棋';
  const [fr, fc] = from;
  const [tr, tc] = to;
  if (fr < 0 || fr > 9 || fc < 0 || fc > 8 || tr < 0 || tr > 9 || tc < 0 || tc > 8) return '坐标不合法';
  const piece = room.board[fr][fc];
  if (!piece || piece.c !== color) return '请选择自己的棋子';
  const legal = legalMovesFrom(room.board, color, fr, fc);
  if (!legal.some(([r, c]) => r === tr && c === tc)) return '这一步不符合棋规';

  const captured = room.board[tr][tc];
  room.board[tr][tc] = piece;
  room.board[fr][fc] = null;
  room.moves.push({ from, to, piece: piece.c + piece.t, captured: captured ? captured.c + captured.t : null });
  if (room.moves.length > MAX_MOVES) room.moves.shift();
  room.moveCount += 1;
  room.lastMove = { from, to };
  room.turn = other(color);
  room.turnStartedAt = Date.now();

  const oppLegal = legalMoveMap(room.board, room.turn);
  const oppKing = findKing(room.board, room.turn);
  room.check = oppKing ? attacked(room.board, oppKing[0], oppKing[1], color) : false;

  if (Object.keys(oppLegal).length === 0) {
    room.status = 'over';
    room.winner = color;
    room.endReason = room.check ? 'checkmate' : 'stalemate';
  }
  bump(room);
  return null;
}

/* ------------------------------------------------------------------ */
/* HTTP 工具                                                           */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 16384) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  let filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      if (!path.extname(rel)) {
        filePath = path.join(PUBLIC_DIR, 'index.html');
        return sendFile(res, filePath, true);
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    sendFile(res, filePath, false);
  });
}

function sendFile(res, filePath, isFallback) {
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(500);
      res.end('Server Error');
      return;
    }
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': isFallback || ext === '.html' ? 'no-cache' : 'public, max-age=300',
      'Content-Length': data.length,
    });
    res.end(data);
  });
}

function publicRoomList() {
  const list = [];
  for (const room of rooms.values()) {
    if (room.status === 'over' && Date.now() - room.lastActive > 20 * 60 * 1000) continue;
    list.push({
      id: room.id,
      name: room.name,
      status: room.status,
      red: room.players.r ? room.players.r.name : null,
      black: room.players.b ? room.players.b.name : null,
      redOnline: isOnline(room.players.r),
      blackOnline: isOnline(room.players.b),
      spectators: room.spectators.size,
      moveCount: room.moveCount,
      lastActive: room.lastActive,
    });
  }
  list.sort((a, b) => {
    const rank = (s) => (s === 'playing' ? 0 : s === 'waiting' ? 1 : 2);
    if (rank(a.status) !== rank(b.status)) return rank(a.status) - rank(b.status);
    return b.lastActive - a.lastActive;
  });
  return list;
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

async function handleApi(req, res, pathname, query) {
  const url = req.url || '';

  if (pathname === '/api/rooms' && req.method === 'GET') {
    return json(res, 200, { ok: true, rooms: publicRoomList(), serverNow: Date.now() });
  }

  if (pathname === '/api/rooms' && req.method === 'POST') {
    const body = await readBody(req);
    if (rooms.size >= MAX_ROOMS) return json(res, 503, { ok: false, error: '棋室数量已达上限，请稍后再试' });
    const hostName = cleanName(body.name, '红方棋手');
    const room = createRoom(body.roomName, hostName);
    return json(res, 200, {
      ok: true,
      roomId: room.id,
      token: room.players.r.token,
      state: snapshot(room, room.players.r.token),
    });
  }

  const m = pathname.match(/^\/api\/rooms\/([a-f0-9]{8})\/([a-z]+)$/);
  if (!m) return json(res, 404, { ok: false, error: 'not found' });
  const room = rooms.get(m[1]);
  if (!room) return json(res, 404, { ok: false, error: '棋室不存在或已过期' });

  const sub = m[2];
  const body = req.method === 'POST' ? await readBody(req) : {};

  if (sub === 'sync' && req.method === 'GET') {
    const viewer = String(query.get('token') || '');
    const since = Number(query.get('since') || 0);
    if (viewer) touch(room, viewer);
    if (since && since === room.seq) {
      await waitForChange(room, since, LONGPOLL_MS);
      if (viewer) touch(room, viewer);
    }
    return json(res, 200, { ok: true, state: snapshot(room, viewer) });
  }

  if (sub === 'join' && req.method === 'POST') {
    const viewer = typeof body.token === 'string' ? body.token : '';
    const name = cleanName(body.name, '匿名棋友');
    const seat = body.seat;

    // 老成员回归：直接按原身份进入
    const existing = viewer ? roleOf(room, viewer) : null;
    if (existing === 'r' || existing === 'b') {
      room.players[existing].name = name;
      room.players[existing].lastSeen = Date.now();
      bump(room);
      return json(res, 200, { ok: true, token: viewer, role: existing, state: snapshot(room, viewer) });
    }
    if (existing === 'spec') {
      const s = room.spectators.get(viewer);
      s.name = name;
      s.lastSeen = Date.now();
      bump(room);
      return json(res, 200, { ok: true, token: viewer, role: 'spec', state: snapshot(room, viewer) });
    }

    const wantSeat = seat === 'r' || seat === 'b' ? seat : seat === 'auto' ? 'auto' : 'spec';
    const seatFree = (s) => !room.players[s] || Date.now() - room.players[s].lastSeen > 60000;
    let target = null;
    if (wantSeat === 'r' || wantSeat === 'b') {
      if (!seatFree(wantSeat)) return json(res, 409, { ok: false, error: '该座位已被占用' });
      if (room.players[wantSeat]) {
        pushChat(room, 'sys', '系统', `${room.players[wantSeat].name} 离线超时，座位由 ${name} 接替`);
      }
      target = wantSeat;
    } else if (wantSeat === 'auto') {
      if (!room.players.r) target = 'r';
      else if (!room.players.b) target = 'b';
      else if (seatFree('r')) target = 'r';
      else if (seatFree('b')) target = 'b';
      else target = 'spec';
    } else {
      target = 'spec';
    }

    const newToken = viewer || token();
    if (target === 'spec') {
      room.spectators.set(newToken, { name, lastSeen: Date.now() });
      pushChat(room, 'sys', '系统', `${name} 进入观战`);
    } else {
      room.players[target] = { token: newToken, name, lastSeen: Date.now() };
      pushChat(room, 'sys', '系统', `${name} 执${target === 'r' ? '红' : '黑'}入座`);
      if (room.players.r && room.players.b) {
        if (room.status === 'waiting' || room.status === 'over') {
          resetGame(room);
        }
      }
    }
    bump(room);
    return json(res, 200, { ok: true, token: newToken, role: target, state: snapshot(room, newToken) });
  }

  if (sub === 'move' && req.method === 'POST') {
    const viewer = String(body.token || '');
    touch(room, viewer);
    const color = roleOf(room, viewer);
    if (color !== 'r' && color !== 'b') return json(res, 403, { ok: false, error: '观战者不能走棋' });
    const from = Array.isArray(body.from) ? body.from.map(Number) : null;
    const to = Array.isArray(body.to) ? body.to.map(Number) : null;
    if (!from || !to) return json(res, 400, { ok: false, error: '参数错误' });
    const err = applyMove(room, color, from, to);
    if (err) return json(res, 400, { ok: false, error: err });
    return json(res, 200, { ok: true, state: snapshot(room, viewer) });
  }

  if (sub === 'chat' && req.method === 'POST') {
    const viewer = String(body.token || '');
    const role = roleOf(room, viewer);
    if (!role) return json(res, 403, { ok: false, error: '请先加入棋室' });
    const text = typeof body.text === 'string' ? body.text.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60) : '';
    if (!text) return json(res, 400, { ok: false, error: '消息为空' });
    const now = Date.now();
    const last = room.chatRate.get(viewer) || 0;
    if (now - last < 700) return json(res, 429, { ok: false, error: '发送太快啦' });
    room.chatRate.set(viewer, now);
    const name = role === 'r' ? room.players.r.name : role === 'b' ? room.players.b.name : room.spectators.get(viewer).name;
    pushChat(room, role, name, text);
    bump(room);
    return json(res, 200, { ok: true });
  }

  if (sub === 'resign' && req.method === 'POST') {
    const viewer = String(body.token || '');
    const color = roleOf(room, viewer);
    if (color !== 'r' && color !== 'b') return json(res, 403, { ok: false, error: '观战者不能认输' });
    if (room.status !== 'playing') return json(res, 400, { ok: false, error: '当前没有进行中的对局' });
    room.status = 'over';
    room.winner = other(color);
    room.endReason = 'resign';
    pushChat(room, 'sys', '系统', `${room.players[color].name} 认输，${room.players[other(color)].name} 获胜`);
    bump(room);
    return json(res, 200, { ok: true, state: snapshot(room, viewer) });
  }

  if (sub === 'rematch' && req.method === 'POST') {
    const viewer = String(body.token || '');
    const color = roleOf(room, viewer);
    if (color !== 'r' && color !== 'b') return json(res, 403, { ok: false, error: '观战者不能发起重开' });
    if (!room.rematch.includes(color)) room.rematch.push(color);
    if (room.players.r && room.players.b) {
      if (room.rematch.length >= 2) {
        resetGame(room);
        pushChat(room, 'sys', '系统', '双方已就绪，新的一局开始');
      }
    } else {
      resetGame(room);
      pushChat(room, 'sys', '系统', '已重置棋盘，等待对手入座');
    }
    bump(room);
    return json(res, 200, { ok: true, state: snapshot(room, viewer) });
  }

  return json(res, 404, { ok: false, error: 'not found' });
}

const server = http.createServer((req, res) => {
  try {
    const parsed = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost'));
    let pathname = '/';
    try {
      pathname = decodeURIComponent(parsed.pathname);
    } catch (e) {
      pathname = parsed.pathname;
    }

    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (pathname.startsWith('/api/')) {
      handleApi(req, res, pathname, parsed.searchParams).catch((err) => {
        if (!res.headersSent) json(res, 400, { ok: false, error: err.message || 'bad request' });
        else res.end();
      });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      res.end('Method Not Allowed');
      return;
    }
    serveStatic(req, res, pathname);
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Server Error');
    } else {
      res.end();
    }
  }
});

/* ------------------------------------------------------------------ */
/* 定时任务：超时判负、在线状态、房间回收                              */
/* ------------------------------------------------------------------ */

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.status === 'playing' && now - room.turnStartedAt > MOVE_LIMIT_MS) {
      const loser = room.turn;
      const winner = other(loser);
      room.status = 'over';
      room.winner = winner;
      room.endReason = 'timeout';
      pushChat(room, 'sys', '系统', `${room.players[loser] ? room.players[loser].name : loser} 超时，${room.players[winner] ? room.players[winner].name : winner} 获胜`);
      bump(room);
    }
    if (now - room.lastActive > ROOM_TTL_MS) rooms.delete(room.id);
  }
  // 清理过期的观战者
  for (const room of rooms.values()) {
    for (const [t, s] of room.spectators) {
      if (now - s.lastSeen > 10 * 60 * 1000) room.spectators.delete(t);
    }
    for (const [t, ts] of room.chatRate) {
      if (now - ts > 60 * 1000) room.chatRate.delete(t);
    }
  }
}, 1000);

server.listen(PORT, '0.0.0.0', () => {
  console.log('chess-arena listening on 0.0.0.0:' + PORT);
});
