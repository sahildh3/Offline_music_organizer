const state = {
    songs: [],
    folders: JSON.parse(localStorage.getItem('mo_folders')) || [
        { id: 'f1', name: 'Music' },
        { id: 'f2', name: 'Podcast' },
        { id: 'f3', name: 'Audiobook' },
        { id: 'f4', name: 'Instrumental' }
    ],
    tags: JSON.parse(localStorage.getItem('mo_tags')) || {},
    currentIndex: parseInt(localStorage.getItem('mo_index')) || 0,
    isPlaying: false,
    history: [],
    lastFolderId: null,
    preloadedUrl: null,
    preloadedIndex: -1,
    lastProgressUpdate: 0,
    isTaggingLocked: false,
    selectedExportMethod: localStorage.getItem('mo_export_method') || 'streaming',
    exportAbortController: null,
    exportWorker: null,
    queueSearchQuery: '',
    objectUrls: {}, // Track URLs for memory safety
    taggingLockTimeout: null
};

// --- ZIP Utility (Vanilla JS) ---
// This implements a basic ZIP writer using standard browser APIs
const ZIP_UTILS = {
    // CRC32 implementation for ZIP integrity
    crc32: (data) => {
        const table = ZIP_UTILS._getCRC32Table();
        let crc = 0 ^ 0xFFFFFFFF;
        for (let i = 0; i < data.length; i++) crc = (crc >>> 8) ^ table[(crc ^ data[i]) & 0xFF];
        return (crc ^ 0xFFFFFFFF) >>> 0;
    },

    _getCRC32Table: () => {
        if (ZIP_UTILS._table) return ZIP_UTILS._table;
        const table = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            let c = i;
            for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
            table[i] = c;
        }
        ZIP_UTILS._table = table;
        return table;
    },

    // Create a Local File Header
    createLocalHeader: (filename, size, crc, compressedSize = 0, method = 0, useDataDescriptor = false) => {
        const nameBuf = new TextEncoder().encode(filename);
        const header = new Uint8Array(30 + nameBuf.length);
        const view = new DataView(header.buffer);
        view.setUint32(0, 0x04034b50, true); // Signature
        view.setUint16(4, 20, true);         // Version
        view.setUint16(6, useDataDescriptor ? 0x0008 : 0, true); // Flags (Bit 3 for Data Descriptor)
        view.setUint16(8, method, true);     // Method (0=Store, 8=Deflate)
        view.setUint16(10, 0, true);         // Time
        view.setUint16(12, 0, true);         // Date
        view.setUint32(14, useDataDescriptor ? 0 : crc, true);       // CRC32
        view.setUint32(18, useDataDescriptor ? 0 : (compressedSize || size), true); // Compressed Size
        view.setUint32(22, useDataDescriptor ? 0 : size, true);      // Uncompressed Size
        view.setUint16(26, nameBuf.length, true); // Name Length
        view.setUint16(28, 0, true);         // Extra Length
        header.set(nameBuf, 30);
        return header;
    },

    // Create a Data Descriptor (for streaming)
    createDataDescriptor: (size, compressedSize, crc) => {
        const desc = new Uint8Array(16);
        const view = new DataView(desc.buffer);
        view.setUint32(0, 0x08074b50, true); // Signature
        view.setUint32(4, crc, true);        // CRC32
        view.setUint32(8, compressedSize, true); // Compressed Size
        view.setUint32(12, size, true);      // Uncompressed Size
        return desc;
    },

    // Create a Central Directory Header
    createCentralHeader: (filename, size, crc, offset, compressedSize = 0, method = 0) => {
        const nameBuf = new TextEncoder().encode(filename);
        const header = new Uint8Array(46 + nameBuf.length);
        const view = new DataView(header.buffer);
        view.setUint32(0, 0x02014b50, true); // Signature
        view.setUint16(4, 20, true);         // Version Made By
        view.setUint16(6, 20, true);         // Version Needed
        view.setUint16(8, 0, true);          // Flags
        view.setUint16(10, method, true);    // Method
        view.setUint16(12, 0, true);         // Time
        view.setUint16(14, 0, true);         // Date
        view.setUint32(16, crc, true);       // CRC
        view.setUint32(20, compressedSize || size, true); // Compressed Size
        view.setUint32(24, size, true);      // Uncompressed Size
        view.setUint16(28, nameBuf.length, true); // Name Length
        view.setUint16(30, 0, true);         // Extra Length
        view.setUint16(32, 0, true);         // Comment Length
        view.setUint16(34, 0, true);         // Disk Start
        view.setUint16(36, 0, true);         // Internal Attr
        view.setUint32(38, 0, true);         // External Attr
        view.setUint32(42, offset, true);    // Offset
        header.set(nameBuf, 46);
        return header;
    },

    // Create End of Central Directory
    createEOCD: (count, size, offset) => {
        const eocd = new Uint8Array(22);
        const view = new DataView(eocd.buffer);
        view.setUint32(0, 0x06054b50, true); // Signature
        view.setUint16(4, 0, true);          // Disk Number
        view.setUint16(6, 0, true);          // CD Disk Start
        view.setUint16(8, count, true);      // CD Records on Disk
        view.setUint16(10, count, true);     // Total CD Records
        view.setUint32(12, size, true);      // CD Size
        view.setUint32(16, offset, true);    // CD Offset
        view.setUint16(20, 0, true);         // Comment Length
        return eocd;
    },

    // Sanitize filename for ZIP and File System
    sanitizeFilename: (name, fallback = "unnamed") => {
        if (!name) return fallback;
        // Remove invalid characters and path separators
        // eslint-disable-next-line no-control-regex
        const sanitized = name.replace(/[<>:"/\\|?*]/g, '_').replace(/[\x00-\x1f]/g, '_').trim();
        return sanitized || fallback;
    },

    // Sanitize HTML to prevent XSS
    sanitizeHTML: (str) => {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }
};

const METADATA_UTILS = {
    extract: async (file) => {
        const metadata = { artist: 'Unknown Artist', album: 'Unknown Album' };
        try {
            // Read first 128KB for ID3v2 and MP4
            const headBuffer = await file.slice(0, 128 * 1024).arrayBuffer();
            const headView = new DataView(headBuffer);
            
            if (headView.getUint8(0) === 0x49 && headView.getUint8(1) === 0x44 && headView.getUint8(2) === 0x33) {
                METADATA_UTILS._parseID3v2(headBuffer, metadata);
            } else if (headView.getUint32(4) === 0x66747970 || headView.getUint32(4) === 0x4D344120) {
                METADATA_UTILS._parseMP4(headBuffer, metadata);
            }

            // If still unknown, check last 128 bytes for ID3v1 (MP3)
            if (metadata.artist === 'Unknown Artist' && file.size > 128) {
                const tailBuffer = await file.slice(file.size - 128).arrayBuffer();
                const tailView = new DataView(tailBuffer);
                if (tailView.getUint8(0) === 0x54 && tailView.getUint8(1) === 0x41 && tailView.getUint8(2) === 0x47) { // "TAG"
                    const decoder = new TextDecoder('utf-8');
                    const artist = decoder.decode(new Uint8Array(tailBuffer, 33, 30)).replace(/\0/g, '').trim();
                    const album = decoder.decode(new Uint8Array(tailBuffer, 63, 30)).replace(/\0/g, '').trim();
                    if (artist) metadata.artist = artist;
                    if (album) metadata.album = album;
                }
            }
        } catch (e) {
            console.warn("Metadata extraction failed:", e);
        }
        return metadata;
    },
    
    _parseID3v2: (buffer, metadata) => {
        const view = new DataView(buffer);
        const version = view.getUint8(3);
        let offset = 10;
        const tagSize = ((view.getUint8(6) & 0x7F) << 21) | ((view.getUint8(7) & 0x7F) << 14) | ((view.getUint8(8) & 0x7F) << 7) | (view.getUint8(9) & 0x7F);
        
        while (offset < tagSize && offset < buffer.byteLength - 10) {
            const frameId = String.fromCharCode(view.getUint8(offset), view.getUint8(offset+1), view.getUint8(offset+2), view.getUint8(offset+3));
            let frameSize;
            if (version === 4) {
                frameSize = ((view.getUint8(offset+4) & 0x7F) << 21) | ((view.getUint8(offset+5) & 0x7F) << 14) | ((view.getUint8(offset+6) & 0x7F) << 7) | (view.getUint8(offset+7) & 0x7F);
            } else {
                frameSize = view.getUint32(offset + 4);
            }
            
            if (frameSize <= 0) break;
            
            if (frameId === 'TPE1') metadata.artist = METADATA_UTILS._decodeText(buffer, offset + 10, frameSize);
            if (frameId === 'TALB') metadata.album = METADATA_UTILS._decodeText(buffer, offset + 10, frameSize);
            
            offset += 10 + frameSize;
        }
        return metadata;
    },

    _parseMP4: (buffer, metadata) => {
        const view = new DataView(buffer);
        let offset = 0;
        while (offset < buffer.byteLength - 8) {
            const size = view.getUint32(offset);
            const type = String.fromCharCode(view.getUint8(offset+4), view.getUint8(offset+5), view.getUint8(offset+6), view.getUint8(offset+7));
            if (size <= 0) break;
            if (type === 'moov' || type === 'udta' || type === 'meta' || type === 'ilst') {
                offset += (type === 'meta' ? 12 : 8);
                continue;
            }
            if (type === '©ART') metadata.artist = METADATA_UTILS._decodeMP4Text(buffer, offset + 8, size - 8);
            if (type === '©alb') metadata.album = METADATA_UTILS._decodeMP4Text(buffer, offset + 8, size - 8);
            
            offset += size;
        }
        return metadata;
    },

    _decodeText: (buffer, offset, size) => {
        const view = new DataView(buffer);
        const encoding = view.getUint8(offset);
        const data = new Uint8Array(buffer, offset + 1, size - 1);
        try {
            if (encoding === 1 || encoding === 2) return new TextDecoder('utf-16').decode(data).replace(/\0/g, '').trim();
            return new TextDecoder('utf-8').decode(data).replace(/\0/g, '').trim();
        } catch { return 'Unknown'; }
    },

    _decodeMP4Text: (buffer, offset, size) => {
        const view = new DataView(buffer);
        try {
            if (String.fromCharCode(view.getUint8(offset+4), view.getUint8(offset+5), view.getUint8(offset+6), view.getUint8(offset+7)) === 'data') {
                return new TextDecoder().decode(new Uint8Array(buffer, offset + 16, size - 16)).trim();
            }
        } catch { return 'Unknown'; }
        return 'Unknown';
    }
};

const elements = {
    audio: document.getElementById('audioPlayer'),
    fileInputs: [document.getElementById('fileInput'), document.getElementById('fileInputLarge')],
    mainContent: document.getElementById('mainContent'),
    uploadArea: document.getElementById('uploadArea'),
    reuploadMessage: document.getElementById('reuploadMessage'),
    foldersGrid: document.getElementById('foldersGrid'),
    queueList: document.getElementById('queueList'),
    currentSongName: document.getElementById('currentSongName'),
    currentSongInfo: document.getElementById('currentSongInfo'),
    songCounter: document.getElementById('songCounter'),
    playBtn: document.getElementById('playBtn'),
    seekSlider: document.getElementById('seekSlider'),
    currentTime: document.getElementById('currentTime'),
    duration: document.getElementById('duration'),
    progressBar: document.getElementById('progressBar'),
    progressPercent: document.getElementById('progressPercent'),
    completionState: document.getElementById('completionState'),
    activePlayer: document.getElementById('activePlayer'),
    prevBtn: document.getElementById('prevBtn'),
    nextBtn: document.getElementById('nextBtn'),
    exportBtn: document.getElementById('exportBtn'),
    exportBtnLarge: document.getElementById('exportBtnLarge'),
    importBackupBtn: document.getElementById('importBackupBtn'),
    exportBackupBtn: document.getElementById('exportBackupBtn'),
    extractMetadataToggle: document.getElementById('extractMetadataToggle'),
    skipBtn: document.getElementById('skipBtn'),
    exportSummaryModal: document.getElementById('exportSummaryModal'),
    exportSummaryList: document.getElementById('exportSummaryList'),
    cancelExportSummaryBtn: document.getElementById('cancelExportSummaryBtn'),
    confirmExportSummaryBtn: document.getElementById('confirmExportSummaryBtn'),
    manageFoldersBtn: document.getElementById('manageFoldersBtn'),
    manageFoldersModal: document.getElementById('manageFoldersModal'),
    closeManageFoldersBtn: document.getElementById('closeManageFoldersBtn'),
    manageAddFolderBtn: document.getElementById('manageAddFolderBtn'),
    manageFoldersList: document.getElementById('manageFoldersList'),
    presetsBtn: document.getElementById('presetsBtn'),
    presetsModal: document.getElementById('presetsModal'),
    closePresetsBtn: document.getElementById('closePresetsBtn'),
    folderModal: document.getElementById('folderModal'),
    folderModalTitle: document.getElementById('folderModalTitle'),
    folderNameInput: document.getElementById('folderNameInput'),
    saveFolderBtn: document.getElementById('saveFolderBtn'),
    cancelFolderBtn: document.getElementById('cancelFolderBtn'),
    undoBtn: document.getElementById('undoBtn'),
    resetAppBtn: document.getElementById('resetAppBtn'),
    clearQueueBtn: document.getElementById('clearQueueBtn'),
    confirmModal: document.getElementById('confirmModal'),
    confirmModalTitle: document.getElementById('confirmModalTitle'),
    confirmModalMessage: document.getElementById('confirmModalMessage'),
    saveConfirmBtn: document.getElementById('saveConfirmBtn'),
    cancelConfirmBtn: document.getElementById('cancelConfirmBtn'),
    helpBtn: document.getElementById('helpBtn'),
    helpModal: document.getElementById('helpModal'),
    queueSearch: document.getElementById('queueSearch'),
    closeHelpBtn: document.getElementById('closeHelpBtn'),
    installBtn: document.getElementById('installBtn'),
    shareBtn: document.getElementById('shareBtn'),
    // Export UI
    exportModal: document.getElementById('exportModal'),
    closeExportBtn: document.getElementById('closeExportBtn'),
    selectStreamingBtn: document.getElementById('selectStreamingBtn'),
    selectBatchBtn: document.getElementById('selectBatchBtn'),
    selectSyncBtn: document.getElementById('selectSyncBtn'),
    streamingDetails: document.getElementById('streamingDetails'),
    batchDetails: document.getElementById('batchDetails'),
    syncDetails: document.getElementById('syncDetails'),
    startExportBtn: document.getElementById('startExportBtn'),
    // Progress UI
    progressModal: document.getElementById('progressModal'),
    progressTitle: document.getElementById('progressTitle'),
    zipProgressBar: document.getElementById('zipProgressBar'),
    progressText: document.getElementById('progressText'),
    progressStatus: document.getElementById('progressStatus'),
    cancelExportBtn: document.getElementById('cancelExportBtn'),
    iframeWarning: document.getElementById('iframeWarning'),
    openNewTabBtn: document.getElementById('openNewTabBtn'),
    syncWarning: document.getElementById('browserCompatibilityWarning'),
    toggleAdvancedExport: document.getElementById('toggleAdvancedExport'),
    advancedExportSection: document.getElementById('advancedExportSection'),
    errorModal: document.getElementById('errorModal'),
    errorMessage: document.getElementById('errorMessage'),
    errorSuggestion: document.getElementById('errorSuggestion'),
    closeErrorBtn: document.getElementById('closeErrorBtn')
};

// --- Worker Initialization ---
function initExportWorker() {
    if (state.exportWorker) return;
    state.exportWorker = new Worker('./exportWorker.js');
    state.exportWorker.onmessage = (e) => {
        const { type, percent, status, message } = e.data;
        if (type === 'progress') {
            updateProgress(percent, status, "Streaming Export");
        } else if (type === 'done') {
            updateProgress(100, "Export Complete!", "Success!", true);
            setTimeout(() => elements.progressModal.classList.add('hidden'), 2000);
            state.exportAbortController = null;
        } else if (type === 'error') {
            handleExportError(new Error(message));
        }
    };
}

function handleExportError(error) {
    elements.progressModal.classList.add('hidden');
    state.exportAbortController = null;
    
    if (error.message === 'AbortError' || error.name === 'AbortError') {
        console.log("Export cancelled by user");
        return;
    }

    elements.errorMessage.innerText = error.message || "Unknown error occurred.";
    
    // Provide context-aware suggestions
    if (error.message.includes('4GB')) {
        elements.errorSuggestion.innerText = "Standard ZIP files are limited to 4GB. Try splitting your library into smaller folders or use 'Direct Sync'.";
    } else if (error.message.includes('Quota')) {
        elements.errorSuggestion.innerText = "Your device is low on disk space. Please free up some space and try again.";
    } else {
        elements.errorSuggestion.innerText = "Try splitting your library into smaller folders or using 'Direct Sync' if supported by your browser.";
    }
    
    elements.errorModal.classList.remove('hidden');
}

// --- Export Logic ---

async function updateProgress(percent, status, title = "Processing...", force = false) {
    const now = Date.now();
    if (!force && now - state.lastProgressUpdate < 100) return;
    state.lastProgressUpdate = now;

    if (elements.progressTitle) elements.progressTitle.innerText = title;
    if (elements.zipProgressBar) elements.zipProgressBar.style.width = `${percent}%`;
    if (elements.progressText) elements.progressText.innerText = `${percent}%`;
    if (elements.progressStatus) elements.progressStatus.innerText = status;
    // Yield to main thread to prevent UI freezing
    await new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * Method 1: Streaming Export
 * Uses a single ZIP file, processing songs one-by-one to save RAM.
 */
async function exportStreaming() {
    if (state.songs.length === 0) return;

    const totalBytes = state.songs.reduce((acc, s) => acc + s.file.size, 0);
    const ZIP_LIMIT = 4 * 1024 * 1024 * 1024; // 4GB

    if (totalBytes > ZIP_LIMIT) {
        handleExportError(new Error("Export size exceeds the 4GB limit for standard ZIP files. Please split your export into smaller folders or use 'Direct Sync'."));
        return;
    }

    if (totalBytes > 3.5 * 1024 * 1024 * 1024) {
        const proceed = confirm("Your export is near the 4GB ZIP limit. If the resulting file exceeds 4GB, it may be corrupted. Continue anyway?");
        if (!proceed) return;
    }
    
    let fileHandle;
    
    try {
        if (window.showSaveFilePicker) {
            fileHandle = await window.showSaveFilePicker({
                suggestedName: `Organized_Music_${new Date().getTime()}.zip`,
                types: [{ description: 'ZIP Archive', accept: { 'application/zip': ['.zip'] } }]
            });
        } else {
            throw new Error("API_NOT_SUPPORTED");
        }
    } catch (err) {
        if (err.name === 'AbortError' || err.message === 'AbortError') return;
        
        const isInIframe = window.self !== window.top;
        if (isInIframe || err.message === "API_NOT_SUPPORTED") {
            alert("This feature is restricted in the preview window. Please open the app in a new tab to use Streaming Export.");
        } else {
            console.error("Save picker failed:", err);
            handleExportError(new Error("Could not initialize export. Ensure your browser supports the File System Access API."));
        }
        return;
    }

    elements.exportModal.classList.add('hidden');
    elements.progressModal.classList.remove('hidden');
    await updateProgress(0, "Initializing worker...", "Streaming Export", true);

    initExportWorker();
    state.exportAbortController = new AbortController();
    
    state.exportWorker.postMessage({
        type: 'start',
        songs: state.songs,
        folders: state.folders,
        tags: state.tags,
        fileHandle: fileHandle
    });
}

async function exportBatched() {
    if (state.songs.length === 0) return;

    elements.exportModal.classList.add('hidden');
    elements.progressModal.classList.remove('hidden');
    elements.progressTitle.textContent = "Batched Export";
    elements.zipProgressBar.style.width = "0%";
    elements.progressText.textContent = "0%";
    elements.progressStatus.textContent = "Preparing batches...";
    elements.cancelExportBtn.classList.remove('hidden');

    state.exportAbortController = new AbortController();
    const signal = state.exportAbortController.signal;

    const MAX_BATCH_SIZE = 300 * 1024 * 1024; // 300MB limit per batch
    let currentBatch = [];
    let currentBatchSize = 0;
    let batchCount = 1;

    const processBatch = async (batch, index) => {
        if (signal.aborted) throw new Error('AbortError');
        await updateProgress(100, `Finalizing Batch ${index}...`, `Batch ${index}`, false);
        const entries = [];
        let offset = 0;
        const chunks = [];

        for (const item of batch) {
            if (signal.aborted) throw new Error('AbortError');
            
            try {
                const data = new Uint8Array(await item.song.file.arrayBuffer());
                const crc = ZIP_UTILS.crc32(data);
                
                let compressedData = data;
                let method = 0; // Default to STORE
                
                // Optional compression
                if (window.CompressionStream && data.length > 0) {
                    try {
                        const cs = new CompressionStream('deflate-raw');
                        const writer = cs.writable.getWriter();
                        writer.write(data);
                        writer.close();
                        const reader = cs.readable.getReader();
                        const bChunks = [];
                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) break;
                            bChunks.push(value);
                        }
                        const totalLen = bChunks.reduce((acc, c) => acc + c.length, 0);
                        compressedData = new Uint8Array(totalLen);
                        let bOffset = 0;
                        for (const chunk of bChunks) {
                            compressedData.set(chunk, bOffset);
                            bOffset += chunk.length;
                        }
                        method = 8;
                    } catch (err) {
                        console.warn(`Compression failed for ${item.song.name}, falling back to STORE`, err);
                        method = 0;
                        compressedData = data;
                    }
                }

                const header = ZIP_UTILS.createLocalHeader(item.filename, data.length, crc, compressedData.length, method);
                chunks.push(header, compressedData);
                entries.push({ filename: item.filename, size: data.length, crc, offset, compressedSize: compressedData.length, method });
                offset += header.length + compressedData.length;
                
                // Yield to main thread
                await new Promise(resolve => setTimeout(resolve, 0));
            } catch (err) {
                console.error(`Failed to process ${item.song.name} in batch:`, err);
                // Skip this file in the batch
            }
        }

        if (signal.aborted) throw new Error('AbortError');
        const cdOffset = offset;
        let cdSize = 0;
        entries.forEach(e => {
            const cdHeader = ZIP_UTILS.createCentralHeader(e.filename, e.size, e.crc, e.offset, e.compressedSize, e.method);
            chunks.push(cdHeader);
            cdSize += cdHeader.length;
        });

        chunks.push(ZIP_UTILS.createEOCD(entries.length, cdSize, cdOffset));
        
        const blob = new Blob(chunks, { type: 'application/zip' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `Organized_Music_Part${index}.zip`;
        a.click();
        
        // Explicitly flush memory
        URL.revokeObjectURL(url);
        chunks.length = 0;
        entries.length = 0;
        
        // Yield to allow GC
        await new Promise(resolve => setTimeout(resolve, 100));
    };

    try {
        const totalSongs = state.songs.length;
        const totalBytes = state.songs.reduce((acc, s) => acc + s.file.size, 0);
        let processedBytes = 0;
        let lastProgressTime = Date.now();
        let lastProgressBytes = 0;

        const sortedItems = state.songs.map((song, index) => ({ song, index })).sort((a, b) => a.song.file.size - b.song.file.size);

        for (let i = 0; i < totalSongs; i++) {
            if (signal.aborted) throw new Error('AbortError');
            const { song, index } = sortedItems[i];
            const folder = state.folders.find(f => f.id === state.tags[index]);
            const folderName = folder ? folder.name : "Unclassified";
            const filename = `${ZIP_UTILS.sanitizeFilename(folderName)}/${ZIP_UTILS.sanitizeFilename(song.name)}`;
            const fileSize = song.file.size;

            if (fileSize > MAX_BATCH_SIZE) {
                console.warn(`File ${song.name} exceeds batch size limit (${MAX_BATCH_SIZE} bytes). Skipping.`);
                processedBytes += fileSize;
                continue;
            }

            if (currentBatchSize + fileSize > MAX_BATCH_SIZE && currentBatch.length > 0) {
                await processBatch(currentBatch, batchCount++);
                currentBatch = [];
                currentBatchSize = 0;
            }

            currentBatch.push({ song, filename });
            currentBatchSize += fileSize;
            processedBytes += fileSize;
            
            const now = Date.now();
            if (now - lastProgressTime > 100 || processedBytes - lastProgressBytes > 1024 * 1024) {
                await updateProgress(Math.round((processedBytes / (totalBytes || 1)) * 100), `Batching: ${song.name}`, "Batched Export");
                lastProgressTime = now;
                lastProgressBytes = processedBytes;
            }
        }

        if (currentBatch.length > 0) {
            await processBatch(currentBatch, batchCount);
        }
        
        await updateProgress(100, "Batched Export Complete!", "Success!", true);
        setTimeout(() => elements.progressModal.classList.add('hidden'), 2000);

    } catch (error) {
        if (error.message === 'AbortError' || error.name === 'AbortError') {
            console.log("Batched export cancelled by user");
        } else {
            console.error("Batched export failed:", error);
            handleExportError(error);
        }
    } finally {
        state.exportAbortController = null;
        elements.progressModal.classList.add('hidden');
    }
}

async function exportDirectSync() {
    if (!window.showDirectoryPicker) {
        alert("Your browser does not support the File System Access API. Please use Chrome or Edge.");
        return;
    }

    try {
        const rootHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        
        elements.exportModal.classList.add('hidden');
        elements.progressModal.classList.remove('hidden');
        
        state.exportAbortController = new AbortController();
        const signal = state.exportAbortController.signal;

        const totalBytes = state.songs.reduce((acc, s) => acc + s.file.size, 0);
        let processedBytes = 0;
        let lastProgressTime = Date.now();
        let lastProgressBytes = 0;

        const sortedItems = state.songs.map((song, index) => ({ song, index })).sort((a, b) => a.song.file.size - b.song.file.size);

        for (let i = 0; i < sortedItems.length; i++) {
            if (signal.aborted) throw new Error('AbortError');
            const { song, index } = sortedItems[i];
            const folder = state.folders.find(f => f.id === state.tags[index]);
            const folderName = ZIP_UTILS.sanitizeFilename(folder ? folder.name : "Unclassified", "Unclassified");
            const songName = ZIP_UTILS.sanitizeFilename(song.name, `song_${index}.mp3`);

            const now = Date.now();
            if (now - lastProgressTime > 100 || processedBytes - lastProgressBytes > 1024 * 1024) {
                await updateProgress(Math.round((processedBytes / (totalBytes || 1)) * 100), `Syncing: ${songName}`, "Direct Sync");
                lastProgressTime = now;
                lastProgressBytes = processedBytes;
            }

            try {
                // Get or create folder
                const folderHandle = await rootHandle.getDirectoryHandle(folderName, { create: true });
                // Create file
                const fileHandle = await folderHandle.getFileHandle(songName, { create: true });
                
                // Write content using streams for stability and backpressure
                const writable = await fileHandle.createWritable();
                
                // Use pipeTo for efficient streaming and backpressure handling
                await song.file.stream().pipeTo(writable, { signal });
                
                processedBytes += song.file.size;
                
                // Yield to main thread
                await new Promise(resolve => setTimeout(resolve, 0));
            } catch (fileError) {
                if (fileError.name === 'AbortError') throw fileError;
                console.error(`Failed to sync file ${songName}:`, fileError);
                // Continue with next file unless it's a security/permission error
                if (fileError.name === 'NotAllowedError' || fileError.name === 'SecurityError') {
                    throw fileError; 
                }
            }
        }

        if (signal.aborted) throw new Error('AbortError');
        await updateProgress(100, "Sync Complete!", "Success!", true);
        setTimeout(() => elements.progressModal.classList.add('hidden'), 2000);

    } catch (error) {
        if (error.name === 'AbortError' || error.message === 'AbortError') {
            console.log("Direct sync cancelled by user");
            return;
        }
        
        const isInIframe = window.self !== window.top;
        if (isInIframe || error.message.includes('Cross origin sub frames')) {
            alert("This feature is restricted in the preview window. Please open the app in a new tab to use Direct Sync.");
        } else if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
            alert("Permission denied. The browser blocked multiple file writes. Try using 'Streaming ZIP' for better compatibility.");
        } else {
            console.error("Direct sync failed:", error);
            handleExportError(error);
        }
    } finally {
        state.exportAbortController = null;
        elements.progressModal.classList.add('hidden');
    }
}

// --- Export Summary & Backup ---

function showExportSummary() {
    if (state.songs.length === 0) return;
    
    const summary = {};
    state.folders.forEach(f => summary[f.id] = { name: f.name, count: 0 });
    summary['unassigned'] = { name: 'Unassigned', count: 0 };

    state.songs.forEach((song, index) => {
        const folderId = state.tags[index];
        if (folderId && summary[folderId]) {
            summary[folderId].count++;
        } else {
            summary['unassigned'].count++;
        }
    });

    elements.exportSummaryList.innerHTML = '';
    
    let totalCount = 0;
    for (const key in summary) {
        if (summary[key].count > 0) {
            totalCount += summary[key].count;
            const item = document.createElement('div');
            item.className = 'flex justify-between items-center py-1 border-b border-white/5 last:border-0';
            item.innerHTML = `
                <span class="text-gray-300">${summary[key].name}</span>
                <span class="font-mono text-purple-400">${summary[key].count}</span>
            `;
            elements.exportSummaryList.appendChild(item);
        }
    }

    const totalItem = document.createElement('div');
    totalItem.className = 'flex justify-between items-center py-2 mt-2 border-t border-white/10 font-bold';
    totalItem.innerHTML = `
        <span class="text-white">Total Files</span>
        <span class="font-mono text-purple-400">${totalCount}</span>
    `;
    elements.exportSummaryList.appendChild(totalItem);

    elements.exportSummaryModal.classList.remove('hidden');
}

if (elements.cancelExportSummaryBtn) {
    elements.cancelExportSummaryBtn.onclick = () => {
        elements.exportSummaryModal.classList.add('hidden');
    };
}

if (elements.confirmExportSummaryBtn) {
    elements.confirmExportSummaryBtn.onclick = () => {
        elements.exportSummaryModal.classList.add('hidden');
        elements.exportModal.classList.remove('hidden');
    };
}

if (elements.exportBackupBtn) {
    elements.exportBackupBtn.onclick = () => {
        const backupData = {
            folders: state.folders,
            tags: state.tags,
            lastFolderId: state.lastFolderId,
            songNames: state.songs.map(s => s.name) // Store names to help with matching on import
        };
        const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `MusicOrganizer_Backup_${new Date().toISOString().split('T')[0]}.json`;
        a.click();
        URL.revokeObjectURL(url);
    };
}

if (elements.importBackupBtn) {
    elements.importBackupBtn.onclick = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            try {
                const text = await file.text();
                const backupData = JSON.parse(text);
                
                if (backupData.folders && Array.isArray(backupData.folders)) {
                    state.folders = backupData.folders;
                }
                
                if (backupData.tags && typeof backupData.tags === 'object' && !Array.isArray(backupData.tags)) {
                    // We only restore tags if the number of songs matches or we map by name
                    if (state.songs.length > 0) {
                        if (backupData.songNames && backupData.songNames.length > 0) {
                            // Map by name
                            state.songs.forEach((song, index) => {
                                const backupIndex = backupData.songNames.indexOf(song.name);
                                if (backupIndex !== -1 && backupData.tags[backupIndex]) {
                                    state.tags[index] = backupData.tags[backupIndex];
                                }
                            });
                        } else {
                            // Direct restore if no names to map, assuming same order
                            state.tags = backupData.tags;
                        }
                    } else {
                        // If queue is empty, just load the tags, they will apply when songs are added
                        state.tags = backupData.tags;
                    }
                }
                
                if (backupData.lastFolderId) {
                    state.lastFolderId = backupData.lastFolderId;
                }

                saveState();
                render();
                alert("Backup imported successfully!");
            } catch (err) {
                console.error("Failed to import backup:", err);
                alert("Failed to import backup. Invalid file format.");
            }
        };
        input.click();
    };
}

