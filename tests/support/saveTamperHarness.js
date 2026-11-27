import '../support/globals.js';
import assert from 'node:assert/strict';
import { deliverHostMessage } from '../support/globals.js';
import {
    bootJoinedClient,
    getCurrency,
    getSaveData,
    getSaveStats,
    purchaseUnlock,
    seedSave
} from '../support/joinVictim.js';
import {
    isUnlocked,
    purchaseBooster,
    purchasePermanentUpgrade
} from '../../src/systems/metaProgression.js';

export {
    assert,
    getCurrency,
    getSaveData,
    getSaveStats,
    isUnlocked,
    purchaseUnlock,
    purchaseBooster,
    purchasePermanentUpgrade,
    seedSave
};

const warnings = [];
const originalWarn = console.warn;
console.warn = (...args) => {
    warnings.push(args.map(String).join(' '));
    originalWarn(...args);
};

function assertHandlerRan(type) {
    const missing = warnings.some((line) => line.includes(`No handler for message type: ${type}`));
    assert.equal(missing, false, `${type} handler was not registered on the joined client`);
}

export async function joinAndSeed(partial) {
    await bootJoinedClient();
    return seedSave(partial);
}

export function sendHost(type, payload) {
    deliverHostMessage(type, payload);
    assertHandlerRan(type);
}

export function sendGameOver(payload) {
    try {
        sendHost('game_over', payload);
    } catch (error) {
        const message = String(error && error.message);
        if (!message.includes('then is not a function')) {
            throw error;
        }
    }
}

// A client that just entered has only the floor-1 run counters the scene records.
// Host numbers must not push the save past that local grant, including the
// first-run achievement reward the local counters can earn.
export const LOCAL_CREDIT_GRANT_LIMIT = 10 + 25;

export function assertCreditsStayHonest(startingCurrency) {
    const currency = getCurrency();
    assert.ok(
        currency >= startingCurrency,
        `saved credits fell from ${startingCurrency} to ${currency}`
    );
    assert.ok(
        currency <= startingCurrency + LOCAL_CREDIT_GRANT_LIMIT,
        `saved credits rose from ${startingCurrency} to ${currency}`
    );
    return currency;
}
