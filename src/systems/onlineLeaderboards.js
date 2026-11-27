/**
 * Online Leaderboards System
 *
 * Reads global leaderboards from Dreamlo using its read-only public codes.
 * Provides async submission and retrieval with caching.
 *
 * Dreamlo's private (write) codes must never ship in this client: anyone who
 * has one can add, delete, or clear every score on that board. Score writes
 * go to a server-side endpoint instead (VITE_LEADERBOARD_SUBMIT_URL), which
 * holds the private codes, validates the run, and forwards it to Dreamlo.
 * When no endpoint is configured, online submission is disabled.
 *
 * Submit endpoint contract: POST, Content-Type application/json, body
 * { board: 'allTime'|'daily', name, score, floor, character, time, date }.
 * Any 2xx response is treated as accepted.
 */

// Dreamlo public (read-only) codes - Two leaderboards
const LEADERBOARDS = {
    allTime: {
        publicKey: '696eba6f8f40bb1184b6c60f'
    },
    daily: {
        publicKey: '696ff2ee8f40bb1184b8cc92'
    }
};

const SCORE_SUBMIT_URL = resolveSubmitUrl(import.meta.env?.VITE_LEADERBOARD_SUBMIT_URL);

/**
 * Accept only an absolute HTTPS submit endpoint (or HTTP on localhost for development)
 * @param {string|undefined} value - Configured endpoint
 * @returns {string|null} - Endpoint URL, or null when online submission is disabled
 */
function resolveSubmitUrl(value) {
    if (!value) return null;
    try {
        const url = new URL(value);
        const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
        if (url.protocol === 'https:' || (url.protocol === 'http:' && isLocal)) {
            return url.toString();
        }
    } catch {
        // invalid URL
    }
    console.warn('[OnlineLeaderboards] Ignoring invalid VITE_LEADERBOARD_SUBMIT_URL');
    return null;
}

// IMPORTANT: Dreamlo free tier only supports HTTP, not HTTPS.
// Since the game is deployed on HTTPS (GitHub Pages), we need a CORS proxy.
// The proxy routes: HTTPS (our game) -> Proxy -> HTTP (Dreamlo)
// Only public, read-only requests may go through it; it sees every URL it relays.
//
// Current proxy: corsproxy.io (free, public, browser-only)
// For production, consider: Cloudflare Workers, Vercel Edge Functions, or Dreamlo paid tier
const CORS_PROXY = 'https://corsproxy.io/?';
const DREAMLO_RAW_URL = 'http://dreamlo.com/lb';

/**
 * Build a proxied URL for Dreamlo API calls
 * @param {string} path - Path to append (e.g., "/publicKey/json")
 * @returns {string} - Full proxied URL
 */
function buildProxiedUrl(path) {
    return `${CORS_PROXY}${encodeURIComponent(DREAMLO_RAW_URL + path)}`;
}

// Cache configuration - separate cache for each board type
const CACHE_DURATION_MS = 60000; // 1 minute cache
const leaderboardCaches = {
    allTime: { data: null, timestamp: 0 },
    daily: { data: null, timestamp: 0 }
};

// Request timeout
const REQUEST_TIMEOUT_MS = 5000;

/**
 * Sanitize player name for API submission
 * - Alphanumeric, underscores, and hyphens only
 * - Max 20 characters
 * @param {string} name - Raw player name
 * @returns {string} - Sanitized name
 */
function sanitizeName(name) {
    if (!name) return 'Anonymous';
    // Remove special characters, keep alphanumeric, underscore, hyphen
    const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 20);
    return sanitized || 'Anonymous';
}

/**
 * Validate score is reasonable (basic sanity check)
 * @param {number} score - Score to validate
 * @returns {boolean} - Whether score seems valid
 */
function isValidScore(score) {
    // Score should be a positive number, not absurdly high
    // Max realistic score: ~100 floors * 1000 + 1000 kills * 10 + 100 bosses * 500 + 30000 time bonus
    const MAX_REASONABLE_SCORE = 200000;
    return typeof score === 'number' && score > 0 && score <= MAX_REASONABLE_SCORE;
}

