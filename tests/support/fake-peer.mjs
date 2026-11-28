/**
 * Minimal Peer constructor. initNetwork does `new Peer(id, config)` and
 * listens for `open`, `error`, and (as host) `connection`.
 *
 * The `connection` event is what peerjs 1.5.4 emits for a data offer
 * (lib/peer.ts, ServerMessageType.Offer, ConnectionType.Data). The object
 * passed here is the JSON data connection from json-data-channel.mjs.
 */

import { createJsonConnection } from './json-data-channel.mjs';

const peers = new Map();

export function installFakePeer() {
    class Peer {
        constructor(id) {
            this.id = id;
            this.handlers = {};
            if (id) {
                peers.set(id, this);
            }
            Peer.latest = this;
        }

        on(event, callback) {
            this.handlers[event] = callback;
            if (event === 'open') {
                queueMicrotask(() => callback(this.id));
            }
        }

        connect(hostPeerId) {
            const conn = createJsonConnection(hostPeerId);
            Peer.lastClientConnection = conn;
            const facade = conn.facade;
            const originalOn = facade.on.bind(facade);
            facade.on = (event, callback) => {
                originalOn(event, callback);
                if (event === 'open') {
                    queueMicrotask(() => callback());
                }
            };
            return facade;
        }

        destroy() {
            peers.delete(this.id);
        }
    }

    globalThis.Peer = Peer;
    return { peers, Peer };
}

/**
 * Open an attacker data connection on the live host peer and mark it open
 * so the host records it before any join message.
 */
export function connectAttacker(peers, peerId) {
    const host = [...peers.values()].find((peer) => String(peer.id).startsWith('smash-'));
    if (!host || typeof host.handlers.connection !== 'function') {
        throw new Error('Host peer is not listening for connections');
    }

    const conn = createJsonConnection(peerId);
    host.handlers.connection(conn.facade);
    conn.emit('open');
    return conn;
}
