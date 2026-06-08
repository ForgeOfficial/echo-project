const express = require('express');
const prisma = require('../services/prisma');

const router = express.Router();

router.get('/leaderboard', async (req, res) => {
  const users = await prisma.user.findMany({
    orderBy: { elo: 'desc' },
    take: 100,
    select: { id: true, pseudo: true, elo: true, wins: true, losses: true, draws: true },
  });
  res.json(users);
});

router.get('/profile/:pseudo', async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { pseudoLower: req.params.pseudo.toLowerCase() },
    select: { id: true, pseudo: true, elo: true, wins: true, losses: true, draws: true },
  });
  if (!user) return res.status(404).json({ error: 'Joueur introuvable' });

  const rawMatches = await prisma.match.findMany({
    where: { OR: [{ player1Id: user.id }, { player2Id: user.id }] },
    orderBy: { createdAt: 'desc' },
    take: 20,
    include: {
      player1: { select: { pseudo: true } },
      player2: { select: { pseudo: true } },
    },
  });

  const matches = rawMatches.map(m => {
    const isP1 = m.player1Id === user.id;
    const opponent = isP1 ? m.player2.pseudo : m.player1.pseudo;
    const eloDelta = isP1 ? m.player1EloDelta : m.player2EloDelta;
    const shots = isP1 ? m.player1Shots : m.player2Shots;
    const hits = isP1 ? m.player1Hits : m.player2Hits;
    const accuracy = shots > 0 ? Math.round(hits / shots * 100) : 0;
    let result = 'D';
    if (m.winnerId === user.id) result = 'W';
    else if (m.winnerId !== null && m.winnerId !== user.id) result = 'L';
    return { opponent, eloDelta, accuracy, result, createdAt: m.createdAt };
  });

  res.json({ ...user, matches });
});

router.get('/online', (req, res) => {
  res.json({ count: 0 });
});

module.exports = router;
