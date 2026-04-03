const safeCreateIcons = () => { if (window.lucide) window.lucide.createIcons(); };

// --- PWA Registration ---
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
}

// --- State & Logic ---
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
    isTaggingLocked: false,
    objectUrls: {} // Track URLs for memory safety
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
    addFolderBtn: document.getElementById('addFolderBtn'),
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
    closeHelpBtn: document.getElementById('closeHelpBtn'),
    installBtn: document.getElementById('installBtn'),
    shareBtn: document.getElementById('shareBtn'),
    progressModal: document.getElementById('progressModal'),
    progressBar: document.getElementById('progressBar'),
    progressText: document.getElementById('progressText'),
    progressStatus: document.getElementById('progressStatus')
};

const PRESET_PACKS = {
    language: ['English', 'Spanish', 'Hindi', 'French', 'Other'],
    mood: ['Happy', 'Sad', 'Chill', 'Energetic', 'Relax'],
    type: ['Podcast', 'Audiobook', 'Music', 'Background', 'Ambience']
};

function formatTime(s) { if (isNaN(s)) return "0:00"; const m = Math.floor(s / 60); const sc = Math.floor(s % 60); return `${m}:${sc.toString().padStart(2, '0')}`; }

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

function loadSong(index, autoplay = true) {
    if (index < 0 || index >= state.songs.length) {
        if (index >= state.songs.length && state.songs.length > 0) {
            state.currentIndex = state.songs.length;
            render();
        }
        return;
    }
    
    state.isTaggingLocked = true;
    state.currentIndex = index;
    const song = state.songs[index];
    elements.currentSongName.textContent = song.name;
    elements.songCounter.textContent = `${index + 1} of ${state.songs.length}`;
    
    // Memory Safety: Revoke old URLs except current and preloaded
    Object.keys(state.objectUrls).forEach(idx => {
        const i = parseInt(idx);
        if (i !== index && i !== index + 1) revokeUrl(i);
    });

    if (state.preloadedIndex === index && state.preloadedUrl) {
        elements.audio.src = state.preloadedUrl;
        state.objectUrls[index] = state.preloadedUrl;
        state.preloadedUrl = null;
        state.preloadedIndex = -1;
    } else {
        const url = URL.createObjectURL(song.file);
        elements.audio.src = url;
        state.objectUrls[index] = url;
    }
    
    if (autoplay) {
        elements.audio.play().then(() => {
            state.isPlaying = true;
            updatePlayIcon();
        }).catch(() => {});
    } else {
        state.isPlaying = false;
        updatePlayIcon();
    }

    // Preload next
    const nextIdx = index + 1;
    if (nextIdx < state.songs.length && !state.objectUrls[nextIdx]) {
        const nextUrl = URL.createObjectURL(state.songs[nextIdx].file);
        state.preloadedUrl = nextUrl;
        state.preloadedIndex = nextIdx;
        state.objectUrls[nextIdx] = nextUrl;
    }

    state.isTaggingLocked = false;
    render();
    saveState();
}

function updatePlayIcon() {
    elements.playBtn.innerHTML = `<i data-lucide="${state.isPlaying ? 'pause' : 'play'}" class="w-8 h-8 ${state.isPlaying ? '' : 'ml-1'}"></i>`;
    lucide.createIcons();
}

