'use strict';

/* ============================================================
 * 連珠成五 · 在线五子棋  前端
 * ============================================================ */

const SIZE = 15;

const REASON = {
  five: '五子连珠',
  resign: '认输',
  timeout: '超时',
  draw: '和棋',
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
  histSig: '',
  hover: null,
  busy: false,
  polling: false,
  choseSpec: false,
  danmakuOn: true,
  recvAt: 0,
  failures: 0,
  joined: false,
  clockTimer: null,
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
  let n = localStorage.getItem('gomoku.nick');
  if (!n) {
    n = '棋友' + Math.floor(100 + Math.random() * 900);
    localStorage.setItem('gomoku.nick', n);
  }
  return n;
}

function setNick(n) {
  n = (n || '').trim().slice(0, 12);
  if (n) localStorage.setItem('gomoku.nick', n);
}

function tokenKey(roomId) { return 'gomoku.token.' + roomId; }

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
    const res = await fetch('/api/gomoku/rooms', { cache: 'no-store' });
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
    const blackName = r.black ? esc(r.black) : '虚位以待';
    const whiteName = r.white ? esc(r.white) : '虚位以待';
    return `
      <div class="room-card" data-id="${esc(r.id)}">
        <div class="room-card-head">
          <div class="room-card-name">${esc(r.name)}</div>
          ${chip}
        </div>
        <div class="room-card-row"><span class="dot ${r.black ? (r.blackOnline ? 'black' : 'off') : 'off'}"></span>黑 · ${blackName}</div>
        <div class="room-card-row"><span class="dot ${r.white ? (r.whiteOnline ? 'red' : 'off') : 'off'}"></span>白 · ${whiteName}</div>
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
    const res = await fetch('/api/gomoku/rooms', {
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
  S.hover = null;
  S.choseSpec = false;
  S.joined = false;
  S.lastChatId = 0;
  S.lastDanmakuId = 0;
  S.histSig = '';
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
      const url = `/api/gomoku/rooms/${roomId}/sync?token=${encodeURIComponent(S.token)}&since=${S.seq}`;
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
    const cost = Date.now() - started;
    if (cost < 300) await sleep(300 - cost);
  }
}

function applyState(st) {
  if (S.room && st.seq < S.seq) return;
  const firstState = !S.room;
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
  renderMoveLog(st);
  appendChat(st.chat || [], firstState);
  updateSpecList(st);
  drawBoard();
}

function renderSeats(st) {
  paintSeat('seatBlack', st.players.b, 'b', st);
  paintSeat('seatWhite', st.players.w, 'w', st);
}

function paintSeat(id, p, color, st) {
  const el = $(id);
  const nameEl = el.querySelector('.seat-name');
  if (p) {
    nameEl.innerHTML = `<span class="presence ${p.online ? '' : 'off'}"></span>${esc(p.name)}`;
    el.querySelector('.seat-meta').textContent = (color === 'b' ? '黑方 · 先手' : '白方 · 后手') + (p.online ? ' · 在线' : ' · 离线');
  } else {
    nameEl.textContent = '虚位以待';
    el.querySelector('.seat-meta').textContent = color === 'b' ? '黑方 · 先手' : '白方 · 后手';
  }
  el.classList.toggle('active', st.status === 'playing' && st.turn === color);
}

function renderMyRole(st) {
  const el = $('myRole');
  if (st.myColor === 'b') { el.textContent = '黑方棋手'; el.style.color = '#a9c8ff'; }
  else if (st.myColor === 'w') { el.textContent = '白方棋手'; el.style.color = '#f0dcb4'; }
  else { el.textContent = '观战者'; el.style.color = ''; }
}

function renderHint(st) {
  const el = $('turnHint');
  if (st.status === 'waiting') {
    el.innerHTML = '等待另一位棋手入座<br>把邀请链接发给朋友，或等观战者上座';
  } else if (st.status === 'over') {
    if (!st.winner) {
      el.innerHTML = '本局结束 · <strong>和棋</strong>（棋盘已满）';
    } else {
      const winner = st.winner === 'b' ? '黑方' : '白方';
      el.innerHTML = `本局结束 · <strong>${winner}获胜</strong>（${REASON[st.endReason] || '结束'}）`;
    }
  } else if (st.myColor === st.turn) {
    el.innerHTML = '<strong>轮到你落子</strong> · 每步限时 60 秒';
  } else if (st.myColor === 'spec') {
    el.innerHTML = (st.turn === 'b' ? '黑方' : '白方') + '正在思考… · 你正在观战';
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
  } else if (!st.winner) {
    b.innerHTML = '和棋<small>点击「重新开始」再来一局</small>';
  } else {
    const winner = st.winner === 'b' ? '黑方' : '白方';
    b.innerHTML = `${winner}胜 · ${REASON[st.endReason] || ''}<small>点击「重新开始」再来一局</small>`;
  }
}

function renderButtons(st) {
  const resign = $('resignBtn');
  const rematch = $('rematchBtn');
  const isPlayer = st.myColor === 'b' || st.myColor === 'w';
  resign.disabled = !(isPlayer && st.status === 'playing');
  rematch.disabled = !isPlayer;

  const voted = (st.rematch || []).includes(st.myColor);
  if (st.status === 'over' && isPlayer && st.players.b && st.players.w && voted) {
    rematch.textContent = '等待对手确认…';
    rematch.disabled = true;
  } else {
    rematch.textContent = '重新开始';
  }
}

function renderMoveLog(st) {
  const hist = st.history || [];
  $('moveCount').textContent = st.moveCount;
  const tail = hist.length ? hist[hist.length - 1] : null;
  const sig = hist.length + ':' + (tail ? tail.n + tail.text : '');
  if (sig === S.histSig) return;
  S.histSig = sig;

  const el = $('moveLog');
  if (!hist.length) {
    el.innerHTML = '<div class="move-empty">开局后此处记录落子坐标</div>';
    renderLastMove(null);
    return;
  }

  const rows = new Map();
  for (const mv of hist) {
    const key = Math.ceil(mv.n / 2);
    let row = rows.get(key);
    if (!row) {
      row = { n: key, b: '', w: '' };
      rows.set(key, row);
    }
    if (mv.color === 'b') row.b = mv.text;
    else row.w = mv.text;
  }
  const keys = Array.from(rows.keys()).sort((a, b) => a - b);
  let html = '';
  keys.forEach((key, i) => {
    const row = rows.get(key);
    const isLast = i === keys.length - 1;
    html += `<div class="mv-row${isLast ? ' last' : ''}">`
      + `<span class="mv-n">${row.n}</span>`
      + `<span class="mv-black">${esc(row.b || '')}</span>`
      + `<span class="mv-white">${esc(row.w || '')}</span>`
      + '</div>';
  });
  el.innerHTML = html;
  el.scrollTop = el.scrollHeight;
  renderLastMove(hist[hist.length - 1]);
}

function renderLastMove(mv) {
  const el = $('lastMove');
  if (!mv) {
    el.textContent = '';
    el.classList.remove('pop');
    return;
  }
  el.textContent = (mv.color === 'b' ? '黑 ' : '白 ') + mv.text;
  el.classList.remove('pop');
  void el.offsetWidth;
  el.classList.add('pop');
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
  const bTaken = !!st.players.b;
  const wTaken = !!st.players.w;
  overlay.querySelectorAll('.join-actions .btn').forEach((btn) => {
    const seat = btn.dataset.seat;
    if (seat === 'b') {
      btn.disabled = bTaken;
      btn.innerHTML = bTaken ? '执黑 · 已占' : '执黑 <small>先手</small>';
    } else if (seat === 'w') {
      btn.disabled = wTaken;
      btn.innerHTML = wTaken ? '执白 · 已占' : '执白 <small>后手</small>';
    }
  });
  $('joinDesc').textContent = bTaken && wTaken ? '两个座位都已坐满，你可以观战' : '先到先得，空位可入座';
}

async function joinRoom(seat) {
  if (!S.roomId) return;
  const name = nick();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`/api/gomoku/rooms/${S.roomId}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, seat, token: S.token }),
      });
      let data = null;
      try {
        data = await res.json();
      } catch (e) {
        data = null;
      }
      if (!data) {
        if (attempt === 0) { await sleep(300); continue; }
        toast('网络异常，请稍后重试');
        return;
      }
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
      return;
    } catch (e) {
      if (attempt === 0) { await sleep(300); continue; }
      toast('网络异常，请检查网络后重试');
      return;
    }
  }
}

