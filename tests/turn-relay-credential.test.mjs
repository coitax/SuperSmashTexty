/**
 * Spec for the long-lived TURN credential shipped in the multiplayer client.
 *
 * These tests fail while that credential is still embedded in the client the
 * game ships. They pass once a match no longer hands WebRTC a TURN username
 * and credential that were compiled into the client. A fix can either stop
 * configuring a TURN relay, or fetch a short-lived username and credential
 * when the peer is created and use only those.
 *
 * The local TURN stand-in speaks the long-term credential handshake from
 * RFC 5389 (sections 10.2 and 15.4) and the Allocate exchange from RFC 5766
 * (sections 2.2, 6, and 13). It never contacts the relay host named in the
 * client. The test page redirects turn and stun URLs to that stand-in and
 * asks the browser for relay candidates, so gathering has to authenticate.
 *
 * A replacement that fetches credentials can call any same-origin path under
 * /api/. The test answers with JSON { username, credential, ttl, urls,
 * iceServers: [{ urls, username, credential }] }. username and credential are
 * new placeholders on every response. A cross-origin fetch is sent there too.
 *
 * Run:
 *   npm ci
 *   node --test tests/turn-relay-credential.test.mjs
 *
 * Product paths covered:
 *   menu scene -> initParty -> initNetwork(inviteCode, true)
 *     src/scenes/menu.js (setupMenuScene calls initParty)
 *     src/systems/partySystem.js (initParty calls initNetwork)
 *   join scene -> joinPartyAsClient -> initNetwork('client', false)
 *     then connectToHost
 *     src/scenes/joinParty.js, src/systems/partySystem.js,
 *     src/systems/matchmakingSystem.js (also calls joinPartyAsClient)
 * Both paths build the RTC configuration in initNetwork and PeerJS 1.5.4
 * passes that object to the RTCPeerConnection constructor
 * (peerjs dist/peerjs.js, Peer constructor option merge and
 * Negotiator._startPeerConnection).
 *
 * The unavailable-id retry calls the same initNetwork function again.
 * No other module builds an ICE server list.
 */

import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { crc32 } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAGIC = 0x2112a442;
const REALM = 'example.invalid';
const ATTR = {
    username: 0x0006,
    integrity: 0x0008,
    errorCode: 0x0009,
    lifetime: 0x000d,
    realm: 0x0014,
    nonce: 0x0015,
    xorRelayed: 0x0016,
    requestedTransport: 0x0019,
    xorMapped: 0x0020,
    fingerprint: 0x8028,
};
const ALLOCATE_REQUEST = 0x0003;
const ALLOCATE_SUCCESS = 0x0103;
const ALLOCATE_ERROR = 0x0113;
const BINDING_REQUEST = 0x0001;
const BINDING_SUCCESS = 0x0101;

function md5Key(username, realm, password) {
    return createHash('md5').update(`${username}:${realm}:${password}`).digest();
}

function parseStun(packet) {
    if (packet.length < 20) return null;
    const type = packet.readUInt16BE(0);
    const length = packet.readUInt16BE(2);
    if (packet.readUInt32BE(4) !== MAGIC) return null;
    if (20 + length > packet.length) return null;
    const transactionId = packet.subarray(8, 20);
    const attrs = [];
    let offset = 20;
    const end = 20 + length;
    while (offset + 4 <= end) {
        const attrType = packet.readUInt16BE(offset);
        const attrLength = packet.readUInt16BE(offset + 2);
        const valueStart = offset + 4;
        const valueEnd = valueStart + attrLength;
        if (valueEnd > end) return null;
        attrs.push({
            type: attrType,
            value: packet.subarray(valueStart, valueEnd),
            offset,
        });
        offset = valueEnd + ((4 - (attrLength % 4)) % 4);
    }
    return { type, length, transactionId, attrs };
}

function attribute(type, value) {
    const padding = (4 - (value.length % 4)) % 4;
    const out = Buffer.alloc(4 + value.length + padding);
    out.writeUInt16BE(type, 0);
    out.writeUInt16BE(value.length, 2);
    value.copy(out, 4);
    return out;
}

function stringAttr(type, text) {
    return attribute(type, Buffer.from(text, 'utf8'));
}

