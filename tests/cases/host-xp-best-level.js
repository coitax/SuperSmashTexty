import {
    assert,
    getSaveStats,
    joinAndSeed,
    sendGameOver,
    sendHost
} from '../support/saveTamperHarness.js';

await joinAndSeed({
    currency: 40,
    stats: {
        totalRuns: 0,
        bestFloor: 1,
        bestLevel: 1,
        bestRoom: 1,
        totalEnemiesKilled: 0,
        totalBossesKilled: 0,
        totalFloorsReached: 0,
        totalRoomsCleared: 0,
        totalCurrencyEarned: 0,
        totalPlayTime: 0,
        fastestRunTime: 0
    }
});

for (let i = 0; i < 8; i++) {
    sendHost('xp_gain', { value: 100000 });
}

sendGameOver({
    currencyEarned: 1,
    runStats: {
        floorsReached: 1,
        roomsCleared: 0,
        enemiesKilled: 0,
        bossesKilled: 0,
        level: 40
    },
    partyStats: []
});

const stats = getSaveStats();
assert.equal(stats.bestLevel, 1, `bestLevel became ${stats.bestLevel} from host XP`);
assert.equal(stats.totalRuns, 1);
