'use strict';

/* ============================================================
 * 楚河汉界 · 在线象棋擂台  前端
 * ============================================================ */

const CHARS = {
  rK: '帅', rA: '仕', rB: '相', rN: '马', rR: '车', rC: '炮', rP: '兵',
  bK: '将', bA: '士', bB: '象', bN: '马', bR: '车', bC: '炮', bP: '卒',
};

const REASON = {
  checkmate: '将死',
  stalemate: '困毙',
  resign: '认输',
  timeout: '超时',
  capture: '擒王',
};

const $ = (id) => document.getElementById(id);

const S = {
  view: 'lobby',
  rooms: [],
  room: null,
  roomId: null,
  token: '',
  role: 'spec',
  seq: 0,
  lastChatId: 0,
  lastDanmakuId: 0,
  sel: null,
  busy: false,
  polling: false,
  choseSpec: false,
  danmakuOn: true,
  recvAt: 0,
  failures: 0,
  joined: false,
  clockTimer: null,
  lastRoomsAt: 0,
};

/* ---------------- 基础工具 ---------------- */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

function nick() {
  let n = localStorage.getItem('chess.nick');
  if (!n) {
    n = '棋友' + Math.floor(100 + Math.random() * 900);
    localStorage.setItem('chess.nick', n);
  }
  return n;
}

function setNick(n) {
  n = (n || '').trim().slice(0, 12);
  if (n) localStorage.setItem('chess.nick', n);
}

function tokenKey(roomId) { return 'chess.token.' + roomId; }

function fmtClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m + ':' + String(s).padStart(2, '0');
}

function fmtTime(ts) {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/* ============================================================
 * 大厅
 * ============================================================ */
async function loadRooms() {
  try {
    const res = await fetch('/api/rooms', { cache: 'no-store' });
    const data = await res.json();
    if (!data.ok) throw new Error();
    S.rooms = data.rooms || [];
    renderRoomList();
  } catch (e) {
    $('roomGrid').innerHTML = '<div class="empty-hint">加载失败，请点击刷新重试</div>';
  }
}

function renderRoomList() {
  const grid = $('roomGrid');
  const list = S.rooms;
  $('statRooms').textContent = list.length;
  $('statLive').textContent = list.filter((r) => r.status === 'playing').length;

  if (!list.length) {
    grid.innerHTML = '<div class="empty-hint">还没有棋室，创建一间并邀请朋友来对弈吧</div>';
    return;
  }

  grid.innerHTML = list.map((r) => {
    const chip = r.status === 'playing'
      ? '<span class="chip live">对局中</span>'
      : r.status === 'waiting'
        ? '<span class="chip waiting">等待棋手</span>'
        : '<span class="chip over">已结束</span>';
    const redName = r.red ? esc(r.red) : '虚位以待';
    const blackName = r.black ? esc(r.black) : '虚位以待';
    return `
      <div class="room-card" data-id="${esc(r.id)}">
        <div class="room-card-head">
          <div class="room-card-name">${esc(r.name)}</div>
          ${chip}
        </div>
        <div class="room-card-row"><span class="dot ${r.red ? (r.redOnline ? 'red' : 'off') : 'off'}"></span>红 · ${redName}</div>
        <div class="room-card-row"><span class="dot ${r.black ? (r.blackOnline ? 'black' : 'off') : 'off'}"></span>黑 · ${blackName}</div>
        <div class="room-card-foot">
          <span>观战 ${r.spectators}</span>
          <span>${r.moveCount} 手</span>
        </div>
      </div>`;
  }).join('');

  grid.querySelectorAll('.room-card').forEach((el) => {
    el.addEventListener('click', () => enterRoom(el.dataset.id));
  });
}

async function createRoom() {
  const btn = $('createBtn');
  const name = $('nickInput').value.trim() || nick();
  setNick(name);
  btn.disabled = true;
  try {
    const res = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, roomName: $('roomNameInput').value.trim() }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || '创建失败');
    localStorage.setItem(tokenKey(data.roomId), data.token);
    enterRoom(data.roomId);
  } catch (e) {
    toast(e.message || '创建失败');
  } finally {
    btn.disabled = false;
  }
}