function xorAddress(port, address) {
    const value = Buffer.alloc(8);
    value[1] = 0x01;
    value.writeUInt16BE(port ^ (MAGIC >>> 16), 2);
    const parts = address.split('.').map((part) => Number(part));
    const cookie = Buffer.alloc(4);
    cookie.writeUInt32BE(MAGIC, 0);
    for (let i = 0; i < 4; i += 1) value[4 + i] = parts[i] ^ cookie[i];
    return value;
}

function withFingerprint(message) {
    const headered = Buffer.concat([message, Buffer.alloc(8)]);
    headered.writeUInt16BE(headered.length - 20, 2);
    headered.writeUInt16BE(ATTR.fingerprint, headered.length - 8);
    headered.writeUInt16BE(4, headered.length - 6);
    const crc = (crc32(headered.subarray(0, headered.length - 4)) ^ 0x5354554e) >>> 0;
    headered.writeUInt32BE(crc, headered.length - 4);
    return headered;
}

function stunMessage(type, transactionId, parts) {
    const body = Buffer.concat(parts);
    const header = Buffer.alloc(20);
    header.writeUInt16BE(type, 0);
    header.writeUInt16BE(body.length, 2);
    header.writeUInt32BE(MAGIC, 4);
    transactionId.copy(header, 8);
    return withFingerprint(Buffer.concat([header, body]));
}

function successWithIntegrity(transactionId, parts, username, realm, password) {
    const body = Buffer.concat(parts);
    const key = md5Key(username, realm, password);
    const header = Buffer.alloc(20);
    header.writeUInt16BE(ALLOCATE_SUCCESS, 0);
    header.writeUInt16BE(body.length + 24, 2);
    header.writeUInt32BE(MAGIC, 4);
    transactionId.copy(header, 8);
    const hmac = createHmac('sha1', key).update(Buffer.concat([header, body])).digest();
    const mi = Buffer.alloc(24);
    mi.writeUInt16BE(ATTR.integrity, 0);
    mi.writeUInt16BE(20, 2);
    hmac.copy(mi, 4);
    return withFingerprint(Buffer.concat([header, body, mi]));
}

function errorCodeAttr(code, reason) {
    const phrase = Buffer.from(reason, 'utf8');
    const value = Buffer.alloc(4 + phrase.length);
    value[2] = Math.floor(code / 100);
    value[3] = code % 100;
    phrase.copy(value, 4);
    return attribute(ATTR.errorCode, value);
}

function integrityOk(packet, username, realm, password) {
    const parsed = parseStun(packet);
    if (!parsed) return false;
    const mi = parsed.attrs.find((attr) => attr.type === ATTR.integrity);
    if (!mi || mi.value.length !== 20) return false;
    const key = md5Key(username, realm, password);
    const head = Buffer.from(packet.subarray(0, mi.offset));
    head.writeUInt16BE(mi.offset + 4, 2);
    const expected = createHmac('sha1', key).update(head).digest();
    return expected.equals(mi.value);
}

function buildAuthenticatedAllocate(username, password, realm, nonce) {
    const transactionId = randomBytes(12);
    const before = Buffer.concat([
        stringAttr(ATTR.username, username),
        stringAttr(ATTR.realm, realm),
        stringAttr(ATTR.nonce, nonce),
        attribute(ATTR.requestedTransport, Buffer.from([17, 0, 0, 0])),
    ]);
    const key = md5Key(username, realm, password);
    const header = Buffer.alloc(20);
    header.writeUInt16BE(ALLOCATE_REQUEST, 0);
    header.writeUInt16BE(before.length + 24, 2);
    header.writeUInt32BE(MAGIC, 4);
    transactionId.copy(header, 8);
    const hmac = createHmac('sha1', key).update(Buffer.concat([header, before])).digest();
    const mi = Buffer.alloc(24);
    mi.writeUInt16BE(ATTR.integrity, 0);
    mi.writeUInt16BE(20, 2);
    hmac.copy(mi, 4);
    return withFingerprint(Buffer.concat([header, before, mi]));
}

