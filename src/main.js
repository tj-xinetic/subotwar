import Phaser from 'phaser';
import { createClient } from '@supabase/supabase-js';
import './style.css';

const app = document.querySelector('#app');
const config = import.meta.env;
const sessionId = crypto.randomUUID();
const state = {
  client: null,
  directory: null,
  room: null,
  lobby: null,
  nickname: sessionStorage.getItem('subotwar-nickname') ?? '',
  connected: false,
  game: null,
};

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));
const formatClock = (seconds) => `${Math.floor(seconds / 60)}<span> : ${String(seconds % 60).padStart(2, '0')}</span>`;

function presenceMembers(channel) {
  return Object.values(channel?.presenceState?.() ?? {}).flat();
}

function publicLobbies() {
  const grouped = new Map();
  for (const member of presenceMembers(state.directory)) {
    const lobby = member.lobby;
    if (!lobby?.roomId) continue;
    const existing = grouped.get(lobby.roomId);
    if (!existing || lobby.playerCount > existing.playerCount) grouped.set(lobby.roomId, lobby);
  }
  return [...grouped.values()].sort((a, b) => a.createdAt - b.createdAt);
}

function setNickname(value) {
  state.nickname = value.trim().slice(0, 18);
  sessionStorage.setItem('subotwar-nickname', state.nickname);
}

function renderHome() {
  state.game?.destroy(true);
  state.game = null;
  app.innerHTML = `
    <header class="topbar">
      <a class="wordmark" href="#" aria-label="Subotwar home"><span class="mark">S</span> SUBOTWAR</a>
      <div class="connection"><span class="status-dot ${state.connected ? 'is-online' : ''}"></span>${state.connected ? 'ARENA ONLINE' : 'CONNECTING'}</div>
    </header>
    <main class="home-layout">
      <section class="intro">
        <p class="eyebrow"><span>OPEN ARENA</span><span class="eyebrow-line"></span><span>01 / 02 PLAYERS</span></p>
        <h1>LAST BOT<br /><em>STANDING.</em></h1>
        <p class="intro-copy">Two drivers enter. One robot stays in the ring. Pick a lobby and settle it on the dohyo.</p>
        <label class="name-label" for="nickname">DRIVER CALLSIGN</label>
        <div class="create-row">
          <input id="nickname" maxlength="18" autocomplete="nickname" placeholder="Your nickname" value="${escapeHtml(state.nickname)}" />
          <button class="button button-dark" id="create-lobby" ${state.connected ? '' : 'disabled'}><span>＋</span> CREATE LOBBY</button>
        </div>
        ${!state.connected ? `<p class="setup-note">Connect a Supabase project to open the live arena. Add its URL and anon key to <code>.env</code>.</p>` : ''}
        <div class="arena-stats"><span><b>2</b> DRIVERS PER MATCH</span><span><b>90</b> SEC ROUND</span><span><b>0</b> SECOND INSTALL</span></div>
      </section>
      <section class="lobby-board" aria-labelledby="lobby-title">
        <div class="board-heading"><div><p class="eyebrow">LIVE MATCHMAKING</p><h2 id="lobby-title">Public lobbies</h2></div><span class="lobby-count">${publicLobbies().length.toString().padStart(2, '0')} OPEN</span></div>
        <div class="lobby-list" id="lobby-list">${renderLobbyCards()}</div>
        <div class="board-foot"><span class="pulse-dot"></span> PUBLIC ROOMS · AUTO-UPDATING</div>
      </section>
    </main>
    <footer class="footer"><span>SUBOTWAR / ONLINE DOHYO</span><span>NO COINS. NO COVER. JUST THE RING.</span></footer>
    <div class="toast" id="toast" role="status"></div>`;

  document.querySelector('#nickname').addEventListener('input', (event) => setNickname(event.target.value));
  document.querySelector('#create-lobby').addEventListener('click', createLobby);
  document.querySelector('#lobby-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-join]');
    if (button) joinLobby(button.dataset.join);
  });
}