/* ============================================================
 * 落子 / 聊天
 * ============================================================ */
async function postAction(action, body) {
  if (!S.roomId) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`/api/gomoku/rooms/${S.roomId}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ token: S.token }, body || {})),
      });
      let data = null;
      try {
        data = await res.json();
      } catch (e) {
        data = null;
      }
      if (!data) {
        if (attempt === 0) { await sleep(300); continue; }
        toast('网络异常，请稍后重试');
        return null;
      }
      if (!res.ok || !data.ok) {
        toast(data.error || '操作失败');
        return null;
      }
      if (data.state) applyState(data.state);
      return data;
    } catch (e) {
      if (attempt === 0) { await sleep(300); continue; }
      toast('网络异常，请检查网络后重试');
      return null;
    }
  }
  return null;
}

async function sendMove(x, y) {
  if (S.busy) return;
  S.busy = true;
  S.hover = null;
  drawBoard();
  await postAction('move', { x, y });
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
  const duration = Math.max(5200, (dist / 0.13));

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
  const blackEl = $('clockBlack');
  const whiteEl = $('clockWhite');

  if (st.status === 'playing' && st.turn === 'w') {
    whiteEl.textContent = fmtClock(left);
    blackEl.textContent = fmtClock(st.limit);
  } else if (st.status === 'playing') {
    blackEl.textContent = fmtClock(left);
    whiteEl.textContent = fmtClock(st.limit);
  } else {
    blackEl.textContent = fmtClock(st.limit);
    whiteEl.textContent = fmtClock(st.limit);
  }
  blackEl.classList.toggle('hot', st.status === 'playing' && st.turn === 'b' && left < 10000);
  whiteEl.classList.toggle('hot', st.status === 'playing' && st.turn === 'w' && left < 10000);
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
  const cell = Math.min(rect.width, rect.height) / (SIZE - 1 + 2.05);
  geo.cell = cell;
  geo.ox = (rect.width - cell * (SIZE - 1)) / 2;
  geo.oy = (rect.height - cell * (SIZE - 1)) / 2;
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
  const st = S.room;
  const { w, h, cell } = geo;
  if (!w || !h || !cell) return;
  ctx.clearRect(0, 0, w, h);

  // 木色底
  const bg = ctx.createLinearGradient(0, 0, w * 0.7, h);
  bg.addColorStop(0, '#f7e7c5');
  bg.addColorStop(0.5, '#efd9ac');
  bg.addColorStop(1, '#e2c48d');
  roundRect(0, 0, w, h, 16);
  ctx.fillStyle = bg;
  ctx.fill();

  // 木纹
  ctx.save();
  ctx.strokeStyle = 'rgba(122, 74, 28, 0.05)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 26; i++) {
    const y = (i / 26) * h + ((i * 37) % 13);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.bezierCurveTo(w * 0.32, y + 6, w * 0.62, y - 7, w, y + 3);
    ctx.stroke();
  }
  ctx.restore();

  // 外框
  const m = cell * 0.62;
  ctx.strokeStyle = 'rgba(112, 66, 22, 0.85)';
  ctx.lineWidth = Math.max(2, cell * 0.05);
  ctx.strokeRect(geo.ox - m, geo.oy - m, cell * (SIZE - 1) + m * 2, cell * (SIZE - 1) + m * 2);
  ctx.strokeStyle = 'rgba(112, 66, 22, 0.4)';
  ctx.lineWidth = Math.max(1, cell * 0.02);
  ctx.strokeRect(geo.ox - m * 0.6, geo.oy - m * 0.6, cell * (SIZE - 1) + m * 1.2, cell * (SIZE - 1) + m * 1.2);

  // 格线
  ctx.strokeStyle = 'rgba(112, 66, 22, 0.72)';
  ctx.lineWidth = Math.max(1, cell * 0.018);
  ctx.beginPath();
  for (let i = 0; i < SIZE; i++) {
    ctx.moveTo(px(0), py(i));
    ctx.lineTo(px(SIZE - 1), py(i));
    ctx.moveTo(px(i), py(0));
    ctx.lineTo(px(i), py(SIZE - 1));
  }
  ctx.stroke();

  // 星位
  const stars = [[3, 3], [11, 3], [3, 11], [11, 11], [7, 7]];
  ctx.fillStyle = 'rgba(90, 52, 16, 0.8)';
  for (const [x, y] of stars) {
    ctx.beginPath();
    ctx.arc(px(x), py(y), Math.max(1.6, cell * 0.085), 0, Math.PI * 2);
    ctx.fill();
  }

  // 坐标
  ctx.save();
  ctx.fillStyle = 'rgba(112, 66, 22, 0.55)';
  ctx.font = `600 ${Math.max(8, Math.round(cell * 0.3))}px "Helvetica Neue", Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < SIZE; i++) {
    ctx.fillText(String.fromCharCode(65 + i), px(i), py(0) - cell * 0.72);
    ctx.fillText(String(SIZE - i), px(0) - cell * 0.72, py(i));
  }
  ctx.restore();

  if (!st) return;

  // 落子
  const board = st.board || [];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const v = board[y] ? board[y][x] : null;
      if (v === 'b' || v === 'w') drawStone(x, y, v, 1);
    }
  }

  // 最后一手
  if (st.lastMove) {
    const lm = st.lastMove;
    ctx.save();
    ctx.beginPath();
    ctx.arc(px(lm.x), py(lm.y), Math.max(2, cell * 0.09), 0, Math.PI * 2);
    ctx.fillStyle = lm.color === 'b' ? '#f0c987' : '#c8483d';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  // 悬停预览
  if (S.hover && st.status === 'playing' && st.myColor === st.turn && st.myColor !== 'spec') {
    const { x, y } = S.hover;
    if (!board[y] || !board[y][x]) drawStone(x, y, st.myColor, 0.38);
  }

  // 获胜连线
  if (st.winLine && st.winLine.length >= 2) {
    const first = st.winLine[0];
    const last = st.winLine[st.winLine.length - 1];
    ctx.save();
    ctx.strokeStyle = 'rgba(200, 72, 61, 0.92)';
    ctx.lineWidth = Math.max(3, cell * 0.13);
    ctx.lineCap = 'round';
    ctx.shadowColor = 'rgba(200, 72, 61, 0.7)';
    ctx.shadowBlur = cell * 0.5;
    ctx.beginPath();
    ctx.moveTo(px(first[0]), py(first[1]));
    ctx.lineTo(px(last[0]), py(last[1]));
    ctx.stroke();
    ctx.restore();
    for (const [x, y] of st.winLine) {
      ctx.beginPath();
      ctx.arc(px(x), py(y), cell * 0.3, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255, 236, 190, 0.8)';
      ctx.lineWidth = Math.max(1.5, cell * 0.05);
      ctx.stroke();
    }
  }
}

