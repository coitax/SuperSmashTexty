/**
 * Spec for the global leaderboard private-code exposure.
 *
 * These tests fail while the client still embeds Dreamlo private codes and
 * sends them on score writes. They pass once those codes are gone from the
 * shipped client and score writes no longer leave the browser as Dreamlo
 * private mutations.
 *
 * Dreamlo's developer page (https://www.dreamlo.com/developer) is the
 * contract for the stand-in below:
 * - Every call is an HTTP GET URL. There is no other credential.
 * - The private code authorizes adds and deletes. The public code is read-only.
 * - /add/Name/Score[/Seconds[/Text]] stores a score. The same name keeps the
 *   higher score, so a lower add does not replace a higher one.
 * - /add-pipe, /add-xml, and /add-quote are that same add with another body.
 * - /delete/Name removes that name. /clear removes every score.
 * - /json on the public code is how this game reads the board.
 *
 * The client wraps those URLs with https://corsproxy.io/? plus
 * encodeURIComponent (buildProxiedUrl in src/systems/onlineLeaderboards.js).
 * The stand-in undoes that encoding. It does not contact the network.
 *
 * Game over (src/scenes/gameOver.js) calls submitScore, which also calls
 * submitOnlineScore, then calls submitOnlineScore('allTime') and, for a daily
 * run, submitDailyScore. The GLOBAL tab and getGlobalRank read the all-time
 * board through getOnlineLeaderboard. The daily online board is written by
 * submitDailyScore and read by getOnlineLeaderboard(..., 'daily') and
 * getDailyOnlineLeaderboard.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    submitOnlineScore,
    submitDailyScore,
    getOnlineLeaderboard,
    getDailyOnlineLeaderboard,
    getGlobalRank,
    clearCache
} from '../src/systems/onlineLeaderboards.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROXY_PREFIX = 'https://corsproxy.io/?';
const PRIVATE_ACTION = 'add|add-pipe|add-xml|add-quote|delete|clear';
const PRIVATE_URL = new RegExp(
    `^http://dreamlo\\.com/lb/([^/]+)/(${PRIVATE_ACTION})(?:/|$)`
);
const PUBLIC_JSON_URL = /^http:\/\/dreamlo\.com\/lb\/([^/]+)\/json(?:\/|$)/;

const memoryStore = new Map();
globalThis.localStorage = {
    getItem(key) {
        return memoryStore.has(key) ? memoryStore.get(key) : null;
    },
    setItem(key, value) {
        memoryStore.set(key, String(value));
    },
    removeItem(key) {
        memoryStore.delete(key);
    },
    clear() {
        memoryStore.clear();
    }
};

let queue = Promise.resolve();

function serial(name, fn) {
    const previous = queue;
    let release;
    queue = new Promise(resolve => {
        release = resolve;
    });
    test(name, async () => {
        await previous;
        try {
            await fn();
        } finally {
            release();
        }
    });
}

function unwrapClientUrl(url) {
    const value = String(url);
    if (value.startsWith(PROXY_PREFIX)) {
        return decodeURIComponent(value.slice(PROXY_PREFIX.length));
    }
    return value;
}

function isDreamloPrivateMutation(url) {
    return PRIVATE_URL.test(unwrapClientUrl(url));
}

function walkJsFiles(dir) {
    const files = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...walkJsFiles(full));
        } else if (entry.name.endsWith('.js')) {
            files.push(full);
        }
    }
    return files;
}

function privateKeyLiteralsInClient() {
    const found = [];
    for (const file of walkJsFiles(path.join(root, 'src'))) {
        const source = readFileSync(file, 'utf8');
        const pattern = /privateKey\s*:\s*['"]([^'"]+)['"]/g;
        for (const match of source.matchAll(pattern)) {
            found.push({ file, code: match[1] });
        }
    }
    return found;
}

function boardCodesFromSource(boardType) {
    const source = readFileSync(path.join(root, 'src/systems/onlineLeaderboards.js'), 'utf8');
    const block = source.match(new RegExp(`${boardType}\\s*:\\s*\\{([^}]+)\\}`));
    if (!block) return { publicKey: null, privateKey: null };
    const publicKey = block[1].match(/publicKey\s*:\s*['"]([^'"]+)['"]/);
    const privateKey = block[1].match(/privateKey\s*:\s*['"]([^'"]+)['"]/);
    return {
        publicKey: publicKey ? publicKey[1] : null,
        privateKey: privateKey ? privateKey[1] : null
    };
}

function jsonResponse(body) {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
    });
}

/**
 * In-memory Dreamlo board. Mutation rules match the developer page cited above.
 * A public code cannot add, delete, or clear.
 */
