import fs from 'node:fs/promises';
import path from 'node:path';
import { Writable } from 'node:stream';

// --- Environment Detection (Basic) ---
const isNode = typeof process !== 'undefined' && process.versions && process.versions.node;
const isDeno = typeof Deno !== 'undefined';
const isBun = typeof Bun !== 'undefined';
// Assume Edge if none of the above and not explicitly browser
const isEdge = !isNode && !isDeno && !isBun && typeof self !== 'undefined' && typeof self.fetch === 'function';

const LOG_DIR = './log';
let mainLogStream = null;
let keyStatusLogStream = null;
let currentLogDate = '';

// --- File System Operations (Adapters) ---

async function ensureLogDirExistsNode() {
    try {
        await fs.mkdir(LOG_DIR, { recursive: true });
        return true;
    } catch (error) {
        console.error(`[Logger] Failed to create log directory ${LOG_DIR}:`, error);
        return false;
    }
}

async function createWriteStreamNode(filePath) {
    try {
        // Use 'a' flag to append to the file
        const stream = (await import('node:fs')).createWriteStream(filePath, { flags: 'a' });
        return stream;
    } catch (error) {
        console.error(`[Logger] Failed to create write stream for ${filePath}:`, error);
        return null;
    }
}

// --- Logger Core ---

function getLogDate() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// Get or create the main log stream for the current date
async function getMainLogStream() {
    const dateStr = getLogDate();
    if (dateStr === currentLogDate && mainLogStream) {
        return mainLogStream;
    }

    // Close previous stream if date changed
    if (mainLogStream) {
        await new Promise(resolve => mainLogStream.end(resolve));
        mainLogStream = null;
    }

    currentLogDate = dateStr;
    const logFileName = `${currentLogDate}.log`;
    const logFilePath = path.join(LOG_DIR, logFileName);

    if (isNode) {
        if (await ensureLogDirExistsNode()) {
            mainLogStream = await createWriteStreamNode(logFilePath);
        }
    } else if (isDeno) {
        try {
            await Deno.mkdir(LOG_DIR, { recursive: true });
            mainLogStream = {
                write: async (chunk) => {
                    try { await Deno.writeTextFile(logFilePath, chunk, { append: true }); }
                    catch (e) { console.error(`[Logger-Deno] Error writing to main log:`, e); }
                },
                end: (cb) => { if (cb) cb(); }
            };
        } catch (e) { console.error(`[Logger-Deno] Error setting up main log file:`, e); }
    } else if (isBun) {
         try {
            await fs.mkdir(LOG_DIR, { recursive: true }); // Assuming Node fs compat works
             mainLogStream = {
                 write: async (chunk) => {
                     try { await Bun.write(logFilePath, chunk); } // Bun.write appends
                     catch (e) { console.error(`[Logger-Bun] Error writing to main log:`, e); }
                 },
                 end: (cb) => { if (cb) cb(); }
             };
         } catch (e) { console.error(`[Logger-Bun] Error setting up main log file:`, e); }
    }

    if (!mainLogStream) {
        console.warn('[Logger] Main file logging disabled (unsupported environment or setup error).');
    }
    return mainLogStream;
}

// Get or create the key status log stream
async function getKeyStatusLogStream() {
    // Key status log doesn't rotate daily, always use the same file
    if (keyStatusLogStream) {
        return keyStatusLogStream;
    }

    const logFileName = `key_status.log`;
    const logFilePath = path.join(LOG_DIR, logFileName);

    if (isNode) {
        if (await ensureLogDirExistsNode()) {
            keyStatusLogStream = await createWriteStreamNode(logFilePath);
        }
    } else if (isDeno) {
        try {
            await Deno.mkdir(LOG_DIR, { recursive: true });
            keyStatusLogStream = {
                write: async (chunk) => {
                    try { await Deno.writeTextFile(logFilePath, chunk, { append: true }); }
                    catch (e) { console.error(`[Logger-Deno] Error writing to key status log:`, e); }
                },
                end: (cb) => { if (cb) cb(); }
            };
        } catch (e) { console.error(`[Logger-Deno] Error setting up key status log file:`, e); }
    } else if (isBun) {
         try {
            await fs.mkdir(LOG_DIR, { recursive: true });
             keyStatusLogStream = {
                 write: async (chunk) => {
                     try { await Bun.write(logFilePath, chunk); }
                     catch (e) { console.error(`[Logger-Bun] Error writing to key status log:`, e); }
                 },
                 end: (cb) => { if (cb) cb(); }
             };
         } catch (e) { console.error(`[Logger-Bun] Error setting up key status log file:`, e); }
    }

     if (!keyStatusLogStream) {
        console.warn('[Logger] Key status file logging disabled (unsupported environment or setup error).');
    }
    return keyStatusLogStream;
}

// Generic write function
async function writeToStream(streamGetter, message) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n`;

    const stream = await streamGetter();
    if (stream) {
        try {
            await new Promise((resolve, reject) => {
                if (typeof stream.write === 'function') {
                    stream.write(logMessage, (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                    if (!isNode) resolve(); // Assume immediate write for non-node mocks
                } else {
                    resolve(); // Cannot write
                }
            });
        } catch (error) {
            console.error('[Logger] Error writing to log stream:', error);
            // Reset stream variable so it tries to recreate next time
            if (streamGetter === getMainLogStream) mainLogStream = null;
            if (streamGetter === getKeyStatusLogStream) keyStatusLogStream = null;
        }
    }
}

// Log to the main daily log file
export async function logToFile(message) {
    // Always log to console
    console.log(`[Log] ${message.substring(0, 200)}${message.length > 200 ? '...' : ''}`); // Keep console log brief
    await writeToStream(getMainLogStream, message);
}

// Log key status to the dedicated key_status.log file
export async function logKeyStatus(statusData) {
    const message = `Key Pool Status:\n${safeStringify(statusData, 2)}\n---`;
    await writeToStream(getKeyStatusLogStream, message);
}


// Helper to safely stringify potentially large or circular objects
function safeStringify(obj, space = 2) {
    try {
        // Basic check for streams or large objects - might need refinement
        if (obj instanceof ReadableStream || obj instanceof WritableStream) {
            return '[Stream Object]';
        }
        // Simple truncation for potentially large bodies
        const str = JSON.stringify(obj, null, space);
        // Increase limit slightly for key status, but still limit
        if (str && str.length > 10000) {
            return str.substring(0, 10000) + '... [truncated]';
        }
        return str || '[stringify failed]'; // Ensure return value
    } catch (e) {
        if (e instanceof TypeError && e.message.includes('circular structure')) {
            return '[Circular Structure]';
        }
        return `[Error Stringifying: ${e.message}]`;
    }
}


// Function to format request/response for logging
export function formatLog(type, data) {
    let logString = `${type.toUpperCase()} LOG\n`;
    for (const key in data) {
        // Ensure value exists before stringifying
        const value = data[key] !== undefined ? safeStringify(data[key]) : '[undefined]';
        logString += `${key}: ${value}\n`;
    }
    return logString;
}