/* ============================================================
 * 进入 / 离开棋室
 * ============================================================ */
function enterRoom(roomId) {
  leaveRoom(true);
  S.roomId = roomId;
  S.token = localStorage.getItem(tokenKey(roomId)) || '';
  S.room = null;
  S.seq = 0;
  S.sel = null;
  S.choseSpec = false;
  S.joined = false;
  S.lastChatId = 0;
  S.lastDanmakuId = 0;
  S.view = 'room';

  if (location.hash !== '#r=' + roomId) location.hash = '#r=' + roomId;

  $('lobby').classList.add('hidden');
  $('roomView').classList.remove('hidden');
  $('chatList').innerHTML = '';
  $('joinOverlay').classList.add('hidden');
  $('banner').classList.add('hidden');

  pollLoop(roomId);

  clearInterval(S.clockTimer);
  S.clockTimer = setInterval(tickClock, 250);

  requestAnimationFrame(() => {
    resizeCanvas();
    drawBoard();
  });
}

function leaveRoom(silent) {
  S.polling = false;
  clearInterval(S.clockTimer);
  S.clockTimer = null;
  S.roomId = null;
  S.room = null;
  S.seq = 0;
  if (silent) return;
  S.view = 'lobby';
  if (location.hash) history.replaceState(null, '', location.pathname);
  $('roomView').classList.add('hidden');
  $('lobby').classList.remove('hidden');
  loadRooms();
}

function backToLobby() {
  leaveRoom(false);
}

/* ============================================================
 * 轮询同步
 * ============================================================ */
async function pollLoop(roomId) {
  if (S.polling) return;
  S.polling = true;
  while (S.polling && S.roomId === roomId) {
    const started = Date.now();
    try {
      const url = `/api/rooms/${roomId}/sync?token=${encodeURIComponent(S.token)}&since=${S.seq}`;
      const res = await fetch(url, { cache: 'no-store' });
      if (res.status === 404) {
        toast('棋室不存在或已过期');
        leaveRoom(false);
        return;
      }
      const data = await res.json();
      if (S.roomId !== roomId) return;
      if (data.ok && data.state) applyState(data.state);
      S.failures = 0;
    } catch (e) {
      S.failures += 1;
      await sleep(Math.min(5000, 600 * S.failures));
    }
    // 若服务端立即返回（有更新），避免过度空转
    const cost = Date.now() - started;
    if (cost < 300) await sleep(300 - cost);
  }
}

function applyState(st) {
  if (S.room && st.seq < S.seq) return;
  const firstState = !S.room;
  const prevMy = S.role;
  S.room = st;
  S.seq = st.seq;
  S.role = st.myColor;
  S.recvAt = performance.now();

  if (st.myColor !== 'spec') {
    S.joined = true;
    $('joinOverlay').classList.add('hidden');
  } else if (!S.choseSpec && !S.joined) {
    showJoinOverlay(st);
  }

  $('roomTitle').textContent = st.name;
  const chip = $('roomStatus');
  chip.className = 'chip ' + (st.status === 'playing' ? 'live' : st.status === 'waiting' ? 'waiting' : 'over');
  chip.textContent = st.status === 'playing' ? '对局中' : st.status === 'waiting' ? '等待棋手' : '已结束';

  renderSeats(st);
  renderMyRole(st);
  renderHint(st);
  renderBanner(st);
  renderButtons(st);
  appendChat(st.chat || [], firstState);
  updateSpecList(st);
  drawBoard();

  if (prevMy !== st.myColor) S.sel = null;
}

function renderSeats(st) {
  const red = st.players.r;
  const black = st.players.b;
  paintSeat('seatRed', red, 'r');
  paintSeat('seatBlack', black, 'b');
}

function paintSeat(id, p, color) {
  const el = $(id);
  const nameEl = el.querySelector('.seat-name');
  if (p) {
    nameEl.innerHTML = `<span class="presence ${p.online ? '' : 'off'}"></span>${esc(p.name)}`;
    el.querySelector('.seat-meta').textContent = (color === 'r' ? '红方 · 先手' : '黑方 · 后手') + (p.online ? ' · 在线' : ' · 离线');
  } else {
    nameEl.textContent = '虚位以待';
    el.querySelector('.seat-meta').textContent = color === 'r' ? '红方 · 先手' : '黑方 · 后手';
  }
  el.classList.toggle('active', st.status === 'playing' && st.turn === color);
}