function createDreamlo() {
    const boards = new Map();
    const publicToPrivate = new Map();

    function entries(privateCode) {
        if (!boards.has(privateCode)) boards.set(privateCode, new Map());
        return boards.get(privateCode);
    }

    function pair(publicCode, privateCode) {
        publicToPrivate.set(publicCode, privateCode);
        entries(privateCode);
    }

    function seed(privateCode, entry) {
        entries(privateCode).set(entry.name, { ...entry });
    }

    function toDreamlo(entry) {
        return {
            name: entry.name,
            score: String(entry.score),
            seconds: String(entry.seconds),
            text: entry.text
        };
    }

    function apply(url) {
        const decoded = unwrapClientUrl(url);
        const match = decoded.match(/^http:\/\/dreamlo\.com\/lb\/([^/]+)\/([^/?]+)(?:\/(.*))?$/);
        if (!match) return { handled: false };

        const code = match[1];
        const action = match[2];
        const rest = match[3] ? match[3].split('/').map(part => decodeURIComponent(part)) : [];

        if (action === 'json' || action.startsWith('json')) {
            const privateCode = publicToPrivate.get(code);
            const list = privateCode ? [...entries(privateCode).values()] : [];
            const body = list.length === 0
                ? { dreamlo: { leaderboard: {} } }
                : {
                    dreamlo: {
                        leaderboard: {
                            entry: list.length === 1 ? toDreamlo(list[0]) : list.map(toDreamlo)
                        }
                    }
                };
            return { handled: true, body };
        }

        if (!PRIVATE_URL.test(decoded)) {
            return { handled: true, body: 'ERROR' };
        }

        // The public code is read-only. Unknown codes are not this board.
        if (!boards.has(code)) {
            return { handled: true, body: 'ERROR' };
        }

        const board = entries(code);
        if (action === 'clear') {
            board.clear();
        } else if (action === 'delete') {
            board.delete(rest[0] ?? '');
        } else if (action === 'add' || action.startsWith('add-')) {
            const name = rest[0];
            const score = Number(rest[1]);
            const seconds = Number(rest[2] || 0);
            const text = rest[3] || '';
            if (!name || name.includes('*') || !Number.isFinite(score)) {
                return { handled: true, body: 'ERROR' };
            }
            const existing = board.get(name);
            if (!existing || score > existing.score) {
                board.set(name, { name, score, seconds, text });
            }
        }
        return { handled: true, body: 'OK' };
    }

    return { pair, seed, apply };
}

async function withFetch(mock, fn) {
    const previous = globalThis.fetch;
    globalThis.fetch = mock;
    try {
        return await fn();
    } finally {
        globalThis.fetch = previous;
    }
}

async function observeBoard(boardType, submit) {
    const calls = [];
    await withFetch(async (url) => {
        calls.push(String(url));
        const decoded = unwrapClientUrl(url);
        if (PUBLIC_JSON_URL.test(decoded)) {
            return jsonResponse({ dreamlo: { leaderboard: {} } });
        }
        return new Response('OK', { status: 200 });
    }, async () => {
        await submit();
        clearCache(boardType);
        await getOnlineLeaderboard(10, boardType);
    });

    let writeCode = null;
    let readCode = null;
    for (const url of calls) {
        const decoded = unwrapClientUrl(url);
        const write = decoded.match(PRIVATE_URL);
        const read = decoded.match(PUBLIC_JSON_URL);
        if (write) writeCode = write[1];
        if (read) readCode = read[1];
    }
    return { calls, writeCode, readCode };
}

const validEntry = {
    name: 'Runner',
    score: 1200,
    floor: 2,
    character: 'survivor',
    time: 30,
    date: '2026-01-18'
};

