import '../support/globals.js';
import { deliverHostMessage } from '../support/globals.js';
import { createKaplayStub } from '../support/kaplayStub.js';
import { setupGameScene } from '../../src/scenes/game.js';
import { initParty, joinPartyAsClient } from '../../src/systems/partySystem.js';
import { getPartySize, getParty } from '../../src/systems/partySystem.js';
import {
    getCurrency,
    getSaveData,
    getSaveStats,
    purchaseUnlock,
    saveGame
} from '../../src/systems/metaProgression.js';

export { deliverHostMessage, getCurrency, getSaveData, getSaveStats, purchaseUnlock };

export async function bootJoinedClient() {
    const k = createKaplayStub();
    setupGameScene(k);
    k.scene('gameOver', () => {});
    k.scene('menu', () => {});

    await initParty(k);
    const joined = await joinPartyAsClient('123456');
    if (!joined) {
        throw new Error('joinPartyAsClient returned false');
    }

    deliverHostMessage('party_sync', {
        yourSlotIndex: 1,
        slots: [
            {
                playerId: 'host-player',
                playerName: 'Host',
                inviteCode: '123456',
                selectedCharacter: 'survivor',
                selectedPortrait: 'default',
                playerLevel: 1,
                permanentUpgradeLevels: {},
                isLocal: false,
                peerId: 'smash-123456',
                isReady: true
            },
            {
                playerId: 'victim-player',
                playerName: 'Victim',
                inviteCode: '654321',
                selectedCharacter: 'survivor',
                selectedPortrait: 'default',
                playerLevel: 1,
                permanentUpgradeLevels: {},
                isLocal: false,
                peerId: null,
                isReady: true
            }
        ]
    });

    if (getPartySize() < 2) {
        throw new Error(`party did not grow after party_sync: ${getPartySize()}`);
    }
    const party = getParty();
    if (!party.slots[1]?.isLocal || party.isHost) {
        throw new Error('victim did not become the joining client');
    }

    try {
        deliverHostMessage('game_start', {});
    } catch (error) {
        if (!k.lastSceneError) throw error;
    }

    if (k.lastSceneError) {
        const sceneError = k.lastSceneError;
        console.error('game scene stopped:', sceneError && sceneError.stack || sceneError);
    }

    return k;
}

export function seedSave(partial) {
    const save = getSaveData();
    const next = {
        ...save,
        ...partial,
        stats: { ...save.stats, ...(partial.stats || {}) },
        unlocks: {
            ...save.unlocks,
            ...(partial.unlocks || {}),
            characters: partial.unlocks?.characters || save.unlocks.characters
        },
        achievements: partial.achievements || save.achievements
    };
    saveGame(next);
    return getSaveData();
}
