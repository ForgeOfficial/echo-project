const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const prisma = require('../services/prisma');
const { authenticate } = require('../middleware/authenticate');

const router = express.Router();
const BCRYPT_ROUNDS = 12;
const ACCESS_TTL = '15m';
// Les invités n'ont pas de refresh token : leur access token doit vivre assez
// longtemps pour survivre à un rechargement de page en pleine partie.
const GUEST_TTL = '12h';
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function signAccess(userId, pseudo) {
  return jwt.sign({ userId, pseudo }, process.env.JWT_SECRET, { expiresIn: ACCESS_TTL });
}

function setCookieRefresh(res, token) {
  res.cookie('refreshToken', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: REFRESH_TTL_MS,
  });
}

router.post('/register', async (req, res) => {
  const { pseudo, password } = req.body;
  if (!pseudo || !/^[a-zA-Z0-9_]{3,20}$/.test(pseudo)) {
    return res.status(400).json({ error: 'Pseudo invalide (3-20 caractères, lettres/chiffres/_)' });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères' });
  }
  const existing = await prisma.user.findUnique({ where: { pseudoLower: pseudo.toLowerCase() } });
  if (existing) return res.status(409).json({ error: 'Ce pseudo est déjà utilisé' });

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const user = await prisma.user.create({
    data: { pseudo, pseudoLower: pseudo.toLowerCase(), passwordHash },
  });

  const accessToken = signAccess(user.id, user.pseudo);
  const rawRefresh = crypto.randomBytes(40).toString('hex');
  await prisma.refreshToken.create({
    data: { token: rawRefresh, userId: user.id, expiresAt: new Date(Date.now() + REFRESH_TTL_MS) },
  });
  setCookieRefresh(res, rawRefresh);
  res.status(201).json({ accessToken, user: { id: user.id, pseudo: user.pseudo, elo: user.elo } });
});

router.post('/login', async (req, res) => {
  const { pseudo, password } = req.body;
  if (!pseudo || !password) return res.status(400).json({ error: 'Champs requis' });

  const user = await prisma.user.findUnique({ where: { pseudoLower: pseudo.toLowerCase() } });
  if (!user) return res.status(401).json({ error: 'Identifiants incorrects' });

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) return res.status(401).json({ error: 'Identifiants incorrects' });

  const accessToken = signAccess(user.id, user.pseudo);
  const rawRefresh = crypto.randomBytes(40).toString('hex');
  await prisma.refreshToken.create({
    data: { token: rawRefresh, userId: user.id, expiresAt: new Date(Date.now() + REFRESH_TTL_MS) },
  });
  setCookieRefresh(res, rawRefresh);
  res.json({ accessToken, user: { id: user.id, pseudo: user.pseudo, elo: user.elo } });
});

// Jeu sans compte : on signe un token éphémère porteur d'un userId préfixé
// « guest: » (jamais en base). Aucun mot de passe, aucun refresh token, aucune
// écriture DB. Le flag `guest` permet au reste du jeu de l'identifier.
router.post('/guest', async (req, res) => {
  const { pseudo } = req.body;
  if (!pseudo || !/^[a-zA-Z0-9_]{3,20}$/.test(pseudo)) {
    return res.status(400).json({ error: 'Pseudo invalide (3-20 caractères, lettres/chiffres/_)' });
  }
  const userId = `guest:${crypto.randomUUID()}`;
  const accessToken = jwt.sign({ userId, pseudo, guest: true }, process.env.JWT_SECRET, { expiresIn: GUEST_TTL });
  res.json({ accessToken, user: { id: userId, pseudo, elo: 1000, guest: true } });
});

router.post('/refresh', async (req, res) => {
  const token = req.cookies.refreshToken;
  if (!token) return res.status(401).json({ error: 'No refresh token' });

  const stored = await prisma.refreshToken.findUnique({ where: { token } });
  if (!stored || stored.revoked || stored.expiresAt < new Date()) {
    return res.status(401).json({ error: 'Refresh token invalide ou expiré' });
  }
  const user = await prisma.user.findUnique({ where: { id: stored.userId } });
  const accessToken = signAccess(user.id, user.pseudo);
  res.json({ accessToken, user: { id: user.id, pseudo: user.pseudo, elo: user.elo } });
});

router.post('/logout', async (req, res) => {
  const token = req.cookies.refreshToken;
  if (token) {
    await prisma.refreshToken.updateMany({ where: { token }, data: { revoked: true } });
  }
  res.clearCookie('refreshToken');
  res.json({ ok: true });
});

router.get('/me', authenticate, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { id: true, pseudo: true, elo: true, wins: true, losses: true, draws: true },
  });
  res.json(user);
});

module.exports = router;
