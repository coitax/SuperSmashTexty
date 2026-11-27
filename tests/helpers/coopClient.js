/**
 * Drives a joined co-op client in headless Chrome.
 *
 * WebRTC is not available to the test, so the PeerJS script the page loads
 * (peerjs@1.5.4, index.html) is replaced with a transport stand-in. The
 * stand-in performs the same receive steps as peerjs Json._handleDataMessage
 * (peerjs 1.5.4 lib/dataconnection/BufferedConnection/Json.ts):
 *   UTF-8 decode the data-channel bytes, JSON.parse, drop a PeerJS
 *   __peerData close frame, otherwise emit "data".
 * connectToHost in src/systems/networkSystem.js registers the real
 * handleMessage on that "data" event. Everything after that is the game.
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const PEERJS_RECEIVE_SHIM = `
(function () {
  function Emitter() { this._h = Object.create(null); }
  Emitter.prototype.on = function (ev, cb) {
    (this._h[ev] || (this._h[ev] = [])).push(cb);
    return this;
  };
  Emitter.prototype.emit = function (ev, arg) {
    var list = this._h[ev] || [];
    for (var i = 0; i < list.length; i++) list[i](arg);
  };

  // peerjs 1.5.4 Json._handleDataMessage
  function deliver(conn, messageObject) {
    var encoded = new TextEncoder().encode(JSON.stringify(messageObject));
    var deserializedData = JSON.parse(new TextDecoder().decode(encoded));
    var peerData = deserializedData['__peerData'];
    if (peerData && peerData.type === 'close') {
      conn.emit('close');
      return;
    }
    conn.emit('data', deserializedData);
  }

  function DataConnection(peerId) {
    Emitter.call(this);
    this.peer = peerId;
    this.open = false;
    this.peerConnection = null;
  }
  DataConnection.prototype = Object.create(Emitter.prototype);
  DataConnection.prototype.send = function (data) {
    (window.__sentToHost || (window.__sentToHost = [])).push(data);
  };
  DataConnection.prototype.close = function () { this.emit('close'); };

  function Peer(id, options) {
    Emitter.call(this);
    var userId = typeof id === 'string' ? id : undefined;
    this.id = userId || ('client-' + Math.random().toString(16).slice(2));
    this.options = options || {};
    var self = this;
    setTimeout(function () { self.emit('open', self.id); }, 0);
  }
  Peer.prototype = Object.create(Emitter.prototype);
  Peer.prototype.connect = function (peerId) {
    var conn = new DataConnection(peerId);
    window.__hostConn = conn;
    window.__deliverHostMessage = function (messageObject) {
      deliver(conn, messageObject);
    };
    setTimeout(function () {
      conn.open = true;
      conn.emit('open');
    }, 0);
    return conn;
  };
  Peer.prototype.destroy = function () { this.emit('close'); };

  window.Peer = Peer;
})();
`;

function httpGet(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        }).on('error', reject);
    });
}

class Cdp {
    constructor(ws) {
        this.ws = ws;
        this.nextId = 0;
        this.pending = new Map();
        this.handlers = [];
        ws.addEventListener('message', (event) => {
            const msg = JSON.parse(event.data);
            if (msg.id && this.pending.has(msg.id)) {
                const { resolve, reject } = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                if (msg.error) reject(new Error(JSON.stringify(msg.error)));
                else resolve(msg.result);
                return;
            }
            if (msg.method) {
                for (const handler of this.handlers) handler(msg);
            }
        });
    }

    send(method, params = {}, sessionId) {
        const id = ++this.nextId;
        const payload = { id, method, params };
        if (sessionId) payload.sessionId = sessionId;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify(payload));
        });
    }

    onEvent(handler) {
        this.handlers.push(handler);
    }
}

export async function startCoopClient() {
    const port = 5200 + Math.floor(Math.random() * 1000);
    const vite = spawn('npx', ['vite', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let viteLog = '';
    vite.stdout.on('data', (chunk) => { viteLog += chunk; });
    vite.stderr.on('data', (chunk) => { viteLog += chunk; });

    const origin = `http://127.0.0.1:${port}`;
    const readyDeadline = Date.now() + 30000;
    while (Date.now() < readyDeadline) {
        try {
            const res = await httpGet(origin + '/');
            if (res.status === 200) break;
        } catch {
            // server still starting
        }
        if (vite.exitCode !== null) {
            throw new Error('Vite exited early:\\n' + viteLog);
        }
        await new Promise((r) => setTimeout(r, 200));
    }

    const debugPort = 9400 + Math.floor(Math.random() * 500);
    const userDataDir = `/tmp/coop-spawn-chrome-${process.pid}-${debugPort}`;
    const chrome = spawn('google-chrome', [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu-sandbox',
        '--disable-dev-shm-usage',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${userDataDir}`,
        '--no-first-run',
        '--disable-background-networking',
        'about:blank',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let chromeLog = '';
    chrome.stderr.on('data', (chunk) => { chromeLog += chunk; });

    let version;
    const chromeDeadline = Date.now() + 20000;
    while (Date.now() < chromeDeadline) {
        try {
            version = JSON.parse((await httpGet(`http://127.0.0.1:${debugPort}/json/version`)).body);
            break;
        } catch {
            if (chrome.exitCode !== null) {
                throw new Error('Chrome exited early:\\n' + chromeLog);
            }
            await new Promise((r) => setTimeout(r, 200));
        }
    }
    if (!version?.webSocketDebuggerUrl) {
        throw new Error('Chrome DevTools did not come up:\\n' + chromeLog);
    }

    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve);
        ws.addEventListener('error', reject);
    });
    const cdp = new Cdp(ws);

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

    const logs = [];
    cdp.onEvent((msg) => {
        if (msg.sessionId !== sessionId) return;
        if (msg.method === 'Runtime.consoleAPICalled') {
            const text = (msg.params.args || []).map((arg) => arg.value ?? arg.description ?? '').join(' ');
            logs.push(text);
        }
        if (msg.method === 'Runtime.exceptionThrown') {
            logs.push('EXC ' + (msg.params.exceptionDetails?.text || '') + ' ' + (msg.params.exceptionDetails?.exception?.description || ''));
        }
        if (msg.method === 'Fetch.requestPaused') {
            handlePaused(msg.params).catch((err) => {
                logs.push('FETCH ' + err.message);
            });
        }
    });

    async function handlePaused(params) {
        const url = params.request.url;
        if (url.includes('peerjs@1.5.4/dist/peerjs.min.js')) {
            await cdp.send('Fetch.fulfillRequest', {
                requestId: params.requestId,
                responseCode: 200,
                responseHeaders: [{ name: 'Content-Type', value: 'application/javascript' }],
                body: Buffer.from(PEERJS_RECEIVE_SHIM).toString('base64'),
            }, sessionId);
            return;
        }
        if (url.includes('/src/main.js')) {
            const bodyResult = await cdp.send('Fetch.getResponseBody', { requestId: params.requestId }, sessionId);
            let source = bodyResult.base64Encoded
                ? Buffer.from(bodyResult.body, 'base64').toString('utf8')
                : bodyResult.body;
            source += '\nwindow.__k = k;\n';
            await cdp.send('Fetch.fulfillRequest', {
                requestId: params.requestId,
                responseCode: 200,
                responseHeaders: [{ name: 'Content-Type', value: 'text/javascript' }],
                body: Buffer.from(source).toString('base64'),
            }, sessionId);
            return;
        }
        await cdp.send('Fetch.continueRequest', { requestId: params.requestId }, sessionId);
    }

    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Fetch.enable', {
        patterns: [
            { urlPattern: '*peerjs@1.5.4/dist/peerjs.min.js*', requestStage: 'Request' },
            { urlPattern: '*127.0.0.1*/src/main.js*', requestStage: 'Response' },
        ],
    }, sessionId);
    await cdp.send('Page.navigate', { url: origin + '/' }, sessionId);

    const evalInPage = async (expression, awaitPromise = true) => {
        const result = await cdp.send('Runtime.evaluate', {
            expression,
            awaitPromise,
            returnByValue: true,
        }, sessionId);
        if (result.exceptionDetails) {
            throw new Error(result.exceptionDetails.text + ' ' + (result.exceptionDetails.exception?.description || expression));
        }
        return result.result.value;
    };

    const pageDeadline = Date.now() + 30000;
    let booted = false;
    while (Date.now() < pageDeadline) {
        const state = await evalInPage('Boolean(window.__k) && typeof window.Peer === "function"');
        if (state) {
            booted = true;
            break;
        }
        await new Promise((r) => setTimeout(r, 200));
    }
    if (!booted) {
        throw new Error('Game page did not boot.\\n' + logs.slice(-30).join('\\n'));
    }

    async function joinAndEnterGame() {
        const joined = await evalInPage(`(async () => {
            const party = await import('/src/systems/partySystem.js');
            const ok = await party.joinPartyAsClient('123456');
            const sent = (window.__sentToHost || []).map((m) => m.type);
            window.__deliverHostMessage({
                type: 'party_sync',
                payload: {
                    yourSlotIndex: 1,
                    slots: [
                        { playerId: 'host', playerName: 'Host', inviteCode: '123456', selectedCharacter: 'survivor', selectedPortrait: 'default', playerLevel: 1, isLocal: false, peerId: 'smash-123456', isReady: true },
                        { playerId: 'victim', playerName: 'Victim', inviteCode: '654321', selectedCharacter: 'survivor', selectedPortrait: 'default', playerLevel: 1, isLocal: false, peerId: 'victim-peer', isReady: true },
                        { playerId: null, playerName: null, inviteCode: null, selectedCharacter: null, selectedPortrait: null, playerLevel: 1, isLocal: false, peerId: null, isReady: false },
                        { playerId: null, playerName: null, inviteCode: null, selectedCharacter: null, selectedPortrait: null, playerLevel: 1, isLocal: false, peerId: null, isReady: false }
                    ]
                }
            });
            const errors = [];
            const origError = console.error;
            console.error = (...args) => {
                errors.push(args.map((a) => String(a && a.stack || a)).join(' '));
                origError.apply(console, args);
            };
            window.__sceneErrors = errors;
            window.__deliverHostMessage({ type: 'game_start', payload: {} });
            console.error = origError;
            return { ok, sent, hasDeliver: typeof window.__deliverHostMessage === 'function' };
        })()`);
        if (!joined.ok || !joined.hasDeliver) {
            throw new Error('Client did not join the host: ' + JSON.stringify(joined) + '\\n' + logs.slice(-40).join('\\n'));
        }

        const deadline = Date.now() + 20000;
        let scene = null;
        while (Date.now() < deadline) {
            scene = await evalInPage(`(async () => {
                const mp = await import('/src/systems/multiplayerGame.js');
                const partyAfter = await import('/src/systems/partySystem.js');
                return {
                    isHost: mp.isHost(),
                    active: mp.isMultiplayerActive(),
                    partySize: partyAfter.getPartySize(),
                    players: window.__k ? window.__k.get('player').length : -1,
                    scene: window.__k && window.__k.getSceneName ? window.__k.getSceneName() : null,
                    errors: window.__sceneErrors || []
                };
            })()`);
            if (scene.active && scene.players > 0 && scene.scene === 'game') break;
            await new Promise((r) => setTimeout(r, 50));
        }
        if (!scene?.active || scene.isHost || scene.partySize < 2 || scene.players < 1) {
            throw new Error('Client did not enter the co-op game scene: ' + JSON.stringify(scene) + '\\n' + logs.slice(-40).join('\\n'));
        }
        await evalInPage('window.__k.paused = true', false);
        return { ...joined, ...scene };
        return joined;
    }

    async function reload() {
        logs.length = 0;
        try {
            await evalInPage(`(() => {
                const k = window.__k;
                if (!k) return;
                k.paused = true;
                for (const tag of ['enemy', 'boss', 'obstacle', 'xpPickup', 'currencyPickup', 'projectile', 'enemyHealthBar']) {
                    for (const obj of k.get(tag)) {
                        try { k.destroy(obj); } catch (err) { /* already gone */ }
                    }
                }
            })()`, false);
        } catch {
            // The page may already be navigating.
        }
        await cdp.send('Page.navigate', { url: origin + '/?reload=' + Date.now() }, sessionId);
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
            try {
                const state = await evalInPage(`Boolean(window.__k) && typeof window.Peer === 'function' && !window.__deliverHostMessage && window.__k.getSceneName && window.__k.getSceneName() === 'menu'`);
                if (state) return;
            } catch {
                // Execution context torn down during navigation.
            }
            await new Promise((r) => setTimeout(r, 200));
        }
        throw new Error('Reload did not finish.\\n' + logs.slice(-20).join('\\n'));
    }

    return {
        logs,
        evalInPage,
        joinAndEnterGame,
        reload,
        async stop() {
            try { ws.close(); } catch { /* already closed */ }
            chrome.kill('SIGKILL');
            vite.kill('SIGKILL');
        },
    };
}