function renderMyRole(st) {
  const el = $('myRole');
  if (st.myColor === 'r') { el.textContent = '红方棋手'; el.style.color = '#ff9d92'; }
  else if (st.myColor === 'b') { el.textContent = '黑方棋手'; el.style.color = '#a9c8ff'; }
  else { el.textContent = '观战者'; el.style.color = ''; }
}

function renderHint(st) {
  const el = $('turnHint');
  if (st.status === 'waiting') {
    el.innerHTML = '等待另一位棋手入座<br>把邀请链接发给朋友，或等观战者上座';
  } else if (st.status === 'over') {
    const winner = st.winner === 'r' ? '红方' : '黑方';
    el.innerHTML = `本局结束 · <strong>${winner}获胜</strong>（${REASON[st.endReason] || '结束'}）`;
  } else if (st.myColor === st.turn) {
    el.innerHTML = '<strong>轮到你走棋</strong> · 每步限时 90 秒';
  } else if (st.myColor === 'spec') {
    el.innerHTML = (st.turn === 'r' ? '红方' : '黑方') + '正在思考… · 你正在观战';
  } else {
    el.textContent = '等待对方落子…';
  }
}

function renderBanner(st) {
  const b = $('banner');
  if (st.status === 'playing') {
    b.classList.add('hidden');
    return;
  }
  b.classList.remove('hidden');
  if (st.status === 'waiting') {
    b.innerHTML = '等待棋手入座<small>分享邀请链接，即可开始对弈</small>';
  } else {
    const winner = st.winner === 'r' ? '红方' : '黑方';
    b.innerHTML = `${winner}胜 · ${REASON[st.endReason] || ''}<small>点击「重新开始」再来一局</small>`;
  }
}

function renderButtons(st) {
  const resign = $('resignBtn');
  const rematch = $('rematchBtn');
  const isPlayer = st.myColor === 'r' || st.myColor === 'b';
  resign.disabled = !(isPlayer && st.status === 'playing');
  rematch.disabled = !isPlayer;

  const voted = (st.rematch || []).includes(st.myColor);
  if (st.status === 'over' && isPlayer && (st.players.r && st.players.b) && voted) {
    rematch.textContent = '等待对手确认…';
    rematch.disabled = true;
  } else {
    rematch.textContent = '重新开始';
  }
}

function updateSpecList(st) {
  $('specCount').textContent = st.spectatorsCount;
  const el = $('specList');
  if (!st.spectatorsCount) {
    el.textContent = '还没有人观战';
  } else {
    el.innerHTML = (st.spectators || []).map((n) => esc(n)).join(' · ')
      + (st.spectatorsCount > (st.spectators || []).length ? ' 等 ' + st.spectatorsCount + ' 人' : '');
  }
}

/* ============================================================
 * 加入 / 座位
 * ============================================================ */
function showJoinOverlay(st) {
  const overlay = $('joinOverlay');
  overlay.classList.remove('hidden');
  const rTaken = !!st.players.r;
  const bTaken = !!st.players.b;
  overlay.querySelectorAll('.join-actions .btn').forEach((btn) => {
    const seat = btn.dataset.seat;
    if (seat === 'r') {
      btn.disabled = rTaken;
      btn.innerHTML = rTaken ? '执红 · 已占' : '执红 <small>先手</small>';
    } else if (seat === 'b') {
      btn.disabled = bTaken;
      btn.innerHTML = bTaken ? '执黑 · 已占' : '执黑 <small>后手</small>';
    }
  });
  $('joinDesc').textContent = rTaken && bTaken ? '两个座位都已坐满，你可以观战' : '先到先得，空位可入座';
}