function startTurnStandIn() {
    const passwords = new Map();
    const seenAttrTypes = [];
    const socket = dgram.createSocket('udp4');
    const nonce = randomBytes(12).toString('hex');

    function remember(username, credential, issued) {
        passwords.set(username, { credential, issued, authed: false });
    }

    function issueCredential() {
        const username = `issued-${randomBytes(8).toString('hex')}`;
        const credential = `issued-${randomBytes(12).toString('hex')}`;
        remember(username, credential, true);
        return { username, credential };
    }

    socket.on('message', (message, rinfo) => {
        const parsed = parseStun(message);
        if (!parsed) return;
        seenAttrTypes.push(parsed.attrs.map((attr) => attr.type));
        const reply = (type, parts) => {
            const packet = stunMessage(type, parsed.transactionId, parts);
            socket.send(packet, rinfo.port, rinfo.address);
        };
        if (parsed.type === BINDING_REQUEST) {
            reply(BINDING_SUCCESS, [attribute(ATTR.xorMapped, xorAddress(rinfo.port, rinfo.address))]);
            return;
        }
        if (parsed.type !== ALLOCATE_REQUEST) return;
        const usernameAttr = parsed.attrs.find((attr) => attr.type === ATTR.username);
        const realmAttr = parsed.attrs.find((attr) => attr.type === ATTR.realm);
        const username = usernameAttr ? usernameAttr.value.toString('utf8') : '';
        const realm = realmAttr ? realmAttr.value.toString('utf8') : '';
        const known = username ? passwords.get(username) : undefined;
        const authed = Boolean(
            known && realm && integrityOk(message, username, realm, known.credential),
        );
        if (!authed) {
            reply(ALLOCATE_ERROR, [
                errorCodeAttr(401, 'Unauthorized'),
                stringAttr(ATTR.realm, REALM),
                stringAttr(ATTR.nonce, nonce),
            ]);
            return;
        }
        known.authed = true;
        const lifetime = Buffer.alloc(4);
        lifetime.writeUInt32BE(600, 0);
        const successParts = [
            attribute(ATTR.xorRelayed, xorAddress(50000, '127.0.0.1')),
            attribute(ATTR.lifetime, lifetime),
            attribute(ATTR.xorMapped, xorAddress(rinfo.port, rinfo.address)),
        ];
        const success = successWithIntegrity(
            parsed.transactionId,
            successParts,
            username,
            realm,
            known.credential,
        );
        socket.send(success, rinfo.port, rinfo.address);
    });

    return new Promise((resolve) => {
        socket.bind(0, '127.0.0.1', () => {
            resolve({
                port: socket.address().port,
                remember,
                issueCredential,
                status() {
                    const entries = [...passwords.values()];
                    return {
                        presented: entries.filter((entry) => !entry.issued || entry.presented).length,
                        entries: [...passwords.entries()].map(([username, entry]) => ({
                            username,
                            issued: entry.issued,
                            authed: entry.authed,
                            presented: Boolean(entry.presented),
                        })),
                        attrTypes: seenAttrTypes.slice(-8),
                    };
                },
                markPresented(username) {
                    const entry = passwords.get(username);
                    if (entry) entry.presented = true;
                },
                close() {
                    return new Promise((done) => socket.close(done));
                },
            });
        });
    });
}

function hasStaticTurnCredential(text) {
    const hasTurnUrl = /turns?:[^'"\s<>]+/i.test(text);
    const hasUsername = /username\s*:\s*['"`][^'"`]{4,}['"`]/.test(text);
    const hasCredential = /credential\s*:\s*['"`][^'"`]{4,}['"`]/.test(text);
    return hasTurnUrl && hasUsername && hasCredential;
}

function readTextFiles(dir, acc) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            readTextFiles(full, acc);
            continue;
        }
        if (!/\.(js|mjs|cjs|html|css|json|svg|txt|xml|map)$/i.test(entry.name)) continue;
        acc.push(fs.readFileSync(full, 'utf8'));
    }
}

