/**
 * Party Fields
 * Validation for player fields received from other peers.
 * Every value returned here is safe to store, broadcast, and draw.
 */

import { CHARACTER_UNLOCKS } from '../data/unlocks.js';
import { PORTRAITS } from '../data/portraits.js';
import { ACHIEVEMENTS } from '../data/achievements.js';

// Matches the limit enforced by the profile name editor (src/scenes/profile.js)
export const MAX_PLAYER_NAME_LENGTH = 20;
export const MIN_PLAYER_LEVEL = 1;
export const MAX_PLAYER_LEVEL = 9999;

const MAX_ID_LENGTH = 64;
const MAX_UPGRADE_LEVEL = 99;
const MAX_PROFILE_LIST_LENGTH = 500;
const MAX_PROFILE_STATS_KEYS = 64;
const SHARED_UPGRADE_KEYS = ['startingHealth', 'startingDamage', 'startingSpeed', 'propDurability', 'propDropChance'];
const EMOTE_TYPES = ['exclamation', 'heart'];

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @returns {string|null} Name trimmed and capped at MAX_PLAYER_NAME_LENGTH, or null if not usable
 */
export function sanitizePlayerName(value) {
    if (typeof value !== 'string') return null;
    let name = value.slice(0, MAX_PLAYER_NAME_LENGTH * 4).replace(CONTROL_CHARS, '').trim();
    if (name.length > MAX_PLAYER_NAME_LENGTH) {
        name = name.slice(0, MAX_PLAYER_NAME_LENGTH);
        // Don't leave half of a surrogate pair at the end
        if (/[\ud800-\udbff]$/.test(name)) {
            name = name.slice(0, -1);
        }
        name = name.trim();
    }
    return name.length > 0 ? name : null;
}

/**
 * @returns {number|null} Integer level in MIN_PLAYER_LEVEL..MAX_PLAYER_LEVEL, or null if not usable
 */
export function sanitizePlayerLevel(value) {
    let level = null;
    if (typeof value === 'number') {
        level = value;
    } else if (typeof value === 'string' && /^\d{1,4}$/.test(value)) {
        level = Number(value);
    }
    if (!Number.isInteger(level) || level < MIN_PLAYER_LEVEL || level > MAX_PLAYER_LEVEL) {
        return null;
    }
    return level;
}

export function sanitizeCharacterKey(value) {
    return typeof value === 'string' && hasOwn(CHARACTER_UNLOCKS, value) ? value : null;
}

export function sanitizePortraitId(value) {
    return typeof value === 'string' && hasOwn(PORTRAITS, value) ? value : null;
}

export function sanitizeAchievementId(value) {
    return typeof value === 'string' && hasOwn(ACHIEVEMENTS, value) ? value : null;
}

export function sanitizeEmoteType(value) {
    return EMOTE_TYPES.includes(value) ? value : null;
}

export function sanitizeInviteCode(value) {
    return typeof value === 'string' && /^[A-Za-z0-9]{1,16}$/.test(value) ? value : null;
}

function sanitizeId(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH ? value : null;
}

/**
 * @returns {Object|null} Only the shared upgrade keys, each a small non-negative integer
 */
export function sanitizePermanentUpgradeLevels(value) {
    if (!isPlainObject(value)) return null;
    const levels = {};
    for (const key of SHARED_UPGRADE_KEYS) {
        const level = value[key];
        levels[key] = Number.isInteger(level) && level >= 0 && level <= MAX_UPGRADE_LEVEL ? level : 0;
    }
    return levels;
}

/**
 * Rebuild a party slot received from the host, keeping only known fields
 */
export function sanitizeRemoteSlot(slot) {
    const source = isPlainObject(slot) ? slot : {};
    const playerId = sanitizeId(source.playerId);
    return {
        playerId,
        playerName: playerId ? (sanitizePlayerName(source.playerName) || 'Player') : null,
        inviteCode: sanitizeInviteCode(source.inviteCode),
        selectedCharacter: sanitizeCharacterKey(source.selectedCharacter),
        selectedPortrait: sanitizePortraitId(source.selectedPortrait),
        playerLevel: sanitizePlayerLevel(source.playerLevel) || 1,
        permanentUpgradeLevels: sanitizePermanentUpgradeLevels(source.permanentUpgradeLevels),
        isLocal: false,
        peerId: null,
        isReady: source.isReady === true,
        isDisconnected: source.isDisconnected === true
    };
}

function sanitizeStringList(value, isAllowed) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, MAX_PROFILE_LIST_LENGTH).filter(isAllowed);
}

function sanitizeStats(value) {
    const stats = {};
    if (!isPlainObject(value)) return stats;
    for (const key of Object.keys(value).slice(0, MAX_PROFILE_STATS_KEYS)) {
        const stat = value[key];
        if (key.length <= MAX_ID_LENGTH && typeof stat === 'number' && Number.isFinite(stat) && stat >= 0) {
            stats[key] = stat;
        }
    }
    return stats;
}

/**
 * Rebuild profile data received from another player, keeping only known fields
 */
export function sanitizeProfileData(value) {
    if (!isPlainObject(value)) return null;
    const totalXP = value.totalXP;
    return {
        playerName: sanitizePlayerName(value.playerName) || 'Player',
        selectedPortrait: sanitizePortraitId(value.selectedPortrait) || 'default',
        playerLevel: sanitizePlayerLevel(value.playerLevel) || 1,
        totalXP: typeof totalXP === 'number' && Number.isFinite(totalXP) && totalXP >= 0 ? totalXP : 0,
        stats: sanitizeStats(value.stats),
        achievements: sanitizeStringList(value.achievements, id => sanitizeAchievementId(id) !== null),
        unlockedPortraits: sanitizeStringList(value.unlockedPortraits, id => sanitizePortraitId(id) !== null)
    };
}
