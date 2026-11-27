/**
 * Spec for host-controlled co-op credit messages.
 *
 * These tests exercise the client path a co-op host can reach:
 * PeerJS JSON data on the host connection -> network handleMessage ->
 * the currency_gain handler registered when the match scene starts ->
 * addCurrency -> localStorage -> shop purchase helpers.
 *
 * They assert the safe outcome, so they fail while a host can still
 * change the victim's saved balance with an arbitrary amount.
 *
 * Shared operation not covered here: the in-scene `game_over` handler in
 * src/scenes/game.js also adds a host-supplied `currencyEarned` through
 * addCurrency. It is registered only while the Kaplay game scene is
 * running, so this file does not start that scene.
 */

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';

// peerjs@1.5.4 Json channel refuses payloads whose UTF-8 form is at least
// BinaryPackChunker.chunkedMTU (lib/dataconnection/BufferedConnection/binaryPackChunker.ts).
const PEERJS_JSON_MAX_BYTES = 16300;
const HOST_CODE = '123456';
const STORAGE_KEY = 'superSmashTexty_save';

const memory = new Map();

globalThis.localStorage = {
    getItem(key) {
        return memory.has(key) ? memory.get(key) : null;
    },
    setItem(key, value) {
        memory.set(key, String(value));
    },
    removeItem(key) {
        memory.delete(key);
    },
    clear() {
        memory.clear();
    }
};

globalThis.window = {
    addEventListener() {},
    removeEventListener() {}
};
globalThis.alert = () => {};

let hostChannel = null;

class HostDataChannel {
    constructor(peerId) {
        this.peer = peerId;
        this.open = false;
        this.listeners = new Map();
    }

    on(event, callback) {
        const list = this.listeners.get(event) || [];
        list.push(callback);
        this.listeners.set(event, list);
    }

    emit(event, data) {
        for (const callback of this.listeners.get(event) || []) {
            callback(data);
        }
    }

    send() {}
}

class FakePeer {
    constructor(id) {
        this.listeners = new Map();
        queueMicrotask(() => {
            this.emit('open', id || 'client-generated-id');
        });
    }

    on(event, callback) {
        const list = this.listeners.get(event) || [];
        list.push(callback);
        this.listeners.set(event, list);
    }

    emit(event, data) {
        for (const callback of this.listeners.get(event) || []) {
            callback(data);
        }
    }

    connect(peerId, options) {
        if (options?.serialization !== 'json') {
            throw new Error(`expected json serialization, got ${options?.serialization}`);
        }
        hostChannel = new HostDataChannel(peerId);
        queueMicrotask(() => {
            hostChannel.open = true;
            hostChannel.emit('open');
        });
        return hostChannel;
    }

    destroy() {}
}

globalThis.Peer = FakePeer;

let instrumentNextPickup = null;
let kaplay = null;

function componentStub() {
    return {};
}

function installKaplay(onGameScene) {
    kaplay = {
        paused: false,
        width: () => 800,
        height: () => 600,
        dt: () => 0.016,
        vec2(x = 0, y = 0) {
            const vector = {
                x,
                y,
                sub(other) { return kaplay.vec2(vector.x - other.x, vector.y - other.y); },
                add(other) { return kaplay.vec2(vector.x + other.x, vector.y + other.y); },
                scale(n) { return kaplay.vec2(vector.x * n, vector.y * n); },
                len() { return Math.hypot(vector.x, vector.y); },
                unit() {
                    const length = Math.hypot(vector.x, vector.y) || 1;
                    return kaplay.vec2(vector.x / length, vector.y / length);
                }
            };
            return vector;
        },
        rgb: () => ({ r: 255, g: 255, b: 255 }),
        text: componentStub,
        pos: componentStub,
        anchor: componentStub,
        color: componentStub,
        area: componentStub,
        scale: componentStub,
        opacity: componentStub,
        destroy() {},
        get: () => [],
        add() {
            const entity = {
                pos: { x: 0, y: 0 },
                opacity: 1,
                color: {},
                scale: {},
                exists: () => true,
                is: () => false,
                onUpdate() {},
                onDestroy() {}
            };
            if (instrumentNextPickup) {
                const instrument = instrumentNextPickup;
                instrumentNextPickup = null;
                instrument(entity);
            }
            return entity;
        },
        go(scene) {
            if (scene === 'game') onGameScene();
        }
    };
    return kaplay;
}

/**
 * Reproduce peerjs@1.5.4 Json._send / Json._handleDataMessage:
 * JSON.stringify, UTF-8, drop at chunkedMTU, JSON.parse, suppress __peerData close.
 */
