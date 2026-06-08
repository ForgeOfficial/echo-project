const prisma = require('./prisma');
const { ELO } = require('../../../shared/constants');

function calculateElo(elo1, elo2, winnerIndex) {
  const expected1 = 1 / (1 + Math.pow(10, (elo2 - elo1) / 400));
  const expected2 = 1 - expected1;
  let score1, score2;
  if (winnerIndex === 0) { score1 = 1; score2 = 0; }
  else if (winnerIndex === 1) { score1 = 0; score2 = 1; }
  else { score1 = 0.5; score2 = 0.5; }
  const k1 = elo1 < ELO.K_THRESHOLD ? ELO.K_LOW : ELO.K_HIGH;
  const k2 = elo2 < ELO.K_THRESHOLD ? ELO.K_LOW : ELO.K_HIGH;
  const delta1 = Math.round(k1 * (score1 - expected1));
  const delta2 = Math.round(k2 * (score2 - expected2));
  return [delta1, delta2];
}

async function saveMatchResult(data) {
  const { player1Id, player2Id, winnerId, player1EloDelta, player2EloDelta, ...rest } = data;

  await prisma.$transaction([
    prisma.match.create({
      data: { player1Id, player2Id, winnerId, player1EloDelta, player2EloDelta, ...rest },
    }),
    prisma.user.update({
      where: { id: player1Id },
      data: {
        elo: { increment: player1EloDelta },
        ...(winnerId === player1Id ? { wins: { increment: 1 } } : {}),
        ...(winnerId === player2Id ? { losses: { increment: 1 } } : {}),
        ...(winnerId === null ? { draws: { increment: 1 } } : {}),
      },
    }),
    prisma.user.update({
      where: { id: player2Id },
      data: {
        elo: { increment: player2EloDelta },
        ...(winnerId === player2Id ? { wins: { increment: 1 } } : {}),
        ...(winnerId === player1Id ? { losses: { increment: 1 } } : {}),
        ...(winnerId === null ? { draws: { increment: 1 } } : {}),
      },
    }),
  ]);
}

module.exports = { calculateElo, saveMatchResult };
