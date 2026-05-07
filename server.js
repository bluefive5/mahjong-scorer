const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const HISTORY_FILE = path.join(__dirname, 'history.json');
const rooms = {};

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    }
  } catch (e) { /* ignore */ }
  return [];
}

function saveHistory(entry) {
  const history = loadHistory();
  history.unshift(entry);
  if (history.length > 100) history.length = 100;
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

app.get('/api/history', (_req, res) => {
  res.json(loadHistory());
});

const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function genCode() {
  let code = '';
  for (let i = 0; i < 4; i++) code += CHARS[Math.floor(Math.random() * CHARS.length)];
  return rooms[code] ? genCode() : code;
}

io.on('connection', (socket) => {
  console.log(`[连接] ${socket.id}`);

  socket.on('create_room', ({ playerName, maxPlayers, baseMoney }) => {
    if (!playerName || !playerName.trim()) return socket.emit('error_msg', '请输入名字');
    const code = genCode();
    rooms[code] = {
      id: code,
      owner: socket.id,
      maxPlayers: Math.min(Math.max(maxPlayers || 4, 2), 6),
      baseMoney: baseMoney || 1,
      players: [{ id: socket.id, name: playerName.trim(), score: 0, connected: true }],
      rounds: [],
      state: 'lobby',
      createdAt: Date.now(),
    };
    socket.join(code);
    socket.emit('room_created', rooms[code]);
    console.log(`[创建房间] ${code} by ${playerName}`);
  });

  socket.on('join_room', ({ roomCode, playerName }) => {
    if (!playerName || !playerName.trim()) return socket.emit('error_msg', '请输入名字');
    const code = roomCode.toUpperCase().trim();
    const room = rooms[code];
    if (!room) return socket.emit('error_msg', '房间不存在');
    if (room.state !== 'lobby') return socket.emit('error_msg', '游戏已开始，无法加入');

    const existing = room.players.find(p => p.name === playerName.trim());
    if (existing && !existing.connected) {
      existing.id = socket.id;
      existing.connected = true;
      socket.join(code);
      socket.emit('room_joined', room);
      socket.to(code).emit('room_updated', room);
      console.log(`[重连] ${playerName} → ${code}`);
      return;
    }
    if (existing) return socket.emit('error_msg', '该名字已被使用，换个名字试试');

    if (room.players.length >= room.maxPlayers) return socket.emit('error_msg', '房间已满');

    room.players.push({ id: socket.id, name: playerName.trim(), score: 0, connected: true });
    socket.join(code);
    socket.emit('room_joined', room);
    socket.to(code).emit('room_updated', room);
    console.log(`[加入] ${playerName} → ${code}`);
  });

  socket.on('update_config', ({ roomCode, maxPlayers, baseMoney }) => {
    const room = rooms[roomCode];
    if (!room || room.owner !== socket.id) return;
    if (room.state !== 'lobby') return;
    if (maxPlayers) room.maxPlayers = Math.min(Math.max(maxPlayers, 2), 6);
    if (baseMoney != null) room.baseMoney = baseMoney;
    io.to(roomCode).emit('room_updated', room);
  });

  socket.on('start_game', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.owner !== socket.id) return;
    if (room.players.length < 2) return socket.emit('error_msg', '至少需要2人才能开始');
    room.state = 'playing';
    room.currentRound = 1;
    room.players.forEach(p => { p.score = 0; });
    io.to(roomCode).emit('game_started', room);
    console.log(`[开始游戏] ${roomCode}`);
  });

  socket.on('submit_round', ({ roomCode, deltas }) => {
    const room = rooms[roomCode];
    if (!room || room.state !== 'playing') return;

    // deltas: { playerId: number } — round score changes
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    for (const p of room.players) {
      if (deltas[p.id] === undefined) return socket.emit('error_msg', '所有玩家都需要有本轮分数');
    }
    let sum = 0;
    for (const [pid, val] of Object.entries(deltas)) {
      const p = room.players.find(pp => pp.id === pid);
      if (!p) return socket.emit('error_msg', '玩家数据异常');
      sum += val;
    }
    if (Math.abs(sum) > 0.001) return socket.emit('error_msg', '本轮分数总和必须为0');

    const round = {
      number: room.currentRound,
      deltas: { ...deltas },
      submitter: player.name,
      time: Date.now(),
    };

    for (const [pid, delta] of Object.entries(deltas)) {
      const p = room.players.find(pp => pp.id === pid);
      if (p) p.score = Math.round((p.score + delta) * 100) / 100;
    }

    room.rounds.push(round);
    room.currentRound++;
    room.scoreSubmittedBy = null;

    io.to(roomCode).emit('round_completed', { round, room });
    console.log(`[提交回合] ${roomCode} 第${round.number}局 by ${player.name}`);
  });

  socket.on('undo_round', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.owner !== socket.id) return;
    if (room.state !== 'playing' || room.rounds.length === 0) return;

    const last = room.rounds.pop();
    for (const [pid, delta] of Object.entries(last.deltas)) {
      const p = room.players.find(pp => pp.id === pid);
      if (p) p.score = Math.round((p.score - delta) * 100) / 100;
    }
    room.currentRound--;

    io.to(roomCode).emit('round_undone', { room, undoneRound: last.number });
    console.log(`[撤销] ${roomCode} 第${last.number}局`);
  });

  socket.on('end_game', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.owner !== socket.id) return;
    room.state = 'finished';
    room.endedAt = Date.now();

    const summary = room.players
      .map(p => ({ name: p.name, score: p.score, money: Math.round(p.score * room.baseMoney * 100) / 100 }))
      .sort((a, b) => b.score - a.score);

    const historyEntry = {
      roomCode,
      date: new Date().toISOString(),
      players: summary,
      rounds: room.rounds.length,
      baseMoney: room.baseMoney,
    };
    saveHistory(historyEntry);

    io.to(roomCode).emit('game_ended', { room, summary, historyEntry });
    console.log(`[游戏结束] ${roomCode}`);
  });

  socket.on('back_to_lobby', ({ roomCode }) => {
    // keep same players, reset scores, start again
  });

  socket.on('disconnect', () => {
    console.log(`[断开] ${socket.id}`);
    for (const [code, room] of Object.entries(rooms)) {
      const player = room.players.find(p => p.id === socket.id);
      if (player) {
        player.connected = false;
        io.to(code).emit('player_disconnected', { playerName: player.name });

        const stillConnected = room.players.some(p => p.connected);
        if (!stillConnected) {
          setTimeout(() => {
            const r = rooms[code];
            if (r && !r.players.some(p => p.connected)) {
              delete rooms[code];
              console.log(`[清理房间] ${code}`);
            }
          }, 10 * 60 * 1000);
        } else if (room.owner === socket.id) {
          room.owner = room.players.find(p => p.connected)?.id || room.owner;
          io.to(code).emit('room_updated', room);
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3456;
server.listen(PORT, () => {
  const os = require('os');
  const ifaces = os.networkInterfaces();
  const addrs = [];
  for (const [name, nets] of Object.entries(ifaces)) {
    for (const net of nets) {
      if (net.family === 'IPv4' && !net.internal) addrs.push(net.address);
    }
  }
  console.log(`🀄 麻将记分器运行在 http://localhost:${PORT}`);
  for (const addr of addrs) {
    console.log(`   局域网访问: http://${addr}:${PORT}`);
  }
});

// 定时清理超过1小时的空房间
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of Object.entries(rooms)) {
    if (!room.players.some(p => p.connected) && now - room.createdAt > 3600000) {
      delete rooms[code];
    }
  }
}, 60000);