// --- UI Event Listeners ---

if (elements.exportBtn) {
    elements.exportBtn.onclick = () => {
        showExportSummary();
    };
}

if (elements.exportBtnLarge) {
    elements.exportBtnLarge.onclick = () => {
        showExportSummary();
    };
}

if (elements.closeExportBtn) elements.closeExportBtn.onclick = () => elements.exportModal.classList.add('hidden');

if (elements.toggleAdvancedExport) {
    elements.toggleAdvancedExport.onclick = () => {
        const isHidden = elements.advancedExportSection.classList.contains('hidden');
        elements.advancedExportSection.classList.toggle('hidden');
        elements.toggleAdvancedExport.querySelector('svg').style.transform = isHidden ? 'rotate(180deg)' : 'rotate(0deg)';
    };
}

if (elements.closeErrorBtn) elements.closeErrorBtn.onclick = () => elements.errorModal.classList.add('hidden');

function updateExportSelection(method) {
    // Hide Direct Sync if API not supported
    if (!window.showDirectoryPicker && elements.selectSyncBtn) {
        elements.selectSyncBtn.classList.add('hidden');
        if (method === 'sync') method = 'streaming';
    }

    // Hide Streaming if API not supported
    if (!window.showSaveFilePicker && elements.selectStreamingBtn) {
        elements.selectStreamingBtn.classList.add('hidden');
        if (method === 'streaming') method = 'batch';
    }

    state.selectedExportMethod = method;
    localStorage.setItem('mo_export_method', method);
    
    // Update button styles
    const buttons = [elements.selectStreamingBtn, elements.selectBatchBtn, elements.selectSyncBtn];
    buttons.forEach(btn => {
        if (!btn) return;
        if (btn.dataset.method === method) {
            btn.classList.add('active-method', 'border-purple-500');
            btn.classList.remove('border-transparent');
        } else {
            btn.classList.remove('active-method', 'border-purple-500');
            btn.classList.add('border-transparent');
        }
    });

    // Update details visibility
    if (elements.streamingDetails) elements.streamingDetails.classList.toggle('hidden', method !== 'streaming');
    if (elements.batchDetails) elements.batchDetails.classList.toggle('hidden', method !== 'batch');
    if (elements.syncDetails) elements.syncDetails.classList.toggle('hidden', method !== 'sync');

    // Browser Compatibility Check
    if (elements.syncWarning) {
        if (method === 'sync') {
            const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
            if (isMobile) {
                elements.syncWarning.textContent = "Direct Sync is not supported on mobile browsers. Please use Streaming ZIP instead.";
                elements.syncWarning.classList.remove('hidden');
            } else if (!window.showDirectoryPicker) {
                elements.syncWarning.textContent = "Your browser does not support Direct Sync. Please use Chrome, Edge, or Brave on Desktop.";
                elements.syncWarning.classList.remove('hidden');
            } else {
                elements.syncWarning.classList.add('hidden');
            }
        } else {
            elements.syncWarning.classList.add('hidden');
        }
    }

    // Show iframe warning if in iframe and method is restricted
    if (elements.iframeWarning) {
        const isInIframe = window.self !== window.top;
        const isRestricted = method === 'streaming' || method === 'sync';
        elements.iframeWarning.classList.toggle('hidden', !isInIframe || !isRestricted);
    }
}

