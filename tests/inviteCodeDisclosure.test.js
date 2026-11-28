/**
 * Invite codes are the host peer id (`smash-` + the saved code). These tests
 * run the real party and network modules against an in-process PeerJS stand-in
 * (tests/peerStandIn.js) and require:
 * - join_request, party_sync, and party_update do not carry another player's
 *   saved invite code
 * - after the host leaves, that saved code no longer admits someone who was
 *   in the lobby, and does not return the saved profile
 *
 * The assertions fail while the disclosure is present.
 *
 * Run:
 *   node --test tests/inviteCodeDisclosure.test.js
 *
 * Not covered here:
 * - addPlayerToParty is never called by the game
 * - attemptReconnect is never called by the game
 * - the player_info handler rebroadcasts a party update, but no game code sends player_info
 * - removePlayerFromPartyAndShift is never called
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';

const HOST_CODE = '147258';
const VICTIM_CODE = '258369';
const ATTACKER_CODE = '369147';
const SAVED_CODES = [HOST_CODE, VICTIM_CODE, ATTACKER_CODE];

function createBroker() {
    const clients = new Map();
    const queues = new Map();

    function workerId(worker) {
        for (const [id, client] of clients) {
            if (client.worker === worker) return id;
        }
        return null;
    }

    function send(worker, message) {
        worker.postMessage(message);
    }

    function flushQueue(id) {
        const queued = queues.get(id);
        const client = clients.get(id);
        if (!queued || !client) return;
        queues.delete(id);
        for (const message of queued) send(client.worker, message);
    }

    function forward(dstId, packet) {
        const destination = clients.get(dstId);
        if (destination) {
            send(destination.worker, packet);
            return;
        }
        if (packet.kind === 'forward-signal') {
            if (!queues.has(dstId)) queues.set(dstId, []);
            queues.get(dstId).push(packet);
        }
    }

    return {
        attach(worker) {
            worker.on('message', (msg) => {
                if (!msg || msg.kind === 'cmd-result') return;
                if (msg.kind === 'retrieve-id') {
                    let id = randomUUID();
                    while (clients.has(id)) id = randomUUID();
                    send(worker, { kind: 'allocated-id', reqId: msg.reqId, id });
                    return;
                }
                if (msg.kind === 'register') {
                    if (msg.key !== 'peerjs') {
                        send(worker, { kind: 'registered', reqId: msg.reqId, status: 'invalid-key' });
                        return;
                    }
                    const existing = clients.get(msg.id);
                    if (existing && existing.token !== msg.token) {
                        send(worker, { kind: 'registered', reqId: msg.reqId, status: 'id-taken', id: msg.id });
                        return;
                    }
                    clients.set(msg.id, { worker, token: msg.token });
                    send(worker, { kind: 'registered', reqId: msg.reqId, status: 'open', id: msg.id });
                    flushQueue(msg.id);
                    return;
                }
                if (msg.kind === 'unregister') {
                    const current = clients.get(msg.id);
                    if (current && current.worker === worker) clients.delete(msg.id);
                    return;
                }
                const src = workerId(worker);
                if (!src) return;
                if (msg.kind === 'signal') {
                    forward(msg.message.dst, {
                        kind: 'forward-signal',
                        message: {
                            type: msg.message.type,
                            src,
                            dst: msg.message.dst,
                            payload: msg.message.payload
                        }
                    });
                    return;
                }
                if (msg.kind === 'data') {
                    forward(msg.dst, {
                        kind: 'forward-data',
                        src,
                        connectionId: msg.connectionId,
                        raw: msg.raw
                    });
                    return;
                }
                if (msg.kind === 'dc-close') {
                    forward(msg.dst, {
                        kind: 'forward-dc-close',
                        src,
                        connectionId: msg.connectionId
                    });
                }
            });
        }
    };
}

function startPlayer(broker) {
    const worker = new Worker(new URL('./playerWorker.js', import.meta.url));
    const pending = new Map();
    let seq = 1;
    worker.on('message', (msg) => {
        if (!msg || msg.kind !== 'cmd-result') return;
        const waiter = pending.get(msg.reqId);
        if (!waiter) return;
        pending.delete(msg.reqId);
        if (msg.error) waiter.reject(new Error(msg.error));
        else waiter.resolve(msg.result);
    });
    broker.attach(worker);
    return {
        worker,
        cmd(name, args) {
            const reqId = seq++;
            return new Promise((resolve, reject) => {
                pending.set(reqId, { resolve, reject });
                worker.postMessage({ kind: 'cmd', reqId, name, args });
            });
        },
        async close() {
            await worker.terminate();
        }
    };
}

function stringsIn(value, found = []) {
    if (typeof value === 'string') found.push(value);
    else if (Array.isArray(value)) {
        for (const item of value) stringsIn(item, found);
    } else if (value && typeof value === 'object') {
        for (const item of Object.values(value)) stringsIn(item, found);
    }
    return found;
}

function savedCodesIn(message, codes) {
    const strings = stringsIn(message);
    return codes.filter((code) => strings.some((value) => value === code || value === `smash-${code}`));
}

function incomingOfType(traffic, type) {
    return traffic.filter((entry) => entry.dir === 'in' && entry.message && entry.message.type === type);
}

async function waitForStatus(player, predicate, timeoutMs = 3000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const status = await player.cmd('status');
        if (predicate(status)) return status;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const status = await player.cmd('status');
    throw new Error(`Timed out waiting for player status: ${JSON.stringify(status)}`);
}

test('lobby party messages disclose saved invite codes and they still join later', { timeout: 20000 }, async () => {
    const broker = createBroker();
    const host = startPlayer(broker);
    const victim = startPlayer(broker);
    const attacker = startPlayer(broker);
    const failures = new Set();

    try {
        await host.cmd('init', { playerName: 'Host', inviteCode: HOST_CODE });
        await victim.cmd('init', { playerName: 'Victim', inviteCode: VICTIM_CODE });
        await attacker.cmd('init', { playerName: 'Attacker', inviteCode: ATTACKER_CODE });

        const victimJoin = await victim.cmd('join', { hostInviteCode: HOST_CODE });
        assert.equal(victimJoin.joined, true, 'victim could not join the host; the harness did not open the lobby');
        const attackerJoin = await attacker.cmd('join', { hostInviteCode: HOST_CODE });
        assert.equal(attackerJoin.joined, true, 'attacker could not join the host; the harness did not open the lobby');

        await victim.cmd('toggleReady');
        await host.cmd('changeCharacter', { characterKey: 'scout' });

        const hostTraffic = await host.cmd('getTraffic');
        const victimTraffic = await victim.cmd('getTraffic');
        const attackerTraffic = await attacker.cmd('getTraffic');

        const joinRequests = incomingOfType(hostTraffic, 'join_request');
        if (joinRequests.length < 2) {
            throw new Error(`harness delivered ${joinRequests.length} join_request messages`);
        }
        for (const entry of joinRequests) {
            const leaked = savedCodesIn(entry.message, [VICTIM_CODE, ATTACKER_CODE]);
            if (leaked.length > 0) {
                failures.add(`join_request to the host carried saved invite code ${leaked.join(', ')}`);
            }
        }

        const attackerSync = incomingOfType(attackerTraffic, 'party_sync');
        if (attackerSync.length < 1) {
            throw new Error('harness did not deliver party_sync to the second joiner');
        }
        for (const entry of attackerSync) {
            const leaked = savedCodesIn(entry.message, [HOST_CODE, VICTIM_CODE]);
            if (leaked.length > 0) {
                failures.add(`party_sync to a lobby member carried saved invite code ${leaked.join(', ')}`);
            }
        }

        const partyUpdates = [
            ...incomingOfType(victimTraffic, 'party_update'),
            ...incomingOfType(attackerTraffic, 'party_update')
        ];
        if (partyUpdates.length < 1) {
            throw new Error('harness did not deliver party_update');
        }
        for (const entry of partyUpdates) {
            const leaked = savedCodesIn(entry.message, SAVED_CODES);
            if (leaked.length > 0) {
                failures.add(`party_update carried saved invite code ${leaked.join(', ')}`);
            }
        }

        await host.cmd('disconnectNetwork');

        const victimAfter = await waitForStatus(
            victim,
            (status) => status.isHost && status.peerReady
        );
        await waitForStatus(attacker, (status) => status.isHost && status.peerReady);

        const reuse = await attacker.cmd('joinAndReadHostProfile', { hostInviteCode: VICTIM_CODE });
        const profileName = reuse.profile && reuse.profile.playerName;
        const gotSavedProfile = !!(
            reuse.profile
            && reuse.profile.playerName === 'Victim'
            && reuse.profile.stats
            && Array.isArray(reuse.profile.achievements)
        );
        if (gotSavedProfile) {
            failures.add(
                `after the host left, the saved code ${VICTIM_CODE} still opened the victim's lobby ` +
                `and returned the saved profile (hosted as ${victimAfter.peerId}, invite ${victimAfter.inviteCode})`
            );
        } else if (reuse.joined && reuse.synced && victimAfter.peerId === VICTIM_CODE) {
            failures.add(
                `after the host left, the saved code ${VICTIM_CODE} still synced a lobby with the victim ` +
                `(profile=${profileName})`
            );
        }

        assert.deepEqual([...failures], []);
    } finally {
        await Promise.all([host.close(), victim.close(), attacker.close()]);
    }
});

test('party update after a member leaves still omits saved invite codes', { timeout: 25000 }, async () => {
    const broker = createBroker();
    const host = startPlayer(broker);
    const victim = startPlayer(broker);
    const attacker = startPlayer(broker);

    try {
        await host.cmd('init', { playerName: 'Host', inviteCode: HOST_CODE });
        await victim.cmd('init', { playerName: 'Victim', inviteCode: VICTIM_CODE });
        await attacker.cmd('init', { playerName: 'Attacker', inviteCode: ATTACKER_CODE });
        assert.equal((await victim.cmd('join', { hostInviteCode: HOST_CODE })).joined, true);
        assert.equal((await attacker.cmd('join', { hostInviteCode: HOST_CODE })).joined, true);

        // Let join broadcasts finish, then watch only messages from the leave.
        await new Promise((resolve) => setTimeout(resolve, 300));
        await victim.cmd('clearTraffic');
        await attacker.cmd('disconnectNetwork');

        const started = Date.now();
        let removalUpdate = null;
        while (Date.now() - started < 18000) {
            const traffic = await victim.cmd('getTraffic');
            const updates = incomingOfType(traffic, 'party_update');
            removalUpdate = updates.find((entry) => {
                const slots = entry.message.payload && entry.message.payload.slots;
                return Array.isArray(slots) && !slots.some((slot) => slot.playerName === 'Attacker');
            });
            if (removalUpdate) break;
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
        if (!removalUpdate) {
            throw new Error('harness did not deliver the party_update from finalizeDisconnect');
        }

        const leaked = savedCodesIn(removalUpdate.message, [HOST_CODE, VICTIM_CODE]);
        assert.deepEqual(
            leaked,
            [],
            `party_update after a member left carried saved invite code ${leaked.join(', ')}`
        );
    } finally {
        await Promise.all([host.close(), victim.close(), attacker.close()]);
    }
});
