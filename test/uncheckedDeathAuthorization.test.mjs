/**
 * Authorization tests for co-op death and entity-removal messages.
 *
 * These tests describe the behavior that should hold once a joined player
 * cannot apply a death to somebody else's slot or delete another client's
 * enemies and pickups. They fail while that check is missing.
 *
 * Run:
 *   node --test test/uncheckedDeathAuthorization.test.mjs
 *
 * The in-process transport below is the PeerJS 1.5.4 JSON data channel
 * (the build index.html loads), reduced to the steps that touch the
 * message bytes. Negotiation is local because this environment has no
 * PeerServer; the bytes are still encoded and decoded the way Json.ts does.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker, isMainThread } from 'node:worker_threads';

const HOST_CODE = '246810';
const CHUNKED_MTU = 16300;

if (isMainThread) {
    test('a joined player cannot freeze the host with a player_death for the host slot', async () => {
        const session = await startSession();
        try {
            await session.ready();
            const before = await session.rpc('host', { cmd: 'prove-local-movement' });
            assert.ok(before.delta > 0, 'harness must be able to move the host before the attack');

            await session.rpc('host', { cmd: 'arm-combat' });
            // Second party lookup resolves to the other client, not the host named in the payload.
            await session.rpc('host', { cmd: 'arm-slot-flip', decoySlot: 2 });
            await session.rpc('attacker', { cmd: 'send', type: 'player_death', payload: { slotIndex: 0 } });

            const host = await session.rpc('host', { cmd: 'exercise-local' });
            const otherClient = await session.rpc('victim', { cmd: 'exercise-slot', slot: 0 });
            const decoy = await session.rpc('host', { cmd: 'player-flags', slot: 2 });

            assert.equal(host.canMove, true, 'forged player_death must not clear the host canMove flag');
            assert.equal(host.canShoot, true, 'forged player_death must not clear the host canShoot flag');
            assert.equal(host.isDead, false, 'forged player_death must not mark the host dead');
            assert.ok(host.delta > 0, 'host must still move after a forged player_death');
            assert.ok(host.projectiles > 0, 'host must still shoot after a forged player_death');
            assert.equal(otherClient.canMove, true);
            assert.equal(otherClient.canShoot, true);
            assert.equal(otherClient.isDead, false);
            assert.ok(otherClient.delta > 0, 'other clients must not lock the host player');
            assert.equal(decoy.canMove, true);
            assert.equal(decoy.isDead, false);
        } finally {
            await session.stop();
        }
    });

    test('a joined player cannot freeze another player with a player_death for that slot', async () => {
        const session = await startSession();
        try {
            await session.ready();
            const before = await session.rpc('victim', { cmd: 'prove-local-movement' });
            assert.ok(before.delta > 0, 'harness must be able to move the other player before the attack');

            await session.rpc('host', { cmd: 'arm-combat-slot', slot: 2 });
            await session.rpc('host', { cmd: 'arm-slot-flip', decoySlot: 0 });
            await session.rpc('attacker', { cmd: 'send', type: 'player_death', payload: { slotIndex: 2 } });

            const victim = await session.rpc('victim', { cmd: 'exercise-local' });
            const hostShot = await session.rpc('host', { cmd: 'exercise-remote-shot', slot: 2 });
            const decoy = await session.rpc('host', { cmd: 'player-flags', slot: 0 });

            assert.equal(victim.canMove, true, 'forged player_death must not clear the other player canMove flag');
            assert.equal(victim.canShoot, true, 'forged player_death must not clear the other player canShoot flag');
            assert.equal(victim.isDead, false, 'forged player_death must not mark the other player dead');
            assert.ok(victim.delta > 0, 'the named player must still move');
            assert.equal(hostShot.canMove, true);
            assert.equal(hostShot.canShoot, true);
            assert.equal(hostShot.isDead, false);
            assert.ok(hostShot.projectiles > 0, 'the host must still fire for that player');
            assert.equal(decoy.isDead, false);
            assert.equal(decoy.canMove, true);
        } finally {
            await session.stop();
        }
    });

    test('a death notice for the sender slot still locks only that sender', async () => {
        const session = await startSession();
        try {
            await session.ready();
            await session.rpc('host', { cmd: 'arm-slot-flip', decoySlot: 0 });
            await session.rpc('attacker', { cmd: 'send', type: 'player_death', payload: { slotIndex: 1 } });

            const attacker = await session.rpc('host', { cmd: 'player-flags', slot: 1 });
            const host = await session.rpc('host', { cmd: 'player-flags', slot: 0 });
            const victim = await session.rpc('host', { cmd: 'player-flags', slot: 2 });

            assert.equal(attacker.isDead, true);
            assert.equal(attacker.canMove, false);
            assert.equal(attacker.canShoot, false);
            assert.equal(host.isDead, false);
            assert.equal(host.canMove, true);
            assert.equal(host.canShoot, true);
            assert.equal(victim.isDead, false);
            assert.equal(victim.canMove, true);
        } finally {
            await session.stop();
        }
    });

    test('a joined player cannot delete enemies or pickups on other clients', async () => {
        const session = await startSession();
        try {
            await session.ready();
            const spawned = await session.rpc('host', { cmd: 'spawn-world' });
            const attackerSeen = await session.rpc('attacker', { cmd: 'list-entities' });
            const victimSeen = await session.rpc('victim', { cmd: 'list-entities' });
            assert.ok(attackerSeen.enemies.includes(spawned.enemyId));
            assert.ok(attackerSeen.pickups.includes(spawned.pickupId));
            assert.ok(victimSeen.enemies.includes(spawned.enemyId));
            assert.ok(victimSeen.pickups.includes(spawned.pickupId));

            await session.rpc('attacker', {
                cmd: 'send',
                type: 'enemy_death',
                payload: {
                    entityId: spawned.enemyId,
                    entityType: 'enemy',
                    x: 10,
                    y: 20
                }
            });
            await session.rpc('attacker', {
                cmd: 'send',
                type: 'enemy_death',
                payload: {
                    entityId: spawned.pickupId,
                    entityType: 'xpPickup',
                    x: 30,
                    y: 40
                }
            });
            await session.rpc('host', { cmd: 'flush' });
            await session.rpc('attacker', { cmd: 'flush' });
            await session.rpc('victim', { cmd: 'flush' });

            for (const role of ['attacker', 'victim']) {
                const after = await session.rpc(role, { cmd: 'list-entities' });
                assert.ok(after.enemies.includes(spawned.enemyId), `${role} must keep the enemy`);
                assert.ok(after.pickups.includes(spawned.pickupId), `${role} must keep the pickup`);
                assert.equal(after.enemyAlive[spawned.enemyId], true);
                assert.equal(after.pickupAlive[spawned.pickupId], true);
            }

            const host = await session.rpc('host', { cmd: 'list-entities' });
            assert.ok(host.enemies.includes(spawned.enemyId));
            assert.ok(host.pickups.includes(spawned.pickupId));
        } finally {
            await session.stop();
        }
    });
} else {
    await runWorker();
}

async function startSession() {
    const workers = {};
    const peers = new Map();
    const pending = new Map();
    let nextRpc = 1;

    function route(worker, msg) {
        if (msg.op === 'register') {
            peers.set(msg.peerId, worker);
            worker.postMessage({ op: 'peer-registered', peerId: msg.peerId });
            return;
        }
        if (msg.op === 'connect') {
            const host = peers.get(msg.to);
            if (!host) {
                worker.postMessage({ op: 'peer-error', error: `no host ${msg.to}` });
                return;
            }
            host.postMessage({
                op: 'incoming',
                from: msg.from,
                to: msg.to,
                serialization: msg.serialization,
                reliable: msg.reliable
            });
            return;
        }
        if (msg.op === 'incoming-ready') {
            const client = peers.get(msg.from);
            client.postMessage({ op: 'link-open', to: msg.to });
            return;
        }
        if (msg.op === 'bytes') {
            const remote = peers.get(msg.to);
            if (!remote) return;
            remote.postMessage({ op: 'bytes', from: msg.from, bytes: msg.bytes });
            return;
        }
        if (msg.op === 'rpc-done') {
            const waiter = pending.get(msg.id);
            if (!waiter) return;
            pending.delete(msg.id);
            if (msg.error) waiter.reject(new Error(msg.error));
            else waiter.resolve(msg.result);
        }
    }

    for (const role of ['host', 'attacker', 'victim']) {
        const worker = new Worker(new URL(import.meta.url), { workerData: { role } });
        workers[role] = worker;
        worker.on('message', (msg) => route(worker, msg));
        worker.on('error', (err) => {
            for (const waiter of pending.values()) waiter.reject(err);
        });
    }

    async function rpc(role, message) {
        const id = nextRpc++;
        const response = new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
        });
        workers[role].postMessage({ ...message, id, op: 'rpc' });
        return response;
    }

    return {
        workers,
        rpc,
        async ready() {
            const host = await rpc('host', { cmd: 'boot' });
            assert.equal(host.code, HOST_CODE);
            await rpc('attacker', { cmd: 'boot', code: host.code });
            await rpc('host', { cmd: 'wait-party', size: 2 });
            await rpc('victim', { cmd: 'boot', code: host.code });
            await rpc('host', { cmd: 'wait-party', size: 3 });
            await rpc('host', { cmd: 'settle-join-timer' });
            await rpc('host', { cmd: 'start-match' });
            await rpc('attacker', { cmd: 'start-match' });
            await rpc('victim', { cmd: 'start-match' });
        },
        async stop() {
            await Promise.all(Object.values(workers).map(async (worker) => {
                await worker.terminate();
            }));
        }
    };
}

async function runWorker() {
    const { workerData, parentPort } = await import('node:worker_threads');
    const role = workerData.role;
    installBrowser(role);
    const transport = installPeerTransport(parentPort);

    const party = await import('../src/systems/partySystem.js');
    const mp = await import('../src/systems/multiplayerGame.js');
    const network = await import('../src/systems/networkSystem.js');
    const { createPlayer } = await import('../src/entities/player.js');
    const { setSoundEnabled } = await import('../src/systems/sounds.js');
    const { setupCombatSystem } = await import('../src/systems/combat.js');

    setSoundEnabled(false);

    const k = createKaplayStub();
    const players = new Map();
    let combatArmed = false;

    parentPort.on('message', async (msg) => {
        if (msg.op !== 'rpc') {
            transport.dispatch(msg);
            return;
        }
        try {
            const result = await handle(msg);
            parentPort.postMessage({ op: 'rpc-done', id: msg.id, result });
        } catch (err) {
            parentPort.postMessage({
                op: 'rpc-done',
                id: msg.id,
                error: err && err.stack ? err.stack : String(err)
            });
        }
    });

    async function handle(msg) {
        if (msg.cmd === 'boot') {
            if (role === 'host') {
                const code = await party.initParty(k);
                return { code: party.getInviteCode(), init: code || null };
            }
            const joined = await party.joinPartyAsClient(msg.code);
            if (!joined) throw new Error(`${role} failed to join`);
            await waitFor(() => party.getParty().slots.some((slot) => slot.isLocal && slot.playerId));
            const localSlot = party.getParty().slots.findIndex((slot) => slot.isLocal);
            return { localSlot };
        }
        if (msg.cmd === 'wait-party') {
            await waitFor(() => party.getPartySize() >= msg.size);
            return { size: party.getPartySize() };
        }
        if (msg.cmd === 'settle-join-timer') {
            await delay(350);
            return { settled: true };
        }
        if (msg.cmd === 'start-match') {
            const localSlot = party.getParty().slots.findIndex((slot) => slot.isLocal);
            mp.initMultiplayerGame(role === 'host', localSlot, k);
            for (let slot = 0; slot < 3; slot++) {
                const player = createPlayer(k, 100, 100, 'survivor');
                player.slotIndex = slot;
                player.isRemote = slot !== localSlot;
                player.move = { x: 0, y: 0 };
                mp.registerPlayer(slot, player);
                players.set(slot, player);
            }
            return { localSlot };
        }
        if (msg.cmd === 'prove-local-movement') {
            const localSlot = mp.getLocalPlayerSlot();
            return measureMove(localSlot, true);
        }
        if (msg.cmd === 'arm-combat') {
            armCombat(mp.getLocalPlayerSlot());
            return { armed: true };
        }
        if (msg.cmd === 'arm-combat-slot') {
            armCombat(msg.slot);
            return { armed: true };
        }
        if (msg.cmd === 'arm-slot-flip') {
            armSlotFlip(party.getParty(), attackerPeerId(party.getParty()), msg.decoySlot);
            return { armed: true };
        }
        if (msg.cmd === 'send') {
            network.sendToHost(msg.type, msg.payload);
            return { sent: true };
        }
        if (msg.cmd === 'flush') {
            return { flushed: true };
        }
        if (msg.cmd === 'exercise-local') {
            const localSlot = mp.getLocalPlayerSlot();
            const moved = measureMove(localSlot, true);
            return { ...flags(players.get(localSlot)), ...moved };
        }
        if (msg.cmd === 'exercise-slot') {
            const moved = measureMove(msg.slot, false);
            return { ...flags(players.get(msg.slot)), ...moved };
        }
        if (msg.cmd === 'player-flags') {
            return flags(players.get(msg.slot));
        }
        if (msg.cmd === 'exercise-remote-shot') {
            const player = players.get(msg.slot);
            const before = flags(player);
            player.aimAngle = 0;
            player.isShooting = true;
            const shotsBefore = k.get('projectile').length;
            k._time = 100;
            k._runUpdates();
            return {
                ...before,
                projectiles: k.get('projectile').length - shotsBefore
            };
        }
        if (msg.cmd === 'spawn-world') {
            const enemy = k.add([k.pos(40, 50), 'enemy']);
            const pickup = k.add([k.pos(60, 70), 'xpPickup']);
            const enemyId = mp.registerEnemy(enemy, { type: 'basic', floor: 1 });
            const pickupId = mp.registerPickup(pickup, { type: 'xpPickup', value: 3 });
            return { enemyId, pickupId };
        }
        if (msg.cmd === 'list-entities') {
            const enemies = k.get('enemy');
            const pickups = k.get('xpPickup');
            const enemyAlive = {};
            const pickupAlive = {};
            for (const enemy of enemies) {
                if (enemy.mpEntityId !== undefined) enemyAlive[enemy.mpEntityId] = enemy.exists();
            }
            for (const pickup of pickups) {
                if (pickup.mpEntityId !== undefined) pickupAlive[pickup.mpEntityId] = pickup.exists();
            }
            return {
                enemies: Object.keys(enemyAlive).map(Number),
                pickups: Object.keys(pickupAlive).map(Number),
                enemyAlive,
                pickupAlive
            };
        }
        throw new Error(`unknown cmd ${msg.cmd}`);
    }

    function armCombat(slot) {
        const player = players.get(slot);
        const target = k.add([k.pos(400, 100), 'enemy']);
        target.hp = () => 10;
        target.exists = () => true;
        k._time = 100;
        setupCombatSystem(k, player);
        combatArmed = true;
    }

    function measureMove(slot) {
        const player = players.get(slot);
        player.pos.x = 100;
        player.pos.y = 100;
        const shotsBefore = k.get('projectile').length;
        if (player.isRemote) {
            player.move = { x: 1, y: 0 };
        } else {
            k._release('d');
            k._press('d');
        }
        k._runUpdates();
        if (!player.isRemote) k._release('d');
        const delta = player.pos.x - 100;
        player.pos.x = 100;
        if (player.isRemote) player.move = { x: 0, y: 0 };
        return {
            delta,
            projectiles: k.get('projectile').length - shotsBefore,
            combatArmed
        };
    }
}

function flags(player) {
    return {
        canMove: player.canMove,
        canShoot: player.canShoot,
        isDead: Boolean(player.isDead)
    };
}

function attackerPeerId(partyState) {
    const peerId = partyState.slots[1] && partyState.slots[1].peerId;
    if (!peerId) throw new Error('attacker peer id missing');
    return peerId;
}

function armSlotFlip(partyState, peerId, decoySlot) {
    const realGet = partyState.peerIdToSlot.get.bind(partyState.peerIdToSlot);
    let gets = 0;
    partyState.peerIdToSlot.get = (id) => {
        const real = realGet(id);
        if (id !== peerId) return real;
        gets += 1;
        return gets === 1 ? real : decoySlot;
    };
    const realFind = Array.prototype.findIndex;
    let finds = 0;
    partyState.slots.findIndex = function (predicate) {
        const real = realFind.call(this, predicate);
        finds += 1;
        if (finds > 1 && this[real] && this[real].peerId === peerId) return decoySlot;
        return real;
    };
}

function installBrowser(role) {
    const store = new Map();
    const save = {
        version: 1,
        currency: 0,
        playerName: role === 'host' ? 'Host' : role === 'attacker' ? 'Attacker' : 'Victim',
        inviteCode: role === 'host' ? HOST_CODE : '135790',
        totalXP: 0,
        playerLevel: 1,
        selectedPortrait: 'default',
        selectedCharacter: 'survivor',
        unlocks: {
            characters: ['survivor'],
            weapons: ['default'],
            permanentUpgrades: [],
            portraits: ['default']
        },
        permanentUpgradeLevels: {},
        permanentUpgradePurchaseHistory: {},
        stats: {},
        achievements: [],
        runHistory: []
    };
    store.set('superSmashTexty_save', JSON.stringify(save));

    const listeners = new Map();
    globalThis.localStorage = {
        getItem: (key) => (store.has(key) ? store.get(key) : null),
        setItem: (key, value) => store.set(key, String(value)),
        removeItem: (key) => store.delete(key)
    };
    globalThis.document = {
        hasFocus: () => true,
        hidden: false,
        addEventListener() {},
        removeEventListener() {}
    };
    Object.defineProperty(globalThis, 'navigator', {
        value: {
            getGamepads: () => [],
            maxTouchPoints: 0
        },
        configurable: true,
        writable: true
    });
    globalThis.alert = () => {};
    globalThis.window = globalThis;
    globalThis.addEventListener = (type, fn) => {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
    };
    globalThis.removeEventListener = () => {};
    globalThis.AudioContext = class {
        constructor() {
            this.currentTime = 0;
            this.state = 'running';
            this.destination = {};
        }
        createOscillator() {
            return { type: '', frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, start() {}, stop() {} };
        }
        createGain() {
            return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
        }
        resume() { return Promise.resolve(); }
    };
    globalThis.webkitAudioContext = globalThis.AudioContext;
}

function installPeerTransport(parentPort) {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const connections = new Map();
    let peer = null;

    function encodeMessage(data) {
        const encoded = encoder.encode(JSON.stringify(data));
        if (encoded.byteLength >= CHUNKED_MTU) {
            const error = new Error('Message too big for JSON channel');
            error.type = 'message-too-big';
            throw error;
        }
        return encoded;
    }

    function decodeMessage(bytes) {
        const deserialized = JSON.parse(decoder.decode(bytes));
        if (deserialized && deserialized.__peerData && deserialized.__peerData.type === 'close') {
            return { close: true };
        }
        return { data: deserialized };
    }

    class DataConnection {
        constructor(remoteId) {
            this.peer = remoteId;
            this._open = false;
            this._handlers = new Map();
        }
        on(type, fn) {
            if (!this._handlers.has(type)) this._handlers.set(type, []);
            this._handlers.get(type).push(fn);
        }
        emit(type, ...args) {
            for (const fn of this._handlers.get(type) || []) fn(...args);
        }
        send(data) {
            if (!this._open) {
                this.emit('error', { type: 'not-open-yet' });
                return;
            }
            parentPort.postMessage({
                op: 'bytes',
                from: peer.id,
                to: this.peer,
                bytes: encodeMessage(data)
            });
        }
        close() {
            this._open = false;
            this.emit('close');
        }
    }

    class Peer {
        constructor(id) {
            this.requestedId = id;
            this.id = null;
            this._handlers = new Map();
            peer = this;
            queueMicrotask(() => {
                const assigned = this.requestedId || `guest-${Math.random().toString(36).slice(2)}`;
                parentPort.postMessage({ op: 'register', peerId: assigned });
            });
        }
        on(type, fn) {
            if (!this._handlers.has(type)) this._handlers.set(type, []);
            this._handlers.get(type).push(fn);
        }
        emit(type, ...args) {
            for (const fn of this._handlers.get(type) || []) fn(...args);
        }
        connect(remoteId, options = {}) {
            if (options.serialization !== 'json') {
                throw new Error(`expected json serialization, got ${options.serialization}`);
            }
            const conn = new DataConnection(remoteId);
            connections.set(remoteId, conn);
            parentPort.postMessage({
                op: 'connect',
                from: this.id,
                to: remoteId,
                serialization: options.serialization,
                reliable: options.reliable
            });
            return conn;
        }
        destroy() {
            this.emit('close');
        }
    }

    globalThis.Peer = Peer;

    return {
        dispatch(msg) {
            if (msg.op === 'peer-registered') {
                peer.id = msg.peerId;
                peer.emit('open', peer.id);
                return;
            }
            if (msg.op === 'incoming') {
                if (msg.serialization !== 'json') {
                    throw new Error(`incoming serialization ${msg.serialization}`);
                }
                const conn = new DataConnection(msg.from);
                connections.set(msg.from, conn);
                peer.emit('connection', conn);
                conn._open = true;
                conn.emit('open');
                parentPort.postMessage({ op: 'incoming-ready', from: msg.from, to: peer.id });
                return;
            }
            if (msg.op === 'link-open') {
                const conn = connections.get(msg.to);
                conn._open = true;
                conn.emit('open');
                return;
            }
            if (msg.op === 'bytes') {
                const conn = connections.get(msg.from);
                const decoded = decodeMessage(msg.bytes);
                if (decoded.close) {
                    conn.close();
                    return;
                }
                conn.emit('data', decoded.data);
            }
        }
    };
}

function createKaplayStub() {
    const updates = [];
    const keyDown = [];
    const keyUp = [];
    const entities = new Set();

    function vec2(x = 0, y = 0) {
        return {
            x,
            y,
            len() { return Math.hypot(this.x, this.y); },
            scale(s) { return vec2(this.x * s, this.y * s); },
            unit() {
                const length = this.len() || 1;
                return vec2(this.x / length, this.y / length);
            },
            add(other) { return vec2(this.x + other.x, this.y + other.y); },
            sub(other) { return vec2(this.x - other.x, this.y - other.y); },
            clone() { return vec2(this.x, this.y); }
        };
    }

    function add(components) {
        const obj = {
            pos: vec2(0, 0),
            tags: [],
            _alive: true,
            _destroyCbs: [],
            opacity: 1,
            angle: 0,
            hidden: false,
            exists() { return this._alive; },
            onDestroy(fn) { this._destroyCbs.push(fn); },
            onDeath(fn) { this._deathCbs.push(fn); },
            _deathCbs: [],
            onUpdate(fn) { updates.push(() => { if (obj._alive) fn(); }); },
            on() {}
        };
        for (const component of components) {
            if (typeof component === 'string') obj.tags.push(component);
            else if (typeof component === 'function') component(obj);
        }
        entities.add(obj);
        return obj;
    }

    const k = {
        paused: false,
        _time: 0,
        dt: () => 1 / 60,
        time: () => k._time,
        width: () => 800,
        height: () => 600,
        clamp: (value, min, max) => Math.max(min, Math.min(max, value)),
        vec2,
        rgb: (...channels) => ({ r: channels[0], g: channels[1], b: channels[2] }),
        add,
        destroy(obj) {
            if (!obj || obj._alive === false) return;
            obj._alive = false;
            for (const fn of obj._destroyCbs || []) fn();
            entities.delete(obj);
        },
        get(tag) {
            return [...entities].filter((obj) => obj._alive && obj.tags.includes(tag));
        },
        text: () => () => {},
        pos: (x, y) => (obj) => { obj.pos = vec2(x, y); },
        anchor: () => () => {},
        color: (...channels) => (obj) => { obj.color = channels; },
        scale: () => () => {},
        rotate: () => () => {},
        z: () => () => {},
        rect: () => () => {},
        opacity: () => () => {},
        area: () => () => {},
        lifespan: () => () => {},
        health: (amount) => (obj) => {
            obj._hp = amount;
            obj.hp = () => obj._hp;
            obj.setHP = (value) => { obj._hp = value; };
            obj.hurt = (damage) => { obj._hp -= damage; };
        },
        onUpdate(fn) { updates.push(fn); },
        onKeyDown(keys, fn) { keyDown.push({ keys, fn }); },
        onKeyRelease(keys, fn) { keyUp.push({ keys, fn }); },
        onCollide() {},
        isKeyDown: () => false,
        mousePos: () => ({ x: 400, y: 300 }),
        wait(delay, fn) { if (delay === 0) fn(); },
        gameData: {},
        _press(key) {
            for (const handler of keyDown) {
                if (handler.keys.includes(key)) handler.fn();
            }
        },
        _release(key) {
            for (const handler of keyUp) {
                if (handler.keys.includes(key)) handler.fn();
            }
        },
        _runUpdates() {
            for (const fn of updates) fn();
        }
    };
    return k;
}

function waitFor(predicate) {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const timer = setInterval(() => {
            try {
                if (predicate()) {
                    clearInterval(timer);
                    resolve();
                } else if (Date.now() - started > 4000) {
                    clearInterval(timer);
                    reject(new Error('timed out waiting for party state'));
                }
            } catch (err) {
                clearInterval(timer);
                reject(err);
            }
        }, 10);
    });
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