if (elements.selectStreamingBtn) elements.selectStreamingBtn.onclick = () => updateExportSelection('streaming');
if (elements.selectBatchBtn) elements.selectBatchBtn.onclick = () => updateExportSelection('batch');
if (elements.selectSyncBtn) elements.selectSyncBtn.onclick = () => updateExportSelection('sync');

if (elements.openNewTabBtn) {
    elements.openNewTabBtn.onclick = () => {
        window.open(window.location.href, '_blank');
    };
}

if (elements.startExportBtn) {
    elements.startExportBtn.onclick = () => {
        const totalBytes = state.songs.reduce((acc, s) => acc + s.file.size, 0);
        const ZIP_LIMIT = 4 * 1024 * 1024 * 1024; // 4GB

        if (state.selectedExportMethod !== 'sync' && totalBytes > ZIP_LIMIT) {
            alert("Export size exceeds the 4GB limit for standard ZIP files. Please split your export or use 'Direct Sync'.");
            return;
        }

        switch (state.selectedExportMethod) {
            case 'streaming':
                exportStreaming();
                break;
            case 'batch':
                exportBatched();
                break;
            case 'sync':
                exportDirectSync();
                break;
        }
    };
}

if (elements.cancelExportBtn) {
    elements.cancelExportBtn.onclick = () => {
        if (state.exportAbortController) {
            state.exportAbortController.abort();
        }
        if (state.exportWorker) {
            state.exportWorker.postMessage({ type: 'abort' });
        }
        elements.progressModal.classList.add('hidden');
    };
}

