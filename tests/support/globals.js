// Browser globals the game modules touch. Installed before those modules load.
const store = new Map();

globalThis.localStorage = {
    getItem(key) {
        return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
        store.set(String(key), String(value));
    },
    removeItem(key) {
        store.delete(key);
    },
    clear() {
        store.clear();
    },
    key(index) {
        return Array.from(store.keys())[index] ?? null;
    },
    get length() {
        return store.size;
    }
};

globalThis.window = globalThis;
globalThis.self = globalThis;

if (typeof globalThis.addEventListener !== 'function') {
    globalThis.addEventListener = () => {};
    globalThis.removeEventListener = () => {};
}

const nav = globalThis.navigator;
nav.getGamepads = () => [];
if (nav.maxTouchPoints === undefined) {
    try { nav.maxTouchPoints = 0; } catch { /* read-only in this runtime */ }
}

const doc = globalThis.document || {};
if (typeof doc.hasFocus !== 'function') doc.hasFocus = () => true;
if (typeof doc.querySelector !== 'function') doc.querySelector = () => null;
if (typeof doc.createElement !== 'function') {
    doc.createElement = () => ({
        style: {},
        width: 800,
        height: 600,
        addEventListener() {},
        getContext() {
            return {};
        }
    });
}
if (typeof doc.addEventListener !== 'function') doc.addEventListener = () => {};
if (!doc.body) doc.body = { appendChild() {}, style: {} };
try {
    globalThis.document = doc;
} catch {
    // document is already the global one; methods were patched in place
}

globalThis.Audio = class Audio {
    constructor() {
        this.loop = false;
        this.volume = 1;
        this.paused = true;
        this.currentTime = 0;
    }
    play() {
        this.paused = false;
        return Promise.resolve();
    }
    pause() {
        this.paused = true;
    }
};

function audioParam(initial = 0) {
    return {
        value: initial,
        setValueAtTime() {},
        linearRampToValueAtTime() {},
        exponentialRampToValueAtTime() {},
        cancelScheduledValues() {}
    };
}

globalThis.AudioContext = class AudioContext {
    constructor() {
        this.state = 'running';
        this.currentTime = 0;
        this.destination = {};
        this.sampleRate = 44100;
    }
    createGain() {
        return { gain: audioParam(1), connect() {} };
    }
    createOscillator() {
        return {
            type: 'square',
            frequency: audioParam(440),
            connect() {},
            start() {},
            stop() {}
        };
    }
    createBuffer() {
        return { getChannelData() { return new Float32Array(1); } };
    }
    createBufferSource() {
        return { buffer: null, connect() {}, start() {}, stop() {} };
    }
    resume() {
        return Promise.resolve();
    }
};
globalThis.webkitAudioContext = globalThis.AudioContext;

// PeerJS 1.5.4 JSON data channel, used by connect(..., { serialization: 'json' }).
// Send path: Json._send stringifies, TextEncodes, and drops payloads whose
// encoded size is >= BinaryPackChunker.chunkedMTU (16300).
// Receive path: TextDecoder + JSON.parse, then drop PeerJS close frames,
// otherwise emit "data". peers/peerjs v1.5.4
// lib/dataconnection/BufferedConnection/Json.ts
// lib/dataconnection/BufferedConnection/binaryPackChunker.ts
const JSON_CHANNEL_MAX_BYTES = 16300;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

class JsonDataConnection {
    constructor(peerId) {
        this.peer = peerId;
        this.open = false;
        this.listeners = new Map();
    }

    on(event, handler) {
        this.listeners.set(event, handler);
    }

    emit(event, ...args) {
        const handler = this.listeners.get(event);
        if (handler) handler(...args);
    }

    send(data) {
        if (!this.open) return;
        const encoded = textEncoder.encode(JSON.stringify(data));
        if (encoded.byteLength >= JSON_CHANNEL_MAX_BYTES) return;
        const deserialized = JSON.parse(textDecoder.decode(encoded));
        const peerData = deserialized.__peerData;
        if (peerData && peerData.type === 'close') {
            this.close();
            return;
        }
        this.emit('data', deserialized);
    }

    close() {
        this.open = false;
        this.emit('close');
    }
}

class PeerStub {
    constructor(id) {
        this._id = id;
        this._listeners = new Map();
        this.destroyed = false;
        queueMicrotask(() => {
            if (this.destroyed) return;
            const assigned = this._id || `client-${Math.random().toString(16).slice(2)}`;
            this._id = assigned;
            this.emit('open', assigned);
        });
    }

    on(event, handler) {
        this._listeners.set(event, handler);
    }

    emit(event, ...args) {
        const handler = this._listeners.get(event);
        if (handler) handler(...args);
    }

    connect(peerId, options = {}) {
        if (options.serialization !== 'json') {
            throw new Error(`expected json serialization, got ${options.serialization}`);
        }
        const conn = new JsonDataConnection(peerId);
        globalThis.__victimHostConnection = conn;
        queueMicrotask(() => {
            conn.open = true;
            conn.emit('open');
        });
        return conn;
    }

    destroy() {
        this.destroyed = true;
    }
}

globalThis.Peer = PeerStub;

export function deliverHostMessage(type, payload) {
    const conn = globalThis.__victimHostConnection;
    if (!conn) {
        throw new Error('victim is not connected to a host');
    }
    const encoded = textEncoder.encode(JSON.stringify({ type, payload }));
    if (encoded.byteLength >= JSON_CHANNEL_MAX_BYTES) {
        throw new Error('host message dropped: larger than PeerJS JSON channel limit');
    }
    const deserialized = JSON.parse(textDecoder.decode(encoded));
    const peerData = deserialized.__peerData;
    if (peerData && peerData.type === 'close') {
        conn.close();
        return;
    }
    if (!conn.listeners.has('data')) {
        throw new Error(`no data handler registered for host message ${type}`);
    }
    conn.emit('data', deserialized);
}