async function prepare(boardType, submit) {
    const observed = await observeBoard(boardType, submit);
    const fromSource = boardCodesFromSource(boardType);
    const writeCode = observed.writeCode || fromSource.privateKey;
    const readCode = observed.readCode || fromSource.publicKey;
    const storedCodes = privateKeyLiteralsInClient();

    if (!writeCode && storedCodes.length === 0) {
        assert.equal(observed.calls.some(isDreamloPrivateMutation), false);
        return { fixed: true, observed };
    }

    assert.ok(readCode, 'the game read path did not identify the public board code');
    assert.ok(writeCode, 'a private code was expected from the client');

    const service = createDreamlo();
    service.pair(readCode, writeCode);
    service.seed(writeCode, {
        name: 'ExistingPlayer',
        score: 5000,
        seconds: 40,
        text: '4|survivor|2026-01-18'
    });
    service.seed(writeCode, {
        name: 'OtherPlayer',
        score: 2500,
        seconds: 55,
        text: '2|scout|2026-01-18'
    });

    const before = await readThrough(service, boardType, () => getOnlineLeaderboard(10, boardType));
    assert.equal(before.error, null);
    assert.ok(
        before.entries.some(entry => entry.name === 'ExistingPlayer' && entry.score === 5000),
        'harness did not show the seeded score through the game read path'
    );
    return { fixed: false, service, writeCode, before, observed };
}

async function readThrough(service, boardType, read) {
    return withFetch(async (url) => {
        const result = service.apply(url);
        if (!result.handled) {
            throw new Error('test refused a request that is not a Dreamlo leaderboard URL');
        }
        if (result.body && typeof result.body === 'object') return jsonResponse(result.body);
        return new Response(String(result.body ?? ''), { status: 200 });
    }, async () => {
        clearCache(boardType);
        return read();
    });
}

function outsider(service, code, path) {
    const result = service.apply(`http://dreamlo.com/lb/${code}/${path}`);
    assert.equal(result.handled, true);
}

async function assertRecordedCallsArePublic(calls) {
    for (const url of calls) {
        assert.equal(
            isDreamloPrivateMutation(url),
            false,
            'score submission requested a Dreamlo private add, delete, or clear URL'
        );
        const decoded = unwrapClientUrl(url);
        for (const entry of privateKeyLiteralsInClient()) {
            assert.equal(decoded.includes(entry.code), false);
        }
    }
}

serial('all-time submitOnlineScore does not send a Dreamlo private code', async () => {
    const observed = await observeBoard('allTime', () => submitOnlineScore(validEntry, 'allTime'));
    await assertRecordedCallsArePublic(observed.calls);
    assert.equal(privateKeyLiteralsInClient().length, 0);
});

serial('daily submitOnlineScore does not send a Dreamlo private code', async () => {
    const observed = await observeBoard('daily', () => submitOnlineScore(validEntry, 'daily'));
    await assertRecordedCallsArePublic(observed.calls);
    assert.equal(boardCodesFromSource('daily').privateKey, null);
});

serial('submitDailyScore does not send a Dreamlo private code', async () => {
    const observed = await observeBoard('daily', () => submitDailyScore(validEntry));
    await assertRecordedCallsArePublic(observed.calls);
});

serial('local submitScore does not send a Dreamlo private code', async () => {
    const { submitScore } = await import('../src/systems/leaderboards.js');
    const calls = [];
    await withFetch(async (url) => {
        calls.push(String(url));
        return new Response('OK', { status: 200 });
    }, async () => {
        submitScore({
            score: validEntry.score,
            floor: validEntry.floor,
            character: validEntry.character,
            time: validEntry.time,
            isDaily: false,
            date: validEntry.date
        });
        await Promise.resolve();
    });
    await assertRecordedCallsArePublic(calls);
});

