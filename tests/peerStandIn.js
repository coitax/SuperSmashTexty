/**
 * In-process stand-in for the PeerJS client (peerjs 1.5.4) and the
 * peerjs-server 1.0.2 broker the game is written against.
 *
 * The steps below follow the source that was read, in order:
 * - peerjs 1.5.4 lib/peer.ts constructor, _initialize, connect, OFFER handling
 * - peerjs 1.5.4 lib/utils/validateId.ts and lib/utils/randomToken.ts
 * - peerjs 1.5.4 lib/socket.ts (id + client token + key "peerjs" on the socket)
 * - peerjs 1.5.4 lib/negotiator.ts _makeOffer (OFFER to dst, no shared secret)
 * - peerjs 1.5.4 lib/dataconnection/DataConnection.ts send/close
 * - peerjs 1.5.4 lib/dataconnection/BufferedConnection/Json.ts stringify, parse, emit "data"
 * - peerjs-server 1.0.2 src/services/webSocketServer/index.ts id registration
 * - peerjs-server 1.0.2 src/models/realm.ts generateClientId (randomUUID)
 * - peerjs-server 1.0.2 src/messageHandler/handlers/transmission/index.ts forward by dst id
 *
 * WebRTC ICE itself is not run. Once both sides have exchanged OFFER/ANSWER,
 * application bytes are delivered the way Json.ts delivers a data-channel
 * message: JSON.stringify on send, JSON.parse on receive, then "data".
 */

import { parentPort } from 'node:worker_threads';

const ID_RE = /^[A-Za-z0-9]+(?:[ _-][A-Za-z0-9]+)*$/;
const DEFAULT_KEY = 'peerjs';

function randomToken() {
    return Math.random().toString(36).slice(2);
}

class PeerError extends Error {
    constructor(type, message) {
        super(typeof message === 'string' ? message : 'Peer error');
        this.type = type;
    }
}

class Emitter {
    constructor() {
        this._events = new Map();
    }

    on(name, cb) {
        if (!this._events.has(name)) this._events.set(name, []);
        this._events.get(name).push(cb);
        return this;
    }

    emit(name, ...args) {
        for (const cb of this._events.get(name) || []) cb(...args);
    }
}

let activePeer = null;
let reqSeq = 1;
const pendingReqs = new Map();

function post(message) {
    parentPort.postMessage(message);
}

class DataConnection extends Emitter {
    constructor(peerId, provider, options) {
        super();
        this.peer = peerId;
        this.provider = provider;
        this.connectionId = options.connectionId || `dc_${randomToken()}`;
        this.serialization = options.serialization || 'json';
        this.reliable = !!options.reliable;
        this.metadata = options.metadata;
        this.label = options.label || this.connectionId;
        this.open = false;
        this._closed = false;
        this._originator = !!options.originator;
        provider._track(this);
    }

    send(data) {
        if (!this.open) {
            this.emit('error', new PeerError('not-open-yet', 'Connection is not open. You should listen for the `open` event before sending messages.'));
            return;
        }
        // Json.ts: stringify, then the remote parses and emits "data".
        const raw = JSON.stringify(data);
        post({
            kind: 'data',
            dst: this.peer,
            connectionId: this.connectionId,
            raw
        });
    }

    close() {
        if (this._closed) return;
        this._closed = true;
        this.open = false;
        this.provider._untrack(this);
        post({
            kind: 'dc-close',
            dst: this.peer,
            connectionId: this.connectionId
        });
        this.emit('close');
    }

    _markOpen() {
        if (this._closed || this.open) return;
        this.open = true;
        this.emit('open');
    }

    _receiveRaw(raw) {
        if (this._closed) return;
        let deserialized;
        try {
            deserialized = JSON.parse(raw);
        } catch {
            return;
        }
        const peerData = deserialized && deserialized.__peerData;
        if (peerData && peerData.type === 'close') {
            this.close();
            return;
        }
        this.provider._record('in', this.peer, deserialized);
        this.emit('data', deserialized);
    }

    _remoteClosed() {
        if (this._closed) return;
        this._closed = true;
        this.open = false;
        this.provider._untrack(this);
        this.emit('close');
    }
}

class Peer extends Emitter {
    constructor(id, options) {
        super();
        let userId;
        if (id && id.constructor === Object) {
            options = id;
        } else if (id) {
            userId = id.toString();
        }

        this._options = {
            debug: 0,
            key: DEFAULT_KEY,
            token: randomToken(),
            ...options
        };
        this._id = null;
        this._destroyed = false;
        this._connections = new Map();
        this.destroyed = false;
        this.disconnected = false;
        activePeer = this;

        if (userId && !(!userId || ID_RE.test(userId))) {
            setTimeout(() => {
                this.emit('error', new PeerError('invalid-id', `ID "${userId}" is invalid`));
            }, 0);
            return;
        }

        if (userId) {
            this._initialize(userId);
        } else {
            const reqId = reqSeq++;
            pendingReqs.set(reqId, (allocated) => {
                if (this._destroyed) return;
                this._initialize(allocated);
            });
            post({ kind: 'retrieve-id', reqId });
        }
    }

