/**
 * PeerJS 1.5.4 JSON data-channel behavior used by this game.
 *
 * The client connects with serialization: 'json' (networkSystem.js).
 * The host builds the matching serializer from the offer
 * (peerjs 1.5.4 lib/peer.ts, `_serializers[payload.serialization]`).
 *
 * Json._send (lib/dataconnection/BufferedConnection/Json.ts) UTF-8 encodes
 * JSON.stringify(data) and refuses the message when byteLength >= chunkedMTU.
 * chunkedMTU is 16300 (lib/dataconnection/BufferedConnection/binaryPackChunker.ts).
 * Json._handleDataMessage decodes with TextDecoder and JSON.parse, then emits
 * 'data' with that value. A payload whose __peerData.type is 'close' closes
 * the channel instead of being delivered.
 *
 * This stand-in performs those steps and no others. It does not invent a
 * schema check PeerJS does not have.
 */

export const JSON_CHANNEL_MAX_BYTES = 16300;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * @param {unknown} data
 * @returns {{ dropped: true, byteLength: number } | { dropped: false, closed: true } | { dropped: false, closed: false, data: any }}
 */
export function peerJsJsonTransfer(data) {
    const encoded = encoder.encode(JSON.stringify(data));
    if (encoded.byteLength >= JSON_CHANNEL_MAX_BYTES) {
        return { dropped: true, byteLength: encoded.byteLength };
    }

    const deserialized = JSON.parse(decoder.decode(encoded));
    const peerData = deserialized && deserialized.__peerData;
    if (peerData && peerData.type === 'close') {
        return { dropped: false, closed: true };
    }

    return { dropped: false, closed: false, data: deserialized };
}

/**
 * Host-side DataConnection facade. networkSystem.js registers `data` and
 * `open`, then later calls `send` for party_sync and party_update.
 */
export function createJsonConnection(peerId) {
    const handlers = {};
    const sent = [];

    const facade = {
        peer: peerId,
        open: false,
        on(event, callback) {
            handlers[event] = callback;
        },
        send(data) {
            const result = peerJsJsonTransfer(data);
            if (result.dropped) {
                sent.push({ dropped: true, byteLength: result.byteLength });
                return;
            }
            if (!result.closed) {
                sent.push(result.data);
            }
        },
        close() {
            this.open = false;
        },
    };

    return {
        facade,
        sent,
        emit(event) {
            if (event === 'open') {
                facade.open = true;
            }
            handlers[event]?.();
        },
        /**
         * Deliver one application message the way the host's `data` listener
         * receives it after JSON serialization.
         */
        deliver(message) {
            const result = peerJsJsonTransfer(message);
            if (result.dropped || result.closed) {
                return result;
            }
            handlers.data(result.data);
            return result;
        },
    };
}