function renderLobbyCards() {
  const lobbies = publicLobbies();
  if (!state.connected) return '<div class="empty-state"><span class="empty-icon">⌁</span><strong>ARENA NOT CONNECTED</strong><p>Set up the free realtime connection to see open rooms.</p></div>';
  if (!lobbies.length) return '<div class="empty-state"><span class="empty-icon">◎</span><strong>NO OPEN ROOMS</strong><p>Start the first lobby. Your opponent can join from here.</p></div>';
  return lobbies.map((lobby) => `
    <article class="lobby-card">
      <div class="lobby-index">${String(lobbies.indexOf(lobby) + 1).padStart(2, '0')}</div>
      <div class="lobby-info"><strong>${escapeHtml(lobby.hostName)}'S DOHYO</strong><span>ROOM ${escapeHtml(lobby.roomId.slice(0, 5).toUpperCase())}</span></div>
      <div class="slots" aria-label="${lobby.playerCount} of 2 players"><i class="filled"></i><i class="${lobby.playerCount > 1 ? 'filled' : ''}"></i></div>
      <button class="join-button" data-join="${escapeHtml(lobby.roomId)}" ${lobby.playerCount > 1 ? 'disabled' : ''}>${lobby.playerCount > 1 ? 'FULL' : 'JOIN'} <span>↗</span></button>
    </article>`).join('');
}

function refreshDirectory() {
  const list = document.querySelector('#lobby-list');
  const count = document.querySelector('.lobby-count');
  if (list) list.innerHTML = renderLobbyCards();
  if (count) count.textContent = `${publicLobbies().length.toString().padStart(2, '0')} OPEN`;
}

function toast(message) {
  const node = document.querySelector('#toast');
  if (!node) return;
  node.textContent = message;
  node.classList.add('visible');
  window.setTimeout(() => node.classList.remove('visible'), 2600);
}

function lobbyRoster() {
  return presenceMembers(state.room).sort((a, b) => a.player - b.player);
}

async function subscribe(channel) {
  return new Promise((resolve, reject) => {
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') resolve();
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') reject(new Error('Could not connect to that lobby.'));
    });
  });
}

function registerRoomEvents(channel) {
  channel.on('presence', { event: 'sync' }, () => {
    if (!state.lobby || state.room !== channel) return;
    updateLobbyDirectory();
    renderLobby();
  });
  channel.on('broadcast', { event: 'kick' }, ({ payload }) => {
    if (payload?.target === sessionId && payload.hostId === state.lobby?.hostId) {
      leaveLobby(true).then(() => toast('The host removed you from the lobby.'));
    }
  });
  channel.on('broadcast', { event: 'game-start' }, ({ payload }) => {
    if (payload?.hostId !== state.lobby?.hostId) return;
    launchMatch();
  });
  channel.on('broadcast', { event: 'game-input' }, ({ payload }) => {
    if (state.lobby?.isHost) state.game?.scene.getScene('SumoScene')?.setOpponentInput(payload.input);
  });
  channel.on('broadcast', { event: 'game-state' }, ({ payload }) => {
    if (!state.lobby?.isHost) state.game?.scene.getScene('SumoScene')?.applySnapshot(payload);
  });
  channel.on('broadcast', { event: 'game-over' }, ({ payload }) => {
    state.game?.scene.getScene('SumoScene')?.finish(payload.winner, payload.reason);
  });
}

async function createLobby() {
  if (!state.connected) return toast('The online arena is not connected yet.');
  setNickname(document.querySelector('#nickname')?.value ?? state.nickname);
  if (!state.nickname) return toast('Add a nickname before creating a lobby.');
  const roomId = crypto.randomUUID().slice(0, 8);
  await enterRoom({ roomId, isHost: true, hostName: state.nickname, player: 1, createdAt: Date.now() });
}

async function joinLobby(roomId) {
  if (!state.connected) return toast('The online arena is not connected yet.');
  setNickname(document.querySelector('#nickname')?.value ?? state.nickname);
  if (!state.nickname) return toast('Add a nickname before joining a lobby.');
  const lobby = publicLobbies().find((room) => room.roomId === roomId);
  if (!lobby) return toast('That lobby has closed. Refreshing the room list.');
  await enterRoom({ roomId, isHost: false, hostName: lobby.hostName, hostId: lobby.hostId, player: 2 });
}

