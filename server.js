import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

const PORT = process.env.PORT || 3000;

// Static files
app.use(express.static(path.join(process.cwd(), 'public')));
app.use(express.json({ limit: '1mb' }));

// Load sample terms on boot (rooms can replace via teacher upload)
let defaultTerms = [];
try {
  const sample = fs.readFileSync(path.join(process.cwd(), 'terms.sample.json'), 'utf-8');
  defaultTerms = JSON.parse(sample);
} catch (e) {
  console.warn('Could not load terms.sample.json, starting with empty terms.');
}

// --- Utilities ---
function roomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/1
  let code = '';
  for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random()*alphabet.length)];
  return code;
}

function normalize(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Simple Levenshtein distance
function levenshtein(a, b) {
  a = normalize(a);
  b = normalize(b);
  const m = a.length, n = b.length;
  const dp = Array.from({length: m+1}, () => new Array(n+1).fill(0));
  for (let i=0;i<=m;i++) dp[i][0] = i;
  for (let j=0;j<=n;j++) dp[0][j] = j;
  for (let i=1;i<=m;i++) {
    for (let j=1;j<=n;j++) {
      const cost = a[i-1]===b[j-1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i-1][j] + 1,
        dp[i][j-1] + 1,
        dp[i-1][j-1] + cost
      );
    }
  }
  return dp[m][n];
}

function isMatch(guess, termObj) {
  const g = normalize(guess);
  const t = normalize(termObj.term);
  if (!g) return false;
  if (g === t) return true;
  if (Array.isArray(termObj.aliases)) {
    for (const a of termObj.aliases) if (normalize(a) === g) return true;
  }
  // fuzzy: normalized distance <= 0.2
  const dist = levenshtein(g, t);
  const maxlen = Math.max(g.length, t.length) || 1;
  const norm = dist / maxlen;
  return norm <= 0.2;
}

function pick3(arr) {
  const copy = [...arr];
  const out = [];
  for (let i=0;i<3 && copy.length>0;i++) {
    const idx = Math.floor(Math.random()*copy.length);
    out.push(copy.splice(idx,1)[0]);
  }
  return out;
}

// Simple profanity list (expandable)
const BAD_WORDS = ['fuck','shit','bitch','cunt','asshole','dick','bastard','slut','whore'];
function sanitizeGuess(t) {
  const lower = (t||'').toLowerCase();
  for (const w of BAD_WORDS) {
    if (lower.includes(w)) return '[redacted]';
  }
  return t;
}

// --- Room State ---
/**
 * rooms[code] = {
 *   code,
 *   teacher: socketId,
 *   players: [{id, name, points}],
 *   spectators: [{id, name}],
 *   lastDrawerId,
 *   current: {
 *     drawerId,
 *     termId,
 *     endsAt: epoch_ms
 *   },
 *   terms: Term[],
 *   filters: TopicTag[],
 *   roundsAutoEnd?: number,
 *   roundNumber: number,
 *   guessRate: Map<socketId, {count, windowStartMs}>
 * }
 */
const rooms = Object.create(null);

function computePool(terms, filters) {
  if (!filters || filters.length===0) return terms;
  // If filter includes 'U3', it's shorthand: include U3AOS1 + U3AOS2 as well, similarly for U4
  const expanded = new Set(filters);
  if (filters.includes('U3')) { expanded.add('U3AOS1'); expanded.add('U3AOS2'); }
  if (filters.includes('U4')) { expanded.add('U4AOS1'); expanded.add('U4AOS2'); }
  return terms.filter(t => (t.topicTags||[]).some(tag => expanded.has(tag)));
}

function nextDrawerId(room) {
  const ids = room.players.map(p=>p.id);
  if (ids.length < 2) return null;
  let candidates = ids;
  if (room.lastDrawerId && ids.length > 1) {
    candidates = ids.filter(id => id !== room.lastDrawerId);
    if (candidates.length === 0) candidates = ids; // fallback
  }
  return candidates[Math.floor(Math.random()*candidates.length)];
}

function broadcastLeaderboard(room) {
  const standings = room.players
    .map(p => ({playerId: p.id, name: p.name, points: p.points}))
    .sort((a,b)=> b.points - a.points || a.name.localeCompare(b.name));
  io.to(`room:${room.code}`).emit('leaderboard:update', { standings });
}

function stopGame(room, reason='manual') {
  room.current = null;
  io.to(`room:${room.code}`).emit('game:stop', { reason });
}

