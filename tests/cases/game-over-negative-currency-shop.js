import {
    assert,
    assertCreditsStayHonest,
    getCurrency,
    getSaveStats,
    joinAndSeed,
    purchaseBooster,
    purchasePermanentUpgrade,
    purchaseUnlock,
    sendGameOver
} from '../support/saveTamperHarness.js';

const startingCurrency = 200;
await joinAndSeed({ currency: startingCurrency });

sendGameOver({
    currencyEarned: -1000000000,
    runStats: {
        floorsReached: -25,
        roomsCleared: 0,
        enemiesKilled: -40,
        bossesKilled: -3,
        level: 99
    },
    partyStats: []
});

const stats = getSaveStats();
assert.equal(stats.totalRuns, 1);

const weapon = purchaseUnlock('weapons', 'shotgun', 50);
assert.equal(weapon, true, `weapon purchase was rejected at ${getCurrency()} credits`);

const upgrade = purchasePermanentUpgrade('startingHealth', 50, 5);
assert.equal(upgrade.success, true, `permanent upgrade was rejected (${upgrade.reason}) at ${getCurrency()} credits`);

const booster = purchaseBooster('damageBoost', 50);
assert.equal(booster.success, true, `booster purchase was rejected (${booster.reason}) at ${getCurrency()} credits`);

assert.ok(stats.totalFloorsReached >= 0, `floors were driven to ${stats.totalFloorsReached}`);
assert.ok(stats.totalEnemiesKilled >= 0, `kills were driven to ${stats.totalEnemiesKilled}`);
assert.ok(stats.totalBossesKilled >= 0, `bosses were driven to ${stats.totalBossesKilled}`);
assertCreditsStayHonest(startingCurrency);