function deliverHostMessage(message) {
    const json = JSON.stringify(message);
    const encoded = new TextEncoder().encode(json);
    if (encoded.byteLength >= PEERJS_JSON_MAX_BYTES) return false;
    const deserialized = JSON.parse(new TextDecoder().decode(encoded));
    if (deserialized?.__peerData?.type === 'close') return false;
    hostChannel.emit('data', deserialized);
    return true;
}

const api = {};

before(async () => {
    const party = await import('../src/systems/partySystem.js');
    const network = await import('../src/systems/networkSystem.js');
    const multiplayer = await import('../src/systems/multiplayerGame.js');
    const meta = await import('../src/systems/metaProgression.js');
    Object.assign(api, { party, network, multiplayer, meta });

    installKaplay(() => {
        const partyState = party.getParty();
        const networkInfo = network.getNetworkInfo();
        const partySize = party.getPartySize();
        if (partySize > 1 && networkInfo.isInitialized) {
            const localSlot = partyState.slots.findIndex((slot) => slot.isLocal);
            multiplayer.initMultiplayerGame(partyState.isHost, localSlot, kaplay);
        }
    });

    await party.initParty(kaplay);
    const joined = await party.joinPartyAsClient(HOST_CODE);
    assert.equal(joined, true, 'victim client should connect to the host data channel');

    deliverHostMessage({
        type: 'party_sync',
        payload: {
            yourSlotIndex: 1,
            slots: [
                { playerId: 'host', playerName: 'Host', inviteCode: HOST_CODE, selectedCharacter: 'survivor', selectedPortrait: 'default', playerLevel: 1, isLocal: false, peerId: null, isReady: true },
                { playerId: 'victim', playerName: 'Victim', inviteCode: '654321', selectedCharacter: 'survivor', selectedPortrait: 'default', playerLevel: 1, isLocal: false, peerId: null, isReady: true },
                { playerId: null, playerName: null, inviteCode: null, selectedCharacter: null, selectedPortrait: null, playerLevel: 1, isLocal: false, peerId: null, isReady: false },
                { playerId: null, playerName: null, inviteCode: null, selectedCharacter: null, selectedPortrait: null, playerLevel: 1, isLocal: false, peerId: null, isReady: false }
            ]
        }
    });

    assert.equal(party.getParty().isHost, false);
    assert.ok(party.getPartySize() > 1);
    assert.equal(network.getNetworkInfo().isInitialized, true);
});

function setBalance(amount) {
    const save = api.meta.loadSave();
    save.currency = amount;
    save.permanentUpgradeLevels = {};
    save.activeBoosters = [];
    save.unlocks.weapons = ['default'];
    save.unlocks.permanentUpgrades = [];
    api.meta.saveGame(save);
}

function enterMatch() {
    if (api.multiplayer.isMultiplayerActive()) {
        api.multiplayer.cleanupMultiplayer();
    }
    const delivered = deliverHostMessage({ type: 'game_start', payload: {} });
    assert.equal(delivered, true);
    assert.equal(api.multiplayer.isMultiplayerActive(), true, 'game_start should load the match and register client handlers');
    assert.equal(api.multiplayer.isHost(), false);
}

function spawnCurrencyPickup(id, value) {
    const delivered = deliverHostMessage({
        type: 'spawn_entity',
        payload: {
            id,
            entityType: 'currencyPickup',
            x: 10,
            y: 20,
            value,
            icon: '$'
        }
    });
    assert.equal(delivered, true);
}

function sendCurrencyGain(payload) {
    const delivered = deliverHostMessage({
        type: 'currency_gain',
        payload
    });
    assert.equal(delivered, true);
}