    get id() {
        return this._id;
    }

    _initialize(id) {
        this._id = id;
        const reqId = reqSeq++;
        pendingReqs.set(reqId, (status) => {
            if (this._destroyed) return;
            if (status === 'open') {
                this.emit('open', this._id);
            } else if (status === 'id-taken') {
                this.emit('error', new PeerError('unavailable-id', `ID "${this._id}" is taken`));
            } else if (status === 'invalid-key') {
                this.emit('error', new PeerError('invalid-key', `API KEY "${this._options.key}" is invalid`));
            }
        });
        post({
            kind: 'register',
            reqId,
            id,
            token: this._options.token,
            key: this._options.key
        });
    }

    _track(conn) {
        this._connections.set(conn.connectionId, conn);
    }

    _untrack(conn) {
        if (this._connections.get(conn.connectionId) === conn) {
            this._connections.delete(conn.connectionId);
        }
    }

    _record(dir, remotePeerId, message) {
        if (typeof globalThis.__recordPeerData === 'function') {
            globalThis.__recordPeerData({ dir, remotePeerId, message });
        }
    }

    connect(peer, options = {}) {
        if (this.disconnected) {
            this.emit('error', new PeerError('disconnected', 'Cannot connect to new Peer after disconnecting from server.'));
            return;
        }
        const serialization = options.serialization || 'json';
        const conn = new DataConnection(peer, this, {
            originator: true,
            serialization,
            reliable: options.reliable,
            metadata: options.metadata
        });
        // negotiator _makeOffer: signaling OFFER addressed only by destination peer id.
        post({
            kind: 'signal',
            message: {
                type: 'OFFER',
                dst: peer,
                payload: {
                    type: 'data',
                    connectionId: conn.connectionId,
                    metadata: conn.metadata,
                    label: conn.label,
                    reliable: conn.reliable,
                    serialization: conn.serialization
                }
            }
        });
        return conn;
    }

    _onRegistered(reqId, status) {
        const cb = pendingReqs.get(reqId);
        pendingReqs.delete(reqId);
        if (cb) cb(status);
    }

    _onAllocated(reqId, id) {
        const cb = pendingReqs.get(reqId);
        pendingReqs.delete(reqId);
        if (cb) cb(id);
    }

    _onSignal(message) {
        if (this._destroyed) return;
        if (message.type === 'OFFER' && message.payload && message.payload.type === 'data') {
            const conn = new DataConnection(message.src, this, {
                connectionId: message.payload.connectionId,
                serialization: message.payload.serialization || 'json',
                reliable: message.payload.reliable,
                metadata: message.payload.metadata,
                label: message.payload.label
            });
            // peer.ts emits "connection" before the data channel is open.
            // Listeners attach during this emit; open follows, still in this turn,
            // so the host stores the connection before any application send.
            this.emit('connection', conn);
            post({
                kind: 'signal',
                message: {
                    type: 'ANSWER',
                    dst: message.src,
                    payload: {
                        connectionId: conn.connectionId,
                        serialization: conn.serialization
                    }
                }
            });
            conn._markOpen();
            return;
        }
        if (message.type === 'ANSWER') {
            const conn = this._connections.get(message.payload.connectionId);
            if (conn) conn._markOpen();
        }
    }

    _onData(_src, connectionId, raw) {
        const conn = this._connections.get(connectionId);
        if (!conn) return;
        conn._receiveRaw(raw);
    }

    _onDcClose(connectionId) {
        const conn = this._connections.get(connectionId);
        if (conn) conn._remoteClosed();
    }

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        this.destroyed = true;
        this.disconnected = true;
        for (const conn of [...this._connections.values()]) {
            conn.close();
        }
        if (this._id) post({ kind: 'unregister', id: this._id });
        if (activePeer === this) activePeer = null;
    }
}

// Record outgoing application messages at send time as well.
const originalSend = DataConnection.prototype.send;
DataConnection.prototype.send = function (data) {
    if (this.open && this.provider) {
        this.provider._record('out', this.peer, data);
    }
    return originalSend.call(this, data);
};

export function installPeer() {
    globalThis.Peer = Peer;
}

export function dispatchPeerMessage(msg) {
    if (!activePeer && msg.kind !== 'allocated-id' && msg.kind !== 'registered') {
        // A late message for a destroyed peer. Allocation/registration can
        // still target the peer that posted them if it is active.
    }
    if (msg.kind === 'allocated-id') {
        if (activePeer) activePeer._onAllocated(msg.reqId, msg.id);
        return;
    }
    if (msg.kind === 'registered') {
        if (activePeer) activePeer._onRegistered(msg.reqId, msg.status);
        return;
    }
    if (!activePeer) return;
    if (msg.kind === 'forward-signal') activePeer._onSignal(msg.message);
    else if (msg.kind === 'forward-data') activePeer._onData(msg.src, msg.connectionId, msg.raw);
    else if (msg.kind === 'forward-dc-close') activePeer._onDcClose(msg.connectionId);
}

