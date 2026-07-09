const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// ─── Game State ────────────────────────────────────────────────────────────────
const COLORS = ['#FF4757', '#1E90FF', '#2ED573', '#FFA502'];

const state = {
  players: [
    { name: 'Player 1', score: 0, color: COLORS[0] },
    { name: 'Player 2', score: 0, color: COLORS[1] },
    { name: 'Player 3', score: 0, color: COLORS[2] },
    { name: 'Player 4', score: 0, color: COLORS[3] },
  ],
  question: '',
  timer: { duration: 60, remaining: 60, running: false },
  voting: { open: false, votes: [0, 0, 0, 0], round: 1 },
  _voterIds: new Set(),   // server-side only, not sent to clients
};

let timerInterval = null;

// ─── Helpers ───────────────────────────────────────────────────────────────────
function publicState() {
  return {
    players: state.players,
    question: state.question,
    timer: state.timer,
    voting: {
      open: state.voting.open,
      votes: state.voting.votes,
      total: state._voterIds.size,
      round: state.voting.round,
    },
  };
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  });
}

function broadcastState() {
  broadcast({ type: 'STATE', data: publicState() });
}

function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  state.timer.running = false;
}

// ─── WebSocket Messages ────────────────────────────────────────────────────────
wss.on('connection', ws => {
  // Send current state immediately on connect
  ws.send(JSON.stringify({ type: 'STATE', data: publicState() }));

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'SET_PLAYER_NAME':
        if (msg.index >= 0 && msg.index < 4) {
          state.players[msg.index].name = String(msg.name).slice(0, 40);
          broadcastState();
        }
        break;

      case 'SET_QUESTION':
        state.question = String(msg.question || '').slice(0, 600);
        broadcastState();
        break;

      case 'SET_TIMER_DURATION':
        stopTimer();
        state.timer.duration = Math.max(5, Math.min(600, Number(msg.duration) || 60));
        state.timer.remaining = state.timer.duration;
        broadcastState();
        break;

      case 'START_TIMER':
        if (!state.timer.running && state.timer.remaining > 0) {
          state.timer.running = true;
          timerInterval = setInterval(() => {
            if (state.timer.remaining > 0) {
              state.timer.remaining--;
              broadcastState();
            } else {
              stopTimer();
              broadcastState();
            }
          }, 1000);
          broadcastState();
        }
        break;

      case 'PAUSE_TIMER':
        stopTimer();
        broadcastState();
        break;

      case 'RESET_TIMER':
        stopTimer();
        state.timer.remaining = state.timer.duration;
        broadcastState();
        break;

      case 'OPEN_VOTING':
        state.voting.open = true;
        broadcastState();
        break;

      case 'CLOSE_VOTING':
        state.voting.open = false;
        broadcastState();
        break;

      case 'RESET_VOTES':
        state.voting.votes = [0, 0, 0, 0];
        state.voting.round++;
        state._voterIds.clear();
        broadcastState();
        break;

      case 'ADJUST_SCORE':
        if (msg.index >= 0 && msg.index < 4) {
          state.players[msg.index].score = Math.max(0,
            state.players[msg.index].score + (Number(msg.delta) || 0));
          broadcastState();
        }
        break;

      case 'RESET_SCORES':
        state.players.forEach(p => { p.score = 0; });
        broadcastState();
        break;

      // ── Audience vote ────────────────────────────────────────────────────────
      case 'VOTE':
        if (!state.voting.open) {
          ws.send(JSON.stringify({ type: 'VOTE_RESULT', success: false, message: 'Voting is not open.' }));
          return;
        }
        if (state._voterIds.has(msg.voterId)) {
          ws.send(JSON.stringify({ type: 'VOTE_RESULT', success: false, message: 'already_voted' }));
          return;
        }
        if (msg.playerIndex < 0 || msg.playerIndex >= 4) return;
        state._voterIds.add(msg.voterId);
        state.voting.votes[msg.playerIndex]++;
        ws.send(JSON.stringify({ type: 'VOTE_RESULT', success: true, playerIndex: msg.playerIndex }));
        broadcastState();
        break;
    }
  });
});

// ─── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  let localIP = 'localhost';
  outer: for (const n of Object.values(nets)) {
    for (const i of n) {
      if (i.family === 'IPv4' && !i.internal) { localIP = i.address; break outer; }
    }
  }

  console.log('\n🎮  Game Show Server Running!\n');
  console.log(`  📺  Display (big screen) → http://localhost:${PORT}/display.html`);
  console.log(`  🎛️   Host controls        → http://localhost:${PORT}/host.html`);
  console.log(`  📱  Voter link (phones)   → http://${localIP}:${PORT}/vote.html`);
  console.log('\n  Share the Voter link with your audience (same WiFi network).\n');
});