// --- Original Logic (Restored & Integrated) ---

const PRESET_PACKS = {
    language: ['English', 'Spanish', 'Hindi', 'French', 'Other'],
    mood: ['Happy', 'Sad', 'Chill', 'Energetic', 'Relax'],
    type: ['Podcast', 'Audiobook', 'Music', 'Background', 'Ambience']
};

function formatTime(s) { if (isNaN(s)) return "0:00"; const m = Math.floor(s / 60); const sc = Math.floor(s % 60); return `${m}:${sc.toString().padStart(2, '0')}`; }

function formatFileSize(b) { if (b === 0) return '0 B'; const k = 1024; const s = ['B', 'KB', 'MB', 'GB', 'TB']; const i = Math.floor(Math.log(b) / Math.log(k)); return parseFloat((b / Math.pow(k, i)).toFixed(1)) + ' ' + s[i]; }

function saveState() {
    localStorage.setItem('mo_folders', JSON.stringify(state.folders));
    localStorage.setItem('mo_tags', JSON.stringify(state.tags));
    localStorage.setItem('mo_index', state.currentIndex);
}

function revokeUrl(index) {
    if (state.objectUrls[index]) {
        URL.revokeObjectURL(state.objectUrls[index]);
        delete state.objectUrls[index];
    }
}

