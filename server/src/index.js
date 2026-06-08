require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const authRoutes = require('./routes/auth');
const gameRoutes = require('./routes/game');
const { setupSocketHandlers } = require('./game/socketHandler');

const ALLOWED_ORIGINS = (process.env.CLIENT_URL || 'http://localhost:3000')
  .split(',')
  .map(o => o.trim())
  .concat(['http://localhost:3000', 'http://localhost:5500']);

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) cb(null, true);
    else cb(new Error('CORS not allowed'));
  },
  credentials: true,
};

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: corsOptions });

app.use(cors(corsOptions));
app.use(express.json());
app.use(cookieParser());

app.use('/auth', authRoutes);
app.use('/api', gameRoutes);

app.get('/health', (req, res) => res.json({ ok: true }));

setupSocketHandlers(io);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`ECHO server running on port ${PORT}`));
