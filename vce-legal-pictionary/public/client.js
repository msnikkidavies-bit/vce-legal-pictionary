const socket = io();
let my = {
  role: null, // 'teacher'|'player'|'spectator'
  code: null,
  name: null,
  isDrawer: false
};

const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
function show(el, on=true){ if(!el)return; el.classList.toggle('hidden', !on); }
function text(el, t){ if(el) el.textContent = t; }

// Auth / Lobby
const btnCreateRoom = $('#btnCreateRoom');
const teacherPanel = $('#teacherPanel');
const roomCodeEl = $('#roomCode');
const playerList = $('#playerList');
const spectatorList = $('#spectatorList');
const btnStartGame = $('#btnStartGame');
const btnStopGame = $('#btnStopGame');
const btnClearCanvas = $('#btnClearCanvas');
const autoRounds = $('#autoRounds');
const termsJson = $('#termsJson');
const btnUploadTerms = $('#btnUploadTerms');
const termUploadResult = $('#termUploadResult');

const joinCode = $('#joinCode');
const joinName = $('#joinName');
const btnJoin = $('#btnJoin');
const joinResult = $('#joinResult');

// Game UI
const game = $('#game');
const roundNum = $('#roundNum');
const timerEl = $('#timer');
const roleEl = $('#role');
const drawerOptions = $('#drawerOptions');
const optionButtons = $('#optionButtons');
const canvas = $('#canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const tools = $('#tools');
const btnClear = $('#btnClear');
const guessBox = $('#guessBox');
const guessInput = $('#guessInput');
const btnGuess = $('#btnGuess');
const termReveal = $('#termReveal');
const leaderboard = $('#leaderboard');
const guessStream = $('#guessStream');

let drawing = false;
let tool = 'pen';
let color = '#000000';
let size = 2;

// Canvas helpers
function setTool(t){ tool = t; }
function setSize(s){ size = Number(s); }
function setColor(c){ color = c; }

canvas.addEventListener('mousedown', e => startDraw(e));
canvas.addEventListener('touchstart', e => startDraw(e.touches[0]));
canvas.addEventListener('mousemove', e => moveDraw(e));
canvas.addEventListener('touchmove', e => moveDraw(e.touches[0]));
window.addEventListener('mouseup', endDraw);
window.addEventListener('touchend', endDraw);

let last = null;
function getPos(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
function startDraw(e) {
  if (!my.isDrawer) return;
  drawing = true;
  last = getPos(e);
}
function moveDraw(e) {
  if (!drawing || !my.isDrawer) return;
  const p = getPos(e);
  drawSegment(last, p, { tool, color, size }, true);
  last = p;
}
function endDraw() {
  drawing = false;
  last = null;
}

function drawSegment(a, b, opts, emit=false) {
  ctx.save();
  if (opts.tool === 'eraser') {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.strokeStyle = 'rgba(0,0,0,1)';
  } else {
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = opts.color || '#000';
  }
  ctx.lineWidth = opts.size || 2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.restore();

  if (emit) {
    socket.emit('draw:stroke', { code: my.code, stroke: { a, b, opts } });
  }
}

btnClear.addEventListener('click', () => {
  if (my.role === 'teacher' || my.isDrawer) {
    socket.emit('canvas:clear', { code: my.code });
  }
});

socket.on('draw:stroke', ({ stroke }) => {
  drawSegment(stroke.a, stroke.b, stroke.opts, false);
});
socket.on('canvas:clear', () => {
  ctx.clearRect(0,0,canvas.width, canvas.height);
});

// Tools UI
tools.addEventListener('click', (e) => {
  const t = e.target.getAttribute('data-tool');
  const c = e.target.getAttribute('data-color');
  const s = e.target.getAttribute('data-size');
  if (t) setTool(t);
  if (c) setColor(c);
  if (s) setSize(s);
});

// Teacher create room
btnCreateRoom.addEventListener('click', () => {
  socket.emit('room:create', {}, ({code}) => {
    my.role = 'teacher';
    my.code = code;
    show(teacherPanel, true);
    text(roomCodeEl, code);
  });
});

// Student join
btnJoin.addEventListener('click', () => {
  const code = (joinCode.value||'').toUpperCase().trim();
  const name = (joinName.value||'').trim();
  socket.emit('room:join', { code, name }, (res) => {
    if (!res || !res.ok) {
      joinResult.textContent = res?.error || 'Unable to join';
      return;
    }
    my.role = res.role;
    my.code = res.code;
    my.name = res.name;
    joinResult.textContent = `Joined as ${res.role}: ${res.name}`;
    startGameUI();
  });
});

// Lobby updates
socket.on('lobby:update', ({ players, spectators }) => {
  playerList.innerHTML = players.map(p=>`<li>${p.name}</li>`).join('');
  spectatorList.innerHTML = spectators.map(s=>`<li>${s.name}</li>`).join('');
});

// Teacher start
btnStartGame.addEventListener('click', () => {
  const filters = $$('input[type=checkbox]:checked').map(c=>c.value);
  const roundsAutoEnd = parseInt(autoRounds.value, 10);
  socket.emit('game:start', { code: my.code, filters, roundsAutoEnd: Number.isInteger(roundsAutoEnd) ? roundsAutoEnd : undefined }, (res)=>{
    if (!res || !res.ok) alert(res?.error || 'Cannot start');
  });
});
btnStopGame.addEventListener('click', () => {
  socket.emit('game:stop', { code: my.code });
});

// Teacher upload terms
btnUploadTerms.addEventListener('click', () => {
  try {
    const parsed = JSON.parse(termsJson.value || '[]');
    socket.emit('terms:replace', { code: my.code, terms: parsed }, (res)=>{
      if (res?.ok) termUploadResult.textContent = `Uploaded ${res.count} terms.`;
      else termUploadResult.textContent = res?.error || 'Upload failed';
    });
  } catch(e) {
    termUploadResult.textContent = 'Invalid JSON';
  }
});

// Round assign drawer
socket.on('round:assignDrawer', ({ drawerId }) => {
  my.isDrawer = (socket.id === drawerId);
  text(roleEl, my.isDrawer ? 'Drawer' : (my.role==='teacher' ? 'Teacher' : 'Guesser'));
  // Only drawer sees options
  show(drawerOptions, my.isDrawer);
  show(tools, my.isDrawer || my.role==='teacher'); // teacher can clear
  show(btnClear, my.isDrawer || my.role==='teacher');
});

// Drawer sees options
socket.on('round:presentOptions', ({ options }) => {
  optionButtons.innerHTML = '';
  options.forEach(o => {
    const btn = document.createElement('button');
    btn.textContent = o.term;
    btn.addEventListener('click', () => {
      socket.emit('round:selectTerm', { code: my.code, termId: o.id }, (res)=>{});
      show(drawerOptions, false);
      // Drawer can start drawing now
    });
    optionButtons.appendChild(btn);
  });
});

socket.on('round:start', ({ roundNumber, seconds }) => {
  text(roundNum, roundNumber);
  text(timerEl, seconds);
  show(game, true);
  show($('#auth'), false);
  guessStream.innerHTML = '';
  termReveal.classList.add('hidden');
  guessInput.value='';
  ctx.clearRect(0,0,canvas.width, canvas.height);
  // Only guessers see guess box
  show(guessBox, (!my.isDrawer && my.role!=='teacher'));
});

socket.on('round:tick', ({ remaining }) => {
  text(timerEl, remaining);
});

socket.on('round:correct', ({ guesserId, termOfficial, secondsRemaining, pointsAwarded }) => {
  text(timerEl, 0);
  show(guessBox, false);
  show(tools, false);
  termReveal.textContent = `Correct: ${termOfficial}`;
  termReveal.classList.remove('hidden');
});

socket.on('round:timeout', ({ termOfficial }) => {
  show(guessBox, false);
  show(tools, false);
  termReveal.textContent = `Time! Term was: ${termOfficial}`;
  termReveal.classList.remove('hidden');
});

socket.on('game:stop', ({ reason }) => {
  alert(`Game ended (${reason}).`);
  window.location.reload();
});

// Guess stream & submission
socket.on('guess:stream', ({ from, text }) => {
  const div = document.createElement('div');
  div.textContent = `${from}: ${text}`;
  guessStream.appendChild(div);
  guessStream.scrollTop = guessStream.scrollHeight;
});

btnGuess.addEventListener('click', submitGuess);
guessInput.addEventListener('keydown', (e)=>{ if (e.key==='Enter') submitGuess(); });
function submitGuess() {
  if (my.isDrawer || my.role==='teacher') return;
  const text = guessInput.value.trim();
  if (!text) return;
  socket.emit('guess:submit', { code: my.code, text }, (res)=>{
    if (res && !res.ok) {
      // throttled
    }
  });
  guessInput.value='';
}

// Leaderboard
socket.on('leaderboard:update', ({ standings }) => {
  leaderboard.innerHTML = '';
  standings.forEach(s => {
    const li = document.createElement('li');
    li.textContent = `${s.name} — ${s.points}`;
    leaderboard.appendChild(li);
  });
});

function startGameUI() {
  show(game, true);
  show($('#auth'), false);
}