function preloadNext(index) {
    const nextIdx = index + 1;
    if (nextIdx < state.songs.length && !state.objectUrls[nextIdx]) {
        const nextUrl = URL.createObjectURL(state.songs[nextIdx].file);
        state.preloadedUrl = nextUrl;
        state.preloadedIndex = nextIdx;
        state.objectUrls[nextIdx] = nextUrl;
    }
}

function loadSong(index, autoplay = true) {
    if (index < 0 || index >= state.songs.length) {
        if (index >= state.songs.length && state.songs.length > 0) {
            state.currentIndex = state.songs.length;
            render();
        }
        return;
    }
    
    state.isTaggingLocked = true;
    clearTimeout(state.taggingLockTimeout);
    state.taggingLockTimeout = setTimeout(() => {
        state.isTaggingLocked = false;
    }, 1000);
    state.currentIndex = index;
    const song = state.songs[index];
    elements.currentSongName.textContent = song.name;
    elements.currentSongInfo.textContent = `${song.artist || 'Unknown Artist'} • ${song.album || 'Unknown Album'}`;
    elements.songCounter.textContent = `${index + 1} of ${state.songs.length}`;
    
    // Memory Safety: Revoke old URLs except current and preloaded
    Object.keys(state.objectUrls).forEach(idx => {
        const i = parseInt(idx);
        if (i < index - 1 || i > index + 1) revokeUrl(i);
    });

    if (state.preloadedIndex === index && state.preloadedUrl) {
        elements.audio.src = state.preloadedUrl;
        state.objectUrls[index] = state.preloadedUrl;
        state.preloadedUrl = null;
        state.preloadedIndex = -1;
    } else {
        const url = state.objectUrls[index] || URL.createObjectURL(song.file);
        elements.audio.src = url;
        state.objectUrls[index] = url;
    }
    
    if (autoplay) {
        elements.audio.play().then(() => {
            state.isPlaying = true;
            updatePlayIcon();
        }).catch((err) => {
            if (err.name === 'NotAllowedError') {
                state.isPlaying = false;
                updatePlayIcon();
            }
        });
    } else {
        state.isPlaying = false;
        updatePlayIcon();
    }

    preloadNext(index);
    render();
    saveState();
}

elements.audio.loop = true;

elements.audio.oncanplaythrough = () => {
    state.isTaggingLocked = false;
};