async function shippedClientText() {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sst-turn-build-'));
    await new Promise((resolve, reject) => {
        const child = spawn(
            process.execPath,
            [path.join(repoRoot, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', outDir, '--emptyOutDir'],
            { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let err = '';
        child.stderr.on('data', (chunk) => {
            err += chunk.toString();
        });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`vite build exited ${code}: ${err.slice(-500)}`));
        });
    });
    const parts = [];
    readTextFiles(path.join(repoRoot, 'src'), parts);
    for (const name of ['index.html', 'vite.config.js']) {
        parts.push(fs.readFileSync(path.join(repoRoot, name), 'utf8'));
    }
    readTextFiles(path.join(repoRoot, 'public'), parts);
    readTextFiles(outDir, parts);
    return parts.join('\n');
}

function peerJsVersion() {
    const html = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
    const match = html.match(/peerjs@([0-9]+\.[0-9]+\.[0-9]+)/);
    if (!match) throw new Error('index.html does not pin a peerjs version');
    return match[1];
}

async function ensurePeerJs(version) {
    const destDir = path.join(os.tmpdir(), `peerjs-${version}-extract`);
    const script = path.join(destDir, 'package/dist/peerjs.js');
    if (!fs.existsSync(script)) {
        fs.mkdirSync(destDir, { recursive: true });
        const tarball = path.join(destDir, 'peerjs.tgz');
        const response = await fetch(`https://registry.npmjs.org/peerjs/-/peerjs-${version}.tgz`);
        if (!response.ok) throw new Error(`could not download peerjs ${version}`);
        fs.writeFileSync(tarball, Buffer.from(await response.arrayBuffer()));
        await new Promise((resolve, reject) => {
            const child = spawn('tar', ['-xzf', tarball, '-C', destDir], { stdio: 'ignore' });
            child.on('error', reject);
            child.on('close', (code) => (code === 0 ? resolve() : reject(new Error('tar failed'))));
        });
    }
    return script;
}

function labelSummary(records, label) {
    const rows = records.filter((row) => row.label === label);
    if (rows.length === 0) return { presented: 0, unissued: false, authed: true };
    return {
        presented: rows.length,
        unissued: rows.some((row) => !row.issued),
        authed: rows.every((row) => row.authed),
    };
}

test('TURN stand-in checks the long-term credential from RFC 5389 section 15.4', async () => {
    const exampleKey = md5Key('user', 'realm', 'pass').toString('hex');
    assert.equal(exampleKey, '8493fbc53ba582fb4c044c456bdc40eb');

    const turn = await startTurnStandIn();
    try {
        const username = 'placeholder-user';
        const credential = 'placeholder-password';
        turn.remember(username, credential, true);
        const client = dgram.createSocket('udp4');
        const first = Buffer.alloc(20);
        first.writeUInt16BE(ALLOCATE_REQUEST, 0);
        first.writeUInt32BE(MAGIC, 4);
        randomBytes(12).copy(first, 8);
        const challenge = await new Promise((resolve, reject) => {
            client.once('message', (packet) => resolve(packet));
            client.send(withFingerprint(first), turn.port, '127.0.0.1', (err) => err && reject(err));
        });
        const parsed = parseStun(challenge);
        assert.equal(parsed.type, ALLOCATE_ERROR);
        const realm = parsed.attrs.find((attr) => attr.type === ATTR.realm).value.toString('utf8');
        const nonce = parsed.attrs.find((attr) => attr.type === ATTR.nonce).value.toString('utf8');
        assert.equal(realm, REALM);
        const authed = buildAuthenticatedAllocate(username, credential, realm, nonce);
        assert.equal(integrityOk(authed, username, realm, credential), true);
        assert.equal(integrityOk(authed, username, realm, 'placeholder-wrong'), false);
        await new Promise((resolve, reject) => {
            client.once('message', () => resolve());
            client.send(authed, turn.port, '127.0.0.1', (err) => err && reject(err));
        });
        const row = turn.status().entries.find((entry) => entry.username === username);
        assert.equal(row.authed, true);
        client.close();
    } finally {
        await turn.close();
    }
});

