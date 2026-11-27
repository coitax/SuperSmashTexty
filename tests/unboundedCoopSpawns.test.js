/**
 * Co-op clients must ignore host spawn traffic past a small cap.
 *
 * These tests fail while a joined client builds a game object for every
 * obstacle, enemy, boss, pickup, or projectile the host lists. They pass
 * once that traffic is capped (extra entries dropped, nothing created for
 * them) and a message over the cap does not destroy objects first.
 *
 * Caps are the safety limits already declared in
 * src/config/constants.js PERFORMANCE_CONFIG, except obstacles, which have
 * no constant. Every room template in src/systems/roomGeneration.js has
 * fewer than 16 obstacles, so 64 is above legitimate rooms.
 *
 * Run:
 *   node --test --test-concurrency=1 --test-force-exit tests/unboundedCoopSpawns.test.js
 *
 * Requires Google Chrome on PATH and the dependencies from package.json.
 * The cases fail on purpose until the spawn handlers enforce the caps.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { startCoopClient } from './helpers/coopClient.js';

const CAP = {
    obstacles: 64,
    enemies: 300,
    bosses: 300,
    pickups: 600,
    projectiles: 500,
};

let client;

describe('co-op spawn caps', { concurrency: 1 }, () => {
test.before(async () => {
    client = await startCoopClient();
});

test.after(async () => {
    if (client) await client.stop();
});

function obstacle(i) {
    return {
        x: (i % 40) * 10,
        y: Math.floor(i / 40) * 10,
        width: 20,
        height: 20,
        type: 'wall',
        char: '#',
        color: [100, 100, 100],
    };
}

async function enterFreshGame() {
    await client.reload();
    return client.joinAndEnterGame();
}

test('a joined client applies a normal obstacle list from the host', async () => {
    const joined = await enterFreshGame();
    assert.equal(joined.isHost, false);
    assert.ok(joined.sent.includes('join_request'));

    const result = await client.evalInPage(`(() => {
        window.__deliverHostMessage({
            type: 'obstacle_data',
            payload: { obstacles: ${JSON.stringify([obstacle(0), obstacle(1)])} }
        });
        return window.__k.get('obstacle').length;
    })()`, false);
    assert.equal(result, 2);
});

test('a joined client does not build an obstacle for every host-listed entry', async () => {
    await enterFreshGame();
    const over = CAP.obstacles + 20;
    const result = await client.evalInPage(`(() => {
        const k = window.__k;
        window.__deliverHostMessage({
            type: 'obstacle_data',
            payload: { obstacles: ${JSON.stringify([obstacle(0), obstacle(1)])} }
        });
        const before = k.get('obstacle').map((obj) => obj.id);
        let adds = 0;
        let destroys = 0;
        const origAdd = k.add.bind(k);
        const origDestroy = k.destroy.bind(k);
        k.add = (...args) => { adds++; return origAdd(...args); };
        k.destroy = (obj) => { destroys++; return origDestroy(obj); };
        const listed = [];
        for (let i = 0; i < ${over}; i++) {
            listed.push({ x: (i % 40) * 10, y: Math.floor(i / 40) * 10, width: 20, height: 20, type: 'wall', char: '#', color: [100, 100, 100] });
        }
        window.__deliverHostMessage({ type: 'obstacle_data', payload: { obstacles: listed } });
        k.add = origAdd;
        k.destroy = origDestroy;
        const after = k.get('obstacle');
        const kept = before.filter((id) => after.some((obj) => obj.id === id)).length;
        return { adds, destroys, live: after.length, kept, before: before.length };
    })()`, false);

    assert.ok(result.adds <= CAP.obstacles, 'created ' + result.adds + ' obstacles from a list of ' + over);
    assert.ok(result.live <= CAP.obstacles, 'left ' + result.live + ' obstacles in the scene');
    if (result.adds === 0) {
        assert.equal(result.destroys, 0, 'oversized obstacle list destroyed objects before it was refused');
        assert.equal(result.kept, result.before);
    }
});

test('a joined client spawns one enemy from one host message', async () => {
    await enterFreshGame();
    const result = await client.evalInPage(`(() => {
        window.__deliverHostMessage({
            type: 'spawn_entity',
            payload: { id: 1, entityType: 'enemy', x: 100, y: 100, type: 'rusher', floor: 1, isBoss: false }
        });
        return window.__k.get('enemy').length;
    })()`, false);
    assert.equal(result, 1);
});

test('a joined client does not spawn an enemy for every host message', async () => {
    await enterFreshGame();
    const result = await client.evalInPage(`(() => {
        const k = window.__k;
        let adds = 0;
        const origAdd = k.add.bind(k);
        k.add = (...args) => { adds++; return origAdd(...args); };
        window.__deliverHostMessage({
            type: 'spawn_entity',
            payload: { id: 1, entityType: 'enemy', x: 10, y: 10, type: 'rusher', floor: 1, isBoss: false }
        });
        const perEnemy = adds;
        const afterOne = k.get('enemy').length;
        adds = 0;
        const extra = ${CAP.enemies};
        for (let i = 0; i < extra; i++) {
            window.__deliverHostMessage({
                type: 'spawn_entity',
                payload: { id: i + 2, entityType: 'enemy', x: 10, y: 10, type: 'rusher', floor: 1, isBoss: false }
            });
        }
        k.add = origAdd;
        const live = k.get('enemy').length;
        const allowedAdds = Math.max(0, ${CAP.enemies} - afterOne) * perEnemy;
        return { live, adds, perEnemy, allowedAdds };
    })()`, false);

    assert.ok(result.perEnemy > 0, 'enemy spawn did not create a game object');
    assert.ok(result.live <= CAP.enemies, 'spawned ' + result.live + ' enemies');
    assert.ok(result.adds <= result.allowedAdds, 'allocated ' + result.adds + ' objects before refusing, budget ' + result.allowedAdds);
});

test('a joined client spawns one boss from one host message', async () => {
    await enterFreshGame();
    const result = await client.evalInPage(`(() => {
        window.__deliverHostMessage({
            type: 'spawn_entity',
            payload: { id: 1, entityType: 'enemy', x: 200, y: 200, type: 'gatekeeper', floor: 1, isBoss: true }
        });
        return window.__k.get('boss').length;
    })()`, false);
    assert.equal(result, 1);
});

test('a joined client does not spawn a boss for every host message', async () => {
    await enterFreshGame();
    const result = await client.evalInPage(`(() => {
        const k = window.__k;
        let adds = 0;
        const origAdd = k.add.bind(k);
        k.add = (...args) => { adds++; return origAdd(...args); };
        window.__deliverHostMessage({
            type: 'spawn_entity',
            payload: { id: 1, entityType: 'enemy', x: 20, y: 20, type: 'gatekeeper', floor: 1, isBoss: true }
        });
        const perBoss = adds;
        const afterOne = k.get('boss').length;
        adds = 0;
        const extra = ${CAP.bosses};
        for (let i = 0; i < extra; i++) {
            window.__deliverHostMessage({
                type: 'spawn_entity',
                payload: { id: i + 2, entityType: 'enemy', x: 20, y: 20, type: 'gatekeeper', floor: 1, isBoss: true }
            });
        }
        k.add = origAdd;
        return { live: k.get('boss').length, adds, perBoss, allowedAdds: Math.max(0, ${CAP.bosses} - afterOne) * perBoss };
    })()`, false);

    assert.ok(result.perBoss > 0, 'boss spawn did not create a game object');
    assert.ok(result.live <= CAP.bosses, 'spawned ' + result.live + ' bosses');
    assert.ok(result.adds <= result.allowedAdds, 'allocated ' + result.adds + ' boss objects before refusing, budget ' + result.allowedAdds);
});

test('a joined client spawns one pickup of each kind from the host', async () => {
    await enterFreshGame();
    const result = await client.evalInPage(`(() => {
        window.__deliverHostMessage({
            type: 'spawn_entity',
            payload: { id: 1, entityType: 'xpPickup', x: 40, y: 40, value: 1 }
        });
        window.__deliverHostMessage({
            type: 'spawn_entity',
            payload: { id: 2, entityType: 'currencyPickup', x: 60, y: 60, value: 1, icon: '$' }
        });
        return {
            xp: window.__k.get('xpPickup').length,
            currency: window.__k.get('currencyPickup').length
        };
    })()`, false);
    assert.equal(result.xp, 1);
    assert.equal(result.currency, 1);
});

test('a joined client does not spawn a pickup for every host message', async () => {
    await enterFreshGame();
    const result = await client.evalInPage(`(() => {
        const k = window.__k;
        let xpAdds = 0;
        let currencyAdds = 0;
        const origAdd = k.add.bind(k);
        const total = ${CAP.pickups + 1};
        k.add = (...args) => { xpAdds++; return origAdd(...args); };
        for (let i = 0; i < total; i++) {
            window.__deliverHostMessage({
                type: 'spawn_entity',
                payload: { id: i + 1, entityType: 'xpPickup', x: 30, y: 30, value: 1 }
            });
        }
        const xpLive = k.get('xpPickup').length;
        k.add = (...args) => { currencyAdds++; return origAdd(...args); };
        for (let i = 0; i < total; i++) {
            window.__deliverHostMessage({
                type: 'spawn_entity',
                payload: { id: 10000 + i, entityType: 'currencyPickup', x: 50, y: 50, value: 1, icon: '$' }
            });
        }
        k.add = origAdd;
        return {
            xpLive,
            xpAdds,
            currencyLive: k.get('currencyPickup').length,
            currencyAdds
        };
    })()`, false);

    assert.ok(
        result.xpLive <= CAP.pickups && result.xpAdds <= CAP.pickups
        && result.currencyLive <= CAP.pickups && result.currencyAdds <= CAP.pickups,
        'pickup flood ' + JSON.stringify(result)
    );
});

test('a joined client spawns one projectile from the host', async () => {
    await enterFreshGame();
    const result = await client.evalInPage(`(() => {
        const before = window.__k.get('projectile').length;
        window.__deliverHostMessage({
            type: 'spawn_projectile',
            payload: {
                id: 1, x: 10, y: 10, directionX: 1, directionY: 0, speed: 100,
                damage: 1, piercing: 0, obstaclePiercing: 0, isCrit: false, maxRange: 100,
                char: '*', color: [255, 255, 100]
            }
        });
        return window.__k.get('projectile').length - before;
    })()`, false);
    assert.equal(result, 1);
});

test('a joined client does not spawn a projectile for every host message', async () => {
    await enterFreshGame();
    const result = await client.evalInPage(`(() => {
        const k = window.__k;
        let adds = 0;
        const origAdd = k.add.bind(k);
        k.add = (...args) => { adds++; return origAdd(...args); };
        const before = k.get('projectile').length;
        const total = ${CAP.projectiles + 1};
        for (let i = 0; i < total; i++) {
            window.__deliverHostMessage({
                type: 'spawn_projectile',
                payload: {
                    id: i + 1, x: 10, y: 10, directionX: 1, directionY: 0, speed: 100,
                    damage: 1, piercing: 0, obstaclePiercing: 0, isCrit: false, maxRange: 100,
                    char: '*', color: [255, 255, 100]
                }
            });
        }
        k.add = origAdd;
        return { live: k.get('projectile').length - before, adds };
    })()`, false);

    assert.ok(result.live <= CAP.projectiles, 'spawned ' + result.live + ' projectiles');
    assert.ok(result.adds <= CAP.projectiles, 'allocated ' + result.adds + ' projectiles before refusing');
});
});
