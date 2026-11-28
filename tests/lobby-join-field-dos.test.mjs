/**
 * Spec for co-op lobby join and rename fields.
 *
 * A connected peer must not be able to store or distribute a playerName that
 * is not text, or a playerName longer than the 20 characters the profile
 * editor already enforces (src/scenes/profile.js, the name field stops at 20).
 * playerLevel must be stored and distributed as an integer from 1 to 9999.
 * Anything else is ignored: join falls back to the default name "Player" and
 * level 1, and a later player_info message leaves the previous value in place.
 *
 * The menu party list (src/scenes/menu.js) must keep redrawing, including the
 * once-per-second refresh, and the level badge it passes to text() must be
 * that integer's decimal form. Outbound party_sync and party_update messages
 * must not contain the raw peer payload.
 *
 * These tests fail while the current handlers copy the payload through.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { installBrowserGlobals } from './support/browser-globals.mjs';
import { connectAttacker, installFakePeer } from './support/fake-peer.mjs';
import { createMenuHarness } from './support/menu-harness.mjs';

installBrowserGlobals();
const { peers } = installFakePeer();

const {
    clearPartyCallbacks,
    clearRemotePlayers,
    getParty,
    restoreLocalPlayerToSoloParty,
} = await import('../src/systems/partySystem.js');
const { disconnect, getNetworkInfo } = await import('../src/systems/networkSystem.js');
const { setupMenuScene } = await import('../src/scenes/menu.js');

const NAME_CAP = 20;
const LEVEL_MIN = 1;
const LEVEL_MAX = 9999;
const here = path.dirname(fileURLToPath(import.meta.url));

function assertSafeName(name, label) {
    assert.equal(typeof name, 'string', `${label} must be a string`);
    assert.ok(
        name.length >= 1 && name.length <= NAME_CAP,
        `${label} length ${name.length} is outside 1..${NAME_CAP}`,
    );
}

function assertSafeLevel(level, label) {
    assert.equal(typeof level, 'number', `${label} must be a number`);
    assert.ok(
        Number.isInteger(level) && level >= LEVEL_MIN && level <= LEVEL_MAX,
        `${label} must be an integer from ${LEVEL_MIN} to ${LEVEL_MAX}`,
    );
}

function walk(value, visit) {
    if (!value || typeof value !== 'object') {
        return;
    }
    visit(value);
    if (Array.isArray(value)) {
        for (const item of value) {
            walk(item, visit);
        }
        return;
    }
    for (const nested of Object.values(value)) {
        walk(nested, visit);
    }
}

function assertWireSafe(sent, forbidden) {
    const delivered = sent.filter((message) => !message?.dropped);
    const blob = JSON.stringify(delivered);
    for (const token of forbidden) {
        assert.equal(
            blob.includes(token),
            false,
            `outbound lobby message still contains attacker field ${token}`,
        );
    }
    walk(delivered, (value) => {
        if (Object.prototype.hasOwnProperty.call(value, 'playerName') && value.playerName != null) {
            assertSafeName(value.playerName, 'outbound playerName');
        }
        if (Object.prototype.hasOwnProperty.call(value, 'playerLevel') && value.playerLevel != null) {
            assertSafeLevel(value.playerLevel, 'outbound playerLevel');
        }
    });
}

function remoteSlot() {
    const slot = getParty().slots.find((entry, index) => index > 0 && entry.playerId);
    assert.ok(slot, 'expected the peer to occupy a party slot');
    return slot;
}

async function bootHost() {
    disconnect();
    clearPartyCallbacks();
    clearRemotePlayers();
    restoreLocalPlayerToSoloParty({
        playerName: 'Host',
        inviteCode: '123456',
        selectedCharacter: 'survivor',
    });

    for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (getNetworkInfo().isInitialized) {
            return;
        }
    }
    throw new Error('host network did not start');
}

function openMenu() {
    const harness = createMenuHarness();
    setupMenuScene(harness.k);
    harness.enter();
    return harness;
}

function refreshMenu(harness) {
    let menuError = null;
    try {
        harness.refreshPartyList();
    } catch (error) {
        menuError = error;
    }
    return menuError;
}

function assertMenuSafe(menuError, harness) {
    assert.equal(
        menuError,
        null,
        `party list refresh threw ${menuError?.name}: ${menuError?.message}`,
    );
    const badges = harness.levelBadgeTexts();
    assert.ok(badges.length > 0, 'menu did not draw a level badge');
    for (const badge of badges) {
        const text = String(badge);
        assert.ok(
            /^\d{1,4}$/.test(text),
            `level badge length ${text.length} is not a 1..9999 integer`,
        );
        assertSafeLevel(Number(text), 'drawn level');
    }
}

function runClient(messages) {
    const dir = mkdtempSync(path.join(tmpdir(), 'lobby-dos-'));
    const file = path.join(dir, 'messages.json');
    const delivered = messages.filter((message) => !message?.dropped);
    writeFileSync(file, JSON.stringify(delivered));
    const child = spawnSync(process.execPath, [path.join(here, 'support/client-apply.mjs'), file], {
        cwd: path.join(here, '..'),
        encoding: 'utf8',
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const line = child.stdout.trim().split('\n').at(-1);
    return JSON.parse(line);
}

test('a normal join keeps a short name and a small level', async () => {
    await bootHost();
    const conn = connectAttacker(peers, 'polite-peer');
    const delivered = conn.deliver({
        type: 'join_request',
        payload: {
            playerName: 'Ada',
            inviteCode: '654321',
            selectedCharacter: 'survivor',
            selectedPortrait: 'default',
            playerLevel: 12,
        },
    });
    assert.equal(delivered.dropped, false);

    const slot = remoteSlot();
    assert.equal(slot.playerName, 'Ada');
    assert.equal(slot.playerLevel, 12);

    const harness = openMenu();
    const menuError = refreshMenu(harness);
    assertMenuSafe(menuError, harness);
    assert.ok(harness.levelBadgeTexts().includes('12'));
});

test('join with a non-string name breaks the party list and is redistributed', async () => {
    await bootHost();
    const harness = openMenu();
    const conn = connectAttacker(peers, 'name-type-peer');
    const objectName = { injected: `OBJTOKEN${'Z'.repeat(180)}` };
    conn.deliver({
        type: 'join_request',
        payload: {
            playerName: objectName,
            inviteCode: '654321',
            selectedCharacter: 'survivor',
            selectedPortrait: 'default',
            playerLevel: 4,
        },
    });

    const menuError = refreshMenu(harness);
    const client = runClient(conn.sent);
    assert.equal(client.ok, true, JSON.stringify(client.menuError));
    assertMenuSafe(menuError, harness);

    const slot = remoteSlot();
    assertSafeName(slot.playerName, 'stored name');
    assert.equal(slot.playerName.includes('OBJTOKEN'), false);
    assertWireSafe(conn.sent, ['OBJTOKEN']);
    for (const slotInfo of client.display) {
        if (slotInfo.playerName && slotInfo.playerName !== 'Empty Slot') {
            assertSafeName(slotInfo.playerName, 'client name');
        }
    }
});

test('join with a numeric name is not drawn with a string method', async () => {
    await bootHost();
    const harness = openMenu();
    const conn = connectAttacker(peers, 'numeric-name-peer');
    conn.deliver({
        type: 'join_request',
        payload: {
            playerName: 8675309,
            inviteCode: '654321',
            selectedCharacter: 'survivor',
            selectedPortrait: 'default',
            playerLevel: 3,
        },
    });

    const menuError = refreshMenu(harness);
    assertMenuSafe(menuError, harness);

    const slot = remoteSlot();
    assertSafeName(slot.playerName, 'stored name');
    assertWireSafe(conn.sent, []);

    const client = runClient(conn.sent);
    assert.equal(client.ok, true, JSON.stringify(client.menuError));
});

test('join with an unbounded level is stored, drawn, and sent in full', async () => {
    await bootHost();
    const harness = openMenu();
    const conn = connectAttacker(peers, 'level-peer');
    const rawLevel = `LEVELTOKEN${'X'.repeat(4000)}`;
    const delivered = conn.deliver({
        type: 'join_request',
        payload: {
            playerName: 'Ada',
            inviteCode: '654321',
            selectedCharacter: 'survivor',
            selectedPortrait: 'default',
            playerLevel: rawLevel,
        },
    });
    assert.equal(delivered.dropped, false, 'level payload must fit the JSON data channel');

    const menuError = refreshMenu(harness);
    assertMenuSafe(menuError, harness);

    const slot = remoteSlot();
    assert.equal(slot.playerName, 'Ada');
    assertSafeLevel(slot.playerLevel, 'stored level');
    assert.equal(String(slot.playerLevel).includes('LEVELTOKEN'), false);
    for (const badge of harness.levelBadgeTexts()) {
        assert.equal(String(badge).includes('LEVELTOKEN'), false);
    }
    assertWireSafe(conn.sent, ['LEVELTOKEN']);

    const client = runClient(conn.sent);
    assert.equal(client.ok, true, JSON.stringify(client.menuError));
    for (const badge of client.levelBadges) {
        assert.equal(String(badge).includes('LEVELTOKEN'), false);
        assert.match(String(badge), /^\d{1,4}$/);
    }
});

test('join with a name longer than 20 characters is capped before it is stored or sent', async () => {
    await bootHost();
    const harness = openMenu();
    const conn = connectAttacker(peers, 'long-name-peer');
    const rawName = `${'Y'.repeat(NAME_CAP)}NAMETOKEN${'Y'.repeat(500)}`;
    conn.deliver({
        type: 'join_request',
        payload: {
            playerName: rawName,
            inviteCode: '654321',
            selectedCharacter: 'survivor',
            selectedPortrait: 'default',
            playerLevel: 2,
        },
    });

    const menuError = refreshMenu(harness);
    assertMenuSafe(menuError, harness);

    const slot = remoteSlot();
    assertSafeName(slot.playerName, 'stored name');
    assert.equal(slot.playerName.includes('NAMETOKEN'), false);
    assert.notEqual(slot.playerName, rawName);
    assertWireSafe(conn.sent, ['NAMETOKEN']);
});

test('player_info can replace the name with a non-string', async () => {
    await bootHost();
    const conn = connectAttacker(peers, 'rename-peer');
    conn.deliver({
        type: 'join_request',
        payload: {
            playerName: 'Ada',
            inviteCode: '654321',
            selectedCharacter: 'survivor',
            selectedPortrait: 'default',
            playerLevel: 6,
        },
    });
    assert.equal(remoteSlot().playerName, 'Ada');
    const harness = openMenu();

    conn.sent.length = 0;
    const objectName = { injected: `RENAMETOKEN${'Q'.repeat(180)}` };
    conn.deliver({
        type: 'player_info',
        payload: { playerName: objectName },
    });

    const menuError = refreshMenu(harness);
    assertMenuSafe(menuError, harness);

    assertSafeName(remoteSlot().playerName, 'name after player_info object');
    assert.equal(String(remoteSlot().playerName).includes('RENAMETOKEN'), false);
    assertWireSafe(conn.sent, ['RENAMETOKEN']);

    const client = runClient(conn.sent);
    assert.equal(client.ok, true, JSON.stringify(client.menuError));
});

test('player_info can replace the name with a string longer than 20 characters', async () => {
    await bootHost();
    const conn = connectAttacker(peers, 'rename-long-peer');
    conn.deliver({
        type: 'join_request',
        payload: {
            playerName: 'Ada',
            inviteCode: '654321',
            selectedCharacter: 'survivor',
            selectedPortrait: 'default',
            playerLevel: 6,
        },
    });
    assert.equal(remoteSlot().playerName, 'Ada');
    const harness = openMenu();

    conn.sent.length = 0;
    const rawName = `${'W'.repeat(NAME_CAP)}LONGRENAME${'W'.repeat(500)}`;
    conn.deliver({
        type: 'player_info',
        payload: { playerName: rawName },
    });

    const menuError = refreshMenu(harness);
    assertMenuSafe(menuError, harness);

    assertSafeName(remoteSlot().playerName, 'name after player_info string');
    assert.notEqual(remoteSlot().playerName, rawName);
    assertWireSafe(conn.sent, ['LONGRENAME']);

    const client = runClient(conn.sent);
    assert.equal(client.ok, true, JSON.stringify(client.menuError));
});