async function enterRoom(details) {
  const channel = state.client.channel(`room-${details.roomId}`, {
    config: { presence: { key: sessionId }, broadcast: { self: false } },
  });
  state.room = channel;
  state.lobby = { ...details, room: channel, hostId: details.hostId ?? sessionId };
  registerRoomEvents(channel);
  try {
    await subscribe(channel);
    const players = presenceMembers(channel);
    if (!details.isHost && players.length >= 2) throw new Error('That lobby is already full.');
    await channel.track({
      sessionId,
      nickname: state.nickname,
      player: details.player,
      hostId: state.lobby.hostId,
    });
    if (details.isHost) {
      await state.directory.track({
        lobby: {
          roomId: details.roomId,
          hostId: sessionId,
          hostName: state.nickname,
          playerCount: 1,
          createdAt: Date.now(),
        },
      });
    }
    renderLobby();
  } catch (error) {
    await state.client.removeChannel(channel);
    state.room = null;
    state.lobby = null;
    refreshDirectory();
    toast(error.message || 'Could not join that lobby.');
  }
}

async function updateLobbyDirectory() {
  if (!state.lobby?.isHost || state.lobby.isLeaving) return;
  if (state.lobby.started) {
    await state.directory.untrack();
    return;
  }
  const members = lobbyRoster();
  await state.directory.track({
    lobby: {
      roomId: state.lobby.roomId,
      hostId: state.lobby.hostId,
      hostName: state.lobby.hostName,
      playerCount: members.length,
      createdAt: state.lobby.createdAt ?? Date.now(),
    },
  });
}

function renderLobby() {
  const lobby = state.lobby;
  if (!lobby) return renderHome();
  const members = lobbyRoster();
  const guest = members.find((member) => member.player === 2);
  app.innerHTML = `
    <header class="topbar"><a class="wordmark" href="#"><span class="mark">S</span> SUBOTWAR</a><button class="text-button" id="leave-lobby">← BACK TO ARENA</button></header>
    <main class="waiting-layout">
      <section class="waiting-copy"><p class="eyebrow"><span>ROOM ${escapeHtml(lobby.roomId.toUpperCase())}</span><span class="eyebrow-line"></span><span>${lobby.isHost ? 'HOST' : 'CHALLENGER'}</span></p>
        <h1>${guest ? 'THE RING<br /><em>IS READY.</em>' : 'CALLING<br /><em>AN OPPONENT.</em>'}</h1>
        <p class="intro-copy">${guest ? 'Both drivers are in. The host can start the match when ready.' : 'Your lobby is live in the public list. Share the room code or wait for a challenger.'}</p>
        <div class="room-code"><span>ROOM CODE</span><strong>${escapeHtml(lobby.roomId.toUpperCase())}</strong><button id="copy-code" title="Copy room code">COPY</button></div>
      </section>
      <section class="roster-panel"><div class="board-heading"><div><p class="eyebrow">DRIVER LINEUP</p><h2>At the edge</h2></div><span class="lobby-count">${members.length} / 2</span></div>
        <div class="driver-row"><span class="driver-number">01</span><span class="driver-badge badge-red">●</span><div class="driver-details"><strong>${escapeHtml(lobby.hostName)}</strong><span>HOST · RED BOT</span></div><span class="ready-label">READY</span></div>
        ${guest ? `<div class="driver-row"><span class="driver-number">02</span><span class="driver-badge badge-blue">●</span><div class="driver-details"><strong>${escapeHtml(guest.nickname)}</strong><span>CHALLENGER · BLUE BOT</span></div>${lobby.isHost ? '<button class="kick-button" id="kick-player" title="Remove challenger">KICK</button>' : '<span class="ready-label">READY</span>'}</div>` : '<div class="driver-row vacant"><span class="driver-number">02</span><span class="driver-badge">＋</span><div class="driver-details"><strong>OPEN SLOT</strong><span>WAITING FOR A CHALLENGER</span></div><span class="searching"><i></i> SEARCHING</span></div>'}
        <div class="roster-actions">${lobby.isHost ? `<button class="button button-dark start-button" id="start-match" ${guest ? '' : 'disabled'}>START MATCH <span>↗</span></button>` : '<div class="host-wait">WAITING FOR HOST TO START</div>'}<p>${lobby.isHost ? 'Only the host can start or remove a player.' : 'The host controls when the match begins.'}</p></div>
      </section>
    </main><footer class="footer"><span>SUBOTWAR / ONLINE DOHYO</span><span>2 DRIVERS · 1 RING</span></footer><div class="toast" id="toast" role="status"></div>`;
  document.querySelector('#leave-lobby').addEventListener('click', () => leaveLobby(true));
  document.querySelector('#copy-code').addEventListener('click', async () => {
    await navigator.clipboard?.writeText(lobby.roomId.toUpperCase());
    toast('Room code copied.');
  });
  document.querySelector('#kick-player')?.addEventListener('click', () => kickPlayer(guest.sessionId));
  document.querySelector('#start-match')?.addEventListener('click', startMatch);
}

