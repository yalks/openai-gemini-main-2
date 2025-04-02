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
let logStream = null;
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

async function getLogStream() {
    const dateStr = getLogDate();
    if (dateStr === currentLogDate && logStream) {
        return logStream;
    }

    // Close previous stream if date changed
    if (logStream) {
        await new Promise(resolve => logStream.end(resolve));
        logStream = null;
    }

    currentLogDate = dateStr;
    const logFileName = `${currentLogDate}.log`;
    const logFilePath = path.join(LOG_DIR, logFileName);

    if (isNode) {
        if (await ensureLogDirExistsNode()) {
            logStream = await createWriteStreamNode(logFilePath);
        }
    } else if (isDeno) {
        // Deno file system access (requires --allow-write flag)
        try {
            await Deno.mkdir(LOG_DIR, { recursive: true });
            // Deno doesn't have a direct append stream like Node, we'll append manually
            logStream = {
                write: async (chunk) => {
                    try {
                        await Deno.writeTextFile(logFilePath, chunk, { append: true });
                    } catch (e) { console.error(`[Logger-Deno] Error writing to log:`, e); }
                },
                end: (cb) => { if (cb) cb(); } // Mock end for compatibility
            };
        } catch (e) { console.error(`[Logger-Deno] Error setting up log file:`, e); }
    } else if (isBun) {
         // Bun file system access (similar to Node but might use Bun API)
         // For simplicity, let's assume Bun's Node compatibility works here
         // Or use Bun.write directly for appending
         try {
            await fs.mkdir(LOG_DIR, { recursive: true }); // Assuming Node fs compat works
             logStream = {
                 write: async (chunk) => {
                     try {
                         await Bun.write(logFilePath, chunk); // Bun.write appends by default if file exists
                     } catch (e) { console.error(`[Logger-Bun] Error writing to log:`, e); }
                 },
                 end: (cb) => { if (cb) cb(); }
             };
         } catch (e) { console.error(`[Logger-Bun] Error setting up log file:`, e); }
    }
    // Edge environments cannot write to local file system

    if (!logStream) {
        console.warn('[Logger] File logging disabled (unsupported environment or setup error).');
    }

    return logStream;
}

export async function logToFile(message) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n---\n`; // Add separator

    // Always log to console
    console.log(`[Log] ${message}`);

    // Try writing to file if supported
    const stream = await getLogStream();
    if (stream) {
        try {
            await new Promise((resolve, reject) => {
                // Deno/Bun mock stream might not be a proper Writable stream
                if (typeof stream.write === 'function') {
                    stream.write(logMessage, (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                    // For non-node streams that write immediately
                    if (!isNode) resolve();
                } else {
                    resolve(); // Cannot write
                }
            });
        } catch (error) {
            console.error('[Logger] Error writing to log stream:', error);
            // Prevent future writes if stream is broken?
            logStream = null;
        }
    }
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
        if (str && str.length > 5000) { // Limit log size
            return str.substring(0, 5000) + '... [truncated]';
        }
        return str;
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
        logString += `${key}: ${safeStringify(data[key])}\n`;
    }
    return logString;
}