serial('game over all-time and daily submits do not send a Dreamlo private code', async () => {
    const { calculateScore, submitScore } = await import('../src/systems/leaderboards.js');
    const duration = 40;
    const score = calculateScore({
        floorsReached: 3,
        enemiesKilled: 10,
        bossesKilled: 1,
        duration
    });
    const entry = {
        name: 'Runner',
        score,
        floor: 3,
        character: 'survivor',
        time: duration,
        date: '2026-01-18'
    };
    const calls = [];
    await withFetch(async (url) => {
        calls.push(String(url));
        return new Response('OK', { status: 200 });
    }, async () => {
        // Same order as src/scenes/gameOver.js: local submitScore, then
        // submitOnlineScore('allTime'), then submitDailyScore for a daily run.
        submitScore({
            score: entry.score,
            floor: entry.floor,
            character: entry.character,
            time: entry.time,
            isDaily: true,
            date: entry.date
        });
        await submitOnlineScore(entry, 'allTime');
        await submitDailyScore(entry);
    });
    await assertRecordedCallsArePublic(calls);
});

serial('an outsider add does not appear on the all-time board the game reads', async () => {
    const prep = await prepare('allTime', () => submitOnlineScore(validEntry, 'allTime'));
    if (prep.fixed) return;
    // Above the client MAX_REASONABLE_SCORE of 200000, so the in-game check
    // would refuse this score. The private code skips that check.
    outsider(prep.service, prep.writeCode, 'add/ForgedPlayer/9999999/1/1|survivor|2026-01-18');
    const after = await readThrough(prep.service, 'allTime', () => getOnlineLeaderboard(10, 'allTime'));
    assert.equal(after.entries.some(entry => entry.name === 'ForgedPlayer'), false);
});

serial('an outsider higher score does not replace an all-time record the game reads', async () => {
    const prep = await prepare('allTime', () => submitOnlineScore(validEntry, 'allTime'));
    if (prep.fixed) return;
    outsider(prep.service, prep.writeCode, 'add/ExistingPlayer/9999999/1/9|survivor|2026-01-18');
    const after = await readThrough(prep.service, 'allTime', () => getOnlineLeaderboard(10, 'allTime'));
    assert.equal(after.entries.find(entry => entry.name === 'ExistingPlayer')?.score, 5000);
});

serial('an outsider delete does not remove an all-time name the game reads', async () => {
    const prep = await prepare('allTime', () => submitOnlineScore(validEntry, 'allTime'));
    if (prep.fixed) return;
    outsider(prep.service, prep.writeCode, 'delete/OtherPlayer');
    const after = await readThrough(prep.service, 'allTime', () => getOnlineLeaderboard(1000));
    assert.equal(after.entries.some(entry => entry.name === 'OtherPlayer'), true);
    const rank = await readThrough(prep.service, 'allTime', () => getGlobalRank('OtherPlayer', 2500));
    assert.equal(rank.error, null);
    assert.equal(rank.rank, 2);
});

serial('an outsider delete-then-add does not replace an all-time score the game reads', async () => {
    const prep = await prepare('allTime', () => submitOnlineScore(validEntry, 'allTime'));
    if (prep.fixed) return;
    // Add keeps the higher score, so replacing 5000 with 10 takes delete then add.
    outsider(prep.service, prep.writeCode, 'delete/ExistingPlayer');
    outsider(prep.service, prep.writeCode, 'add/ExistingPlayer/10/1/1|survivor|2026-01-18');
    const after = await readThrough(prep.service, 'allTime', () => getOnlineLeaderboard(10, 'allTime'));
    assert.equal(after.entries.find(entry => entry.name === 'ExistingPlayer')?.score, 5000);
});

serial('an outsider clear does not empty the all-time board the game reads', async () => {
    const prep = await prepare('allTime', () => submitOnlineScore(validEntry, 'allTime'));
    if (prep.fixed) return;
    // gameOver.js shows this rank from the same all-time read.
    const beforeRank = await readThrough(prep.service, 'allTime', () => getGlobalRank('OtherPlayer', 2500));
    outsider(prep.service, prep.writeCode, 'clear');
    const afterRank = await readThrough(prep.service, 'allTime', () => getGlobalRank('OtherPlayer', 2500));
    assert.equal(afterRank.rank, beforeRank.rank);
    assert.equal(afterRank.total, beforeRank.total);
    const after = await readThrough(prep.service, 'allTime', () => getOnlineLeaderboard(10, 'allTime'));
    assert.equal(after.entries.length, prep.before.entries.length);
    assert.equal(after.entries.some(entry => entry.name === 'ExistingPlayer'), true);
});

