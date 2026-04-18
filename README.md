# Music Organizer Tool (Offline Pro) 🎵

A high-performance, privacy-first Progressive Web Application (PWA) designed for professional music library organization. Built by **sahildh3**.

## 🚀 Overview

The **Music Organizer Tool** allows you to quickly classify and organize your music files into custom folders directly in your browser. It operates entirely offline, ensuring your data never leaves your device. Once organized, you can export your library as a structured directory or ZIP file.

## ✨ Features

- **Privacy First:** 100% client-side processing. No files are uploaded to any server.
- **Metadata Extraction:** Automatically extracts **Artist** and **Album** information from MP3 (ID3v1/v2) and M4A/MP4 files.
- **Smart Organization:** Tag songs into custom folders with a single click or keyboard shortcut.
- **Real-time Stats:** View file sizes and song counts per folder as you organize.
- **PWA Ready:** Installable on desktop and mobile devices for a native-like experience.
- **Offline Support:** Works without an internet connection using Service Workers.
- **Advanced Export:** Multiple export methods optimized for different library sizes and devices.
- **Keyboard Shortcuts:** Optimized for speed with dedicated hotkeys for professional workflows.

## 🏗️ Architecture & Stability (Release Polish)

- **Memory Safety Guards:** Enforces an upfront 800MB library size limit for batched exports to prevent RAM exhaustion and browser crashes, pushing users toward streaming exports for massive libraries.
- **Worker Transfer Optimization:** The Streaming ZIP exporter is optimized to minimize payload sizes during main-thread-to-worker transfer, heavily reducing memory overhead from structured cloning.
- **Robust Theming & Styling:** Built on a stable design foundation leveraging CSS variables. UI states (`dark`/`light`) and folder colors are dynamically linked to application data, ensuring UI consistency without fragile CSS overrides (`!important`).
- **Resilient Build Pipeline:** Safely structures static assets during build for lightweight deployment architectures.

## 🎨 UI & Theme System

The application features a refined, intentional design system:
- **Minimal Monochrome Base:** Flat surfaces, subtle borders, and smooth transitions.
- **Functional Folder Colors:** A stable generated palette is assigned to folders for quick visual identification.
- **Dark/Light Mode:** Full support for both themes, controlled via a toggle in the header. Preferences are saved locally to avoid flashes of unstyled UI.

## 📦 Export Methods

| Method | Best For | Compatibility |
|--------|----------|---------------|
| **Streaming ZIP** | Large Libraries (100+ songs) | All Browsers (Desktop & Mobile) |
| **Direct Sync** | Professional Workflow | Desktop Chrome / Edge / Brave |
| **Batched ZIPs** | Low Memory Environments (<800MB) | All Browsers |

> **Note:** Browser security prevents "Direct Sync" from working inside iframes. Open the app in a new tab to enable advanced file system features.

## ⌨️ Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Space` | Play / Pause |
| `1-9` | Assign to Folder 1-9 |
| `Ctrl + Z` | Undo Last Tag |
| `→` | Next Song |
| `←` | Previous Song |

## 🛡️ Security & Privacy

- **100% Local:** All processing happens in your browser's memory. No tracking, no uploads.
- **XSS Protection:** All user-provided metadata and folder names are sanitized before rendering.
- **Path Traversal Prevention:** Filenames are strictly sanitized to ensure safe directory structures during export.
- **Memory Safety:** Automatic cleanup of audio object URLs and optimized background payload handling prevent browser crashes.

## 🛠️ Built With

- **Vanilla JavaScript (ES6+):** No external frameworks for maximum performance.
- **Web Streams API:** High-performance, memory-efficient ZIP generation.
- **File System Access API:** Direct local directory synchronization.
- **Tailwind CSS:** Modern, responsive utility-first styling (locally bundled).

## ⚠️ Limitations

- **Maximum ZIP size:** ~4GB (standard ZIP format limit).
- **Batch export limit:** Hard limit of 800MB total library size to prevent device RAM exhaustion.
- **ZIP64:** Intentionally not implemented due to limited browser support for handling >4GB binary structures and lacking reliable cross-browser compliance. Use Direct Sync or Streaming Export split across batches for extremely large libraries.

## 📜 Credits & Licenses

- **Tailwind CSS:** MIT License (https://tailwindcss.com)
- **Lucide Icons:** ISC License (https://lucide.dev)
- **Browser APIs:** Web Streams API, File System Access API, Service Workers (No license required)

## ⚖️ License

This project is licensed under the **MIT License**. See the [LICENSE](./LICENSE) file for details.

---
Developed with ❤️ by **sahildh3**