function tagSong(folderId) {
    if (state.isTaggingLocked || state.currentIndex >= state.songs.length) return;
    
    state.history.push({ index: state.currentIndex, folderId: state.tags[state.currentIndex] || null });
    elements.undoBtn.disabled = false;

    state.tags[state.currentIndex] = folderId;
    state.lastFolderId = folderId;

    if (state.currentIndex < state.songs.length - 1) {
        loadSong(state.currentIndex + 1);
    } else {
        state.currentIndex = state.songs.length;
        elements.audio.pause();
        state.isPlaying = false;
        updatePlayIcon();
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

elements.saveConfirmBtn.onclick = () => {
    if (confirmCallback) confirmCallback();
    elements.confirmModal.classList.add('hidden');
};

elements.cancelConfirmBtn.onclick = () => elements.confirmModal.classList.add('hidden');

function render() {
    if (state.songs.length === 0) {
        elements.uploadArea.classList.remove('hidden');
        elements.mainContent.classList.add('hidden');
        elements.exportBtn.disabled = true;
        if (Object.keys(state.tags).length > 0 || state.currentIndex > 0) {
            elements.reuploadMessage.innerHTML = `<span class="text-purple-400 font-bold">Session Restored.</span> Re-upload files to continue organizing.`;
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

    elements.foldersGrid.innerHTML = '';
    state.folders.forEach((f, i) => {
        const isTagged = state.tags[state.currentIndex] === f.id;
        const isLastUsed = state.lastFolderId === f.id;
        const btn = document.createElement('div');
        btn.className = `relative group p-6 rounded-2xl border-2 transition-all flex flex-col items-center gap-2 btn-active cursor-pointer ${
            isTagged ? 'bg-purple-600 border-purple-400 shadow-lg shadow-purple-500/20' : 
            isLastUsed ? 'bg-white/10 border-purple-500/40' : 
            'bg-white/5 border-transparent hover:border-white/10'
        }`;
        btn.innerHTML = `
            <span class="absolute top-2 left-3 text-[10px] font-bold opacity-30">${i + 1}</span>
            <div class="absolute top-2 right-2 flex gap-1 opacity-100 sm:opacity-0 group-hover:opacity-100 transition-opacity">
                <button class="rename-folder-btn p-1.5 bg-white/10 sm:bg-transparent hover:bg-white/20 rounded-lg" data-id="${f.id}"><i data-lucide="edit-2" class="w-3.5 h-3.5"></i></button>
                <button class="delete-folder-btn p-1.5 bg-red-500/20 sm:bg-transparent hover:bg-red-500/30 text-red-400 rounded-lg" data-id="${f.id}"><i data-lucide="trash" class="w-3.5 h-3.5"></i></button>
            </div>
            <i data-lucide="${isTagged ? 'check-circle' : 'folder'}" class="w-6 h-6"></i>
            <span class="text-xs font-bold truncate w-full text-center px-2">${f.name}</span>
        `;
        btn.onclick = (e) => {
            if (e.target.closest('button')) return;
            tagSong(f.id);
        };
        
        btn.querySelector('.rename-folder-btn').onclick = (e) => {
            e.stopPropagation();
            openFolderModal('Rename Folder', f.name, (newName) => {
                f.name = newName;
                saveState();
                render();
            });
        };
        
        btn.querySelector('.delete-folder-btn').onclick = (e) => {
            e.stopPropagation();
            openConfirmModal('Delete Folder', `Are you sure you want to delete "${f.name}"?`, () => {
                state.folders = state.folders.filter(folder => folder.id !== f.id);
                saveState();
                render();
            });
        };
        
        elements.foldersGrid.appendChild(btn);
    });

    elements.queueList.innerHTML = '';
    state.songs.forEach((s, i) => {
        const isActive = state.currentIndex === i;
        const folder = state.folders.find(f => f.id === state.tags[i]);
        const item = document.createElement('div');
        item.className = `p-3 rounded-xl flex items-center gap-3 cursor-pointer transition-all ${isActive ? 'bg-purple-500/20 border border-purple-500/30' : 'hover:bg-white/5'}`;
        item.onclick = () => loadSong(i);
        item.innerHTML = `
            <span class="text-[10px] font-mono text-gray-600 w-4">${i + 1}</span>
            <div class="flex-1 min-w-0">
                <p class="text-xs font-bold truncate ${isActive ? 'text-white' : 'text-gray-400'}">${s.name}</p>
                ${folder ? `<p class="text-[8px] text-purple-400 font-bold uppercase">${folder.name}</p>` : ''}
            </div>
            ${state.tags[i] ? '<i data-lucide="check" class="w-3 h-3 text-green-500"></i>' : ''}
        `;
        elements.queueList.appendChild(item);
    });
    safeCreateIcons();
}

elements.fileInputs.forEach(input => {
    input.onchange = (e) => {
        const files = Array.from(e.target.files);
        if (files.length === 0) return;
        const newSongs = files.map(f => ({ name: f.name, file: f }));
        const wasEmpty = state.songs.length === 0;
        state.songs = [...state.songs, ...newSongs];
        if (wasEmpty) loadSong(state.currentIndex, false);
        else render();
    };
});

elements.playBtn.onclick = () => { if (state.isPlaying) elements.audio.pause(); else elements.audio.play(); state.isPlaying = !state.isPlaying; updatePlayIcon(); };
elements.prevBtn.onclick = () => loadSong(state.currentIndex - 1);
elements.nextBtn.onclick = () => loadSong(state.currentIndex + 1);
elements.undoBtn.onclick = undo;
elements.audio.ontimeupdate = () => { const p = (elements.audio.currentTime / elements.audio.duration) * 100 || 0; elements.seekSlider.value = p; elements.currentTime.textContent = formatTime(elements.audio.currentTime); elements.duration.textContent = formatTime(elements.audio.duration); };
elements.seekSlider.oninput = () => { elements.audio.currentTime = (elements.seekSlider.value / 100) * elements.audio.duration; };

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

elements.saveFolderBtn.onclick = () => {
    const name = elements.folderNameInput.value.trim();
    if (name && folderModalCallback) {
        folderModalCallback(name);
        elements.folderModal.classList.add('hidden');
    }
};

elements.cancelFolderBtn.onclick = () => elements.folderModal.classList.add('hidden');

elements.addFolderBtn.onclick = () => {
    openFolderModal('Add Folder', '', (name) => {
        state.folders.push({ id: 'f' + Date.now(), name });
        saveState();
        render();
    });
};

elements.resetAppBtn.onclick = () => { 
    openConfirmModal('Reset Everything', 'This will clear all songs, tags, and folders. Are you sure?', () => {
        state.folders = [
            { id: 'f1', name: 'Music' },
            { id: 'f2', name: 'Podcast' },
            { id: 'f3', name: 'Audiobook' },
            { id: 'f4', name: 'Instrumental' }
        ];
        state.songs = []; state.tags = {}; state.currentIndex = 0; state.history = []; state.lastFolderId = null; Object.values(state.objectUrls).forEach(URL.revokeObjectURL); state.objectUrls = {}; localStorage.clear(); render(); 
    });
};

elements.clearQueueBtn.onclick = () => { 
    openConfirmModal('Clear Queue', 'This will remove all songs from the queue. Tags will be preserved if you re-upload. Are you sure?', () => {
        state.songs = []; state.tags = {}; state.currentIndex = 0; state.history = []; state.lastFolderId = null; Object.values(state.objectUrls).forEach(URL.revokeObjectURL); state.objectUrls = {}; saveState(); render(); 
    });
};

elements.presetsBtn.onclick = () => elements.presetsModal.classList.remove('hidden');
elements.closePresetsBtn.onclick = () => elements.presetsModal.classList.add('hidden');

elements.helpBtn.onclick = () => elements.helpModal.classList.remove('hidden');
elements.closeHelpBtn.onclick = () => elements.helpModal.classList.add('hidden');

// PWA Install Logic
let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    elements.installBtn.classList.remove('hidden');
});

elements.installBtn.onclick = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
        elements.installBtn.classList.add('hidden');
    }
    deferredPrompt = null;
};

