import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

function runCase(script, args = []) {
    const result = spawnSync(process.execPath, [path.join(here, 'cases', script), ...args], {
        cwd: root,
        encoding: 'utf8'
    });
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    assert.equal(
        result.status,
        0,
        output || `case ${script} exited ${result.status}`
    );
}

test('host game-over cannot raise the joined player credits to the safe-integer cap', () => {
    runCase('game-over-huge-currency.js');
});

test('host game-over cannot drive credits negative or erase lifetime totals, so the shop still sells', () => {
    runCase('game-over-negative-currency-shop.js');
});

test('host game-over cannot grant the first new achievement, its credits, or its character', () => {
    runCase('game-over-achievement-and-character.js');
});

test('host currency-gain cannot reduce the joined player credits', () => {
    runCase('currency-gain-from-host.js', ['negative']);
});

test('host currency-gain cannot raise the joined player credits to the safe-integer cap', () => {
    runCase('currency-gain-from-host.js', ['huge']);
});

test('host xp-gain cannot raise the saved best level when the run ends', () => {
    runCase('host-xp-best-level.js');
});