// --- Socket.IO ---
io.on('connection', (socket) => {
  // Create room (teacher)
  socket.on('room:create', (_, ack) => {
    const code = roomCode();
    rooms[code] = {
      code,
      teacher: socket.id,
      players: [],
      spectators: [],
      lastDrawerId: null,
      current: null,
      terms: JSON.parse(JSON.stringify(defaultTerms)),
      filters: [],
      roundNumber: 0,
      roundsAutoEnd: undefined,
      guessRate: new Map()
    };
    socket.join(`room:${code}`);
    if (ack) ack({ code });
  });

  // Join room (student)
  socket.on('room:join', ({ code, name }, ack) => {
    const room = rooms[code];
    if (!room) return ack && ack({ ok:false, error:'Room not found' });
    const total = room.players.length + room.spectators.length + 1;
    if (total > 30) return ack && ack({ ok:false, error:'Room full (30)' });

    // dedupe name
    let finalName = (name || '').trim();
    if (!finalName) finalName = 'Player';
    const existing = new Set(room.players.map(p=>p.name).concat(room.spectators.map(s=>s.name)));
    if (existing.has(finalName)) {
      let i=2;
      while (existing.has(`${finalName}(${i})`)) i++;
      finalName = `${finalName}(${i})`;
    }

    socket.join(`room:${code}`);

    // Before game start: everyone is a player. After start, late joiners are spectators.
    const isActive = !!room.current || room.roundNumber>0;
    if (isActive) {
      room.spectators.push({ id: socket.id, name: finalName });
      io.to(`room:${code}`).emit('lobby:update', {
        players: room.players.map(p=>({id:p.id,name:p.name})),
        spectators: room.spectators.map(s=>({id:s.id,name:s.name}))
      });
      return ack && ack({ ok:true, role:'spectator', code, name: finalName });
    } else {
      room.players.push({ id: socket.id, name: finalName, points: 0, isDrawer:false });
      io.to(`room:${code}`).emit('lobby:update', {
        players: room.players.map(p=>({id:p.id,name:p.name})),
        spectators: room.spectators.map(s=>({id:s.id,name:s.name}))
      });
      return ack && ack({ ok:true, role:'player', code, name: finalName });
    }
  });

  // Teacher sets filters / rounds / start
  socket.on('game:start', ({ code, filters, roundsAutoEnd }, ack) => {
    const room = rooms[code];
    if (!room || room.teacher !== socket.id) return;
    if (room.players.length < 2) return ack && ack({ ok:false, error:'Need at least 2 players' });
    room.filters = Array.isArray(filters) ? filters : [];
    room.roundsAutoEnd = Number.isInteger(roundsAutoEnd) && roundsAutoEnd>0 ? roundsAutoEnd : undefined;
    room.roundNumber = 0;
    startRound(room);
    if (ack) ack({ ok:true });
  });

  function startRound(room) {
    room.roundNumber += 1;
    const drawerId = nextDrawerId(room);
    if (!drawerId) {
      stopGame(room, 'not-enough-players');
      return;
    }
    for (const p of room.players) p.isDrawer = (p.id === drawerId);
    room.current = { drawerId, termId: null, endsAt: null };

    io.to(`room:${room.code}`).emit('round:assignDrawer', { drawerId });

    // present options to drawer
    const pool = computePool(room.terms, room.filters);
    if (pool.length === 0) {
      stopGame(room, 'no-terms');
      return;
    }
    const options = pick3(pool).map(t => ({ id: t.id, term: t.term }));
    io.to(drawerId).emit('round:presentOptions', { options });
  }

  // Drawer selects term
  socket.on('round:selectTerm', ({ code, termId }, ack) => {
    const room = rooms[code];
    if (!room || !room.current) return;
    if (room.current.drawerId !== socket.id) return;
    const t = (room.terms||[]).find(x=>x.id===termId);
    if (!t) return;
    room.current.termId = termId;
    const endsAt = Date.now() + 30000; // 30s
    room.current.endsAt = endsAt;
    io.to(`room:${room.code}`).emit('round:start', { roundNumber: room.roundNumber, seconds: 30 });
    // ticker
    const interval = setInterval(() => {
      if (!room.current || room.current.termId !== termId) { clearInterval(interval); return; }
      const remaining = Math.max(0, Math.ceil((endsAt - Date.now())/1000));
      io.to(`room:${room.code}`).emit('round:tick', { remaining });
      if (remaining <= 0) {
        clearInterval(interval);
        // timeout
        const term = (room.terms||[]).find(x=>x.id===room.current.termId);
        io.to(`room:${room.code}`).emit('round:timeout', { termOfficial: term ? term.term : 'Term' });
        room.lastDrawerId = room.current.drawerId;
        room.current = null;
        setTimeout(() => {
          // auto end if reached roundsAutoEnd
          if (room.roundsAutoEnd && room.roundNumber >= room.roundsAutoEnd) {
            stopGame(room, 'autoEnd');
          } else {
            startRound(room);
          }
        }, 1500);
      }
    }, 500);
    if (ack) ack({ ok:true });
  });

  // Drawing strokes
  socket.on('draw:stroke', ({ code, stroke }, ack) => {
    const room = rooms[code];
    if (!room || !room.current) return;
    if (socket.id !== room.current.drawerId) return; // only drawer
    // broadcast to room
    io.to(`room:${code}`).emit('draw:stroke', { stroke });
  });
  socket.on('canvas:clear', ({ code }) => {
    const room = rooms[code];
    if (!room || !room.current) return;
    if (socket.id !== room.current.drawerId && socket.id !== room.teacher) return;
    io.to(`room:${code}`).emit('canvas:clear');
  });

  // Guess submission with throttling and profanity filter
  socket.on('guess:submit', ({ code, text }, ack) => {
    const room = rooms[code];
    if (!room || !room.current) return;
    if (socket.id === room.current.drawerId) return; // drawer cannot guess
    const player = room.players.find(p=>p.id===socket.id);
    if (!player) return;

    // Throttle: 3 guesses per second with small burst (5)
    const now = Date.now();
    let rate = room.guessRate.get(socket.id);
    if (!rate || now - rate.windowStartMs > 1000) {
      rate = { count:0, windowStartMs: now };
    }
    rate.count += 1;
    room.guessRate.set(socket.id, rate);
    if (rate.count > 5) { // hard burst cap
      if (ack) ack({ ok:false, error:'Slow down' });
      return;
    }

    const safeText = sanitizeGuess(text);
    io.to(`room:${code}`).emit('guess:stream', { from: player.name, text: safeText });

    if (safeText === '[redacted]') return; // do not evaluate

    // match
    const term = (room.terms||[]).find(x=>x.id===room.current.termId);
    if (!term) return;

    if (isMatch(text, term)) {
      // lock round
      const remaining = Math.max(0, Math.ceil((room.current.endsAt - Date.now())/1000));
      // scoring
      const drawer = room.players.find(p=>p.id===room.current.drawerId);
      if (drawer) drawer.points += remaining;
      player.points += remaining;
      broadcastLeaderboard(room);

      io.to(`room:${code}`).emit('round:correct', {
        guesserId: socket.id,
        termOfficial: term.term,
        secondsRemaining: remaining,
        pointsAwarded: remaining
      });
      room.lastDrawerId = room.current.drawerId;
      room.current = null;
      setTimeout(() => {
        if (room.roundsAutoEnd && room.roundNumber >= room.roundsAutoEnd) {
          stopGame(room, 'autoEnd');
        } else {
          startRound(room);
        }
      }, 1500);
    }
    if (ack) ack({ ok:true });
  });

  // Teacher can stop game
  socket.on('game:stop', ({ code }) => {
    const room = rooms[code];
    if (!room || room.teacher !== socket.id) return;
    stopGame(room, 'manual');
  });

  // Teacher replace terms for this room (session-only)
  socket.on('terms:replace', ({ code, terms }, ack) => {
    const room = rooms[code];
    if (!room || room.teacher !== socket.id) return ack && ack({ ok:false, error:'Not teacher or room missing' });
    if (!Array.isArray(terms)) return ack && ack({ ok:false, error:'Terms must be an array' });
    // basic validation
    const cleaned = terms.map(t => ({
      id: String(t.id || crypto.randomUUID()),
      term: String(t.term || '').trim(),
      topicTags: Array.isArray(t.topicTags) ? t.topicTags.filter(Boolean) : [],
      aliases: Array.isArray(t.aliases) ? t.aliases.filter(Boolean) : []
    })).filter(t => t.term && t.topicTags.length>0);
    room.terms = cleaned;
    if (ack) ack({ ok:true, count: cleaned.length });
  });

  // Disconnect cleanup
  socket.on('disconnect', () => {
    for (const code of Object.keys(rooms)) {
      const room = rooms[code];
      if (!room) continue;
      if (room.teacher === socket.id) {
        // End the room
        io.to(`room:${code}`).emit('game:stop', { reason: 'teacher-disconnected' });
        delete rooms[code];
        continue;
      }
      const pIdx = room.players.findIndex(p=>p.id===socket.id);
      if (pIdx >= 0) {
        room.players.splice(pIdx,1);
      } else {
        const sIdx = room.spectators.findIndex(s=>s.id===socket.id);
        if (sIdx >= 0) room.spectators.splice(sIdx,1);
      }
      io.to(`room:${code}`).emit('lobby:update', {
        players: room.players.map(p=>({id:p.id,name:p.name})),
        spectators: room.spectators.map(s=>({id:s.id,name:s.name}))
      });
    }
  });
});

httpServer.listen(PORT, () => {
  console.log('Server listening on http://localhost:'+PORT);
});