// Share Logic
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
document.querySelectorAll('.preset-pack-btn').forEach(btn => {
    btn.onclick = () => {
        const pack = btn.dataset.pack;
        if (PRESET_PACKS[pack]) {
            state.folders = PRESET_PACKS[pack].map((name, i) => ({ id: `p${pack}${i}`, name }));
            saveState();
            render();
            elements.presetsModal.classList.add('hidden');
        }
    };
});

async function exportZip() { 
    if (state.songs.length === 0) return; 
    
    if (typeof JSZip === 'undefined') {
        alert("JSZip library not loaded correctly. Please refresh the page.");
        return;
    }
    
    // Disable export buttons
    elements.exportBtn.disabled = true;
    elements.exportBtnLarge.disabled = true;
    
    // Show progress modal
    elements.progressModal.classList.remove('hidden');
    elements.progressBar.style.width = '0%';
    elements.progressText.innerText = '0%';
    elements.progressStatus.innerText = 'Initializing...';
    
    try {
        const zip = new JSZip(); 
        const folders = {}; 
        state.folders.forEach(f => folders[f.id] = zip.folder(f.name)); 
        const unclassified = zip.folder("Unclassified"); 
        
        state.songs.forEach((s, i) => { 
            const target = folders[state.tags[i]] || unclassified; 
            target.file(s.name, s.file); 
        }); 
        
        const blob = await zip.generateAsync({ type: "blob" }, (metadata) => {
            const percent = Math.round(metadata.percent);
            elements.progressBar.style.width = `${percent}%`;
            elements.progressText.innerText = `${percent}%`;
            
            if (percent < 100) {
                elements.progressStatus.innerText = `Compressing: ${metadata.currentFile || 'files'}...`;
            } else {
                elements.progressStatus.innerText = 'Finalizing...';
            }
        }); 
        
        const url = URL.createObjectURL(blob); 
        const a = document.createElement('a'); 
        a.href = url; 
        a.download = `Organized_Music_${new Date().toISOString().split('T')[0]}.zip`; 
        a.click(); 
        URL.revokeObjectURL(url); 
    } catch (error) {
        console.error("Export failed:", error);
        alert("Failed to generate ZIP. Please try again.");
    } finally {
        // Hide progress modal and re-enable buttons
        setTimeout(() => {
            elements.progressModal.classList.add('hidden');
            elements.exportBtn.disabled = false;
            elements.exportBtnLarge.disabled = false;
        }, 500);
    }
}

elements.exportBtn.onclick = exportZip; 
elements.exportBtnLarge.onclick = exportZip;

window.onkeydown = (e) => { 
    if (e.key === ' ') { 
        e.preventDefault(); 
        elements.playBtn.click(); 
    } else if (e.key === 'ArrowRight') {
        elements.nextBtn.click(); 
    } else if (e.key === 'ArrowLeft') {
        elements.prevBtn.click(); 
    } else if (e.key === 'z' && (e.ctrlKey || e.metaKey)) { 
        e.preventDefault(); 
        undo(); 
    } else if (!isNaN(e.key) && e.key !== '0') { 
        const f = state.folders[parseInt(e.key) - 1]; 
        if (f) tagSong(f.id); 
    } 
};

render();
safeCreateIcons();