serial('add-pipe, add-xml, and add-quote do not change the all-time board the game reads', async () => {
    const prep = await prepare('allTime', () => submitOnlineScore(validEntry, 'allTime'));
    if (prep.fixed) return;
    outsider(prep.service, prep.writeCode, 'add-pipe/PipePlayer/100/1/1|survivor|2026-01-18');
    outsider(prep.service, prep.writeCode, 'add-xml/XmlPlayer/100/1/1|survivor|2026-01-18');
    outsider(prep.service, prep.writeCode, 'add-quote/QuotePlayer/100/1/1|survivor|2026-01-18');
    const after = await readThrough(prep.service, 'allTime', () => getOnlineLeaderboard(10, 'allTime'));
    const names = after.entries.map(entry => entry.name);
    assert.equal(names.includes('PipePlayer'), false);
    assert.equal(names.includes('XmlPlayer'), false);
    assert.equal(names.includes('QuotePlayer'), false);
});

serial('an outsider add does not appear on the daily online board', async () => {
    const prep = await prepare('daily', () => submitDailyScore(validEntry));
    if (prep.fixed) return;
    outsider(prep.service, prep.writeCode, 'add/ForgedPlayer/9999999/1/1|survivor|2026-01-18');
    const after = await readThrough(
        prep.service,
        'daily',
        () => getDailyOnlineLeaderboard(10, '2026-01-18')
    );
    assert.equal(after.error, null);
    assert.equal(after.entries.some(entry => entry.name === 'ForgedPlayer'), false);
});

serial('an outsider delete does not remove a daily online name', async () => {
    const prep = await prepare('daily', () => submitOnlineScore(validEntry, 'daily'));
    if (prep.fixed) return;
    outsider(prep.service, prep.writeCode, 'delete/OtherPlayer');
    const after = await readThrough(prep.service, 'daily', () => getOnlineLeaderboard(10, 'daily'));
    assert.equal(after.entries.some(entry => entry.name === 'OtherPlayer'), true);
});

serial('an outsider clear does not empty the daily online board', async () => {
    const prep = await prepare('daily', () => submitDailyScore(validEntry));
    if (prep.fixed) return;
    outsider(prep.service, prep.writeCode, 'clear');
    const after = await readThrough(prep.service, 'daily', () => getOnlineLeaderboard(10, 'daily'));
    assert.equal(after.entries.length, prep.before.entries.length);
    assert.equal(after.entries.some(entry => entry.name === 'ExistingPlayer'), true);
});

serial('an outsider higher score does not replace a daily online record', async () => {
    const prep = await prepare('daily', () => submitOnlineScore(validEntry, 'daily'));
    if (prep.fixed) return;
    outsider(prep.service, prep.writeCode, 'delete/ExistingPlayer');
    outsider(prep.service, prep.writeCode, 'add/ExistingPlayer/10/1/1|survivor|2026-01-18');
    const after = await readThrough(
        prep.service,
        'daily',
        () => getDailyOnlineLeaderboard(10, '2026-01-18')
    );
    assert.equal(after.entries.find(entry => entry.name === 'ExistingPlayer')?.score, 5000);
});

serial('the production bundle does not embed a Dreamlo private code', async () => {
    const { build } = await import('vite');
    const outDir = mkdtempSync(path.join(tmpdir(), 'sst-bundle-'));
    try {
        await build({
            root,
            configFile: path.join(root, 'vite.config.js'),
            logLevel: 'silent',
            build: { outDir, emptyOutDir: true, sourcemap: true }
        });
        const texts = [];
        const stack = [outDir];
        while (stack.length) {
            const dir = stack.pop();
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) stack.push(full);
                else texts.push(readFileSync(full, 'utf8'));
            }
        }
        const bundle = texts.join('\n');
        assert.equal(/privateKey\s*:/.test(bundle), false);
        assert.equal(/\.privateKey\b/.test(bundle), false);
        for (const entry of privateKeyLiteralsInClient()) {
            assert.equal(bundle.includes(entry.code), false);
        }
        assert.equal(isDreamloPrivateMutation(bundle), false);
    } finally {
        rmSync(outDir, { recursive: true, force: true });
    }
});
