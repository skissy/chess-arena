'use strict';

/**
 * 五子棋 —— 多人实时对弈 / 观战 / 弹幕
 * 与象棋共用同一个 Node.js 进程，但房间与棋局状态完全独立。
 */

const crypto = require('crypto');

const SIZE = 15;
const MOVE_LIMIT_MS = 60 * 1000;         // 每步思考时间
const LONGPOLL_MS = 8000;                // 长轮询最长挂起
const PRESENCE_MS = 25 * 1000;           // 在线判定窗口
const ROOM_TTL_MS = 3 * 60 * 60 * 1000;  // 活跃房间保留
const MAX_ROOMS = 300;
const MAX_CHAT = 60;
const MAX_MOVES = 400;

/* ------------------------------------------------------------------ */
/* 房间状态                                                            */
/* ------------------------------------------------------------------ */

/** @type {Map<string, any>} */
const rooms = new Map();
/** roomId -> Set<resolve> 长轮询挂起者 */
const waiters = new Map();

function newBoard() {
  return Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
}

function rid() {
  return crypto.randomBytes(4).toString('hex');
}

function token() {
  return crypto.randomBytes(12).toString('hex');
}

function other(color) {
  return color === 'b' ? 'w' : 'b';
}

function cleanName(raw, fallback) {
  if (typeof raw !== 'string') return fallback;
  const s = raw.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 12);
  return s || fallback;
}

/** 坐标记法：列 A-O，行 15-1（左上为 A15） */
function coordName(x, y) {
  return String.fromCharCode(65 + x) + (SIZE - y);
}

function createRoom(name, hostName) {
  const id = rid();
  const room = {
    id,
    name: cleanName(name, '无名棋室'),
    createdAt: Date.now(),
    lastActive: Date.now(),
    board: newBoard(),
    turn: 'b',
    status: 'waiting', // waiting | playing | over
    winner: null,
    endReason: '',
    winLine: null,
    players: {
      b: { token: token(), name: hostName, lastSeen: Date.now() },
      w: null,
    },
    spectators: new Map(),
    chat: [],
    chatRate: new Map(),
    moves: [],
    moveCount: 0,
    lastMove: null,
    turnStartedAt: Date.now(),
    rematch: [],
    seq: 1,
  };
  rooms.set(id, room);
  return room;
}

function bump(room) {
  room.seq += 1;
  room.lastActive = Date.now();
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
  if (room.players.b && room.players.b.token === viewerToken) room.players.b.lastSeen = now;
  if (room.players.w && room.players.w.token === viewerToken) room.players.w.lastSeen = now;
  const spec = room.spectators.get(viewerToken);
  if (spec) spec.lastSeen = now;
}

function isOnline(member) {
  return !!member && Date.now() - member.lastSeen < PRESENCE_MS;
}

function roleOf(room, viewerToken) {
  if (room.players.b && room.players.b.token === viewerToken) return 'b';
  if (room.players.w && room.players.w.token === viewerToken) return 'w';
  if (room.spectators.has(viewerToken)) return 'spec';
  return null;
}

function timeLeft(room) {
  if (room.status !== 'playing') return MOVE_LIMIT_MS;
  return Math.max(0, MOVE_LIMIT_MS - (Date.now() - room.turnStartedAt));
}

function snapshot(room, viewerToken) {
  const myColor = roleOf(room, viewerToken) || 'spec';

  const specNames = [];
  for (const s of room.spectators.values()) if (isOnline(s)) specNames.push(s.name);

  const histStart = Math.max(0, room.moves.length - 200);
  const history = [];
  for (let i = histStart; i < room.moves.length; i++) {
    history.push({ n: i + 1, color: room.moves[i].color, text: room.moves[i].not || '' });
  }

  return {
    seq: room.seq,
    id: room.id,
    name: room.name,
    status: room.status,
    turn: room.turn,
    winner: room.winner,
    endReason: room.endReason,
    winLine: room.winLine,
    board: room.board.map((row) => row.slice()),
    lastMove: room.lastMove,
    history,
    moveCount: room.moveCount,
    players: {
      b: room.players.b
        ? { name: room.players.b.name, online: isOnline(room.players.b) }
        : null,
      w: room.players.w
        ? { name: room.players.w.name, online: isOnline(room.players.w) }
        : null,
    },
    spectatorsCount: specNames.length,
    spectators: specNames.slice(0, 8),
    timeLeft: timeLeft(room),
    limit: MOVE_LIMIT_MS,
    chat: room.chat.slice(-40),
    rematch: room.rematch.slice(),
    myColor,
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
  room.turn = 'b';
  room.status = room.players.w ? 'playing' : 'waiting';
  room.winner = null;
  room.endReason = '';
  room.winLine = null;
  room.moves = [];
  room.moveCount = 0;
  room.lastMove = null;
  room.turnStartedAt = Date.now();
  room.rematch = [];
}

/** 从最新一手出发，检查四个方向上是否有连续五子，返回获胜连线 */
function findWin(board, x, y, color) {
  const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (const [dx, dy] of dirs) {
    const cells = [[x, y]];
    for (const sign of [1, -1]) {
      let cx = x + dx * sign;
      let cy = y + dy * sign;
      while (cx >= 0 && cx < SIZE && cy >= 0 && cy < SIZE && board[cy][cx] === color) {
        cells.push([cx, cy]);
        cx += dx * sign;
        cy += dy * sign;
      }
    }
    if (cells.length >= 5) return cells;
  }
  return null;
}

function applyMove(room, color, x, y) {
  if (room.status !== 'playing') return '对局尚未开始或已结束';
  if (room.turn !== color) return '还没轮到你落子';
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= SIZE || y < 0 || y >= SIZE) {
    return '坐标不合法';
  }
  if (room.board[y][x]) return '这里已经有棋子了';

  room.board[y][x] = color;
  const notation = coordName(x, y);
  room.moves.push({ x, y, color, not: notation });
  if (room.moves.length > MAX_MOVES) room.moves.shift();
  room.moveCount += 1;
  room.lastMove = { x, y, color, text: notation };

  const winLine = findWin(room.board, x, y, color);
  if (winLine) {
    room.status = 'over';
    room.winner = color;
    room.endReason = 'five';
    room.winLine = winLine;
  } else if (room.moveCount >= SIZE * SIZE) {
    room.status = 'over';
    room.winner = null;
    room.endReason = 'draw';
  } else {
    room.turn = other(color);
    room.turnStartedAt = Date.now();
  }

  bump(room);
  return null;
}

