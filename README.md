# PC Doctor 🩺
> **Hardware Diagnostics & Peripheral Laboratory**  
> Modern, ultra-clean web application for hardware testing, real-time sensor inspection, and peripheral latency benchmarking.

[![React](https://img.shields.io/badge/React-18.3-blue.svg)](https://reactjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-blue.svg)](https://www.typescriptlang.org/)
[![TailwindCSS](https://img.shields.io/badge/TailwindCSS-3.4-38B2AC.svg)](https://tailwindcss.com/)
[![Vite](https://img.shields.io/badge/Vite-5.4-646CFF.svg)](https://vitejs.dev/)
[![Design](https://img.shields.io/badge/Aesthetic-Monochrome_Liquid_Glass-111111.svg)](#design-aesthetic)

---

## 🌟 Key Highlights

- **Obsidian Void & Liquid Glass Aesthetic**: Crafted with a deep obsidian black backdrop (`#030303`), subtle backdrop blurs, clean borders (`white/10`), and pure monochrome typography (`#F4F4F4`).
- **Capsule Navigation Dock**: Minimalist floating dock with smooth scale micro-animations and quick hover tooltips.
- **Bilingual by Design**: Seamless one-click toggle between **English (default)** and **Vietnamese**, with persistent preference saved to `localStorage`.
- **Zero Cloud Footprint**: Runs 100% client-side inside the browser using standard Web APIs, Web Audio, MediaDevices, Screen Details, Gamepad API, and IndexedDB.

---

## 🔬 Diagnostic Modules & Labs

### 1. 📊 System Dashboard
- Real-time environment telemetry: User Agent, OS architecture, logical CPU cores, device memory estimation, network connection type, downlink speed, RTT latency, touch capability, battery telemetry (charging status, level, discharge time).
- Connected hardware overview: Quick status counters for Audio Inputs/Outputs, Video Capture devices, and Gamepads.
- Persistent local event logs powered by IndexedDB.

### 2. 🔊 Audio & Microphone Lab
- **Stereo & Surround Tone Generator**: Left / Right channel panning isolation, sub-bass sweep (20Hz - 120Hz), high-frequency hearing check (10kHz - 18kHz), pink noise, and 440Hz reference tone.
- **Microphone Real-Time Oscilloscope & FFT**: High-resolution canvas rendering of live audio waveforms, dynamic peak volume meter (dBFS), clipping warning, and quick loopback monitor test.

### 3. ⌨️ Keyboard Diagnostic Lab
- **Full Physical Key Matrix**: Interactive 80% / 100% key map tracking keydown, keyup, N-key rollover, stuck keys, and scan codes (`e.code`).
- **Typing Benchmark**: Real-time WPM, CPM, typing accuracy, error count, and character consistency benchmark.

### 4. 🖱️ Mouse & Precision Lab
- **Live Button & Wheel Tracker**: Left, middle, right, back, and forward button states with real-time wheel delta logging.
- **High-Precision Polling Rate Meter**: Microsecond-accurate timestamp measurement (`performance.now()`) with rolling average, peak Hz, and jitter metrics.
- **Aim Reflex Benchmark**: Interactive target acquisition speed test across 3 difficulty tiers (Casual, Standard, Precision) with miss tracking and reaction latency (ms).

### 5. 🖥️ Display & Monitor Lab
- **Color Calibration & Dead Pixel Inspection**: 8 full-screen testing modes (Pure Red, Pure Green, Pure Blue, Pure White, Pure Black, 50% Uniformity Gray, Dynamic Banding Gradient, and Full-Spectrum Rainbow) with click-to-mark dead pixel capability.
- **Display Metrics**: Resolution, color depth (bpp), pixel ratio (DPR), orientation, and multi-monitor detection via Screen Details API.

### 6. 📷 Camera & Video Capture Lab
- Real-time camera feed preview with aspect ratio, resolution, and frame rate detection.
- Brightness, contrast, exposure, and saturation live software adjustments.
- Instant snapshot capture and resolution verification.

### 7. 🎮 Gamepad & Controller Lab
- Full controller mapping visualization (Xbox / PlayStation / Generic layout).
- Dual analog stick axis deadzone & circular deflection indicators.
- Analog trigger pressure tracking (L2 / R2) and haptic dual-rumble vibration motor testing.

---

## 🚀 Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) (version 18 or higher recommended)
- [npm](https://www.npmjs.com/) or [pnpm](https://pnpm.io/)

### Installation

```bash
# Clone the repository
git clone https://github.com/your-username/pc-doctor.git

# Navigate to project directory
cd pc-doctor

# Install dependencies
npm install
```

### Running Locally

```bash
# Start Vite development server
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in Chrome, Edge, or any modern Chromium-based browser for the best hardware API compatibility (WebHID, Gamepad Vibration, Screen Details).

### Building for Production

```bash
# Type check & build optimized bundle
npm run build

# Preview production build locally
npm run preview
```

---

## 🛠️ Tech Stack

- **Framework**: [React 18](https://reactjs.org/)
- **Language**: [TypeScript](https://www.typescriptlang.org/)
- **Styling**: [TailwindCSS 3](https://tailwindcss.com/) & Vanilla CSS Glassmorphism
- **Icons**: [Lucide React](https://lucide.dev/)
- **Bundler & Tooling**: [Vite 5](https://vitejs.dev/)
- **Local Persistence**: IndexedDB API

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