elements.audio.onerror = () => {
    console.error("Audio playback error");
    state.isTaggingLocked = false;
    elements.currentSongInfo.textContent = "Playback Error";
};

elements.audio.onended = () => {
    state.isPlaying = false;
    updatePlayIcon();
};

function updatePlayIcon() {
    if (!elements.playBtn) return;
    if (state.isPlaying) {
        elements.playBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-8 h-8"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
    } else {
        elements.playBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-8 h-8 ml-1"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
    }
}

function tagSong(folderId) {
    if (state.isTaggingLocked || state.currentIndex >= state.songs.length) return;
    
    state.isTaggingLocked = true;
    
    state.history.push({ index: state.currentIndex, folderId: state.tags[state.currentIndex] || null });
    elements.undoBtn.disabled = false;

    state.tags[state.currentIndex] = folderId;
    state.lastFolderId = folderId;

    if (state.currentIndex < state.songs.length - 1) {
        const nextIdx = state.currentIndex + 1;
        // Guarantee preload before switching
        if (!state.objectUrls[nextIdx]) {
            const nextUrl = URL.createObjectURL(state.songs[nextIdx].file);
            state.objectUrls[nextIdx] = nextUrl;
            state.preloadedUrl = nextUrl;
            state.preloadedIndex = nextIdx;
        }
        loadSong(nextIdx);
    } else {
        state.currentIndex = state.songs.length;
        elements.audio.pause();
        state.isPlaying = false;
        updatePlayIcon();
        state.isTaggingLocked = false;
        render();
        saveState();
    }
}

function undo() {
    if (state.history.length === 0) return;
    const last = state.history.pop();
    if (state.history.length === 0) elements.undoBtn.disabled = true;
    if (last.folderId === null) delete state.tags[last.index];
    else state.tags[last.index] = last.folderId;
    loadSong(last.index, false);
}

let confirmCallback = null;
function openConfirmModal(title, message, callback) {
    elements.confirmModalTitle.textContent = title;
    elements.confirmModalMessage.textContent = message;
    elements.confirmModal.classList.remove('hidden');
    confirmCallback = callback;
}

if (elements.saveConfirmBtn) {
    elements.saveConfirmBtn.onclick = () => {
        if (confirmCallback) confirmCallback();
        elements.confirmModal.classList.add('hidden');
    };
}

if (elements.cancelConfirmBtn) elements.cancelConfirmBtn.onclick = () => elements.confirmModal.classList.add('hidden');

function renderQueue() {
    if (!elements.queueList) return;
    
    const query = state.queueSearchQuery.toLowerCase();
    const filteredIndices = [];
    
    for (let i = 0; i < state.songs.length; i++) {
        const s = state.songs[i];
        const folder = state.folders.find(f => f.id === state.tags[i]);
        const folderName = folder ? folder.name.toLowerCase() : '';
        const songName = s.name.toLowerCase();
        const artist = (s.artist || '').toLowerCase();
        const album = (s.album || '').toLowerCase();
        
        if (query && !songName.includes(query) && !folderName.includes(query) && !artist.includes(query) && !album.includes(query)) {
            continue;
        }
        filteredIndices.push(i);
    }

    const totalItems = filteredIndices.length;
    const itemHeight = 56; // Approximate height of a queue item
    const containerHeight = elements.queueList.clientHeight || 400;
    const buffer = 10;
    
    const scrollTop = elements.queueList.scrollTop;
    
    const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - buffer);
    const endIndex = Math.min(totalItems - 1, Math.floor((scrollTop + containerHeight) / itemHeight) + buffer);
    
    elements.queueList.innerHTML = '';
    
    if (totalItems === 0) {
        const emptyMsg = document.createElement('div');
        emptyMsg.className = 'p-4 text-center text-[10px] text-gray-600 italic';
        emptyMsg.textContent = 'No songs found.';
        elements.queueList.appendChild(emptyMsg);
        return;
    }

    const spacerTop = document.createElement('div');
    spacerTop.style.height = `${startIndex * itemHeight}px`;
    elements.queueList.appendChild(spacerTop);
    
    for (let i = startIndex; i <= endIndex; i++) {
        const originalIndex = filteredIndices[i];
        const s = state.songs[originalIndex];
        const folder = state.folders.find(f => f.id === state.tags[originalIndex]);
        
        const isActive = state.currentIndex === originalIndex;
        const item = document.createElement('div');
        item.className = `p-3 rounded-xl flex items-center gap-3 cursor-pointer transition-all ${isActive ? 'bg-purple-500/20 border border-purple-500/30' : 'hover:bg-white/5'}`;
        item.onclick = () => loadSong(originalIndex);
        item.innerHTML = `
            <span class="text-[10px] font-mono text-gray-600 w-4">${originalIndex + 1}</span>
            <div class="flex-1 min-w-0">
                <div class="flex justify-between items-center gap-2">
                    <p class="text-xs font-bold truncate ${isActive ? 'text-white' : 'text-gray-400'}">${ZIP_UTILS.sanitizeHTML(s.name)}</p>
                    <span class="text-[9px] text-gray-500 font-mono whitespace-nowrap">${formatFileSize(s.file.size)}</span>
                </div>
                <div class="flex items-center gap-2 mt-0.5">
                    ${folder ? `<p class="text-[8px] text-purple-400 font-bold uppercase">${ZIP_UTILS.sanitizeHTML(folder.name)}</p>` : ''}
                    <p class="text-[8px] text-gray-500 truncate">${ZIP_UTILS.sanitizeHTML(s.artist || 'Unknown Artist')} • ${ZIP_UTILS.sanitizeHTML(s.album || 'Unknown Album')}</p>
                </div>
            </div>
            ${state.tags[originalIndex] ? '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-3 h-3 text-green-500"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>' : ''}
        `;
        elements.queueList.appendChild(item);
    }
    
    const spacerBottom = document.createElement('div');
    spacerBottom.style.height = `${Math.max(0, (totalItems - 1 - endIndex) * itemHeight)}px`;
    elements.queueList.appendChild(spacerBottom);
}

// Add scroll listener once
if (elements.queueList && !elements.queueList.dataset.scrollBound) {
    elements.queueList.addEventListener('scroll', () => {
        renderQueue();
    });
    elements.queueList.dataset.scrollBound = "true";
}

function render() {
    if (state.songs.length === 0) {
        elements.uploadArea.classList.remove('hidden');
        elements.mainContent.classList.add('hidden');
        elements.exportBtn.disabled = true;
        if (Object.keys(state.tags).length > 0 || state.currentIndex > 0) {
            elements.reuploadMessage.innerHTML = `<div class="p-4 bg-purple-500/10 border border-purple-500/20 rounded-2xl mb-4"><p class="text-purple-400 font-bold text-sm">Action Required: Re-upload files to continue</p><p class="text-gray-500 text-xs mt-1">Your progress is saved, but files must be re-loaded for playback.</p></div>`;
        }
        return;
    }
    elements.uploadArea.classList.add('hidden');
    elements.mainContent.classList.remove('hidden');
    elements.exportBtn.disabled = false;

    const isDone = state.currentIndex >= state.songs.length;
    elements.completionState.classList.toggle('hidden', !isDone);
    elements.activePlayer.classList.toggle('hidden', isDone);

    const processed = Object.keys(state.tags).length;
    const percent = Math.round((processed / state.songs.length) * 100) || 0;
    elements.progressBar.style.width = `${percent}%`;
    elements.progressPercent.textContent = `Processed: ${processed} / ${state.songs.length}`;

    const folderCounts = {};
    Object.values(state.tags).forEach(folderId => {
        folderCounts[folderId] = (folderCounts[folderId] || 0) + 1;
    });

    elements.foldersGrid.innerHTML = '';
    state.folders.forEach((f, i) => {
        const isTagged = state.tags[state.currentIndex] === f.id;
        const isLastUsed = state.lastFolderId === f.id;
        const count = folderCounts[f.id] || 0;
        const btn = document.createElement('div');
        btn.className = `folder-card relative group p-6 rounded-2xl border-2 transition-all flex flex-col items-center gap-2 btn-active cursor-pointer ${
            isTagged ? 'bg-purple-600 border-purple-400 shadow-lg shadow-purple-500/20' : 
            isLastUsed ? 'bg-white/10 border-purple-500/40' : 
            'bg-white/5 border-transparent hover:border-white/10'
        }`;
        btn.dataset.id = f.id;
        btn.innerHTML = `
            <span class="absolute top-2 left-3 text-[10px] font-bold opacity-30">${i + 1}</span>
            ${isTagged ? '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-6 h-6"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>' : '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-6 h-6"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>'}
            <div class="text-center w-full px-2">
                <p class="text-xs font-bold truncate">${ZIP_UTILS.sanitizeHTML(f.name)}</p>
                <p class="text-[9px] font-bold opacity-40 uppercase tracking-wider mt-0.5">${count} ${count === 1 ? 'song' : 'songs'}</p>
            </div>
        `;
        
        elements.foldersGrid.appendChild(btn);
    });

    renderQueue();
}