function publicRoomList() {
  const list = [];
  for (const room of rooms.values()) {
    if (room.status === 'over' && Date.now() - room.lastActive > 20 * 60 * 1000) continue;
    list.push({
      id: room.id,
      name: room.name,
      status: room.status,
      black: room.players.b ? room.players.b.name : null,
      white: room.players.w ? room.players.w.name : null,
      blackOnline: isOnline(room.players.b),
      whiteOnline: isOnline(room.players.w),
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
/* HTTP 工具与路由                                                     */
/* ------------------------------------------------------------------ */

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

async function handleGomokuApi(req, res, pathname, query) {
  if (pathname === '/api/gomoku/rooms' && req.method === 'GET') {
    return json(res, 200, { ok: true, rooms: publicRoomList(), serverNow: Date.now() });
  }

  if (pathname === '/api/gomoku/rooms' && req.method === 'POST') {
    const body = await readBody(req);
    if (rooms.size >= MAX_ROOMS) return json(res, 503, { ok: false, error: '棋室数量已达上限，请稍后再试' });
    const hostName = cleanName(body.name, '黑方棋手');
    const room = createRoom(body.roomName, hostName);
    return json(res, 200, {
      ok: true,
      roomId: room.id,
      token: room.players.b.token,
      state: snapshot(room, room.players.b.token),
    });
  }

  const m = pathname.match(/^\/api\/gomoku\/rooms\/([a-f0-9]{8})\/([a-z]+)$/);
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

    const existing = viewer ? roleOf(room, viewer) : null;
    if (existing === 'b' || existing === 'w') {
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

    const wantSeat = seat === 'b' || seat === 'w' ? seat : seat === 'auto' ? 'auto' : 'spec';
    const seatFree = (s) => !room.players[s] || Date.now() - room.players[s].lastSeen > 60000;
    let target = null;
    if (wantSeat === 'b' || wantSeat === 'w') {
      if (!seatFree(wantSeat)) return json(res, 409, { ok: false, error: '该座位已被占用' });
      if (room.players[wantSeat]) {
        pushChat(room, 'sys', '系统', `${room.players[wantSeat].name} 离线超时，座位由 ${name} 接替`);
      }
      target = wantSeat;
    } else if (wantSeat === 'auto') {
      if (!room.players.b) target = 'b';
      else if (!room.players.w) target = 'w';
      else if (seatFree('b')) target = 'b';
      else if (seatFree('w')) target = 'w';
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
      pushChat(room, 'sys', '系统', `${name} 执${target === 'b' ? '黑' : '白'}入座`);
      if (room.players.b && room.players.w) {
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
    if (color !== 'b' && color !== 'w') return json(res, 403, { ok: false, error: '观战者不能落子' });
    const err = applyMove(room, color, Number(body.x), Number(body.y));
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
    const name = role === 'b' ? room.players.b.name : role === 'w' ? room.players.w.name : room.spectators.get(viewer).name;
    pushChat(room, role, name, text);
    bump(room);
    return json(res, 200, { ok: true });
  }

  if (sub === 'resign' && req.method === 'POST') {
    const viewer = String(body.token || '');
    const color = roleOf(room, viewer);
    if (color !== 'b' && color !== 'w') return json(res, 403, { ok: false, error: '观战者不能认输' });
    if (room.status !== 'playing') return json(res, 400, { ok: false, error: '当前没有进行中的对局' });
    const winner = other(color);
    room.status = 'over';
    room.winner = winner;
    room.endReason = 'resign';
    room.winLine = null;
    pushChat(room, 'sys', '系统', `${room.players[color].name} 认输，${room.players[winner].name} 获胜`);
    bump(room);
    return json(res, 200, { ok: true, state: snapshot(room, viewer) });
  }

  if (sub === 'rematch' && req.method === 'POST') {
    const viewer = String(body.token || '');
    const color = roleOf(room, viewer);
    if (color !== 'b' && color !== 'w') return json(res, 403, { ok: false, error: '观战者不能发起重开' });
    if (!room.rematch.includes(color)) room.rematch.push(color);
    if (room.players.b && room.players.w) {
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

/* ------------------------------------------------------------------ */
/* 定时任务：超时判负、房间回收                                        */
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
      room.winLine = null;
      pushChat(room, 'sys', '系统', `${room.players[loser] ? room.players[loser].name : loser} 超时，${room.players[winner] ? room.players[winner].name : winner} 获胜`);
      bump(room);
    }
    if (now - room.lastActive > ROOM_TTL_MS) rooms.delete(room.id);
  }
  for (const room of rooms.values()) {
    for (const [t, s] of room.spectators) {
      if (now - s.lastSeen > 10 * 60 * 1000) room.spectators.delete(t);
    }
    for (const [t, ts] of room.chatRate) {
      if (now - ts > 60 * 1000) room.chatRate.delete(t);
    }
  }
}, 1000);

module.exports = { handleGomokuApi, rooms };
