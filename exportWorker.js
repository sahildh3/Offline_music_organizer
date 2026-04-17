
/**
 * Export Worker for Offline Music Organizer
 * Handles ZIP generation and file processing in a background thread
 * to prevent UI freezing.
 */

// CRC32 Table
let crcTable = null;
function getCRC32Table() {
    if (crcTable) return crcTable;
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        table[i] = c;
    }
    crcTable = table;
    return table;
}

const ZIP_UTILS = {
    createLocalHeader: (filename, size, crc, compressedSize = 0, method = 0, useDataDescriptor = false) => {
        const nameBuf = new TextEncoder().encode(filename);
        const header = new Uint8Array(30 + nameBuf.length);
        const view = new DataView(header.buffer);
        view.setUint32(0, 0x04034b50, true);
        view.setUint16(4, 20, true);
        view.setUint16(6, useDataDescriptor ? 0x0008 : 0, true);
        view.setUint16(8, method, true);
        view.setUint16(10, 0, true);
        view.setUint16(12, 0, true);
        view.setUint32(14, useDataDescriptor ? 0 : crc, true);
        view.setUint32(18, useDataDescriptor ? 0 : (compressedSize || size), true);
        view.setUint32(22, useDataDescriptor ? 0 : size, true);
        view.setUint16(26, nameBuf.length, true);
        view.setUint16(28, 0, true);
        header.set(nameBuf, 30);
        return header;
    },

    createDataDescriptor: (size, compressedSize, crc) => {
        const desc = new Uint8Array(16);
        const view = new DataView(desc.buffer);
        view.setUint32(0, 0x08074b50, true);
        view.setUint32(4, crc, true);
        view.setUint32(8, compressedSize, true);
        view.setUint32(12, size, true);
        return desc;
    },

    createCentralHeader: (filename, size, crc, offset, compressedSize = 0, method = 0) => {
        const nameBuf = new TextEncoder().encode(filename);
        const header = new Uint8Array(46 + nameBuf.length);
        const view = new DataView(header.buffer);
        view.setUint32(0, 0x02014b50, true);
        view.setUint16(4, 20, true);
        view.setUint16(6, 20, true);
        view.setUint16(8, 0, true);
        view.setUint16(10, method, true);
        view.setUint16(12, 0, true);
        view.setUint16(14, 0, true);
        view.setUint32(16, crc, true);
        view.setUint32(20, compressedSize || size, true);
        view.setUint32(24, size, true);
        view.setUint16(28, nameBuf.length, true);
        view.setUint16(30, 0, true);
        view.setUint16(32, 0, true);
        view.setUint16(34, 0, true);
        view.setUint16(36, 0, true);
        view.setUint32(38, 0, true);
        view.setUint32(42, offset, true);
        header.set(nameBuf, 46);
        return header;
    },

    createEOCD: (count, size, offset) => {
        const eocd = new Uint8Array(22);
        const view = new DataView(eocd.buffer);
        view.setUint32(0, 0x06054b50, true);
        view.setUint16(4, 0, true);
        view.setUint16(6, 0, true);
        view.setUint16(8, count, true);
        view.setUint16(10, count, true);
        view.setUint32(12, size, true);
        view.setUint32(16, offset, true);
        view.setUint16(20, 0, true);
        return eocd;
    },
    
    sanitizeFilename: (name, fallback = "unnamed") => {
        if (!name) return fallback;
        // eslint-disable-next-line no-control-regex
        const sanitized = name.replace(/[<>:"/\\|?*]/g, '_').replace(/[\x00-\x1f]/g, '_').trim();
        return sanitized || fallback;
    }
};

let abortController = null;

self.onmessage = async (e) => {
    const { type, items, fileHandle } = e.data;

    if (type === 'abort') {
        if (abortController) abortController.abort();
        return;
    }

    if (type === 'start') {
        abortController = new AbortController();
        const signal = abortController.signal;
        let writable;

        try {
            writable = await fileHandle.createWritable();
            const entries = [];
            let currentOffset = 0;
            const totalBytes = items.reduce((acc, item) => acc + item.file.size, 0);
            let processedBytes = 0;
            const table = getCRC32Table();

            let lastProgressTime = Date.now();
            let lastProgressBytes = 0;

            // Task 4: Reusable buffer for batching writes
            const WRITE_BUFFER_SIZE = 1024 * 1024; // 1MB
            const writeBuffer = new Uint8Array(WRITE_BUFFER_SIZE);
            let bufferOffset = 0;
            let writePromise = Promise.resolve();

            const flushBuffer = async () => {
                if (signal.aborted) throw new Error('AbortError');
                if (bufferOffset > 0) {
                    const chunk = writeBuffer.slice(0, bufferOffset);
                    await writePromise;
                    if (signal.aborted) throw new Error('AbortError');
                    writePromise = writable.write(chunk);
                    bufferOffset = 0;
                }
            };

            const writeData = async (data) => {
                if (signal.aborted) throw new Error('AbortError');
                if (bufferOffset + data.length > WRITE_BUFFER_SIZE) {
                    await flushBuffer();
                }
                if (data.length > WRITE_BUFFER_SIZE) {
                    await writePromise;
                    if (signal.aborted) throw new Error('AbortError');
                    writePromise = writable.write(data);
                } else {
                    writeBuffer.set(data, bufferOffset);
                    bufferOffset += data.length;
                }
            };

            for (let i = 0; i < items.length; i++) {
                if (signal.aborted) throw new Error('AbortError');
                
                const { file, filename, songName } = items[i];

                const now = Date.now();
                if (now - lastProgressTime > 100 || processedBytes - lastProgressBytes > 1024 * 1024) {
                    self.postMessage({ 
                        type: 'progress', 
                        percent: Math.round((processedBytes / (totalBytes || 1)) * 100),
                        status: `Processing: ${songName}`
                    });
                    lastProgressTime = now;
                    lastProgressBytes = processedBytes;
                }

                const method = 0; // STORE
                const header = ZIP_UTILS.createLocalHeader(filename, file.size, 0, 0, method, true);
                await writeData(header);

                let crc = 0 ^ 0xFFFFFFFF;
                let bytesWritten = 0;

                const reader = file.stream().getReader();
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (signal.aborted) throw new Error('AbortError');

                    for (let j = 0; j < value.length; j++) {
                        crc = (crc >>> 8) ^ table[(crc ^ value[j]) & 0xFF];
                    }

                    await writeData(value);
                    bytesWritten += value.length;
                    processedBytes += value.length;

                    // Throttle progress updates
                    const innerNow = Date.now();
                    if (innerNow - lastProgressTime > 100 || processedBytes - lastProgressBytes > 1024 * 1024) {
                        self.postMessage({ 
                            type: 'progress', 
                            percent: Math.round((processedBytes / (totalBytes || 1)) * 100),
                            status: `Streaming: ${songName}`
                        });
                        lastProgressTime = innerNow;
                        lastProgressBytes = processedBytes;
                    }
                }
                crc = (crc ^ 0xFFFFFFFF) >>> 0;

                const descriptor = ZIP_UTILS.createDataDescriptor(file.size, bytesWritten, crc);
                await writeData(descriptor);

                entries.push({ 
                    filename, 
                    size: file.size, 
                    crc, 
                    offset: currentOffset, 
                    compressedSize: bytesWritten, 
                    method 
                });

                currentOffset += header.length + bytesWritten + descriptor.length;
            }

            if (signal.aborted) throw new Error('AbortError');
            self.postMessage({ type: 'progress', percent: 95, status: "Finalizing ZIP structure..." });

            let cdSize = 0;
            const cdOffset = currentOffset;
            for (const e of entries) {
                const cdHeader = ZIP_UTILS.createCentralHeader(e.filename, e.size, e.crc, e.offset, e.compressedSize, e.method);
                await writeData(cdHeader);
                cdSize += cdHeader.length;
            }

            const eocd = ZIP_UTILS.createEOCD(entries.length, cdSize, cdOffset);
            await writeData(eocd);
            
            await flushBuffer();
            await writePromise;
            await writable.close();
            writable = null;

            self.postMessage({ type: 'done' });

        } catch (error) {
            if (writable) {
                try { await writable.abort(); } catch (e) { console.warn("Failed to abort writable", e); }
            }
            self.postMessage({ 
                type: 'error', 
                message: error.message,
                fileName: error.fileName || 'Unknown',
                stack: error.stack
            });
        }
    }
};