function drawStone(x, y, color, alpha) {
  const { cell } = geo;
  const cx = px(x);
  const cy = py(y);
  const r = cell * 0.44;
  ctx.save();
  ctx.globalAlpha = alpha;

  ctx.beginPath();
  ctx.arc(cx + cell * 0.035, cy + cell * 0.06, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(40, 22, 6, 0.28)';
  ctx.fill();

  const grad = ctx.createRadialGradient(cx - r * 0.34, cy - r * 0.4, r * 0.12, cx, cy, r * 1.04);
  if (color === 'b') {
    grad.addColorStop(0, '#6a7684');
    grad.addColorStop(0.42, '#2b3542');
    grad.addColorStop(1, '#0d1219');
  } else {
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.55, '#f3f6fa');
    grad.addColorStop(1, '#c3cdd9');
  }
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.strokeStyle = color === 'b' ? 'rgba(255, 255, 255, 0.12)' : 'rgba(80, 96, 116, 0.35)';
  ctx.lineWidth = Math.max(1, cell * 0.018);
  ctx.stroke();

  // 高光
  ctx.beginPath();
  ctx.ellipse(cx - r * 0.32, cy - r * 0.38, r * 0.34, r * 0.22, -0.7, 0, Math.PI * 2);
  ctx.fillStyle = color === 'b' ? 'rgba(255, 255, 255, 0.16)' : 'rgba(255, 255, 255, 0.85)';
  ctx.fill();

  ctx.restore();
}

