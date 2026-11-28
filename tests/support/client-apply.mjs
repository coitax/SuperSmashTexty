/**
 * Separate module realm (its own process) so the client party state is not
 * the host's. Applies the host's actual outbound messages, then runs the menu.
 *
 * Usage: node tests/support/client-apply.mjs <messages.json>
 * Prints a JSON result on stdout.
 */

import { readFileSync } from 'node:fs';
import { installBrowserGlobals } from './browser-globals.mjs';
import { installFakePeer } from './fake-peer.mjs';
import { createMenuHarness } from './menu-harness.mjs';

installBrowserGlobals();
const { Peer } = installFakePeer();

const { joinPartyAsClient, getPartyDisplayInfo } = await import('../../src/systems/partySystem.js');
const { setupMenuScene } = await import('../../src/scenes/menu.js');

const joined = await joinPartyAsClient('123456');
if (!joined) {
    console.log(JSON.stringify({ ok: false, error: 'client failed to connect' }));
    process.exit(0);
}

const messages = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const conn = Peer.lastClientConnection;
for (const message of messages) {
    // One more JSON hop, matching the client's data-channel receive.
    conn.deliver(message);
}

const harness = createMenuHarness();
setupMenuScene(harness.k);

let menuError = null;
try {
    harness.enter();
    harness.refreshPartyList();
} catch (error) {
    menuError = {
        name: error.name,
        message: error.message,
    };
}

const display = getPartyDisplayInfo().map((slot) => ({
    playerName: slot.playerName,
    playerLevel: slot.playerLevel,
    nameType: slot.playerName === null ? 'null' : typeof slot.playerName,
    levelType: slot.playerLevel === null ? 'null' : typeof slot.playerLevel,
}));

console.log(JSON.stringify({
    ok: menuError === null,
    menuError,
    levelBadges: harness.levelBadgeTexts(),
    display,
}));
