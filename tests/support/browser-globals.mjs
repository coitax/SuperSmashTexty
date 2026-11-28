/**
 * Browser globals the lobby modules touch when a scene or the network boots.
 * Values are empty stand-ins for APIs the tests never use for the attack.
 */

export function installBrowserGlobals() {
    const storage = new Map();

    globalThis.localStorage = {
        getItem(key) {
            return storage.has(key) ? storage.get(key) : null;
        },
        setItem(key, value) {
            storage.set(key, String(value));
        },
        removeItem(key) {
            storage.delete(key);
        },
    };

    const save = {
        version: 1,
        currency: 0,
        playerName: 'Host',
        inviteCode: '123456',
        totalXP: 0,
        playerLevel: 1,
        selectedPortrait: 'default',
        selectedCharacter: 'survivor',
        unlocks: {
            characters: ['survivor'],
            weapons: ['default'],
            permanentUpgrades: [],
            portraits: ['default'],
        },
        permanentUpgradeLevels: {},
        permanentUpgradePurchaseHistory: {},
        stats: {},
        achievements: [],
        runHistory: [],
    };
    localStorage.setItem('superSmashTexty_save', JSON.stringify(save));

    globalThis.__APP_VERSION__ = 'v0.1.test';

    class AudioContext {
        constructor() {
            this.state = 'running';
        }
        resume() {
            return Promise.resolve();
        }
    }

    class Audio {
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
    }

    globalThis.AudioContext = AudioContext;
    globalThis.webkitAudioContext = AudioContext;
    globalThis.Audio = Audio;

    if (!globalThis.window) {
        globalThis.window = globalThis;
    }
    if (typeof globalThis.window.addEventListener !== 'function') {
        globalThis.window.addEventListener = () => {};
        globalThis.window.removeEventListener = () => {};
    }

}
