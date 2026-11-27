import {
    assertCreditsStayHonest,
    getSaveStats,
    joinAndSeed,
    sendGameOver
} from '../support/saveTamperHarness.js';

const startingCurrency = 100;
await joinAndSeed({ currency: startingCurrency });

sendGameOver({
    currencyEarned: 1e20,
    runStats: {
        floorsReached: 20,
        roomsCleared: 40,
        enemiesKilled: 1000,
        bossesKilled: 10,
        level: 50
    },
    partyStats: []
});

assertCreditsStayHonest(startingCurrency);
const stats = getSaveStats();
if (stats.bestFloor !== 1 || stats.totalEnemiesKilled !== 0 || stats.totalBossesKilled !== 0) {
    throw new Error(`host run summary was stored: ${JSON.stringify(stats)}`);
}
if (stats.bestLevel !== 1) {
    throw new Error(`host level was stored as bestLevel ${stats.bestLevel}`);
}
if (stats.totalRuns !== 1) {
    throw new Error(`game-over handler did not record the run the client is in (totalRuns=${stats.totalRuns})`);
}