/**
 * Fetch with timeout
 * @param {string} url - URL to fetch
 * @param {Object} options - fetch options
 * @param {number} timeout - Timeout in ms
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, options = {}, timeout = REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(timeoutId);
        return response;
    } catch (error) {
        clearTimeout(timeoutId);
        throw error;
    }
}

/**
 * Submit score to online leaderboard (non-blocking)
 * @param {Object} entry - Score entry
 * @param {string} entry.name - Player name
 * @param {number} entry.score - Score value
 * @param {number} entry.floor - Floor reached
 * @param {string} entry.character - Character used
 * @param {number} entry.time - Duration in seconds
 * @param {string} entry.date - Date string (YYYY-MM-DD)
 * @param {string} boardType - Which board to submit to ('allTime' or 'daily')
 * @returns {Promise<boolean>} - Whether submission succeeded
 */
export async function submitOnlineScore(entry, boardType = 'allTime') {
    try {
        // Validate score
        if (!isValidScore(entry.score)) {
            console.warn('[OnlineLeaderboards] Invalid score, skipping submission:', entry.score);
            return false;
        }

        const board = LEADERBOARDS[boardType];
        if (!board) {
            console.warn('[OnlineLeaderboards] Unknown board type:', boardType);
            return false;
        }

        if (!SCORE_SUBMIT_URL) {
            console.log('[OnlineLeaderboards] Online score submission is not configured, skipping');
            return false;
        }

        const payload = {
            board: boardType,
            name: sanitizeName(entry.name),
            score: Math.floor(entry.score),
            floor: Math.floor(entry.floor || 1),
            character: String(entry.character || 'unknown'),
            time: Math.floor(entry.time || 0),
            date: String(entry.date || '')
        };

        console.log(`[OnlineLeaderboards] Submitting score to ${boardType}:`, { name: payload.name, score: payload.score, floor: payload.floor });

        const response = await fetchWithTimeout(SCORE_SUBMIT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (response.ok) {
            console.log(`[OnlineLeaderboards] Score submitted to ${boardType} successfully`);
            // Invalidate cache for this board on successful submission
            leaderboardCaches[boardType].data = null;
            leaderboardCaches[boardType].timestamp = 0;
            return true;
        } else {
            console.warn('[OnlineLeaderboards] Submission failed with status:', response.status);
            return false;
        }
    } catch (error) {
        if (error.name === 'AbortError') {
            console.warn('[OnlineLeaderboards] Submission timed out');
        } else {
            console.warn('[OnlineLeaderboards] Submission error:', error.message);
        }
        return false;
    }
}

/**
 * Submit score to daily leaderboard (convenience wrapper)
 * @param {Object} entry - Score entry (same format as submitOnlineScore)
 * @returns {Promise<boolean>} - Whether submission succeeded
 */
export async function submitDailyScore(entry) {
    return submitOnlineScore(entry, 'daily');
}

/**
 * Parse Dreamlo entry into standard format
 * @param {Object} entry - Raw Dreamlo entry
 * @returns {Object} - Parsed entry
 */
function parseEntry(entry) {
    // Parse text field: "floor|character|date"
    const textParts = (entry.text || '').split('|');

    return {
        name: entry.name || 'Anonymous',
        score: parseInt(entry.score, 10) || 0,
        time: parseInt(entry.seconds, 10) || 0,
        floor: parseInt(textParts[0], 10) || 1,
        character: textParts[1] || 'survivor',
        date: textParts[2] || ''
    };
}

/**
 * Get online leaderboard
 * @param {number} limit - Max entries to return
 * @param {string} boardType - Which board to fetch ('allTime' or 'daily')
 * @returns {Promise<Object>} - { entries: [], totalCount: number, error: string|null }
 */
export async function getOnlineLeaderboard(limit = 10, boardType = 'allTime') {
    try {
        const board = LEADERBOARDS[boardType];
        if (!board) {
            console.warn('[OnlineLeaderboards] Unknown board type:', boardType);
            return { entries: [], totalCount: 0, error: 'Unknown board type' };
        }

        const cache = leaderboardCaches[boardType];

        // Check cache first
        const now = Date.now();
        if (cache.data && (now - cache.timestamp) < CACHE_DURATION_MS) {
            console.log(`[OnlineLeaderboards] Using cached ${boardType} leaderboard`);
            return {
                entries: cache.data.slice(0, limit),
                totalCount: cache.data.length,
                error: null
            };
        }

        // Dreamlo JSON URL: /lb/{publicKey}/json
        const url = buildProxiedUrl(`/${board.publicKey}/json`);

        console.log(`[OnlineLeaderboards] Fetching ${boardType} leaderboard...`);

        const response = await fetchWithTimeout(url);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();

        // Parse Dreamlo response format
        // Format: { dreamlo: { leaderboard: { entry: [...] or entry: {} for single } } }
        let entries = [];

        if (data?.dreamlo?.leaderboard?.entry) {
            const rawEntries = data.dreamlo.leaderboard.entry;
            // Handle single entry (object) vs multiple (array)
            if (Array.isArray(rawEntries)) {
                entries = rawEntries.map(parseEntry);
            } else {
                entries = [parseEntry(rawEntries)];
            }
        }

        // Update cache
        cache.data = entries;
        cache.timestamp = now;

        console.log(`[OnlineLeaderboards] Fetched ${entries.length} entries from ${boardType}`);

        return {
            entries: entries.slice(0, limit),
            totalCount: entries.length,
            error: null
        };
    } catch (error) {
        if (error.name === 'AbortError') {
            console.warn('[OnlineLeaderboards] Fetch timed out');
            return { entries: [], totalCount: 0, error: 'Connection timed out' };
        }
        console.warn('[OnlineLeaderboards] Fetch error:', error.message);
        return { entries: [], totalCount: 0, error: 'Could not connect to server' };
    }
}

/**
 * Get daily online leaderboard filtered by today's date
 * @param {number} limit - Max entries to return
 * @param {string} todayDate - Today's date string (YYYY-MM-DD) for filtering
 * @returns {Promise<Object>} - { entries: [], totalCount: number, error: string|null }
 */
export async function getDailyOnlineLeaderboard(limit = 10, todayDate) {
    // Fetch all entries from daily board
    const result = await getOnlineLeaderboard(1000, 'daily');

    if (result.error) {
        return result;
    }

    // Filter entries to only show today's date
    const todayEntries = result.entries.filter(entry => entry.date === todayDate);

    return {
        entries: todayEntries.slice(0, limit),
        totalCount: todayEntries.length,
        error: null
    };
}

/**
 * Get player's global rank and total players
 * @param {string} playerName - Player name to find
 * @param {number} playerScore - Player's score (for comparison if not in top entries)
 * @returns {Promise<Object>} - { rank: number|null, total: number, error: string|null }
 */
export async function getGlobalRank(playerName, playerScore) {
    try {
        const result = await getOnlineLeaderboard(1000); // Get more entries for accurate rank

        if (result.error) {
            return { rank: null, total: 0, error: result.error };
        }

        const sanitizedName = sanitizeName(playerName);

        // Find player in entries
        const playerIndex = result.entries.findIndex(e =>
            e.name.toLowerCase() === sanitizedName.toLowerCase()
        );

        if (playerIndex >= 0) {
            return {
                rank: playerIndex + 1,
                total: result.totalCount,
                error: null
            };
        }

        // Player not found in leaderboard - estimate rank based on score
        // Count how many scores are higher than player's score
        const higherScores = result.entries.filter(e => e.score > playerScore).length;

        return {
            rank: higherScores + 1,
            total: result.totalCount + 1, // +1 to include the player
            error: null
        };
    } catch (error) {
        console.warn('[OnlineLeaderboards] Error getting rank:', error.message);
        return { rank: null, total: 0, error: 'Could not determine rank' };
    }
}

/**
 * Clear the leaderboard cache (useful after submission)
 * @param {string} boardType - Optional board type to clear ('allTime' or 'daily'), clears all if not specified
 */
export function clearCache(boardType = null) {
    if (boardType && leaderboardCaches[boardType]) {
        leaderboardCaches[boardType].data = null;
        leaderboardCaches[boardType].timestamp = 0;
    } else {
        // Clear all caches
        Object.keys(leaderboardCaches).forEach(key => {
            leaderboardCaches[key].data = null;
            leaderboardCaches[key].timestamp = 0;
        });
    }
}

/**
 * Check if online leaderboards are available (basic connectivity check)
 * @returns {Promise<boolean>}
 */
export async function checkOnlineAvailability() {
    try {
        const result = await getOnlineLeaderboard(1);
        return result.error === null;
    } catch {
        return false;
    }
}