test('menu host setup and join-as-client setup do not give WebRTC a compiled-in TURN secret', { timeout: 120000 }, async () => {
    const shipped = await shippedClientText();
    const staticLiteral = hasStaticTurnCredential(shipped);
    const version = peerJsVersion();
    const peerJsPath = await ensurePeerJs(version);
    const turn = await startTurnStandIn();
    const records = [];

    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (req.method === 'POST' && (url.pathname === '/expect' || url.pathname === '/result')) {
            const chunks = [];
            req.on('data', (chunk) => chunks.push(chunk));
            req.on('end', () => {
                let body = {};
                try {
                    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                } catch {
                    res.writeHead(400).end();
                    return;
                }
                if (url.pathname === '/expect') {
                    const username = typeof body.username === 'string' ? body.username : '';
                    const credential = typeof body.credential === 'string' ? body.credential : '';
                    const known = turn.status().entries.find((entry) => entry.username === username);
                    if (!known) turn.remember(username, credential, false);
                    turn.markPresented(username);
                    const issued = Boolean(turn.status().entries.find((entry) => entry.username === username && entry.issued));
                    records.push({
                        label: body.label,
                        issued,
                        get authed() {
                            return turn.status().entries.some((entry) => entry.username === username && entry.authed);
                        },
                    });
                    res.writeHead(204).end();
                    return;
                }
                resultBody = body;
                res.writeHead(204).end();
                if (resultWait) resultWait();
            });
            return;
        }
        if (url.pathname === '/turn-status') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                host: labelSummary(records, 'host'),
                client: labelSummary(records, 'client'),
            }));
            return;
        }
        if (url.pathname.startsWith('/api/')) {
            const issued = turn.issueCredential();
            const payload = {
                username: issued.username,
                credential: issued.credential,
                ttl: 60,
                urls: `turn:127.0.0.1:${turn.port}?transport=udp`,
                iceServers: [{
                    urls: `turn:127.0.0.1:${turn.port}?transport=udp`,
                    username: issued.username,
                    credential: issued.credential,
                }],
            };
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(payload));
            return;
        }
        if (url.pathname === '/vendor/peerjs.js') {
            res.writeHead(200, { 'content-type': 'text/javascript' });
            res.end(fs.readFileSync(peerJsPath));
            return;
        }
        if (url.pathname === '/harness.html') {
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end(harness(turn.port));
            return;
        }
        const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
        const filePath = path.resolve(repoRoot, rel);
        if (!filePath.startsWith(`${repoRoot}${path.sep}`) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
            res.writeHead(404).end();
            return;
        }
        res.writeHead(200, { 'content-type': 'text/javascript' });
        res.end(fs.readFileSync(filePath));
    });

    let resultBody = null;
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sst-chrome-'));
    let resultWait = null;
    const resultPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('browser harness timed out')), 45000);
        resultWait = () => {
            clearTimeout(timer);
            resolve(resultBody);
        };
    });
    const chrome = spawn('google-chrome', [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        `--user-data-dir=${userData}`,
        '--no-first-run',
        '--disable-background-networking',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        `http://127.0.0.1:${port}/harness.html`,
    ], { stdio: 'ignore' });

    try {
        const result = await resultPromise;
        const live = {
            host: labelSummary(records, 'host'),
            client: labelSummary(records, 'client'),
        };
        assert.equal(result && result.error, undefined, result && result.error);
        const problems = [];
        for (const label of ['host', 'client']) {
            if (live[label].presented && !live[label].authed) {
                problems.push(`${label} TURN credential did not authenticate an allocation`);
            }
        }
        assert.deepEqual(problems, []);
        const exposure = [];
        if (staticLiteral) exposure.push('production bundle or client source contains a static TURN username and credential');
        if (live.host.unissued) exposure.push(`host setup presented ${live.host.presented} TURN credential(s) this backend did not issue`);
        if (live.client.unissued) exposure.push(`client setup presented ${live.client.presented} TURN credential(s) this backend did not issue`);
        assert.deepEqual(exposure, []);
    } finally {
        chrome.kill('SIGKILL');
        await new Promise((resolve) => {
            if (chrome.exitCode !== null || chrome.signalCode !== null) resolve();
            else chrome.once('exit', resolve);
        });
        await new Promise((resolve) => server.close(resolve));
        await turn.close();
        try {
            fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        } catch {
            // The profile directory is only test scratch space.
        }
    }
});