async function joinRoom(seat) {
  if (!S.roomId) return;
  const name = nick();
  try {
    const res = await fetch(`/api/rooms/${S.roomId}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, seat, token: S.token }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      toast(data.error || '加入失败');
      return;
    }
    S.token = data.token;
    localStorage.setItem(tokenKey(S.roomId), data.token);
    if (seat === 'spec') S.choseSpec = true;
    S.joined = true;
    $('joinOverlay').classList.add('hidden');
    if (data.state) applyState(data.state);
  } catch (e) {
    toast('网络异常，请重试');
  }
}

/* ============================================================
 * 走棋 / 聊天
 * ============================================================ */
async function postAction(action, body) {
  if (!S.roomId) return null;
  try {
    const res = await fetch(`/api/rooms/${S.roomId}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ token: S.token }, body || {})),
    });
    const data = await res.json().catch(() => ({ ok: false, error: '网络异常' }));
    if (!res.ok || !data.ok) {
      toast(data.error || '操作失败');
      return null;
    }
    if (data.state) applyState(data.state);
    return data;
  } catch (e) {
    toast('网络异常，请重试');
    return null;
  }
}

async function sendMove(from, to) {
  if (S.busy) return;
  S.busy = true;
  S.sel = null;
  drawBoard();
  await postAction('move', { from, to });
  S.busy = false;
}