describe('untrusted host currency messages', { concurrency: 1 }, () => {
    test('a seen pickup credits exactly its small positive value', () => {
        setBalance(40);
        enterMatch();
        // Room-clear coins use Math.floor(1 + floor * 0.3); floor 10 is 4.
        spawnCurrencyPickup(8, 4);
        sendCurrencyGain({ id: 8, value: 4 });
        assert.equal(api.meta.getCurrency(), 44);
    });

    test('the same seen pickup cannot be credited again', () => {
        setBalance(40);
        enterMatch();
        spawnCurrencyPickup(8, 4);
        sendCurrencyGain({ id: 8, value: 4 });
        sendCurrencyGain({ id: 8, value: 4 });
        assert.equal(api.meta.getCurrency(), 44);
    });

    test('a currency message is ignored until the match scene registers the handler', () => {
        setBalance(40);
        if (api.multiplayer.isMultiplayerActive()) {
            api.multiplayer.cleanupMultiplayer();
        }
        sendCurrencyGain({ value: 100 });
        assert.equal(api.meta.getCurrency(), 40);
    });

    test('a huge currency message without a seen pickup does not change the saved balance', () => {
        setBalance(40);
        enterMatch();
        sendCurrencyGain({ value: Number.MAX_SAFE_INTEGER });
        assert.equal(api.meta.getCurrency(), 40);
        const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
        assert.equal(stored.currency, 40);
    });

    test('a huge amount is rejected even when a spawned pickup claims that same amount', () => {
        setBalance(40);
        enterMatch();
        spawnCurrencyPickup(9, Number.MAX_SAFE_INTEGER);
        sendCurrencyGain({ id: 9, value: Number.MAX_SAFE_INTEGER });
        assert.equal(api.meta.getCurrency(), 40);
    });

    test('a negative currency message does not reduce the balance or make the shop refuse purchases', () => {
        setBalance(500);
        enterMatch();
        spawnCurrencyPickup(7, 1);
        sendCurrencyGain({ value: -1000000000000 });
        sendCurrencyGain({ id: 7, value: -1000000000000 });

        const balance = api.meta.getCurrency();
        const weaponPurchase = api.meta.purchaseUnlock('weapons', 'spreadShot', 250);
        const upgradePurchase = api.meta.purchasePermanentUpgrade('startingHealth', 50, 5);
        const boosterPurchase = api.meta.purchaseBooster('healthPack', 30);

        assert.deepEqual(
            { balance, weaponPurchase, upgradePurchase, boosterPurchase },
            {
                balance: 500,
                weaponPurchase: true,
                upgradePurchase: { success: true, newLevel: 1 },
                boosterPurchase: { success: true, boosterKey: 'healthPack' }
            }
        );
    });

    test('a currency amount for a different pickup than the one named is not applied', () => {
        setBalance(40);
        enterMatch();
        spawnCurrencyPickup(7, 1);
        spawnCurrencyPickup(8, 4);
        sendCurrencyGain({ id: 7, value: 4 });
        const balance = api.meta.getCurrency();
        assert.ok(
            balance === 40 || balance === 41,
            `balance became ${balance}; a message for pickup 7 may credit only that pickup's value of 1`
        );
    });

    test('a currency message for an unknown pickup id does not change the balance', () => {
        setBalance(40);
        enterMatch();
        spawnCurrencyPickup(7, 1);
        sendCurrencyGain({ id: 999, value: 1 });
        assert.equal(api.meta.getCurrency(), 40);
    });

    test('a non-numeric currency message does not corrupt the saved balance', () => {
        setBalance(40);
        enterMatch();
        sendCurrencyGain({ value: '-1000000000000' });
        sendCurrencyGain({ id: 7, value: '-1000000000000' });
        const balance = api.meta.getCurrency();
        assert.equal(balance, 40);
        assert.equal(Number.isFinite(balance), true);
    });

    test('a pickup whose value changes between reads cannot credit the later value', () => {
        setBalance(40);
        enterMatch();
        let reads = 0;
        instrumentNextPickup = (entity) => {
            let stored = 0;
            Object.defineProperty(entity, 'value', {
                configurable: true,
                enumerable: true,
                get() {
                    reads += 1;
                    return reads === 1 ? stored : Number.MAX_SAFE_INTEGER;
                },
                set(value) {
                    stored = value;
                }
            });
        };
        spawnCurrencyPickup(11, 1);
        reads = 0;
        sendCurrencyGain({ id: 11, value: 1 });
        const balance = api.meta.getCurrency();
        assert.ok(balance === 40 || balance === 41);
        assert.notEqual(balance, Number.MAX_SAFE_INTEGER);
        assert.ok(balance < 1000);
    });

    test('addCurrency ignores non-finite amounts and never stores a negative balance', () => {
        setBalance(10);
        api.meta.addCurrency(Number.POSITIVE_INFINITY);
        assert.equal(api.meta.getCurrency(), 10);

        setBalance(10);
        api.meta.addCurrency(Number.NaN);
        assert.equal(api.meta.getCurrency(), 10);

        setBalance(10);
        api.meta.addCurrency(-100);
        assert.equal(api.meta.getCurrency(), 0);

        setBalance(10);
        api.meta.addCurrency(Number.NEGATIVE_INFINITY);
        const balance = api.meta.getCurrency();
        assert.equal(Number.isFinite(balance), true);
        assert.ok(balance >= 0);
        assert.equal(balance, 10);
    });
});
