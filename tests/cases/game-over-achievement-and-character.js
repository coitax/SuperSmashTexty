import {
    assert,
    assertCreditsStayHonest,
    getSaveData,
    joinAndSeed,
    sendGameOver
} from '../support/saveTamperHarness.js';

const startingCurrency = 100;
const alreadyEarned = [
    'floor2', 'floor3', 'floor5', 'floor10', 'floor15', 'floor20',
    'firstKill', 'kill100', 'kill500'
];

await joinAndSeed({
    currency: startingCurrency,
    achievements: alreadyEarned,
    stats: {
        totalRuns: 3,
        bestFloor: 20,
        bestLevel: 1,
        totalEnemiesKilled: 500,
        totalBossesKilled: 0,
        totalFloorsReached: 20,
        totalRoomsCleared: 0,
        bestRoom: 1,
        totalCurrencyEarned: 0,
        totalPlayTime: 0,
        fastestRunTime: 0
    }
});

sendGameOver({
    currencyEarned: 1,
    runStats: {
        floorsReached: 1,
        roomsCleared: 0,
        enemiesKilled: 1000,
        bossesKilled: 10,
        level: 20
    },
    partyStats: []
});

assertCreditsStayHonest(startingCurrency);
const save = getSaveData();
assert.equal(save.achievements.includes('kill1000'), false, `kill1000 was saved: ${save.achievements}`);
assert.equal(save.achievements.includes('boss10'), false, `boss10 was saved: ${save.achievements}`);
assert.equal(save.unlocks.characters.includes('vampire'), false, `vampire was unlocked: ${save.unlocks.characters}`);
assert.equal(save.unlocks.characters.includes('bomber'), false, `bomber was unlocked: ${save.unlocks.characters}`);
assert.equal(save.stats.totalRuns, 4, 'game-over handler did not record the joined run');
assert.equal(save.stats.totalEnemiesKilled, 500);
assert.equal(save.stats.totalBossesKilled, 0);
assert.equal(save.stats.bestLevel, 1);