async function leaveLobby(returnToList) {
  const lobby = state.lobby;
  if (!lobby) return;
  lobby.isLeaving = true;
  state.game?.destroy(true);
  state.game = null;
  if (lobby.isHost) await state.directory.untrack();
  await state.client.removeChannel(lobby.room);
  state.room = null;
  state.lobby = null;
  refreshDirectory();
  if (returnToList) renderHome();
}

async function kickPlayer(target) {
  await state.room.send({
    type: 'broadcast', event: 'kick',
    payload: { target, hostId: state.lobby.hostId },
  });
}

async function startMatch() {
  if (!state.lobby?.isHost || lobbyRoster().length < 2) return;
  state.lobby.started = true;
  await state.directory.untrack();
  await state.room.send({
    type: 'broadcast', event: 'game-start',
    payload: { hostId: state.lobby.hostId },
  });
  launchMatch();
}

function launchMatch() {
  if (state.game) return;
  const host = state.lobby.isHost;
  app.innerHTML = `
    <header class="topbar game-topbar"><a class="wordmark" href="#"><span class="mark">S</span> SUBOTWAR</a><div class="round-label">ROUND 01 <span>·</span> ROOM ${escapeHtml(state.lobby.roomId.toUpperCase())}</div><button class="text-button" id="forfeit">FORFEIT</button></header>
    <main class="game-layout"><div class="match-head"><div class="match-driver"><i class="bot-dot red-dot"></i><strong>${escapeHtml(state.lobby.hostName)}</strong><span>RED BOT</span></div><div class="timer" id="match-timer">1<span> : 30</span></div><div class="match-driver right"><i class="bot-dot blue-dot"></i><strong>${escapeHtml(lobbyRoster().find((member) => member.player === 2)?.nickname ?? 'CHALLENGER')}</strong><span>BLUE BOT</span></div></div>
      <div class="game-frame"><div id="game-canvas"></div><div class="game-overlay" id="game-overlay"></div></div>
      <div class="match-controls"><span>${host ? 'W A S D' : '↑ ← ↓ →'} <small>DRIVE / TURN</small></span><span class="ring-caption">DOHYO · 90 SECOND ROUND</span><button class="text-button" id="exit-match">EXIT MATCH</button></div>
    </main><div class="toast" id="toast" role="status"></div>`;
  document.querySelector('#forfeit').addEventListener('click', () => {
    if (state.lobby.isHost) {
      state.room.send({ type: 'broadcast', event: 'game-over', payload: { winner: 'BLUE BOT', reason: 'forfeit' } });
    }
    showGameResult(state.lobby.isHost ? 'BLUE BOT' : 'RED BOT', 'FORFEIT');
  });
  document.querySelector('#exit-match').addEventListener('click', () => leaveLobby(true));
  state.game = new Phaser.Game({
    type: Phaser.CANVAS,
    parent: 'game-canvas',
    width: 900,
    height: 560,
    backgroundColor: '#e8e3d7',
    physics: { default: 'matter', matter: { gravity: { x: 0, y: 0 }, debug: false } },
    scene: [SumoScene],
    banner: false,
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  });
}

function showGameResult(winner, reason) {
  const overlay = document.querySelector('#game-overlay');
  if (!overlay) return;
  overlay.innerHTML = `<div class="result-stamp"><span>${escapeHtml(reason.toUpperCase())}</span><strong>${escapeHtml(winner)}<br />WINS</strong><button id="result-exit">BACK TO ARENA</button></div>`;
  overlay.classList.add('visible');
  document.querySelector('#result-exit').addEventListener('click', () => leaveLobby(true));
}

