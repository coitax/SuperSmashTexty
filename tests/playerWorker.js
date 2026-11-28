/**
 * One game client. Module state in partySystem / networkSystem is a singleton,
 * so each player runs in its own worker.
 */

import { parentPort } from 'node:worker_threads';
import { installPeer, dispatchPeerMessage } from './peerStandIn.js';

const store = new Map();
globalThis.localStorage = {
    getItem(key) {
        return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
        store.set(key, String(value));
    },
    removeItem(key) {
        store.delete(key);
    }
};

globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    location: { protocol: 'https:', hostname: 'localhost' }
};
globalThis.alert = () => {};
console.log = () => {};
console.warn = () => {};

const traffic = [];
globalThis.__recordPeerData = (entry) => {
    traffic.push({
        dir: entry.dir,
        remotePeerId: entry.remotePeerId,
        message: entry.message
    });
};

installPeer();

const meta = await import('../src/systems/metaProgression.js');
const party = await import('../src/systems/partySystem.js');
const network = await import('../src/systems/networkSystem.js');

function waitFor(predicate, timeoutMs) {
    const start = Date.now();
    return new Promise((resolve) => {
        const timer = setInterval(() => {
            let ok = false;
            try {
                ok = predicate();
            } catch {
                ok = false;
            }
            if (ok || Date.now() - start > timeoutMs) {
                clearInterval(timer);
                resolve(ok);
            }
        }, 15);
    });
}

async function joinAndRequestHostProfile(hostInviteCode) {
    const joined = await party.joinPartyAsClient(hostInviteCode);
    if (!joined) {
        return { joined: false, synced: false, profile: null };
    }
    const synced = await waitFor(() => {
        const slot = party.getParty().slots[0];
        return !!(slot && slot.playerId && slot.playerName);
    }, 2000);
    if (!synced) {
        return { joined: true, synced: false, profile: null };
    }
    const profile = await new Promise((resolve) => {
        party.requestPlayerProfile(0, (data) => resolve(data));
    });
    return { joined: true, synced: true, profile };
}

const commands = {
    async init({ playerName, inviteCode }) {
        meta.setPlayerName(playerName);
        meta.setInviteCode(inviteCode);
        await party.initParty();
        return commands.status();
    },
    async join({ hostInviteCode }) {
        const joined = await party.joinPartyAsClient(hostInviteCode);
        return { joined };
    },
    async joinAndReadHostProfile({ hostInviteCode }) {
        return joinAndRequestHostProfile(hostInviteCode);
    },
    toggleReady() {
        return party.toggleReady();
    },
    changeCharacter({ characterKey }) {
        party.broadcastCharacterChange(characterKey);
        return true;
    },
    disconnectNetwork() {
        network.disconnect();
        return true;
    },
    status() {
        const info = network.getNetworkInfo();
        return {
            inviteCode: meta.getInviteCode(),
            playerName: meta.getPlayerName(),
            isHost: party.getParty().isHost,
            networkInitialized: party.getParty().networkInitialized,
            peerId: info.peerId,
            peerReady: !!(info.isInitialized && info.isHost),
            hostId: info.hostId
        };
    },
    getTraffic() {
        return traffic.slice();
    },
    clearTraffic() {
        traffic.length = 0;
        return true;
    }
};

parentPort.on('message', async (msg) => {
    if (msg.kind === 'cmd') {
        try {
            const fn = commands[msg.name];
            if (!fn) throw new Error(`Unknown command ${msg.name}`);
            const result = await fn(msg.args || {});
            parentPort.postMessage({ kind: 'cmd-result', reqId: msg.reqId, result });
        } catch (err) {
            parentPort.postMessage({
                kind: 'cmd-result',
                reqId: msg.reqId,
                error: err && err.stack ? err.stack : String(err)
            });
        }
        return;
    }
    dispatchPeerMessage(msg);
});