async function processFiles(files) {
    if (files.length === 0) return;
    
    await updateProgress(0, "Reading metadata...", "Loading");
    elements.progressModal.classList.remove('hidden');
    
    const newSongs = [];
    let lastProgressTime = Date.now();
    const extractMetadata = elements.extractMetadataToggle ? elements.extractMetadataToggle.checked : true;

    for (let i = 0; i < files.length; i++) {
        const f = files[i];
        let meta = { artist: 'Unknown Artist', album: 'Unknown Album' };
        if (extractMetadata) {
            meta = await METADATA_UTILS.extract(f);
        }
        newSongs.push({ name: f.name, file: f, ...meta });
        
        const now = Date.now();
        if (now - lastProgressTime > 100 || i === files.length - 1) {
            await updateProgress(Math.round((i / files.length) * 100), `Loading: ${f.name}`);
            lastProgressTime = now;
        }
    }
    
    elements.progressModal.classList.add('hidden');
    const wasEmpty = state.songs.length === 0;
    state.songs = [...state.songs, ...newSongs];
    if (wasEmpty) loadSong(state.currentIndex, false);
    else render();
}

elements.fileInputs.forEach(input => {
    input.onchange = async (e) => {
        const files = Array.from(e.target.files);
        await processFiles(files);
    };
});

if (elements.uploadArea) {
    elements.uploadArea.ondragover = (e) => {
        e.preventDefault();
        elements.uploadArea.classList.add('border-purple-500', 'bg-white/5');
    };
    elements.uploadArea.ondragleave = (e) => {
        e.preventDefault();
        elements.uploadArea.classList.remove('border-purple-500', 'bg-white/5');
    };
    elements.uploadArea.ondrop = async (e) => {
        e.preventDefault();
        elements.uploadArea.classList.remove('border-purple-500', 'bg-white/5');
        const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('audio/') || f.name.endsWith('.mp3') || f.name.endsWith('.wav') || f.name.endsWith('.ogg') || f.name.endsWith('.m4a'));
        await processFiles(files);
    };
}

elements.queueSearch.oninput = (e) => {
    state.queueSearchQuery = e.target.value;
    render();
};

function skipSong() {
    if (state.currentIndex >= 0 && state.currentIndex < state.songs.length) {
        if (state.currentIndex + 1 >= state.songs.length) {
            elements.audio.pause();
            state.isPlaying = false;
            updatePlayIcon();
        }
        loadSong(state.currentIndex + 1);
    }
}

if (elements.skipBtn) elements.skipBtn.onclick = skipSong;

if (elements.playBtn) elements.playBtn.onclick = () => { if (state.isPlaying) elements.audio.pause(); else elements.audio.play(); state.isPlaying = !state.isPlaying; updatePlayIcon(); };
if (elements.prevBtn) elements.prevBtn.onclick = () => loadSong(state.currentIndex - 1);
if (elements.nextBtn) elements.nextBtn.onclick = () => loadSong(state.currentIndex + 1);
if (elements.undoBtn) elements.undoBtn.onclick = undo;
if (elements.audio) {
    elements.audio.ontimeupdate = () => { 
        if (!elements.audio.duration) return;
        const p = (elements.audio.currentTime / elements.audio.duration) * 100 || 0; 
        if (elements.seekSlider) elements.seekSlider.value = p; 
        if (elements.currentTime) elements.currentTime.textContent = formatTime(elements.audio.currentTime); 
        if (elements.duration) elements.duration.textContent = formatTime(elements.audio.duration); 
    };
}
if (elements.seekSlider) elements.seekSlider.oninput = () => { elements.audio.currentTime = (elements.seekSlider.value / 100) * elements.audio.duration; };

if (elements.foldersGrid) {
    elements.foldersGrid.addEventListener("click", (e) => {
        const card = e.target.closest(".folder-card");
        if (!card) return;
        const id = card.dataset.id;
        tagSong(id);
    });
}

let folderModalCallback = null;
function openFolderModal(title, initialValue, callback) {
    elements.folderModalTitle.textContent = title;
    elements.folderNameInput.value = initialValue;
    elements.folderModal.classList.remove('hidden');
    setTimeout(() => elements.folderNameInput.focus(), 50);
    folderModalCallback = callback;
}

elements.folderNameInput.onkeydown = (e) => {
    if (e.key === 'Enter') {
        elements.saveFolderBtn.click();
    } else if (e.key === 'Escape') {
        elements.cancelFolderBtn.click();
    }
};

if (elements.saveFolderBtn) {
    elements.saveFolderBtn.onclick = () => {
        const name = elements.folderNameInput.value.trim();
        if (name && folderModalCallback) {
            folderModalCallback(name);
            elements.folderModal.classList.add('hidden');
        }
    };
}

if (elements.cancelFolderBtn) elements.cancelFolderBtn.onclick = () => elements.folderModal.classList.add('hidden');

if (elements.manageAddFolderBtn) {
    elements.manageAddFolderBtn.onclick = () => {
        openFolderModal('Add Folder', '', (name) => {
            if (state.folders.some(f => f.name.toLowerCase() === name.toLowerCase())) {
                alert('A folder with this name already exists.');
                return;
            }
            state.folders.push({ id: 'f' + Date.now(), name });
            if (state.folders.length > 9) {
                alert("Note: Keyboard shortcuts (1-9) are only supported for the first 9 folders.");
            }
            saveState();
            render();
            renderManageFolders();
        });
    };
}

if (elements.manageFoldersBtn) {
    elements.manageFoldersBtn.onclick = () => {
        renderManageFolders();
        elements.manageFoldersModal.classList.remove('hidden');
    };
}

if (elements.closeManageFoldersBtn) {
    elements.closeManageFoldersBtn.onclick = () => {
        elements.manageFoldersModal.classList.add('hidden');
    };
}