class SumoScene extends Phaser.Scene {
  constructor() {
    super('SumoScene');
    this.localInput = { up: false, down: false, left: false, right: false };
    this.opponentInput = { up: false, down: false, left: false, right: false };
    this.lastInputSent = 0;
    this.lastSnapshotSent = 0;
    this.startedAt = 0;
    this.finished = false;
  }

  create() {
    const { width, height } = this.scale;
    this.center = { x: width / 2, y: height / 2 };
    this.radius = 222;
    const mat = this.add.graphics();
    mat.fillStyle(0xf1ede3, 1).fillCircle(this.center.x, this.center.y, this.radius + 20);
    mat.lineStyle(3, 0x282a27, 1).strokeCircle(this.center.x, this.center.y, this.radius + 20);
    mat.lineStyle(2, 0xb7b1a4, 1).strokeCircle(this.center.x, this.center.y, this.radius - 28);
    mat.fillStyle(0xd8d1c2, 0.55).fillCircle(this.center.x, this.center.y, 4);
    for (let index = 0; index < 24; index += 1) {
      const angle = (index / 24) * Math.PI * 2;
      const x = this.center.x + Math.cos(angle) * (this.radius + 10);
      const y = this.center.y + Math.sin(angle) * (this.radius + 10);
      mat.fillStyle(index % 2 ? 0xdf553c : 0x317d90, 1).fillCircle(x, y, 3);
    }
    this.leftBot = this.add.rectangle(this.center.x - 70, this.center.y, 50, 40, 0xdf553c);
    this.rightBot = this.add.rectangle(this.center.x + 70, this.center.y, 50, 40, 0x317d90);
    for (const bot of [this.leftBot, this.rightBot]) {
      this.matter.add.gameObject(bot, {
        shape: { type: 'rectangle', width: 50, height: 40 },
        friction: 0.05,
        frictionAir: 0.08,
        restitution: 0.45,
        density: 0.002,
      });
    }
    this.leftBot.rotation = 0;
    this.rightBot.rotation = Math.PI;
    this.leftBot.setDepth(2);
    this.rightBot.setDepth(2);
    this.leftEye = this.add.circle(this.leftBot.x + 18, this.leftBot.y, 4, 0xf1ede3).setDepth(3);
    this.rightEye = this.add.circle(this.rightBot.x - 18, this.rightBot.y, 4, 0xf1ede3).setDepth(3);
    this.keys = this.input.keyboard.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT');
    this.startedAt = Date.now();
    this.events.once('shutdown', () => this.input.keyboard?.shutdown());
  }

  readInput(prefix) {
    const keys = this.keys;
    const useArrows = prefix === 'arrow';
    return {
      up: (useArrows ? keys.UP : keys.W).isDown,
      down: (useArrows ? keys.DOWN : keys.S).isDown,
      left: (useArrows ? keys.LEFT : keys.A).isDown,
      right: (useArrows ? keys.RIGHT : keys.D).isDown,
    };
  }

  setOpponentInput(input) {
    this.opponentInput = input;
  }

  applySnapshot(snapshot) {
    if (!snapshot || this.finished) return;
    this.leftBot.setPosition(snapshot.left.x, snapshot.left.y).setRotation(snapshot.left.rotation);
    this.matter.body.setVelocity(this.leftBot.body, { x: snapshot.left.vx, y: snapshot.left.vy });
    this.rightBot.setPosition(snapshot.right.x, snapshot.right.y).setRotation(snapshot.right.rotation);
    this.matter.body.setVelocity(this.rightBot.body, { x: snapshot.right.vx, y: snapshot.right.vy });
    const seconds = Math.max(0, Math.ceil(snapshot.remaining / 1000));
    const timer = document.querySelector('#match-timer');
    if (timer) timer.innerHTML = formatClock(seconds);
    this.leftEye.setPosition(this.leftBot.x + Math.cos(this.leftBot.rotation) * 19, this.leftBot.y + Math.sin(this.leftBot.rotation) * 19);
    this.rightEye.setPosition(this.rightBot.x + Math.cos(this.rightBot.rotation) * 19, this.rightBot.y + Math.sin(this.rightBot.rotation) * 19);
  }