function harness(turnPort) {
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head><body>
<script>
const TURN_PORT = ${turnPort};
const NativePC = window.RTCPeerConnection;
window.__arm = false;
window.__label = 'host';
window.RTCPeerConnection = function (config) {
  if (!window.__arm) return new NativePC({ iceServers: [] });
  const iceServers = (config && config.iceServers) || [];
  for (const server of iceServers) {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    const turn = urls.filter(Boolean).some((url) => /^turns?:/i.test(String(url)));
    if (!turn || !server.username || !server.credential) continue;
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/expect', false);
    xhr.setRequestHeader('content-type', 'application/json');
    xhr.send(JSON.stringify({
      label: window.__label,
      username: server.username,
      credential: server.credential
    }));
  }
  const rewritten = (iceServers || []).map((server) => {
    const urls = (Array.isArray(server.urls) ? server.urls : [server.urls]).filter(Boolean).map((url) => {
      const text = String(url);
      if (/^turns?:/i.test(text)) return 'turn:127.0.0.1:' + TURN_PORT + '?transport=udp';
      if (/^stun:/i.test(text)) return 'stun:127.0.0.1:' + TURN_PORT;
      return text;
    });
    return Object.assign({}, server, { urls: urls.length === 1 ? urls[0] : urls });
  });
  const rtcConfig = { iceServers: rewritten, iceTransportPolicy: 'relay' };
  if (config && config.bundlePolicy) rtcConfig.bundlePolicy = config.bundlePolicy;
  if (config && config.rtcpMuxPolicy) rtcConfig.rtcpMuxPolicy = config.rtcpMuxPolicy;
  return new NativePC(rtcConfig);
};
class FakeSocket {
  constructor() {
    this.readyState = 0;
    this.sent = [];
    FakeSocket.latest = this;
    queueMicrotask(() => {
      this.readyState = 1;
      if (this.onopen) this.onopen({});
    });
  }
  send(data) { this.sent.push(String(data)); }
  close() {
    this.readyState = 3;
    if (this.onclose) this.onclose({});
  }
}
window.WebSocket = FakeSocket;
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  if (url.hostname.endsWith('peerjs.com')) {
    return new Response('clientpeer1', { status: 200 });
  }
  if (url.origin !== location.origin) {
    const issued = await nativeFetch('/api/turn-credential');
    return issued;
  }
  return nativeFetch(input, init);
};
function deliver(message) {
  const sock = FakeSocket.latest;
  if (sock && sock.onmessage) sock.onmessage({ data: JSON.stringify(message) });
}
</script>
<script src="/vendor/peerjs.js"></script>
<script type="module">
import { initNetwork, connectToHost, disconnect } from '/src/systems/networkSystem.js';

function safeError(error) {
  return String(error && error.message || error).replace(/[A-Za-z0-9+/=_-]{12,}/g, '[redacted]');
}

async function openPeer(invite, isHost) {
  window.__label = isHost ? 'host' : 'client';
  window.__arm = true;
  const pending = initNetwork(invite, isHost);
  const started = Date.now();
  while (!FakeSocket.latest && Date.now() - started < 3000) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await new Promise((resolve) => setTimeout(resolve, 30));
  deliver({ type: 'OPEN' });
  return pending;
}

async function waitForAuth() {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    const status = await (await fetch('/turn-status')).json();
    if (status.host.authed && status.client.authed && status.host.presented && status.client.presented) return status;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return fetch('/turn-status').then((response) => response.json());
}

try {
  await openPeer('123456', true);
  try {
    deliver({
      type: 'OFFER',
      src: 'smash-654321',
      payload: {
        type: 'data',
        connectionId: 'dc_incoming1',
        serialization: 'json',
        reliable: true,
        sdp: { type: 'offer', sdp: 'v=0\\r\\n' }
      }
    });
  } catch (offerError) {
    // The peer connection is constructed before the offer SDP is applied.
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  disconnect();
  window.__arm = false;
  FakeSocket.latest = null;
  await openPeer('client', false);
  const joining = connectToHost('123456');
  joining.catch(() => {});
  await waitForAuth();
  await fetch('/result', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
} catch (error) {
  await fetch('/result', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ error: safeError(error) })
  });
}
</script>
</body></html>`;
}