function hitTest(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const c = Math.round((x - geo.ox) / geo.cell);
  const r = Math.round((y - geo.oy) / geo.cell);
  if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) return null;
  const dx = x - px(c);
  const dy = y - py(r);
  if (Math.hypot(dx, dy) > geo.cell * 0.52) return null;
  return { x: c, y: r };
}

canvas.addEventListener('mousemove', (e) => {
  const st = S.room;
  if (!st || st.status !== 'playing' || st.myColor === 'spec' || st.turn !== st.myColor) {
    if (S.hover) { S.hover = null; drawBoard(); }
    return;
  }
  const hit = hitTest(e.clientX, e.clientY);
  const same = S.hover && hit && S.hover.x === hit.x && S.hover.y === hit.y;
  if (same || (!hit && !S.hover)) return;
  S.hover = hit;
  drawBoard();
});

canvas.addEventListener('mouseleave', () => {
  if (S.hover) { S.hover = null; drawBoard(); }
});

canvas.addEventListener('click', (e) => {
  const st = S.room;
  if (!st || S.busy) return;
  const hit = hitTest(e.clientX, e.clientY);
  if (!hit) return;
  const my = st.myColor;
  if (my !== 'b' && my !== 'w') {
    toast('观战模式不能落子');
    return;
  }
  if (st.status !== 'playing') return;
  if (st.turn !== my) {
    toast('还没轮到你落子');
    return;
  }
  if (st.board[hit.y] && st.board[hit.y][hit.x]) return;
  sendMove(hit.x, hit.y);
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
    new ResizeObserver(() => resizeCanvas()).observe(document.querySelector('.gomoku-board-frame'));
  }

  setInterval(() => {
    if (S.view === 'lobby') loadRooms();
  }, 3500);
}

function start() {
  bind();
  const m = location.hash.match(/^#r=([a-f0-9]{8})$/);
  if (m) enterRoom(m[1]);
  else loadRooms();
}

start();