async function sendChat(e) {
  e.preventDefault();
  const input = $('chatInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  await postAction('chat', { text });
}

/* ============================================================
 * 聊天与弹幕渲染
 * ============================================================ */
function appendChat(msgs, firstState) {
  const list = $('chatList');
  let added = 0;
  for (const m of msgs) {
    if (m.id <= S.lastChatId) continue;
    S.lastChatId = m.id;
    added += 1;
    const div = document.createElement('div');
    if (m.role === 'sys') {
      div.className = 'msg sys';
      div.textContent = m.text;
    } else {
      div.className = 'msg ' + m.role;
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = m.name;
      const time = document.createElement('span');
      time.className = 'time';
      time.textContent = fmtTime(m.at);
      const txt = document.createElement('span');
      txt.textContent = m.text;
      div.appendChild(time);
      div.appendChild(who);
      div.appendChild(txt);
      if (m.role !== 'spec' && S.room && m.name === S.room.players[m.role]?.name) div.classList.add('self');
    }
    list.appendChild(div);

    if (!firstState && m.role !== 'sys' && m.id > S.lastDanmakuId) {
      spawnDanmaku(m);
    }
    if (m.id > S.lastDanmakuId) S.lastDanmakuId = m.id;
  }
  if (added) {
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 140;
    if (nearBottom || added <= 2) list.scrollTop = list.scrollHeight;
  }
}

function spawnDanmaku(m) {
  if (!S.danmakuOn) return;
  const layer = $('danmakuLayer');
  if (!layer || layer.children.length > 14) return;

  const el = document.createElement('div');
  el.className = 'danmaku-item ' + (m.role || 'spec');
  const who = document.createElement('span');
  who.className = 'dm-name';
  who.textContent = m.name;
  el.appendChild(who);
  el.appendChild(document.createTextNode(m.text));

  el.style.top = (4 + Math.random() * 78) + '%';
  layer.appendChild(el);

  const dist = layer.clientWidth + el.offsetWidth + 60;
  const duration = Math.max(5200, (dist / 0.13)); // ~130px/s

  if (el.animate) {
    const anim = el.animate(
      [{ transform: 'translateX(0px)' }, { transform: `translateX(-${dist}px)` }],
      { duration, easing: 'linear', fill: 'forwards' }
    );
    anim.onfinish = () => el.remove();
  } else {
    setTimeout(() => el.remove(), duration);
  }
}

/* ============================================================
 * 计时
 * ============================================================ */
function tickClock() {
  const st = S.room;
  if (!st) return;
  const elapsed = performance.now() - S.recvAt;
  const left = st.status === 'playing' ? Math.max(0, st.timeLeft - elapsed) : st.timeLeft;
  const redEl = $('clockRed');
  const blackEl = $('clockBlack');

  if (st.status === 'playing' && st.turn === 'b') {
    blackEl.textContent = fmtClock(left);
    redEl.textContent = fmtClock(st.limit);
  } else if (st.status === 'playing') {
    redEl.textContent = fmtClock(left);
    blackEl.textContent = fmtClock(st.limit);
  } else {
    redEl.textContent = fmtClock(st.limit);
    blackEl.textContent = fmtClock(st.limit);
  }
  blackEl.classList.toggle('hot', st.status === 'playing' && st.turn === 'b' && left < 15000);
  redEl.classList.toggle('hot', st.status === 'playing' && st.turn === 'r' && left < 15000);
}

/* ============================================================
 * 棋盘绘制
 * ============================================================ */
const canvas = $('boardCanvas');
const ctx = canvas.getContext('2d');
const geo = { w: 0, h: 0, cell: 0, ox: 0, oy: 0 };

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  geo.w = rect.width;
  geo.h = rect.height;
  const cell = Math.min(rect.width / (8 + 1.3), rect.height / (9 + 1.3));
  geo.cell = cell;
  geo.ox = (rect.width - cell * 8) / 2;
  geo.oy = (rect.height - cell * 9) / 2;
  drawBoard();
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function px(c) { return geo.ox + c * geo.cell; }
function py(r) { return geo.oy + r * geo.cell; }

function drawBoard() {
  const { w, h, cell } = geo;
  if (!w || !h || !cell) return;
  ctx.clearRect(0, 0, w, h);

  // 棋盘底色
  const bg = ctx.createLinearGradient(0, 0, w * 0.6, h);
  bg.addColorStop(0, '#f7e7c5');
  bg.addColorStop(0.5, '#efd9ac');
  bg.addColorStop(1, '#e5c994');
  roundRect(0, 0, w, h, 16);
  ctx.fillStyle = bg;
  ctx.fill();

  // 木纹
  ctx.save();
  ctx.globalAlpha = 0.055;
  ctx.strokeStyle = '#7a4a1c';
  ctx.lineWidth = 1;
  for (let i = 0; i < 22; i++) {
    const y = (i / 22) * h + ((i * 37) % 13);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.bezierCurveTo(w * 0.32, y + 7, w * 0.62, y - 8, w, y + 3);
    ctx.stroke();
  }
  ctx.restore();

  // 外框
  const m = cell * 0.6;
  ctx.strokeStyle = 'rgba(112, 66, 22, 0.85)';
  ctx.lineWidth = Math.max(2, cell * 0.045);
  ctx.strokeRect(geo.ox - m, geo.oy - m, cell * 8 + m * 2, cell * 9 + m * 2);
  ctx.strokeStyle = 'rgba(112, 66, 22, 0.45)';
  ctx.lineWidth = Math.max(1, cell * 0.02);
  ctx.strokeRect(geo.ox - m * 0.62, geo.oy - m * 0.62, cell * 8 + m * 1.24, cell * 9 + m * 1.24);

  // 格线
  ctx.strokeStyle = 'rgba(112, 66, 22, 0.72)';
  ctx.lineWidth = Math.max(1, cell * 0.018);
  ctx.beginPath();
  for (let r = 0; r < 10; r++) {
    ctx.moveTo(px(0), py(r));
    ctx.lineTo(px(8), py(r));
  }
  for (let c = 0; c < 9; c++) {
    if (c === 0 || c === 8) {
      ctx.moveTo(px(c), py(0));
      ctx.lineTo(px(c), py(9));
    } else {
      ctx.moveTo(px(c), py(0));
      ctx.lineTo(px(c), py(4));
      ctx.moveTo(px(c), py(5));
      ctx.lineTo(px(c), py(9));
    }
  }
  ctx.stroke();

  // 九宫格斜线
  ctx.beginPath();
  ctx.moveTo(px(3), py(0)); ctx.lineTo(px(5), py(2));
  ctx.moveTo(px(5), py(0)); ctx.lineTo(px(3), py(2));
  ctx.moveTo(px(3), py(7)); ctx.lineTo(px(5), py(9));
  ctx.moveTo(px(5), py(7)); ctx.lineTo(px(3), py(9));
  ctx.stroke();

  // 楚河汉界
  ctx.save();
  ctx.fillStyle = 'rgba(120, 70, 24, 0.42)';
  ctx.font = `600 ${Math.round(cell * 0.52)}px "Songti SC", "STSong", serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('楚  河', px(2), py(4.5));
  ctx.fillText('汉  界', px(6), py(4.5));
  ctx.restore();

  // 兵炮位标记
  const marks = [[1, 2], [7, 2], [1, 7], [7, 7]];
  ctx.save();
  ctx.strokeStyle = 'rgba(112, 66, 22, 0.5)';
  ctx.lineWidth = Math.max(1, cell * 0.016);
  for (const [c, r] of marks) {
    const x = px(c);
    const y = py(r);
    const s = cell * 0.09;
    for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      ctx.beginPath();
      ctx.moveTo(x + dx * s * 2.6, y + dy * s * 1.4);
      ctx.lineTo(x + dx * s * 1.4, y + dy * s * 1.4);
      ctx.lineTo(x + dx * s * 1.4, y + dy * s * 2.6);
      ctx.stroke();
    }
  }
  ctx.restore();

  const st = S.room;
  if (!st) return;

  // 上一步标记
  if (st.lastMove) {
    ctx.save();
    ctx.strokeStyle = 'rgba(46, 134, 222, 0.75)';
    ctx.lineWidth = Math.max(1.5, cell * 0.03);
    for (const [r, c] of [st.lastMove.from, st.lastMove.to]) {
      const x = px(c);
      const y = py(r);
      const s = cell * 0.42;
      const k = cell * 0.16;
      ctx.beginPath();
      ctx.moveTo(x - s, y - s + k); ctx.lineTo(x - s, y - s); ctx.lineTo(x - s + k, y - s);
      ctx.moveTo(x + s - k, y - s); ctx.lineTo(x + s, y - s); ctx.lineTo(x + s, y - s + k);
      ctx.moveTo(x + s, y + s - k); ctx.lineTo(x + s, y + s); ctx.lineTo(x + s - k, y + s);
      ctx.moveTo(x - s + k, y + s); ctx.lineTo(x - s, y + s); ctx.lineTo(x - s, y + s - k);
      ctx.stroke();
    }
    ctx.restore();
  }

  // 棋子
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 9; c++) {
      const p = st.board[r][c];
      if (p) drawPiece(r, c, p);
    }
  }

  // 可走位置提示
  if (S.sel) {
    const key = S.sel[0] + ',' + S.sel[1];
    const targets = (st.legal && st.legal[key]) || [];
    for (const [r, c] of targets) {
      const x = px(c);
      const y = py(r);
      const occupied = !!st.board[r][c];
      ctx.beginPath();
      if (occupied) {
        ctx.strokeStyle = 'rgba(226, 87, 76, 0.85)';
        ctx.lineWidth = Math.max(2, cell * 0.045);
        ctx.arc(x, y, cell * 0.46, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.fillStyle = 'rgba(60, 120, 90, 0.34)';
        ctx.arc(x, y, cell * 0.14, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // 选中环
    const x = px(S.sel[1]);
    const y = py(S.sel[0]);
    ctx.strokeStyle = '#e3b06a';
    ctx.lineWidth = Math.max(2, cell * 0.05);
    ctx.beginPath();
    ctx.arc(x, y, cell * 0.47, 0, Math.PI * 2);
    ctx.stroke();
  }

  // 将军提示
  if (st.check && st.status === 'playing') {
    const kingChar = st.turn === 'r' ? 'rK' : 'bK';
    outer:
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 9; c++) {
        if (st.board[r][c] === kingChar) {
          const x = px(c);
          const y = py(r);
          const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 220);
          ctx.save();
          ctx.strokeStyle = `rgba(226, 57, 46, ${0.45 + 0.4 * pulse})`;
          ctx.lineWidth = Math.max(2, cell * 0.06);
          ctx.beginPath();
          ctx.arc(x, y, cell * (0.5 + 0.05 * pulse), 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
          break outer;
        }
      }
    }
  }
}

function drawPiece(r, c, p) {
  const x = px(c);
  const y = py(r);
  const rad = geo.cell * 0.44;
  const isRed = p[0] === 'r';

  ctx.save();
  ctx.shadowColor = 'rgba(60, 30, 0, 0.35)';
  ctx.shadowBlur = rad * 0.4;
  ctx.shadowOffsetY = rad * 0.14;

  const g = ctx.createRadialGradient(x - rad * 0.35, y - rad * 0.42, rad * 0.12, x, y, rad * 1.05);
  g.addColorStop(0, '#fffdf4');
  g.addColorStop(0.62, '#f6e8c9');
  g.addColorStop(1, '#ddc69a');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, rad, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.strokeStyle = isRed ? 'rgba(179, 56, 44, 0.45)' : 'rgba(34, 48, 63, 0.42)';
  ctx.lineWidth = Math.max(1, rad * 0.07);
  ctx.beginPath();
  ctx.arc(x, y, rad * 0.84, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = isRed ? '#b3382c' : '#22303f';
  ctx.font = `700 ${Math.round(rad * 1.02)}px "Songti SC", "STSong", "SimSun", serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(CHARS[p] || '?', x, y + rad * 0.05);
}

function hitTest(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const c = Math.round((x - geo.ox) / geo.cell);
  const r = Math.round((y - geo.oy) / geo.cell);
  if (r < 0 || r > 9 || c < 0 || c > 8) return null;
  const dx = x - px(c);
  const dy = y - py(r);
  if (Math.hypot(dx, dy) > geo.cell * 0.55) return null;
  return [r, c];
}

canvas.addEventListener('click', (e) => {
  const st = S.room;
  if (!st || S.busy) return;
  const hit = hitTest(e.clientX, e.clientY);
  if (!hit) { S.sel = null; drawBoard(); return; }
  const [r, c] = hit;
  const my = st.myColor;

  if (my !== 'r' && my !== 'b') {
    toast('观战模式不能走棋');
    return;
  }
  if (st.status !== 'playing') return;
  if (st.turn !== my) {
    toast('还没轮到你走棋');
    return;
  }

  const target = st.board[r][c];
  if (S.sel) {
    const key = S.sel[0] + ',' + S.sel[1];
    const targets = (st.legal && st.legal[key]) || [];
    if (targets.some(([tr, tc]) => tr === r && tc === c)) {
      sendMove(S.sel, [r, c]);
      return;
    }
  }
  if (target && target[0] === my) {
    S.sel = [r, c];
    drawBoard();
    return;
  }
  S.sel = null;
  drawBoard();
});

/* ============================================================
 * 事件绑定与启动
 * ============================================================ */
function bind() {
  $('nickInput').value = nick();
  $('createBtn').addEventListener('click', createRoom);
  $('roomNameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') createRoom(); });
  $('refreshBtn').addEventListener('click', loadRooms);
  $('backBtn').addEventListener('click', backToLobby);
  $('brandHome').addEventListener('click', () => { if (S.view === 'room') backToLobby(); });
  $('chatForm').addEventListener('submit', sendChat);

  $('resignBtn').addEventListener('click', async () => {
    if (!confirm('确定认输吗？')) return;
    await postAction('resign');
  });
  $('rematchBtn').addEventListener('click', () => postAction('rematch'));

  $('inviteBtn').addEventListener('click', async () => {
    const url = location.origin + location.pathname + '#r=' + (S.roomId || '');
    try {
      await navigator.clipboard.writeText(url);
      toast('邀请链接已复制');
    } catch (e) {
      prompt('复制下面的邀请链接：', url);
    }
  });

  $('danmakuToggle').addEventListener('change', (e) => {
    S.danmakuOn = e.target.checked;
    if (!S.danmakuOn) $('danmakuLayer').innerHTML = '';
  });

  document.querySelectorAll('.join-actions .btn').forEach((btn) => {
    btn.addEventListener('click', () => joinRoom(btn.dataset.seat));
  });

  window.addEventListener('hashchange', () => {
    const m = location.hash.match(/^#r=([a-f0-9]{8})$/);
    if (m) {
      if (m[1] !== S.roomId) enterRoom(m[1]);
    } else if (S.view === 'room') {
      backToLobby();
    }
  });

  window.addEventListener('resize', resizeCanvas);
  if (window.ResizeObserver) {
    new ResizeObserver(() => resizeCanvas()).observe(document.querySelector('.board-frame'));
  }

  setInterval(() => {
    if (S.view === 'lobby') loadRooms();
  }, 3500);

  setInterval(() => {
    if (S.view === 'room' && S.room && S.room.status === 'playing') drawBoard();
  }, 400);
}

function start() {
  bind();
  const m = location.hash.match(/^#r=([a-f0-9]{8})$/);
  if (m) enterRoom(m[1]);
  else loadRooms();
}

start();