  drive(bot, input) {
    const turn = Number(input.right) - Number(input.left);
    this.matter.body.setAngularVelocity(bot.body, turn * 0.055);
    const throttle = Number(input.up) - Number(input.down);
    const force = throttle * 0.006;
    this.matter.body.applyForce(bot.body, bot.body.position, {
      x: Math.cos(bot.rotation) * force,
      y: Math.sin(bot.rotation) * force,
    });
  }

  update(time) {
    if (this.finished) return;
    this.localInput = this.readInput(state.lobby.player === 2 ? 'arrow' : 'wasd');
    if (!state.lobby.isHost && time - this.lastInputSent > 45) {
      state.room.send({ type: 'broadcast', event: 'game-input', payload: { input: this.localInput } });
      this.lastInputSent = time;
    }
    if (!state.lobby.isHost) return;

    this.drive(this.leftBot, this.localInput);
    this.drive(this.rightBot, this.opponentInput);
    for (const bot of [this.leftBot, this.rightBot]) {
      const speed = Math.hypot(bot.body.velocity.x, bot.body.velocity.y);
      if (speed > 4.5) this.matter.body.setVelocity(bot.body, { x: bot.body.velocity.x * 4.5 / speed, y: bot.body.velocity.y * 4.5 / speed });
    }
    this.leftEye.setPosition(this.leftBot.x + Math.cos(this.leftBot.rotation) * 19, this.leftBot.y + Math.sin(this.leftBot.rotation) * 19);
    this.rightEye.setPosition(this.rightBot.x + Math.cos(this.rightBot.rotation) * 19, this.rightBot.y + Math.sin(this.rightBot.rotation) * 19);

    const leftOut = Phaser.Math.Distance.Between(this.leftBot.x, this.leftBot.y, this.center.x, this.center.y) > this.radius + 18;
    const rightOut = Phaser.Math.Distance.Between(this.rightBot.x, this.rightBot.y, this.center.x, this.center.y) > this.radius + 18;
    const elapsed = Date.now() - this.startedAt;
    if (leftOut || rightOut) {
      const winner = leftOut && rightOut ? 'DRAW' : leftOut ? 'BLUE BOT' : 'RED BOT';
      this.finish(winner, 'PUSHED OUT');
      state.room.send({ type: 'broadcast', event: 'game-over', payload: { winner, reason: 'pushed out' } });
    } else if (elapsed >= 90000) {
      const winner = this.leftBot.body.speed > this.rightBot.body.speed ? 'RED BOT' : 'BLUE BOT';
      this.finish(winner, 'TIME');
      state.room.send({ type: 'broadcast', event: 'game-over', payload: { winner, reason: 'time' } });
    }

    if (time - this.lastSnapshotSent > 45) {
      state.room.send({
        type: 'broadcast', event: 'game-state',
        payload: {
          left: { x: this.leftBot.x, y: this.leftBot.y, rotation: this.leftBot.rotation, vx: this.leftBot.body.velocity.x, vy: this.leftBot.body.velocity.y },
          right: { x: this.rightBot.x, y: this.rightBot.y, rotation: this.rightBot.rotation, vx: this.rightBot.body.velocity.x, vy: this.rightBot.body.velocity.y },
          remaining: Math.max(0, 90000 - elapsed),
        },
      });
      this.lastSnapshotSent = time;
    }
    const remaining = Math.max(0, Math.ceil((90000 - elapsed) / 1000));
    const timer = document.querySelector('#match-timer');
    if (timer) timer.innerHTML = formatClock(remaining);
  }

  finish(winner, reason) {
    if (this.finished) return;
    this.finished = true;
    showGameResult(winner, reason);
  }
}

function connect() {
  if (!config.VITE_SUPABASE_URL || !config.VITE_SUPABASE_ANON_KEY) {
    renderHome();
    return;
  }
  state.client = createClient(config.VITE_SUPABASE_URL, config.VITE_SUPABASE_ANON_KEY);
  state.directory = state.client.channel('public-lobbies', {
    config: { presence: { key: sessionId }, broadcast: { self: false } },
  });
  state.directory.on('presence', { event: 'sync' }, refreshDirectory);
  state.directory.subscribe((status) => {
    state.connected = status === 'SUBSCRIBED';
    if (state.connected) state.directory.track({ onlineAt: Date.now() });
    renderHome();
  });
  renderHome();
}

connect();