function renderManageFolders() {
    if (!elements.manageFoldersList) return;
    elements.manageFoldersList.innerHTML = '';
    
    if (state.folders.length === 0) {
        elements.manageFoldersList.innerHTML = '<p class="text-xs text-gray-500 text-center py-4">No folders created yet.</p>';
        return;
    }

    state.folders.forEach((f, i) => {
        const item = document.createElement('div');
        item.className = 'flex items-center justify-between p-3 bg-white/5 border border-white/5 rounded-xl group';
        item.dataset.id = f.id;

        item.innerHTML = `
            <div class="flex items-center gap-3 w-full">
                <div class="w-8 h-8 rounded-lg ${i < 9 ? 'bg-purple-500/20 text-purple-400' : 'bg-white/5 text-gray-500'} font-bold flex items-center justify-center text-xs shrink-0">
                    ${i + 1}
                </div>
                
                <div class="flex-1 min-w-0 flex items-center">
                    <span class="text-sm font-bold truncate folder-name-display block w-full">${ZIP_UTILS.sanitizeHTML(f.name)}</span>
                    <input type="text" class="hidden w-full bg-black/50 border border-purple-500/50 rounded px-2 py-1 text-sm font-bold text-white outline-none folder-name-input" value="${ZIP_UTILS.sanitizeHTML(f.name)}">
                </div>
                
                <div class="flex items-center gap-1 shrink-0">
                    <button class="manage-up-btn p-2 bg-white/5 hover:bg-white/10 rounded-lg transition-colors ${i === 0 ? 'opacity-30 cursor-not-allowed' : ''}" title="Move Up" ${i === 0 ? 'disabled' : ''}>
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>
                    </button>
                    <button class="manage-down-btn p-2 bg-white/5 hover:bg-white/10 rounded-lg transition-colors ${i === state.folders.length - 1 ? 'opacity-30 cursor-not-allowed' : ''}" title="Move Down" ${i === state.folders.length - 1 ? 'disabled' : ''}>
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
                    </button>
                    <div class="w-px h-6 bg-white/10 mx-1"></div> <button class="manage-rename-btn p-2 bg-white/5 hover:bg-white/10 text-gray-300 rounded-lg transition-colors" title="Edit">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
                    </button>
                    <button class="manage-save-btn hidden p-2 bg-purple-500/20 hover:bg-purple-500/40 text-purple-400 rounded-lg transition-colors" title="Save">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                    </button>
                    <button class="manage-delete-btn p-2 bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded-lg transition-colors" title="Delete">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                    </button>
                </div>
            </div>
        `;

        const upBtn = item.querySelector('.manage-up-btn');
        const downBtn = item.querySelector('.manage-down-btn');
        const renameBtn = item.querySelector('.manage-rename-btn');
        const saveBtn = item.querySelector('.manage-save-btn');
        const deleteBtn = item.querySelector('.manage-delete-btn');
        const nameDisplay = item.querySelector('.folder-name-display');
        const nameInput = item.querySelector('.folder-name-input');

        if (upBtn) upBtn.onclick = () => {
            if (i > 0) {
                const temp = state.folders[i];
                state.folders[i] = state.folders[i - 1];
                state.folders[i - 1] = temp;
                saveState();
                render();
                renderManageFolders();
            }
        };

        if (downBtn) downBtn.onclick = () => {
            if (i < state.folders.length - 1) {
                const temp = state.folders[i];
                state.folders[i] = state.folders[i + 1];
                state.folders[i + 1] = temp;
                saveState();
                render();
                renderManageFolders();
            }
        };

        const toggleEdit = (editing) => {
            if (editing) {
                nameDisplay.classList.add('hidden');
                nameInput.classList.remove('hidden');
                renameBtn.classList.add('hidden');
                saveBtn.classList.remove('hidden');
                nameInput.focus();
            } else {
                nameDisplay.classList.remove('hidden');
                nameInput.classList.add('hidden');
                renameBtn.classList.remove('hidden');
                saveBtn.classList.add('hidden');
            }
        };

        if (renameBtn) renameBtn.onclick = () => toggleEdit(true);
        
        const saveEdit = () => {
            const newName = nameInput.value.trim();
            if (newName && newName !== f.name) {
                if (state.folders.some(folder => folder.id !== f.id && folder.name.toLowerCase() === newName.toLowerCase())) {
                    alert('A folder with this name already exists.');
                    nameInput.value = f.name;
                    toggleEdit(false);
                    return;
                }
                f.name = newName;
                saveState();
                render();
                renderManageFolders();
            } else {
                toggleEdit(false);
            }
        };

        if (saveBtn) saveBtn.onclick = saveEdit;
        
        if (nameInput) {
            nameInput.onkeydown = (e) => {
                if (e.key === 'Enter') saveEdit();
                else if (e.key === 'Escape') {
                    nameInput.value = f.name;
                    toggleEdit(false);
                }
            };
        }

        if (deleteBtn) deleteBtn.onclick = () => {
            openConfirmModal('Delete Folder', `Are you sure you want to delete "${f.name}"? Songs in this folder will be unclassified.`, () => {
                state.folders = state.folders.filter(folder => folder.id !== f.id);
                for (const index in state.tags) {
                    if (state.tags[index] === f.id) {
                        delete state.tags[index];
                    }
                }
                saveState();
                render();
                renderManageFolders();
            });
        };

        elements.manageFoldersList.appendChild(item);
    });
}

if (elements.resetAppBtn) {
    elements.resetAppBtn.onclick = () => { 
        openConfirmModal('Reset Everything', 'This will clear all songs, tags, and folders. Are you sure?', () => {
            state.folders = [
                { id: 'f1', name: 'Music' },
                { id: 'f2', name: 'Podcast' },
                { id: 'f3', name: 'Audiobook' },
                { id: 'f4', name: 'Instrumental' }
            ];
            state.songs = []; 
            state.tags = {}; 
            state.currentIndex = 0; 
            state.history = []; 
            state.lastFolderId = null; 
            Object.values(state.objectUrls).forEach(url => {
                try { URL.revokeObjectURL(url); } catch (e) { console.warn("Revoke failed", e); }
            }); 
            state.objectUrls = {}; 
            ['mo_folders', 'mo_tags', 'mo_index', 'mo_export_method'].forEach(key => localStorage.removeItem(key));
            render(); 
        });
    };
}

if (elements.clearQueueBtn) {
    elements.clearQueueBtn.onclick = () => { 
        openConfirmModal('Clear Queue', 'This will remove all songs from the queue. Tags will be preserved if you re-upload. Are you sure?', () => {
            state.songs = []; state.tags = {}; state.currentIndex = 0; state.history = []; state.lastFolderId = null; Object.values(state.objectUrls).forEach(url => URL.revokeObjectURL(url)); state.objectUrls = {}; saveState(); render(); 
        });
    };
}

if (elements.presetsBtn) elements.presetsBtn.onclick = () => elements.presetsModal.classList.remove('hidden');
if (elements.closePresetsBtn) elements.closePresetsBtn.onclick = () => elements.presetsModal.classList.add('hidden');

if (elements.helpBtn) elements.helpBtn.onclick = () => elements.helpModal.classList.remove('hidden');
if (elements.closeHelpBtn) elements.closeHelpBtn.onclick = () => elements.helpModal.classList.add('hidden');

// PWA Install Logic
let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    elements.installBtn.classList.remove('hidden');
});

if (elements.installBtn) {
    elements.installBtn.onclick = async () => {
        if (!deferredPrompt) return;
        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        if (outcome === 'accepted') {
            elements.installBtn.classList.add('hidden');
        }
        deferredPrompt = null;
    };
}

// Share Logic
if (elements.shareBtn) {
    elements.shareBtn.onclick = async () => {
        if (navigator.share) {
            try {
                await navigator.share({
                    title: 'Music Organizer Tool',
                    text: 'Organize your music library offline with this professional tool!',
                    url: window.location.href
                });
            } catch (err) {
                console.error('Error sharing:', err);
            }
        } else {
            try {
                await navigator.clipboard.writeText(window.location.href);
                alert('Link copied to clipboard!');
            } catch (err) {
                console.error('Error copying to clipboard:', err);
            }
        }
    };
}

document.querySelectorAll('.preset-pack-btn').forEach(btn => {
    btn.onclick = () => {
        const pack = btn.dataset.pack;
        if (PRESET_PACKS[pack]) {
            PRESET_PACKS[pack].forEach(name => {
                const exists = state.folders.some(f => f.name.toLowerCase() === name.toLowerCase());
                if (!exists) {
                    state.folders.push({ id: `p${pack}${Date.now()}${Math.random()}`, name });
                }
            });
            saveState();
            render();
            elements.presetsModal.classList.add('hidden');
        }
    };
});

window.onkeydown = (e) => { 
    if (e.target.tagName === 'INPUT') return;
    if (e.key === ' ') { 
        e.preventDefault(); 
        elements.playBtn.click(); 
    } else if (e.key === 'ArrowRight') {
        elements.nextBtn.click(); 
    } else if (e.key === 'ArrowLeft') {
        elements.prevBtn.click(); 
    } else if (e.key === 's' || e.key === 'S' || e.key === 'Shift') {
        e.preventDefault();
        skipSong();
    } else if (e.key === 'z' && (e.ctrlKey || e.metaKey)) { 
        e.preventDefault(); 
        undo(); 
    } else if (!isNaN(e.key) && e.key !== '0') { 
        const f = state.folders[parseInt(e.key) - 1]; 
        if (f) tagSong(f.id); 
    } 
};

window.addEventListener('beforeunload', (e) => {
    if (state.songs.length > 0) {
        e.preventDefault();
        e.returnValue = '';
    }
});

render();
updateExportSelection(state.selectedExportMethod);

// --- PWA Registration ---
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
}
