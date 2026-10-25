import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  Activity,
  Volume2,
  Mic,
  Keyboard,
  MousePointer,
  Monitor,
  Camera,
  Gamepad2,
  Play,
  Pause,
  Square,
  RotateCcw,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  HelpCircle,
  Info,
  Maximize2,
  Minimize2,
  Zap,
  Eye,
  Radio,
  Usb,
  Sparkles,
  Check,
  Code,
  VolumeX,
  Crosshair,
  Gauge,
  Target,
  Wifi
} from 'lucide-react';
import { translations, type Lang } from './i18n';
import { NetworkLabModule } from './modules/network/NetworkLabModule';

// ============================================================================
// 1. TYPES & ARCHITECTURAL INTERFACES
// ============================================================================

export type DataAccuracyBadge = 'REALTIME' | 'ESTIMATED' | 'LIMITED' | 'UNSUPPORTED';
export type TestStatus = 'PASS' | 'WARNING' | 'FAIL' | 'SKIPPED' | 'UNSUPPORTED' | 'UNTESTED';

export type ModuleId =
  | 'dashboard'
  | 'network'
  | 'audio'
  | 'keyboard'
  | 'mouse'
  | 'display'
  | 'camera'
  | 'gamepad';

export interface DiagnosticRecord {
  id: string;
  timestamp: string;
  moduleId: ModuleId;
  moduleName: string;
  testName: string;
  device: string;
  method: DataAccuracyBadge;
  status: TestStatus;
  metrics: Record<string, string | number>;
  notes: string;
  error?: string;
}

export interface SystemEnvironmentInfo {
  os: string;
  browser: string;
  userAgent: string;
  cores: number | null;
  deviceMemoryGB: number | null;
  jsHeapUsedMB: number | null;
  jsHeapTotalMB: number | null;
  jsHeapLimitMB: number | null;
  screenWidth: number;
  screenHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  pixelRatio: number;
  colorDepth: number;
  online: boolean;
  secureContext: boolean;
  gpuVendor: string;
  gpuRenderer: string;
  webglVersion: string;
  maxTextureSize: number | null;
  batteryLevel: number | null;
  batteryCharging: boolean | null;
}

export interface ConnectedDevicesSummary {
  audioInputs: MediaDeviceInfo[];
  audioOutputs: MediaDeviceInfo[];
  videoInputs: MediaDeviceInfo[];
  gamepads: { index: number; id: string; buttons: number; axes: number; mapping: string }[];
  permissionsGranted: { audio: boolean; video: boolean };
}

// ============================================================================
// 2. INDEXEDDB STORAGE ENGINE (100% LOCAL, NO CLOUD, NO LOCALSTORAGE)
// ============================================================================

const DB_NAME = 'PCDoctorDiagnosticDB';
const DB_VERSION = 1;
const STORE_HISTORY = 'diagnostic_history';

class LocalDiagnosticDB {
  private dbPromise: Promise<IDBDatabase | null> | null = null;
  private memoryFallback: DiagnosticRecord[] = [];

  constructor() {
    this.init();
  }

  private init(): Promise<IDBDatabase | null> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve) => {
      if (typeof window === 'undefined' || !('indexedDB' in window)) {
        resolve(null);
        return;
      }
      try {
        const request = window.indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE_HISTORY)) {
            db.createObjectStore(STORE_HISTORY, { keyPath: 'id' });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return this.dbPromise;
  }

  async getAllRecords(): Promise<DiagnosticRecord[]> {
    const db = await this.init();
    if (!db) return [...this.memoryFallback].sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_HISTORY, 'readonly');
        const store = tx.objectStore(STORE_HISTORY);
        const req = store.getAll();
        req.onsuccess = () => {
          const list = (req.result as DiagnosticRecord[]) || [];
          resolve(list.sort((a, b) => b.timestamp.localeCompare(a.timestamp)));
        };
        req.onerror = () => resolve([...this.memoryFallback]);
      } catch {
        resolve([...this.memoryFallback]);
      }
    });
  }

  async addRecord(record: DiagnosticRecord): Promise<void> {
    this.memoryFallback = [record, ...this.memoryFallback.filter((r) => r.id !== record.id)];
    const db = await this.init();
    if (!db) return;

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_HISTORY, 'readwrite');
        const store = tx.objectStore(STORE_HISTORY);
        store.put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  async deleteRecord(id: string): Promise<void> {
    this.memoryFallback = this.memoryFallback.filter((r) => r.id !== id);
    const db = await this.init();
    if (!db) return;

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_HISTORY, 'readwrite');
        const store = tx.objectStore(STORE_HISTORY);
        store.delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  async clearAll(): Promise<void> {
    this.memoryFallback = [];
    const db = await this.init();
    if (!db) return;

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_HISTORY, 'readwrite');
        const store = tx.objectStore(STORE_HISTORY);
        store.clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }
}

const diagnosticDB = new LocalDiagnosticDB();

// ============================================================================
// 3. HARDWARE & ENVIRONMENT DETECTION UTILITIES (REAL WEB APIS ONLY)
// ============================================================================

function detectOSAndBrowser(): { os: string; browser: string } {
  const ua = navigator.userAgent;
  let os = 'Unknown OS';
  if (ua.includes('Windows NT 10.0')) os = 'Windows 10 / 11 (NT 10.0)';
  else if (ua.includes('Windows')) os = 'Windows';
  else if (ua.includes('Mac OS X')) os = 'macOS';
  else if (ua.includes('CrOS')) os = 'ChromeOS';
  else if (ua.includes('Linux')) os = 'Linux';
  else if (ua.includes('Android')) os = 'Android';
  else if (ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS';

  let browser = 'Web Browser';
  if (ua.includes('Edg/')) {
    const match = ua.match(/Edg\/([\d.]+)/);
    browser = `Microsoft Edge ${match ? match[1] : ''}`;
  } else if (ua.includes('Chrome/') && !ua.includes('Edg/')) {
    const match = ua.match(/Chrome\/([\d.]+)/);
    browser = `Google Chrome ${match ? match[1] : ''}`;
  } else if (ua.includes('Firefox/')) {
    const match = ua.match(/Firefox\/([\d.]+)/);
    browser = `Mozilla Firefox ${match ? match[1] : ''}`;
  } else if (ua.includes('Safari/') && !ua.includes('Chrome/')) {
    browser = 'Apple Safari';
  }

  return { os, browser };
}

function getWebGLInfo(): {
  vendor: string;
  renderer: string;
  version: string;
  maxTextureSize: number | null;
} {
  try {
    const canvas = document.createElement('canvas');
    const gl =
      (canvas.getContext('webgl2') as WebGL2RenderingContext | null) ||
      (canvas.getContext('webgl') as WebGLRenderingContext | null);
    if (!gl) {
      return {
        vendor: 'UNSUPPORTED',
        renderer: 'WebGL Disabled or Unavailable',
        version: 'None',
        maxTextureSize: null
      };
    }
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    const vendor = debugInfo
      ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)
      : gl.getParameter(gl.VENDOR);
    const renderer = debugInfo
      ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);
    const version = gl.getParameter(gl.VERSION);
    const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    return {
      vendor: String(vendor || 'Generic Vendor'),
      renderer: String(renderer || 'Generic WebGL Renderer'),
      version: String(version || 'WebGL'),
      maxTextureSize: typeof maxTextureSize === 'number' ? maxTextureSize : null
    };
  } catch {
    return {
      vendor: 'LIMITED',
      renderer: 'Restricted by Browser Privacy Settings',
      version: 'Unknown',
      maxTextureSize: null
    };
  }
}

function readSystemEnvironment(
  batteryData?: { level: number | null; charging: boolean | null }
): SystemEnvironmentInfo {
  const { os, browser } = detectOSAndBrowser();
  const glInfo = getWebGLInfo();
  const navAny = navigator as unknown as {
    deviceMemory?: number;
  };
  const perfAny = performance as unknown as {
    memory?: {
      usedJSHeapSize: number;
      totalJSHeapSize: number;
      jsHeapSizeLimit: number;
    };
  };

  return {
    os,
    browser,
    userAgent: navigator.userAgent,
    cores: typeof navigator.hardwareConcurrency === 'number' ? navigator.hardwareConcurrency : null,
    deviceMemoryGB: typeof navAny.deviceMemory === 'number' ? navAny.deviceMemory : null,
    jsHeapUsedMB: perfAny.memory
      ? Math.round((perfAny.memory.usedJSHeapSize / (1024 * 1024)) * 10) / 10
      : null,
    jsHeapTotalMB: perfAny.memory
      ? Math.round((perfAny.memory.totalJSHeapSize / (1024 * 1024)) * 10) / 10
      : null,
    jsHeapLimitMB: perfAny.memory
      ? Math.round(perfAny.memory.jsHeapSizeLimit / (1024 * 1024))
      : null,
    screenWidth: window.screen.width,
    screenHeight: window.screen.height,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    pixelRatio: Math.round(window.devicePixelRatio * 100) / 100,
    colorDepth: window.screen.colorDepth,
    online: navigator.onLine,
    secureContext: Boolean(window.isSecureContext),
    gpuVendor: glInfo.vendor,
    gpuRenderer: glInfo.renderer,
    webglVersion: glInfo.version,
    maxTextureSize: glInfo.maxTextureSize,
    batteryLevel: batteryData?.level ?? null,
    batteryCharging: batteryData?.charging ?? null
  };
}

// ============================================================================
// 4. SHARED UI COMPONENTS (GLASSMORPHISM DESIGN SYSTEM)
// ============================================================================

const StatusBadge: React.FC<{ status: TestStatus; size?: 'sm' | 'md' }> = ({
  status,
  size = 'sm'
}) => {
  const config: Record<
    TestStatus,
    { bg: string; icon: React.ReactNode; label: string }
  > = {
    PASS: {
      bg: 'bg-white/[0.09] text-[#F4F4F4] border-white/20 shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]',
      icon: <CheckCircle2 className="w-3.5 h-3.5 text-[#F4F4F4]" />,
      label: 'PASS'
    },
    WARNING: {
      bg: 'bg-white/[0.05] text-zinc-300 border-white/12 shadow-[inset_0_1px_0_rgba(255,255,255,0.1)]',
      icon: <AlertTriangle className="w-3.5 h-3.5 text-zinc-300" />,
      label: 'WARNING'
    },
    FAIL: {
      bg: 'bg-white/[0.03] text-zinc-400 border-white/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]',
      icon: <XCircle className="w-3.5 h-3.5 text-zinc-400" />,
      label: 'FAIL'
    },
    SKIPPED: {
      bg: 'bg-white/[0.02] text-zinc-500 border-white/[0.07]',
      icon: <HelpCircle className="w-3.5 h-3.5 text-zinc-500" />,
      label: 'SKIPPED'
    },
    UNSUPPORTED: {
      bg: 'bg-transparent text-zinc-500 border-white/[0.06]',
      icon: <Info className="w-3.5 h-3.5 text-zinc-500" />,
      label: 'UNSUPPORTED'
    },
    UNTESTED: {
      bg: 'bg-white/[0.02] text-zinc-500 border-white/[0.06]',
      icon: <HelpCircle className="w-3.5 h-3.5 text-zinc-500" />,
      label: 'UNTESTED'
    }
  };

  const item = config[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 font-medium tracking-wider uppercase rounded-full border ${item.bg
        } ${size === 'sm' ? 'px-2.5 py-0.5 text-[11px]' : 'px-3 py-1 text-xs'}`}
    >
      {item.icon}
      {item.label}
    </span>
  );
};

const GlassCard: React.FC<{
  title?: string;
  icon?: React.ReactNode;
  badge?: DataAccuracyBadge;
  status?: TestStatus;
  rightSlot?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}> = ({ title, icon, badge, status, rightSlot, className = '', children }) => (
  <div
    className={`rounded-2xl liquid-glass-card p-6 transition-all duration-300 relative overflow-hidden group shadow-[0_24px_60px_rgba(0,0,0,0.7),inset_0_1.5px_1px_rgba(255,255,255,0.22)] ${className}`}
  >
    {/* Subtle specular reflection overlay */}
    <div className="absolute inset-0 bg-gradient-to-br from-white/[0.035] via-transparent to-transparent pointer-events-none opacity-60 group-hover:opacity-100 transition-opacity duration-300" />

    <div className="relative z-10">
      {(title || status || rightSlot) && (
        <div className="flex flex-wrap items-center justify-between gap-3 mb-5 pb-4 border-b border-white/[0.07]">
          <div className="flex items-center gap-3">
            {icon && (
              <div className="p-2.5 rounded-xl bg-white/[0.05] border border-white/12 text-[#F4F4F4] shadow-[inset_0_1px_0_rgba(255,255,255,0.18)] backdrop-blur-xl">
                {icon}
              </div>
            )}
            {title && <h3 className="text-sm md:text-base font-semibold text-[#F4F4F4] tracking-tight">{title}</h3>}
          </div>
          <div className="flex items-center gap-2.5 flex-wrap">
            {status && <StatusBadge status={status} />}
            {rightSlot}
          </div>
        </div>
      )}
      {children}
    </div>
  </div>
);

// ============================================================================
// 5. MODULE: DASHBOARD — TỔNG QUAN PC
// ============================================================================

const DashboardModule: React.FC<{
  sysInfo: SystemEnvironmentInfo;
  devices: ConnectedDevicesSummary;
  onRefreshDevices: () => Promise<void>;
  lang?: Lang;
}> = ({ sysInfo, devices, onRefreshDevices, lang = 'en' }) => {
  const t = translations[lang].dashboard;
  const tc = translations[lang].common;

  return (
    <div className="space-y-6">
      {/* Top Hero Action Bar with Liquid Glass Opacity */}
      <div className="rounded-2xl liquid-glass-card p-6 relative overflow-hidden shadow-[0_24px_60px_rgba(0,0,0,0.7),inset_0_1.5px_1px_rgba(255,255,255,0.24)]">
        <div className="relative z-10 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/[0.06] border border-white/15 text-zinc-300 text-xs font-medium mb-2.5 backdrop-blur-xl shadow-[inset_0_1px_1px_rgba(255,255,255,0.18)]">
              <span className="w-2 h-2 rounded-full bg-white animate-pulse shadow-[0_0_8px_rgba(255,255,255,0.8)]" />
              {t.heroTag}
            </div>
            <h2 className="text-xl sm:text-2xl font-bold text-[#F4F4F4] tracking-tight">
              {t.heroTitle}
            </h2>
          </div>
          <div className="flex items-center gap-2.5">
            <button
              onClick={onRefreshDevices}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white/10 hover:bg-white/20 text-[#F4F4F4] border border-white/20 text-sm font-medium transition cursor-pointer shadow-[0_4px_20px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.2)] backdrop-blur-xl hover:scale-[1.02] active:scale-[0.98]"
            >
              <RefreshCw className="w-4 h-4 text-[#F4F4F4]" />
              {t.refreshBtn}
            </button>
          </div>
        </div>
      </div>

      {/* Layered Translucent Glass Telemetry Tiles */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        <div className="p-4 rounded-2xl liquid-glass-sub border border-white/[0.08] hover:border-white/20 hover:bg-white/[0.045] transition-all duration-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]">
          <div className="text-[11px] text-zinc-400 font-medium mb-1">{t.tileDisplay}</div>
          <div className="text-base sm:text-lg font-bold font-mono text-[#F4F4F4] tracking-tight">
            {sysInfo.screenWidth}×{sysInfo.screenHeight}
          </div>
          <div className="text-[10px] text-zinc-500 mt-0.5">{sysInfo.pixelRatio}x {t.dprScale}</div>
        </div>

        <div className="p-4 rounded-2xl liquid-glass-sub border border-white/[0.08] hover:border-white/20 hover:bg-white/[0.045] transition-all duration-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]">
          <div className="text-[11px] text-zinc-400 font-medium mb-1">{t.tileAudio}</div>
          <div className="text-base sm:text-lg font-bold font-mono text-[#F4F4F4] tracking-tight">
            {devices.audioInputs.length} {t.micCount} • {devices.audioOutputs.length} {t.speakerCount}
          </div>
          <div className="text-[10px] text-zinc-500 mt-0.5">{t.mediaDevicesApi}</div>
        </div>

        <div className="p-4 rounded-2xl liquid-glass-sub border border-white/[0.08] hover:border-white/20 hover:bg-white/[0.045] transition-all duration-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]">
          <div className="text-[11px] text-zinc-400 font-medium mb-1">{t.tileCamera}</div>
          <div className="text-base sm:text-lg font-bold font-mono text-[#F4F4F4] tracking-tight">
            {devices.videoInputs.length} {t.webcamCount}
          </div>
          <div className="text-[10px] text-zinc-500 mt-0.5">{t.videoCaptureApi}</div>
        </div>

        <div className="p-4 rounded-2xl liquid-glass-sub border border-white/[0.08] hover:border-white/20 hover:bg-white/[0.045] transition-all duration-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]">
          <div className="text-[11px] text-zinc-400 font-medium mb-1">{t.tileGamepad}</div>
          <div className="text-base sm:text-lg font-bold font-mono text-[#F4F4F4] tracking-tight">
            {devices.gamepads.length} {t.gamepadCount}
          </div>
          <div className="text-[10px] text-zinc-500 mt-0.5">{t.gamepadApiReady}</div>
        </div>
      </div>

      {/* Primary Hardware & Environment Telemetry Grid with Frosted Inset Panels */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <GlassCard
          title={t.cardOsTitle}
          icon={<Monitor className="w-5 h-5" />}
          badge="REALTIME"
        >
          <div className="space-y-2.5 text-xs">
            <div className="p-3 rounded-xl bg-white/[0.02] hover:bg-white/[0.04] border border-white/[0.06] flex items-center justify-between transition-colors shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
              <span className="text-zinc-400">{t.osLabel}</span>
              <span className="text-[#F4F4F4] font-medium text-right">{sysInfo.os}</span>
            </div>
            <div className="p-3 rounded-xl bg-white/[0.02] hover:bg-white/[0.04] border border-white/[0.06] flex items-center justify-between transition-colors shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
              <span className="text-zinc-400">{t.browserLabel}</span>
              <span className="text-[#F4F4F4] font-medium text-right">{sysInfo.browser}</span>
            </div>
            <div className="p-3 rounded-xl bg-white/[0.02] hover:bg-white/[0.04] border border-white/[0.06] flex items-center justify-between transition-colors shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
              <span className="text-zinc-400">{t.screenResLabel}</span>
              <span className="text-[#F4F4F4] font-mono">
                {sysInfo.screenWidth}×{sysInfo.screenHeight} ({sysInfo.pixelRatio}x DPR)
              </span>
            </div>
            <div className="p-3 rounded-xl bg-white/[0.02] hover:bg-white/[0.04] border border-white/[0.06] flex items-center justify-between transition-colors shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
              <span className="text-zinc-400">{t.securityNetLabel}</span>
              <span className="text-[#F4F4F4] font-medium">
                {sysInfo.secureContext ? tc.secure : tc.nonSecure} •{' '}
                {sysInfo.online ? tc.online : tc.offline}
              </span>
            </div>
          </div>
        </GlassCard>

        <GlassCard
          title={t.cardDevicesTitle}
          icon={<Gamepad2 className="w-5 h-5" />}
          badge="REALTIME"
        >
          <div className="space-y-2.5 text-xs">
            <div className="p-3 rounded-xl bg-white/[0.02] hover:bg-white/[0.04] border border-white/[0.06] flex items-center justify-between transition-colors shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
              <span className="text-zinc-400">{t.audioInLabel}</span>
              <span className="text-[#F4F4F4] font-mono font-semibold">
                {devices.audioInputs.length} {tc.devices}
              </span>
            </div>
            <div className="p-3 rounded-xl bg-white/[0.02] hover:bg-white/[0.04] border border-white/[0.06] flex items-center justify-between transition-colors shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
              <span className="text-zinc-400">{t.audioOutLabel}</span>
              <span className="text-[#F4F4F4] font-mono font-semibold">
                {devices.audioOutputs.length} {tc.devices}
              </span>
            </div>
            <div className="p-3 rounded-xl bg-white/[0.02] hover:bg-white/[0.04] border border-white/[0.06] flex items-center justify-between transition-colors shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
              <span className="text-zinc-400">{t.cameraLabel}</span>
              <span className="text-[#F4F4F4] font-mono font-semibold">
                {devices.videoInputs.length} {tc.devices}
              </span>
            </div>
            <div className="p-3 rounded-xl bg-white/[0.02] hover:bg-white/[0.04] border border-white/[0.06] flex items-center justify-between transition-colors shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
              <span className="text-zinc-400">{t.gamepadLabel}</span>
              <span className="text-[#F4F4F4] font-mono font-semibold">
                {devices.gamepads.length} {tc.controllers}
              </span>
            </div>
          </div>
        </GlassCard>
      </div>
    </div>
  );
};

// 9. MODULE: AUDIO LAB — HEADPHONES, SPEAKERS & MICROPHONE (CORE MODULE)
// ============================================================================

const AudioLabModule: React.FC<{
  devices: ConnectedDevicesSummary;
  onRefreshDevices: () => Promise<void>;
  onAddRecord: (rec: Omit<DiagnosticRecord, 'id' | 'timestamp'>) => Promise<void>;
  lang?: Lang;
}> = ({ devices, onRefreshDevices, onAddRecord, lang = 'en' }) => {
  const t = translations[lang].audio;
  // Output Synthesizer State
  const [activeSoundMode, setActiveSoundMode] = useState<string | null>(null);
  const [frequency, setFrequency] = useState<number>(440);
  const [waveType, setWaveType] = useState<OscillatorType>('sine');
  const [volume, setVolume] = useState<number>(0.15); // Safe low initial volume (15%)
  const [selectedSinkId, setSelectedSinkId] = useState<string>('default');
  const [sinkIdStatus, setSinkIdStatus] = useState<string>(
    lang === 'en' ? 'Using system default audio output device.' : 'Sử dụng thiết bị đầu ra mặc định của hệ thống.'
  );

  // Blind Stereo Identification Mini-Test
  const [blindTarget, setBlindTarget] = useState<'left' | 'right' | null>(null);
  const [blindFeedback, setBlindFeedback] = useState<string | null>(null);

  // Microphone & Analyzer State
  const [selectedMicId, setSelectedMicId] = useState<string>('default');
  const [micActive, setMicActive] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [rmsDb, setRmsDb] = useState<number>(-100);
  const [peakDb, setPeakDb] = useState<number>(-100);
  const [clippingCount, setClippingCount] = useState<number>(0);

  // Recording State
  const [isRecording, setIsRecording] = useState(false);
  const [recordedAudioUrl, setRecordedAudioUrl] = useState<string | null>(null);

  // Refs for Web Audio API cleanup
  const audioCtxRef = useRef<AudioContext | null>(null);
  const oscNodeRef = useRef<OscillatorNode | null>(null);
  const noiseNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);

  const micStreamRef = useRef<MediaStream | null>(null);
  const micAudioCtxRef = useRef<AudioContext | null>(null);
  const micAnimRef = useRef<number | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const waveCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const fftCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Stop all output sound immediately
  const stopOutputAudio = useCallback(() => {
    try {
      if (oscNodeRef.current) {
        oscNodeRef.current.stop();
        oscNodeRef.current.disconnect();
        oscNodeRef.current = null;
      }
    } catch {
      // ignore if already stopped
    }
    try {
      if (noiseNodeRef.current) {
        noiseNodeRef.current.stop();
        noiseNodeRef.current.disconnect();
        noiseNodeRef.current = null;
      }
    } catch {
      // ignore
    }
    setActiveSoundMode(null);
  }, []);

  const ensureAudioContext = async (): Promise<AudioContext> => {
    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      audioCtxRef.current = new Ctx();
    }
    if (audioCtxRef.current.state === 'suspended') {
      await audioCtxRef.current.resume();
    }
    return audioCtxRef.current;
  };

  // Attempt setSinkId on AudioContext if supported
  const handleSelectOutputDevice = async (sinkId: string) => {
    setSelectedSinkId(sinkId);
    const ctx = await ensureAudioContext();
    const ctxWithSink = ctx as unknown as { setSinkId?: (id: string) => Promise<void> };
    if (typeof ctxWithSink.setSinkId === 'function') {
      try {
        await ctxWithSink.setSinkId(sinkId === 'default' ? '' : sinkId);
        setSinkIdStatus(lang === 'en' ? 'Successfully redirected audio output via AudioContext.setSinkId().' : 'Đã chuyển hướng đầu ra âm thanh qua AudioContext.setSinkId() thành công.');
      } catch (err) {
        setSinkIdStatus(lang === 'en' ? `Unable to switch audio output (${String(err)}). Using default.` : `Không thể chuyển thiết bị đầu ra (${String(err)}). Đang dùng mặc định.`);
      }
    } else {
      setSinkIdStatus(
        lang === 'en' ? 'AudioContext.setSinkId() is unsupported on this browser. Sound will play via system default device.' : 'Trình duyệt hiện tại không hỗ trợ AudioContext.setSinkId(). Âm thanh sẽ phát qua thiết bị mặc định của Windows.'
      );
    }
  };

  // Play Tone / Stereo Channel
  const playTone = async (mode: 'left' | 'right' | 'stereo' | 'sweep', customFreq?: number) => {
    stopOutputAudio();
    const ctx = await ensureAudioContext();

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const panner = ctx.createStereoPanner();

    osc.type = waveType;
    const startFreq = customFreq ?? frequency;
    osc.frequency.setValueAtTime(startFreq, ctx.currentTime);

    if (mode === 'left') panner.pan.setValueAtTime(-1, ctx.currentTime);
    else if (mode === 'right') panner.pan.setValueAtTime(1, ctx.currentTime);
    else panner.pan.setValueAtTime(0, ctx.currentTime);

    gain.gain.setValueAtTime(Math.min(0.6, Math.max(0.01, volume)), ctx.currentTime);

    if (mode === 'sweep') {
      osc.frequency.setValueAtTime(40, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(14000, ctx.currentTime + 6);
    }

    osc.connect(gain);
    gain.connect(panner);
    panner.connect(ctx.destination);

    osc.start();
    oscNodeRef.current = osc;
    gainNodeRef.current = gain;
    setActiveSoundMode(mode);

    if (mode === 'sweep') {
      osc.stop(ctx.currentTime + 6);
      osc.onended = () => setActiveSoundMode(null);
    }
  };

  // Play White or Pink Noise
  const playNoise = async (type: 'white' | 'pink') => {
    stopOutputAudio();
    const ctx = await ensureAudioContext();
    const bufferSize = ctx.sampleRate * 3;
    const buffer = ctx.createBuffer(2, bufferSize, ctx.sampleRate);

    for (let ch = 0; ch < 2; ch++) {
      const output = buffer.getChannelData(ch);
      if (type === 'white') {
        for (let i = 0; i < bufferSize; i++) {
          output[i] = Math.random() * 2 - 1;
        }
      } else {
        // Paul Kellet's Pink Noise filter approximation
        let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
        for (let i = 0; i < bufferSize; i++) {
          const white = Math.random() * 2 - 1;
          b0 = 0.99886 * b0 + white * 0.0555179;
          b1 = 0.99332 * b1 + white * 0.0750759;
          b2 = 0.96900 * b2 + white * 0.1538520;
          b3 = 0.86650 * b3 + white * 0.3104856;
          b4 = 0.55000 * b4 + white * 0.5329522;
          b5 = -0.7616 * b5 - white * 0.0168980;
          output[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
          b6 = white * 0.115926;
        }
      }
    }

    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    noise.loop = true;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(Math.min(0.5, Math.max(0.01, volume)), ctx.currentTime);

    noise.connect(gain);
    gain.connect(ctx.destination);
    noise.start();

    noiseNodeRef.current = noise;
    gainNodeRef.current = gain;
    setActiveSoundMode(type);
  };

  // Live updates to frequency and volume while oscillator is playing
  useEffect(() => {
    if (oscNodeRef.current && audioCtxRef.current && activeSoundMode !== 'sweep') {
      oscNodeRef.current.frequency.setValueAtTime(frequency, audioCtxRef.current.currentTime);
      oscNodeRef.current.type = waveType;
    }
  }, [frequency, waveType, activeSoundMode]);

  useEffect(() => {
    if (gainNodeRef.current && audioCtxRef.current) {
      gainNodeRef.current.gain.setValueAtTime(volume, audioCtxRef.current.currentTime);
    }
  }, [volume]);

  // Blind Stereo Channel Identification Test
  const startBlindStereoTest = async () => {
    const side: 'left' | 'right' = Math.random() < 0.5 ? 'left' : 'right';
    setBlindTarget(side);
    setBlindFeedback(lang === 'en' ? 'Playing 520 Hz tone in one ear. Identify which side you hear it on!' : 'Đang phát âm thanh 520 Hz ở một bên tai nghe. Hãy chọn bên bạn nghe thấy!');
    await playTone(side, 520);
  };

  const answerBlindStereo = async (guess: 'left' | 'right') => {
    stopOutputAudio();
    if (!blindTarget) return;
    const isCorrect = guess === blindTarget;
    setBlindFeedback(
      isCorrect
        ? lang === 'en' ? `Correct! Audio signal played on the ${blindTarget.toUpperCase()} channel.` : `Chính xác! Tín hiệu phát ở kênh ${blindTarget.toUpperCase()} khớp với tai nghe của bạn.`
        : lang === 'en' ? `Channel mismatch detected! Tone played on ${blindTarget.toUpperCase()} channel, but you selected ${guess.toUpperCase()}.` : `Phát hiện ngược kênh! Tín hiệu phát ở kênh ${blindTarget.toUpperCase()} nhưng bạn nghe ở bên ${guess.toUpperCase()}.`
    );
    await onAddRecord({
      moduleId: 'audio',
      moduleName: 'Audio Lab',
      testName: 'Stereo Channel Identification Test',
      device: selectedSinkId === 'default' ? 'Default Audio Output' : selectedSinkId,
      method: 'REALTIME',
      status: isCorrect ? 'PASS' : 'WARNING',
      metrics: {
        generatedChannel: blindTarget.toUpperCase(),
        userIdentified: guess.toUpperCase()
      },
      notes:
        lang === 'en'
          ? (guess === blindTarget ? 'Headphone/speaker L/R stereo channels correct.' : 'User identified inverted L/R channels.')
          : (guess === blindTarget ? 'Kênh Trái/Phải của tai nghe/loa đúng chuẩn.' : 'Người dùng nhận diện ngược kênh Trái/Phải.')
    });
    setBlindTarget(null);
  };

  // Stop Microphone & Release MediaStream Tracks
  const stopMicrophone = useCallback(() => {
    if (micAnimRef.current) {
      cancelAnimationFrame(micAnimRef.current);
      micAnimRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.stop();
      } catch {
        // ignore
      }
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }
    if (micAudioCtxRef.current && micAudioCtxRef.current.state !== 'closed') {
      micAudioCtxRef.current.close().catch(() => { });
      micAudioCtxRef.current = null;
    }
    setMicActive(false);
    setIsRecording(false);
  }, []);

  // Start Microphone Realtime Analyzer
  const startMicrophone = async () => {
    stopMicrophone();
    setMicError(null);
    setClippingCount(0);

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setMicError(lang === 'en' ? 'Browser does not support navigator.mediaDevices.getUserMedia.' : 'Trình duyệt không hỗ trợ navigator.mediaDevices.getUserMedia.');
      return;
    }

    try {
      const constraints: MediaStreamConstraints = {
        audio:
          selectedMicId && selectedMicId !== 'default'
            ? { deviceId: { exact: selectedMicId }, echoCancellation: false, noiseSuppression: false }
            : { echoCancellation: false, noiseSuppression: false }
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      micStreamRef.current = stream;
      await onRefreshDevices();

      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      micAudioCtxRef.current = ctx;

      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.8;
      source.connect(analyser);

      const timeData = new Float32Array(analyser.fftSize);
      const freqData = new Uint8Array(analyser.frequencyBinCount);

      setMicActive(true);

      const drawLoop = () => {
        analyser.getFloatTimeDomainData(timeData);
        analyser.getByteFrequencyData(freqData);

        let sumSq = 0;
        let maxAbs = 0;
        let clips = 0;
        for (let i = 0; i < timeData.length; i++) {
          const s = timeData[i];
          const abs = Math.abs(s);
          sumSq += s * s;
          if (abs > maxAbs) maxAbs = abs;
          if (abs >= 0.98) clips++;
        }

        const rms = Math.sqrt(sumSq / timeData.length);
        const currentRmsDb = Math.max(-100, Math.round(20 * Math.log10(Math.max(0.00001, rms))));
        const currentPeakDb = Math.max(-100, Math.round(20 * Math.log10(Math.max(0.00001, maxAbs))));

        setRmsDb(currentRmsDb);
        setPeakDb(currentPeakDb);
        if (clips > 0) {
          setClippingCount((prev) => prev + clips);
        }

        // Draw Waveform
        const wCanvas = waveCanvasRef.current;
        if (wCanvas) {
          const wCtx = wCanvas.getContext('2d');
          if (wCtx) {
            const w = (wCanvas.width = wCanvas.clientWidth || 300);
            const h = (wCanvas.height = 110);
            wCtx.fillStyle = '#030303';
            wCtx.fillRect(0, 0, w, h);
            wCtx.strokeStyle = '#F4F4F4';
            wCtx.lineWidth = 1.5;
            wCtx.beginPath();
            const slice = w / timeData.length;
            let x = 0;
            for (let i = 0; i < timeData.length; i++) {
              const y = (0.5 + timeData[i] * 0.45) * h;
              if (i === 0) wCtx.moveTo(x, y);
              else wCtx.lineTo(x, y);
              x += slice;
            }
            wCtx.stroke();
          }
        }

        // Draw FFT Spectrum
        const fCanvas = fftCanvasRef.current;
        if (fCanvas) {
          const fCtx = fCanvas.getContext('2d');
          if (fCtx) {
            const w = (fCanvas.width = fCanvas.clientWidth || 300);
            const h = (fCanvas.height = 110);
            fCtx.fillStyle = '#030303';
            fCtx.fillRect(0, 0, w, h);
            const bars = 64;
            const barWidth = w / bars;
            for (let i = 0; i < bars; i++) {
              const val = freqData[i * 2] || 0;
              const barHeight = (val / 255) * h;
              fCtx.fillStyle = val > 210 ? 'rgba(244, 244, 244, 0.95)' : 'rgba(244, 244, 244, 0.35)';
              fCtx.fillRect(i * barWidth, h - barHeight, Math.max(1, barWidth - 2), barHeight);
            }
          }
        }

        micAnimRef.current = requestAnimationFrame(drawLoop);
      };

      micAnimRef.current = requestAnimationFrame(drawLoop);
    } catch (err) {
      setMicError(
        `Không thể truy cập Microphone: ${String(
          err
        )}. Vui lòng kiểm tra quyền Microphone trên thanh địa chỉ trình duyệt.`
      );
      await onAddRecord({
        moduleId: 'audio',
        moduleName: 'Audio Lab',
        testName: 'Microphone Access & Signal Test',
        device: 'Microphone Input',
        method: 'REALTIME',
        status: 'FAIL',
        metrics: {},
        notes: lang === 'en' ? 'User denied Microphone permission or no device found.' : 'Người dùng từ chối quyền Microphone hoặc không tìm thấy thiết bị.',
        error: String(err)
      });
    }
  };

  // Record a short audio sample for user playback
  const startShortRecording = () => {
    if (!micStreamRef.current || isRecording) return;
    recordedChunksRef.current = [];
    try {
      const recorder = new MediaRecorder(micStreamRef.current);
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) recordedChunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(recordedChunksRef.current, { type: 'audio/webm' });
        if (recordedAudioUrl) URL.revokeObjectURL(recordedAudioUrl);
        setRecordedAudioUrl(URL.createObjectURL(blob));
        setIsRecording(false);
      };
      recorder.start();
      setIsRecording(true);
    } catch (err) {
      setMicError(lang === 'en' ? `MediaRecorder unavailable: ${String(err)}` : `MediaRecorder không khả dụng: ${String(err)}`);
    }
  };

  const stopShortRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
  };

  useEffect(() => {
    return () => {
      stopOutputAudio();
      stopMicrophone();
    };
  }, [stopOutputAudio, stopMicrophone]);

  return (
    <div className="space-y-6">
      {/* Top Emergency Stop & Disclaimer Banner */}
      <div className="rounded-2xl liquid-glass-sub border border-white/10 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="text-xs text-zinc-300 space-y-1">
          <div className="font-semibold text-white flex items-center gap-2">
            <Volume2 className="w-4 h-4 text-white" />
            {t.bannerNotice}
          </div>
          <p className="text-zinc-400">
            {t.bannerDesc}
          </p>
        </div>
        <button
          onClick={() => {
            stopOutputAudio();
            stopMicrophone();
          }}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white/[0.08] hover:bg-white/[0.14] border border-white/20 text-[#F4F4F4] font-medium text-xs shrink-0 shadow-lg shadow-black/50 transition cursor-pointer"
        >
          <VolumeX className="w-4 h-4" />
          {t.emergencyStop}
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Speaker & Headphone Output Generator */}
        <GlassCard
          title={t.cardSynthTitle}
          icon={<Volume2 className="w-5 h-5" />}
          badge="REALTIME"
        >
          <div className="space-y-4 text-xs">
            {/* Output Device Selection */}
            <div>
              <label className="block text-zinc-400 mb-1">
                {t.outputSinkLabel}
              </label>
              <select
                value={selectedSinkId}
                onChange={(e) => handleSelectOutputDevice(e.target.value)}
                className="w-full rounded-xl bg-[#030303] border border-white/10 px-3 py-2 text-[#F4F4F4]"
              >
                <option value="default">{t.defaultOutput}</option>
                {devices.audioOutputs.map((d, idx) => (
                  <option key={d.deviceId || idx} value={d.deviceId}>
                    {d.label || `Loa / Tai nghe #${idx + 1}`}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-zinc-400 mt-1">{sinkIdStatus}</p>
            </div>

            {/* Volume & Frequency Controls */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 p-3.5 rounded-xl liquid-glass-sub">
              <div>
                <div className="flex justify-between mb-1">
                  <span className="text-zinc-400">{t.volumeLabel}</span>
                  <span className="font-mono text-white font-bold">{Math.round(volume * 100)}%</span>
                </div>
                <input
                  type="range"
                  min={0.01}
                  max={0.6}
                  step={0.01}
                  value={volume}
                  onChange={(e) => setVolume(Number(e.target.value))}
                  className="w-full accent-white"
                />
              </div>

              <div>
                <div className="flex justify-between mb-1">
                  <span className="text-zinc-400">{t.frequencyLabel}</span>
                  <span className="font-mono text-white font-bold">{frequency} Hz</span>
                </div>
                <input
                  type="range"
                  min={20}
                  max={16000}
                  step={10}
                  value={frequency}
                  onChange={(e) => setFrequency(Number(e.target.value))}
                  className="w-full accent-white"
                />
              </div>
            </div>

            {/* Frequency Quick Presets */}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-zinc-400 mr-1">{t.presetLabel}</span>
              {[60, 120, 440, 1000, 4000, 8000, 12000].map((f) => (
                <button
                  key={f}
                  onClick={() => setFrequency(f)}
                  className={`px-2.5 py-1 rounded-lg border text-[11px] font-mono transition cursor-pointer ${frequency === f
                    ? 'bg-white text-zinc-950 border-white font-semibold shadow-[0_0_15px_rgba(255,255,255,0.4)]'
                    : 'bg-white/[0.05] border-white/10 text-zinc-300 hover:bg-white/[0.1] hover:text-white'
                    }`}
                >
                  {f} Hz
                </button>
              ))}
            </div>

            {/* Stereo & Tone Generator Buttons */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
              <button
                onClick={() => playTone('left')}
                className={`p-2.5 rounded-xl border font-medium transition cursor-pointer ${activeSoundMode === 'left'
                  ? 'bg-white text-zinc-950 border-white font-bold shadow-[0_0_20px_rgba(255,255,255,0.4)]'
                  : 'bg-white/[0.05] hover:bg-white/[0.1] text-zinc-200 border-white/10'
                  }`}
              >
                {t.btnLeft}
              </button>
              <button
                onClick={() => playTone('stereo')}
                className={`p-2.5 rounded-xl border font-medium transition cursor-pointer ${activeSoundMode === 'stereo'
                  ? 'bg-white text-zinc-950 border-white font-bold shadow-[0_0_20px_rgba(255,255,255,0.4)]'
                  : 'bg-white/[0.05] hover:bg-white/[0.1] text-zinc-200 border-white/10'
                  }`}
              >
                {t.btnStereo}
              </button>
              <button
                onClick={() => playTone('right')}
                className={`p-2.5 rounded-xl border font-medium transition cursor-pointer ${activeSoundMode === 'right'
                  ? 'bg-white text-zinc-950 border-white font-bold shadow-[0_0_20px_rgba(255,255,255,0.4)]'
                  : 'bg-white/[0.05] hover:bg-white/[0.1] text-zinc-200 border-white/10'
                  }`}
              >
                {t.btnRight}
              </button>
              <button
                onClick={() => playTone('sweep')}
                className={`p-2.5 rounded-xl border font-medium transition cursor-pointer ${activeSoundMode === 'sweep'
                  ? 'bg-white text-zinc-950 border-white font-bold shadow-[0_0_20px_rgba(255,255,255,0.4)]'
                  : 'bg-white/[0.05] hover:bg-white/[0.1] text-zinc-200 border-white/10'
                  }`}
              >
                {t.btnSweep}
              </button>
              <button
                onClick={() => playNoise('white')}
                className={`p-2.5 rounded-xl border font-medium transition cursor-pointer ${activeSoundMode === 'white'
                  ? 'bg-white text-zinc-950 border-white font-bold shadow-[0_0_20px_rgba(255,255,255,0.4)]'
                  : 'bg-white/[0.05] hover:bg-white/[0.1] text-zinc-200 border-white/10'
                  }`}
              >
                {t.whiteNoise}
              </button>
              <button
                onClick={() => playNoise('pink')}
                className={`p-2.5 rounded-xl border font-medium transition cursor-pointer ${activeSoundMode === 'pink'
                  ? 'bg-white text-zinc-950 border-white font-bold shadow-[0_0_20px_rgba(255,255,255,0.4)]'
                  : 'bg-white/[0.05] hover:bg-white/[0.1] text-zinc-200 border-white/10'
                  }`}
              >
                {t.pinkNoise}
              </button>
            </div>

            {activeSoundMode && (
              <button
                onClick={stopOutputAudio}
                className="w-full py-2.5 rounded-xl bg-white/[0.08] hover:bg-white/[0.14] border border-white/20 text-[#F4F4F4] font-medium transition cursor-pointer"
              >
                {t.btnStop}
              </button>
            )}

            {/* Blind Stereo Channel Identification Test */}
            <div className="p-3.5 rounded-xl liquid-glass-sub space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-zinc-200">
                  {t.blindTestTitle}
                </span>
                <button
                  onClick={startBlindStereoTest}
                  className="px-3 py-1 rounded-lg bg-white/10 hover:bg-white/20 text-[#F4F4F4] border border-white/20 font-medium cursor-pointer transition"
                >
                  {t.btnPlayRandom}
                </button>
              </div>
              {blindTarget && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => answerBlindStereo('left')}
                    className="flex-1 py-2 rounded-lg bg-white/[0.06] hover:bg-white/15 border border-white/10 text-[#F4F4F4] font-medium cursor-pointer transition"
                  >
                    {t.btnGuessLeft}
                  </button>
                  <button
                    onClick={() => answerBlindStereo('right')}
                    className="flex-1 py-2 rounded-lg bg-white/[0.06] hover:bg-white/15 border border-white/10 text-[#F4F4F4] font-medium cursor-pointer transition"
                  >
                    {t.btnGuessRight}
                  </button>
                </div>
              )}
              {blindFeedback && <p className="text-[11px] text-[#F4F4F4] font-medium">{blindFeedback}</p>}
            </div>
          </div>
        </GlassCard>

        {/* Microphone Input Analyzer & Recorder */}
        <GlassCard
          title={t.cardMicTitle}
          icon={<Mic className="w-5 h-5" />}
          badge="REALTIME"
        >
          <div className="space-y-4 text-xs">
            <div>
              <label className="block text-zinc-400 mb-1">{t.micSelectLabel}</label>
              <select
                value={selectedMicId}
                onChange={(e) => setSelectedMicId(e.target.value)}
                disabled={micActive}
                className="w-full rounded-xl bg-[#191919] border border-white/10 px-3 py-2 text-[#F4F4F4] outline-none"
              >
                <option value="default">{t.defaultMic}</option>
                {devices.audioInputs.map((d, idx) => (
                  <option key={d.deviceId || idx} value={d.deviceId}>
                    {d.label || `Microphone #${idx + 1}`}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              {!micActive ? (
                <button
                  onClick={startMicrophone}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-2xl bg-[#F4F4F4] hover:bg-white text-[#030303] font-bold text-xs shadow-[0_4px_20px_rgba(255,255,255,0.18)] transition cursor-pointer"
                >
                  <Mic className="w-4 h-4" />
                  {t.btnStartMic}
                </button>
              ) : (
                <>
                  <button
                    onClick={stopMicrophone}
                    className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white/[0.08] hover:bg-white/[0.14] border border-white/20 text-[#F4F4F4] font-medium transition cursor-pointer"
                  >
                    <Square className="w-4 h-4" />
                    {t.btnStopMic}
                  </button>

                  {!isRecording ? (
                    <button
                      onClick={startShortRecording}
                      className="inline-flex items-center gap-2 px-3.5 py-2.5 rounded-xl bg-white/10 hover:bg-white/20 border border-white/20 text-[#F4F4F4] font-medium transition cursor-pointer"
                    >
                      <Radio className="w-4 h-4 text-[#F4F4F4]" />
                      {lang === 'en' ? 'Record Test' : 'Ghi âm Thử'}
                    </button>
                  ) : (
                    <button
                      onClick={stopShortRecording}
                      className="inline-flex items-center gap-2 px-3.5 py-2.5 rounded-xl bg-[#F4F4F4] text-[#030303] font-bold animate-pulse transition cursor-pointer"
                    >
                      <Square className="w-4 h-4" />
                      {lang === 'en' ? 'Finish Recording' : 'Hoàn tất Ghi âm'}
                    </button>
                  )}
                </>
              )}
            </div>

            {micError && (
              <div className="p-3 rounded-xl bg-white/[0.04] border border-white/10 text-zinc-300">
                {micError}
              </div>
            )}

            {/* RMS, Peak & Clipping Telemetry */}
            <div className="grid grid-cols-3 gap-2.5">
              <div className="p-3 rounded-xl liquid-glass-sub">
                <div className="text-zinc-400 text-[11px]">{lang === 'en' ? 'RMS Level' : 'Mức RMS'}</div>
                <div className="text-base font-bold font-mono text-[#F4F4F4]">
                  {micActive ? `${rmsDb} dBFS` : '-- dBFS'}
                </div>
              </div>
              <div className="p-3 rounded-xl liquid-glass-sub">
                <div className="text-zinc-400 text-[11px]">{lang === 'en' ? 'Peak Level' : 'Mức Đỉnh (Peak)'}</div>
                <div className="text-base font-bold font-mono text-[#F4F4F4]">
                  {micActive ? `${peakDb} dBFS` : '-- dBFS'}
                </div>
              </div>
              <div className="p-3 rounded-xl liquid-glass-sub">
                <div className="text-zinc-400 text-[11px]">{lang === 'en' ? 'Clipping Samples' : 'Mẫu Vỡ tiếng (Clipping)'}</div>
                <div
                  className={`text-base font-bold font-mono ${clippingCount > 0 ? 'text-zinc-400' : 'text-[#F4F4F4]'
                    }`}
                >
                  {clippingCount} {lang === 'en' ? 'samples' : 'mẫu'}
                </div>
              </div>
            </div>

            {/* Dual Canvas Visualizers: Waveform + FFT */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="rounded-xl overflow-hidden border border-white/10 bg-[#030303] p-2">
                <div className="text-[10px] text-zinc-400 mb-1">{t.waveformLabel}</div>
                <canvas ref={waveCanvasRef} className="w-full h-24 block rounded-lg" />
              </div>
              <div className="rounded-xl overflow-hidden border border-white/10 bg-[#030303] p-2">
                <div className="text-[10px] text-zinc-400 mb-1">{t.fftLabel}</div>
                <canvas ref={fftCanvasRef} className="w-full h-24 block rounded-lg" />
              </div>
            </div>

            {/* Recorded Clip Playback */}
            {recordedAudioUrl && (
              <div className="p-3 rounded-xl liquid-glass-sub space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-white">{lang === 'en' ? 'Local Test Audio Playback:' : 'Bản ghi âm kiểm thử cục bộ:'}</span>
                </div>
                <audio controls src={recordedAudioUrl} className="w-full h-9" />
              </div>
            )}
          </div>
        </GlassCard>
      </div>
    </div>
  );
};

// ============================================================================
// 10. MODULE: KEYBOARD LAB
// ============================================================================

interface KeyDefinition {
  code: string;
  label: string;
  sub?: string;
  width?: string;
  isSpacer?: boolean;
}

const KEYBOARD_MAIN_ROWS: KeyDefinition[][] = [
  // Row 0: Function Row
  [
    { code: 'Escape', label: 'Esc', width: 'w-11 sm:w-12' },
    { code: 'gap-f0', label: '', width: 'w-4 sm:w-5', isSpacer: true },
    { code: 'F1', label: 'F1', width: 'w-11 sm:w-12' },
    { code: 'F2', label: 'F2', width: 'w-11 sm:w-12' },
    { code: 'F3', label: 'F3', width: 'w-11 sm:w-12' },
    { code: 'F4', label: 'F4', width: 'w-11 sm:w-12' },
    { code: 'gap-f1', label: '', width: 'w-3 sm:w-4', isSpacer: true },
    { code: 'F5', label: 'F5', width: 'w-11 sm:w-12' },
    { code: 'F6', label: 'F6', width: 'w-11 sm:w-12' },
    { code: 'F7', label: 'F7', width: 'w-11 sm:w-12' },
    { code: 'F8', label: 'F8', width: 'w-11 sm:w-12' },
    { code: 'gap-f2', label: '', width: 'w-3 sm:w-4', isSpacer: true },
    { code: 'F9', label: 'F9', width: 'w-11 sm:w-12' },
    { code: 'F10', label: 'F10', width: 'w-11 sm:w-12' },
    { code: 'F11', label: 'F11', width: 'w-11 sm:w-12' },
    { code: 'F12', label: 'F12', width: 'w-11 sm:w-12' }
  ],
  // Row 1: Numbers
  [
    { code: 'Backquote', label: '`', sub: '~', width: 'w-11 sm:w-12' },
    { code: 'Digit1', label: '1', sub: '!', width: 'w-11 sm:w-12' },
    { code: 'Digit2', label: '2', sub: '@', width: 'w-11 sm:w-12' },
    { code: 'Digit3', label: '3', sub: '#', width: 'w-11 sm:w-12' },
    { code: 'Digit4', label: '4', sub: '$', width: 'w-11 sm:w-12' },
    { code: 'Digit5', label: '5', sub: '%', width: 'w-11 sm:w-12' },
    { code: 'Digit6', label: '6', sub: '^', width: 'w-11 sm:w-12' },
    { code: 'Digit7', label: '7', sub: '&', width: 'w-11 sm:w-12' },
    { code: 'Digit8', label: '8', sub: '*', width: 'w-11 sm:w-12' },
    { code: 'Digit9', label: '9', sub: '(', width: 'w-11 sm:w-12' },
    { code: 'Digit0', label: '0', sub: ')', width: 'w-11 sm:w-12' },
    { code: 'Minus', label: '-', sub: '_', width: 'w-11 sm:w-12' },
    { code: 'Equal', label: '=', sub: '+', width: 'w-11 sm:w-12' },
    { code: 'Backspace', label: 'Backspace', width: 'w-[88px] sm:w-[96px]' }
  ],
  // Row 2: QWERTY
  [
    { code: 'Tab', label: 'Tab', width: 'w-[66px] sm:w-[72px]' },
    { code: 'KeyQ', label: 'Q', width: 'w-11 sm:w-12' },
    { code: 'KeyW', label: 'W', width: 'w-11 sm:w-12' },
    { code: 'KeyE', label: 'E', width: 'w-11 sm:w-12' },
    { code: 'KeyR', label: 'R', width: 'w-11 sm:w-12' },
    { code: 'KeyT', label: 'T', width: 'w-11 sm:w-12' },
    { code: 'KeyY', label: 'Y', width: 'w-11 sm:w-12' },
    { code: 'KeyU', label: 'U', width: 'w-11 sm:w-12' },
    { code: 'KeyI', label: 'I', width: 'w-11 sm:w-12' },
    { code: 'KeyO', label: 'O', width: 'w-11 sm:w-12' },
    { code: 'KeyP', label: 'P', width: 'w-11 sm:w-12' },
    { code: 'BracketLeft', label: '[', sub: '{', width: 'w-11 sm:w-12' },
    { code: 'BracketRight', label: ']', sub: '}', width: 'w-11 sm:w-12' },
    { code: 'Backslash', label: '\\', sub: '|', width: 'w-[66px] sm:w-[72px]' }
  ],
  // Row 3: CapsLock & Home Row
  [
    { code: 'CapsLock', label: 'Caps Lock', width: 'w-[77px] sm:w-[84px]' },
    { code: 'KeyA', label: 'A', width: 'w-11 sm:w-12' },
    { code: 'KeyS', label: 'S', width: 'w-11 sm:w-12' },
    { code: 'KeyD', label: 'D', width: 'w-11 sm:w-12' },
    { code: 'KeyF', label: 'F', width: 'w-11 sm:w-12' },
    { code: 'KeyG', label: 'G', width: 'w-11 sm:w-12' },
    { code: 'KeyH', label: 'H', width: 'w-11 sm:w-12' },
    { code: 'KeyJ', label: 'J', width: 'w-11 sm:w-12' },
    { code: 'KeyK', label: 'K', width: 'w-11 sm:w-12' },
    { code: 'KeyL', label: 'L', width: 'w-11 sm:w-12' },
    { code: 'Semicolon', label: ';', sub: ':', width: 'w-11 sm:w-12' },
    { code: 'Quote', label: "'", sub: '"', width: 'w-11 sm:w-12' },
    { code: 'Enter', label: 'Enter', width: 'w-[99px] sm:w-[108px]' }
  ],
  // Row 4: Shift Row
  [
    { code: 'ShiftLeft', label: 'Shift', width: 'w-[99px] sm:w-[108px]' },
    { code: 'KeyZ', label: 'Z', width: 'w-11 sm:w-12' },
    { code: 'KeyX', label: 'X', width: 'w-11 sm:w-12' },
    { code: 'KeyC', label: 'C', width: 'w-11 sm:w-12' },
    { code: 'KeyV', label: 'V', width: 'w-11 sm:w-12' },
    { code: 'KeyB', label: 'B', width: 'w-11 sm:w-12' },
    { code: 'KeyN', label: 'N', width: 'w-11 sm:w-12' },
    { code: 'KeyM', label: 'M', width: 'w-11 sm:w-12' },
    { code: 'Comma', label: ',', sub: '<', width: 'w-11 sm:w-12' },
    { code: 'Period', label: '.', sub: '>', width: 'w-11 sm:w-12' },
    { code: 'Slash', label: '/', sub: '?', width: 'w-11 sm:w-12' },
    { code: 'ShiftRight', label: 'Shift', width: 'w-[121px] sm:w-[132px]' }
  ],
  // Row 5: Modifiers
  [
    { code: 'ControlLeft', label: 'Ctrl', width: 'w-[55px] sm:w-[60px]' },
    { code: 'MetaLeft', label: 'Win', width: 'w-[55px] sm:w-[60px]' },
    { code: 'AltLeft', label: 'Alt', width: 'w-[55px] sm:w-[60px]' },
    { code: 'Space', label: 'Spacebar', width: 'flex-1 min-w-[260px]' },
    { code: 'AltRight', label: 'Alt', width: 'w-[55px] sm:w-[60px]' },
    { code: 'ContextMenu', label: 'Menu', width: 'w-[55px] sm:w-[60px]' },
    { code: 'ControlRight', label: 'Ctrl', width: 'w-[55px] sm:w-[60px]' }
  ]
];

const KEYBOARD_NAV_ROWS: KeyDefinition[][] = [
  // Row 0: System Controls
  [
    { code: 'PrintScreen', label: 'PrtSc', width: 'w-11 sm:w-12' },
    { code: 'ScrollLock', label: 'ScrLk', width: 'w-11 sm:w-12' },
    { code: 'Pause', label: 'Pause', width: 'w-11 sm:w-12' }
  ],
  // Row 1: Top Nav (Ins, Home, PgUp)
  [
    { code: 'Insert', label: 'Ins', width: 'w-11 sm:w-12' },
    { code: 'Home', label: 'Home', width: 'w-11 sm:w-12' },
    { code: 'PageUp', label: 'PgUp', width: 'w-11 sm:w-12' }
  ],
  // Row 2: Mid Nav (Del, End, PgDn)
  [
    { code: 'Delete', label: 'Del', width: 'w-11 sm:w-12' },
    { code: 'End', label: 'End', width: 'w-11 sm:w-12' },
    { code: 'PageDown', label: 'PgDn', width: 'w-11 sm:w-12' }
  ],
  // Row 3: Gap Spacer Row
  [
    { code: 'nav-sp-3a', label: '', width: 'w-11 sm:w-12', isSpacer: true },
    { code: 'nav-sp-3b', label: '', width: 'w-11 sm:w-12', isSpacer: true },
    { code: 'nav-sp-3c', label: '', width: 'w-11 sm:w-12', isSpacer: true }
  ],
  // Row 4: Arrow Up (Column 2, perfectly centered above Down)
  [
    { code: 'nav-sp-4a', label: '', width: 'w-11 sm:w-12', isSpacer: true },
    { code: 'ArrowUp', label: '↑', width: 'w-11 sm:w-12' },
    { code: 'nav-sp-4c', label: '', width: 'w-11 sm:w-12', isSpacer: true }
  ],
  // Row 5: Arrow Inverted-T Base (Left, Down, Right)
  [
    { code: 'ArrowLeft', label: '←', width: 'w-11 sm:w-12' },
    { code: 'ArrowDown', label: '↓', width: 'w-11 sm:w-12' },
    { code: 'ArrowRight', label: '→', width: 'w-11 sm:w-12' }
  ]
];

const TYPING_TEST_SENTENCES_EN = [
  'The quick brown fox jumps over the lazy dog near the riverbank on a sunny afternoon.',
  'Sphinx of black quartz, judge my vow, as the mechanical keyboard rings with precision.',
  'Pack my box with five dozen liquor jugs while testing keystroke latency and rollover matrix.',
  'How vexingly quick daft zebras jump through the digital hardware diagnostics laboratory.',
  'High quality mechanical switches ensure crisp tactile feedback and flawless NKRO response.'
];

const TYPING_TEST_SENTENCES_VI = [
  'Hệ thống kiểm tra bàn phím cơ và tốc độ gõ phím chuyên nghiệp với độ chính xác cao.',
  'Công nghệ chẩn đoán phần cứng trực tiếp qua trình duyệt với tiêu chuẩn độ trễ thấp.',
  'Đo lường tốc độ gõ phím WPM và độ nảy phím cơ với khả năng nhận diện đa phím NKRO.',
  'Bàn phím cơ mang lại cảm giác gõ đầm chắc và độ phản hồi xúc giác tuyệt vời.',
  'Trải nghiệm gõ phím mượt mà và chính xác trên từng điểm tiếp xúc switch.'
];

const TypingSpeedTester: React.FC<{
  onAddRecord: (rec: Omit<DiagnosticRecord, 'id' | 'timestamp'>) => Promise<void>;
  lang?: Lang;
}> = ({ onAddRecord, lang = 'en' }) => {
  const t = translations[lang].keyboard;
  const sentences = lang === 'en' ? TYPING_TEST_SENTENCES_EN : TYPING_TEST_SENTENCES_VI;
  const [hasStarted, setHasStarted] = useState(false);
  const [sentenceIndex, setSentenceIndex] = useState(0);
  const [typedText, setTypedText] = useState('');
  const [isStarted, setIsStarted] = useState(false);
  const [isFinished, setIsFinished] = useState(false);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [elapsedSec, setElapsedSec] = useState<number>(0);
  const [saved, setSaved] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const timerRef = useRef<number | null>(null);

  const targetSentence = sentences[sentenceIndex % sentences.length];

  // Start test and reveal random sentence
  const handleStart = useCallback(() => {
    let nextIdx = Math.floor(Math.random() * sentences.length);
    if (sentences.length > 1 && nextIdx === sentenceIndex) {
      nextIdx = (nextIdx + 1) % sentences.length;
    }
    setSentenceIndex(nextIdx);
    setHasStarted(true);
    setTypedText('');
    setIsStarted(false);
    setIsFinished(false);
    setStartTime(null);
    setElapsedSec(0);
    setSaved(false);
    if (timerRef.current) clearInterval(timerRef.current);
    setTimeout(() => {
      inputRef.current?.focus();
    }, 100);
  }, [sentenceIndex]);

  // Reset test state back to hidden start screen
  const handleReset = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    setHasStarted(false);
    setTypedText('');
    setIsStarted(false);
    setIsFinished(false);
    setStartTime(null);
    setElapsedSec(0);
    setSaved(false);
  }, []);

  // Timer loop
  useEffect(() => {
    if (isStarted && !isFinished && startTime) {
      timerRef.current = window.setInterval(() => {
        setElapsedSec(Math.round(((performance.now() - startTime) / 1000) * 10) / 10);
      }, 100);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isStarted, isFinished, startTime]);

  // Handle typing input
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    if (isFinished || !hasStarted) return;

    if (!isStarted && value.length > 0) {
      setIsStarted(true);
      setStartTime(performance.now());
    }

    setTypedText(value);

    // Auto complete when typed length reaches target length
    if (value.length >= targetSentence.length) {
      setIsFinished(true);
      if (timerRef.current) clearInterval(timerRef.current);
      const totalTime = startTime ? Math.max(0.5, (performance.now() - startTime) / 1000) : elapsedSec;
      setElapsedSec(Math.round(totalTime * 10) / 10);
    }
  };

  // Compute live accuracy, WPM, CPM
  let correctCount = 0;
  let errorCount = 0;
  for (let i = 0; i < typedText.length; i++) {
    if (i < targetSentence.length && typedText[i] === targetSentence[i]) {
      correctCount++;
    } else {
      errorCount++;
    }
  }

  const accuracy = typedText.length > 0 ? Math.round((correctCount / typedText.length) * 100) : 100;
  const minutes = Math.max(0.01, elapsedSec / 60);
  const wpm = Math.round((correctCount / 5) / minutes);
  const cpm = Math.round(correctCount / minutes);

  // Save report
  const handleSaveReport = async () => {
    if (saved) return;
    await onAddRecord({
      moduleId: 'keyboard',
      moduleName: 'Keyboard Lab',
      testName: 'Vietnamese Typing Speed & Accuracy Benchmark',
      device: 'Standard HID Keyboard',
      method: 'REALTIME',
      status: accuracy >= 90 && wpm >= 35 ? 'PASS' : 'WARNING',
      metrics: {
        wpm: `${wpm} WPM`,
        cpm: `${cpm} CPM`,
        accuracy: `${accuracy}%`,
        elapsedTime: `${elapsedSec}s`,
        errors: errorCount,
        charsTotal: targetSentence.length
      },
      notes: `Gõ câu mẫu (${sentenceIndex + 1}/5): "${targetSentence.substring(0, 30)}..."`
    });
    setSaved(true);
  };

  return (
    <GlassCard
      title={t.cardTypingTitle}
      icon={<Zap className="w-5 h-5 text-[#F4F4F4]" />}
      rightSlot={
        hasStarted ? (
          <div className="flex items-center gap-2">
            <button
              onClick={handleStart}
              className="px-3 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] text-zinc-200 text-xs font-medium cursor-pointer"
            >
              {t.changeSentence}
            </button>
            <button
              onClick={handleReset}
              className="px-3 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] text-zinc-200 text-xs font-medium cursor-pointer"
            >
              {t.closeTest}
            </button>
          </div>
        ) : null
      }
    >
      {!hasStarted ? (
        <div className="p-10 sm:p-14 rounded-3xl bg-zinc-900/40 backdrop-blur-2xl border border-white/10 flex flex-col items-center justify-center text-center shadow-[0_8px_32px_rgba(0,0,0,0.4),inset_0_1px_1px_rgba(255,255,255,0.1)]">
          <button
            onClick={handleStart}
            className="inline-flex items-center gap-2.5 px-8 py-3 rounded-2xl bg-white hover:bg-zinc-200 text-zinc-950 font-bold text-sm shadow-[0_4px_25px_rgba(255,255,255,0.25)] transition-all duration-200 cursor-pointer transform hover:scale-[1.03] active:scale-[0.98]"
          >
            <Play className="w-4 h-4 fill-zinc-950" />
            <span>{t.btnStart}</span>
          </button>
        </div>
      ) : (
        <div className="space-y-5">
          {/* Realtime Metrics Display */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-xs">
            <div className="p-3.5 rounded-xl liquid-glass-sub">
              <div className="text-zinc-400 text-[11px]">{t.wpmLabel}</div>
              <div className="text-2xl font-bold font-mono text-white mt-1 flex items-baseline gap-1">
                <span>{isStarted ? wpm : 0}</span>
                <span className="text-xs font-normal text-zinc-400">{t.wordsPerMin}</span>
              </div>
            </div>

            <div className="p-3.5 rounded-xl liquid-glass-sub">
              <div className="text-zinc-400 text-[11px]">{t.cpmLabel}</div>
              <div className="text-xl font-bold font-mono text-white mt-1">
                {isStarted ? cpm : 0}
              </div>
              <div className="text-[10px] text-zinc-400 mt-0.5">{t.charsPerMin}</div>
            </div>

            <div className="p-3.5 rounded-xl liquid-glass-sub">
              <div className="text-zinc-400 text-[11px]">{t.accuracyLabel}</div>
              <div className={`text-xl font-bold font-mono mt-1 ${accuracy >= 90 ? 'text-[#F4F4F4]' : 'text-zinc-400'}`}>
                {accuracy}%
              </div>
              <div className="text-[10px] text-zinc-500 mt-0.5">{correctCount}/{typedText.length} {t.charsUnit}</div>
            </div>

            <div className="p-3.5 rounded-xl liquid-glass-sub">
              <div className="text-zinc-400 text-[11px]">{t.elapsedTime}</div>
              <div className="text-xl font-bold font-mono text-zinc-200 mt-1">
                {elapsedSec} <span className="text-xs font-normal text-zinc-400">s</span>
              </div>
              <div className="text-[10px] text-zinc-500 mt-0.5">
                {isFinished ? t.completedNotice : isStarted ? t.timing : t.typeToStart}
              </div>
            </div>

            <div className="p-3.5 rounded-xl liquid-glass-sub">
              <div className="text-zinc-400 text-[11px]">{t.errorCount}</div>
              <div className={`text-xl font-bold font-mono mt-1 ${errorCount > 0 ? 'text-zinc-400' : 'text-[#F4F4F4]'}`}>
                {errorCount}
              </div>
              <div className="text-[10px] text-zinc-500 mt-0.5">{t.mismatchedChars}</div>
            </div>
          </div>

          {/* Target Sentence Display with Live Visual Feedback */}
          <div className="p-5 rounded-2xl bg-[#141414]/90 border border-white/10 relative">
            <div className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider mb-2 flex items-center justify-between">
              <span className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-white/60"></span>
                {t.randomSampleSentence} (#{sentenceIndex + 1}/5)
              </span>
              <span className="font-mono text-zinc-500">
                {typedText.length} / {targetSentence.length} {t.charsUnit}
              </span>
            </div>

            {/* Interactive Colored Character Stream */}
            <div className="text-base sm:text-lg leading-relaxed select-none font-sans p-3.5 rounded-xl bg-[#191919] border border-white/5 mb-4">
              {targetSentence.split('').map((char, idx) => {
                const isTyped = idx < typedText.length;
                const isCurrent = idx === typedText.length;
                const isCorrect = isTyped && typedText[idx] === char;
                const isWrong = isTyped && typedText[idx] !== char;

                let style = 'text-zinc-500';
                if (isCorrect) style = 'text-[#F4F4F4] font-medium';
                else if (isWrong) style = 'text-zinc-400 bg-white/[0.08] rounded px-0.5 line-through';
                else if (isCurrent) style = 'text-[#F4F4F4] border-b border-white bg-white/20 animate-pulse rounded-t';

                return (
                  <span key={idx} className={`${style} transition-colors duration-75`}>
                    {char}
                  </span>
                );
              })}
            </div>

            {/* User Input Area */}
            <div className="space-y-2">
              <input
                ref={inputRef}
                type="text"
                value={typedText}
                onChange={handleInputChange}
                disabled={isFinished}
                placeholder={t.inputPlaceholder}
                className="w-full bg-[#191919] border border-white/15 focus:border-white/40 focus:shadow-[0_0_20px_rgba(255,255,255,0.15)] rounded-xl px-4 py-3 text-[#F4F4F4] font-sans text-base outline-none transition disabled:opacity-75 disabled:bg-[#191919]"
              />
            </div>

            {/* Completion Celebration Banner */}
            {isFinished && (
              <div className="mt-4 p-4 rounded-xl liquid-glass-sub border border-white/20 flex flex-col sm:flex-row items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <CheckCircle2 className="w-6 h-6 text-[#F4F4F4] shrink-0" />
                  <div>
                    <div className="text-sm font-bold text-[#F4F4F4]">
                      {t.testCompleted}
                    </div>
                    <div className="text-xs text-zinc-300">
                      {t.youAchieved} <strong className="text-[#F4F4F4] font-mono">{wpm} WPM</strong> ({cpm} CPM) {t.withAccuracy} <strong className="text-[#F4F4F4] font-mono">{accuracy}%</strong> {t.inTime} <span className="font-mono">{elapsedSec}s</span>.
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleStart}
                    className="px-5 py-2.5 rounded-2xl bg-[#F4F4F4] hover:bg-white text-[#030303] font-bold text-xs shadow-[0_4px_20px_rgba(255,255,255,0.18)] transition cursor-pointer"
                  >
                    {t.tryAnother}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </GlassCard>
  );
};

const KeyboardLabModule: React.FC<{
  onAddRecord: (rec: Omit<DiagnosticRecord, 'id' | 'timestamp'>) => Promise<void>;
  lang?: Lang;
}> = ({ onAddRecord, lang = 'en' }) => {
  const t = translations[lang].keyboard;
  const [captureFocused, setCaptureFocused] = useState(true);
  const [pressedKeys, setPressedKeys] = useState<Set<string>>(new Set());
  const [testedKeys, setTestedKeys] = useState<Record<string, number>>({});
  const [maxRollover, setMaxRollover] = useState<number>(0);
  const [lastEvent, setLastEvent] = useState<{ code: string; key: string } | null>(null);
  const [chatterCount, setChatterCount] = useState<number>(0);
  const lastReleaseRef = useRef<Record<string, number>>({});
  const zoneRef = useRef<HTMLDivElement | null>(null);

  // Scoped Keyboard Event Listener & Blur Protection
  useEffect(() => {
    if (!captureFocused) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Do not capture if typing in a search input elsewhere
      if (
        document.activeElement &&
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)
      ) {
        return;
      }
      e.preventDefault();

      const code = e.code;
      const now = performance.now();

      if (!e.repeat) {
        const prevRelease = lastReleaseRef.current[code] || 0;
        if (now - prevRelease > 0 && now - prevRelease < 22) {
          setChatterCount((c) => c + 1);
        }
        setTestedKeys((prev) => ({ ...prev, [code]: (prev[code] || 0) + 1 }));
      }

      setLastEvent({ code, key: e.key });

      setPressedKeys((prev) => {
        const next = new Set(prev);
        next.add(code);
        if (next.size > maxRollover) setMaxRollover(next.size);
        return next;
      });
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      const code = e.code;
      lastReleaseRef.current[code] = performance.now();
      setPressedKeys((prev) => {
        const next = new Set(prev);
        next.delete(code);
        return next;
      });
    };

    // Clear stuck keys if user leaves window or switches tab
    const handleBlur = () => {
      setPressedKeys(new Set());
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, [captureFocused, maxRollover]);

  const testedCount = Object.keys(testedKeys).length;

  const saveKeyboardReport = () => {
    onAddRecord({
      moduleId: 'keyboard',
      moduleName: 'Keyboard Lab',
      testName: 'Interactive Key Matrix & Rollover Test',
      device: 'Standard HID Keyboard',
      method: 'REALTIME',
      status: chatterCount > 0 ? 'WARNING' : testedCount > 5 ? 'PASS' : 'SKIPPED',
      metrics: {
        uniqueKeysTested: testedCount,
        maxSimultaneousKeysNKRO: maxRollover,
        chatterWarnings: chatterCount
      },
      notes: lang === 'en' ? 'Direct keydown/keyup event testing in capture matrix.' : 'Kiểm tra trực tiếp sự kiện keydown/keyup trong vùng test.'
    });
  };

  const renderKey = (k: KeyDefinition, keyId: string) => {
    if (k.isSpacer) {
      return (
        <div
          key={k.code || keyId}
          className={`${k.width || 'w-11 sm:w-12'} h-11 sm:h-12 pointer-events-none opacity-0 shrink-0`}
        />
      );
    }
    const isDown = pressedKeys.has(k.code);
    const count = testedKeys[k.code] || 0;
    return (
      <div
        key={k.code}
        className={`relative ${k.width || 'w-11 sm:w-12'
          } h-11 sm:h-12 rounded-lg border flex flex-col items-center justify-center select-none transition-all duration-75 shrink-0 ${isDown
            ? 'bg-[#F4F4F4] text-[#030303] border-white shadow-[0_0_20px_rgba(255,255,255,0.7)] translate-y-0.5 font-bold scale-[0.98]'
            : count > 0
              ? 'bg-white/[0.14] text-[#F4F4F4] border-white/30 shadow-[0_2px_0_rgba(255,255,255,0.12),0_4px_8px_rgba(0,0,0,0.5)]'
              : 'bg-white/[0.04] text-zinc-300 border-white/10 hover:border-white/20 hover:bg-white/[0.08] shadow-[0_2px_0_rgba(0,0,0,0.6),0_4px_8px_rgba(0,0,0,0.5)]'
          }`}
      >
        {k.sub && (
          <span
            className={`text-[9px] -mb-0.5 font-mono ${isDown ? 'text-zinc-800' : 'text-zinc-400'
              }`}
          >
            {k.sub}
          </span>
        )}
        <span
          className={`${k.sub ? 'text-[11px] font-semibold' : 'text-xs font-semibold'
            }`}
        >
          {k.label}
        </span>
        {count > 0 && (
          <span className="absolute bottom-0.5 right-1 text-[8px] font-mono text-zinc-400 font-bold">
            {count}×
          </span>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <GlassCard
        title={t.cardMatrixTitle}
        icon={<Keyboard className="w-5 h-5" />}
        badge="REALTIME"
        rightSlot={
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setPressedKeys(new Set());
                setTestedKeys({});
                setMaxRollover(0);
                setChatterCount(0);
                setLastEvent(null);
              }}
              title="Reset & Clear"
              className="p-2 rounded-lg bg-white/[0.06] hover:bg-white/12 border border-white/10 text-zinc-300 hover:text-[#F4F4F4] text-xs font-medium cursor-pointer transition"
            >
              <RotateCcw className="w-4 h-4" />
            </button>
          </div>
        }
      >
        <div
          ref={zoneRef}
          tabIndex={0}
          onFocus={() => setCaptureFocused(true)}
          className="space-y-5 outline-none"
        >
          {/* Telemetry Counters */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-xs">
            <div className="p-3 rounded-xl liquid-glass-sub">
              <div className="text-zinc-400">{t.captureStatus}</div>
              <button
                onClick={() => setCaptureFocused((v) => !v)}
                className={`mt-1 px-2.5 py-1 rounded-lg font-medium text-xs cursor-pointer ${captureFocused
                  ? 'bg-white/[0.12] text-[#F4F4F4] border border-white/25'
                  : 'bg-white/[0.04] text-zinc-400 border border-white/10'
                  }`}
              >
                {captureFocused ? t.activeLabel : t.pausedLabel}
              </button>
            </div>
            <div className="p-3 rounded-xl liquid-glass-sub">
              <div className="text-zinc-400">{t.pressedCountLabel}</div>
              <div className="text-xl font-bold font-mono text-[#F4F4F4] mt-0.5">
                {pressedKeys.size} {t.keysUnit}
              </div>
            </div>
            <div className="p-3 rounded-xl liquid-glass-sub">
              <div className="text-zinc-400">{t.maxNkroLabel}</div>
              <div className="text-xl font-bold font-mono text-[#F4F4F4] mt-0.5">
                {maxRollover} {t.keysUnit}
              </div>
            </div>
            <div className="p-3 rounded-xl liquid-glass-sub">
              <div className="text-zinc-400">{t.testedKeysLabel}</div>
              <div className="text-xl font-bold font-mono text-[#F4F4F4] mt-0.5">
                {testedCount} {t.keysUnit}
              </div>
            </div>
            <div className="p-3 rounded-xl liquid-glass-sub">
              <div className="text-zinc-400">{t.lastKeyLabel}</div>
              <div className="text-sm font-bold font-mono text-zinc-100 mt-1 truncate">
                {lastEvent ? `${lastEvent.code} (${lastEvent.key})` : t.notPressedYet}
              </div>
            </div>
          </div>

          {/* Visual Keyboard Chassis (Centered & High-End Mechanical Aesthetic) */}
          <div className="w-full flex justify-center overflow-x-auto py-3">
            <div className="inline-block p-4 sm:p-6 rounded-3xl bg-[#191919]/95 border border-white/15 shadow-[0_24px_60px_rgba(0,0,0,0.8),inset_0_1px_1px_rgba(255,255,255,0.15)] backdrop-blur-2xl">
              {/* Chassis Status Header */}
              <div className="flex items-center justify-between text-xs text-zinc-400 mb-3 px-1 border-b border-white/10 pb-2.5">
                <div className="flex items-center gap-2.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-white animate-pulse shadow-[0_0_8px_rgba(255,255,255,0.8)]"></span>
                  <span className="font-semibold text-zinc-200 tracking-wider uppercase text-[11px]">
                    Tenkeyless (TKL) ANSI Mechanical Layout • Full NKRO Matrix
                  </span>
                </div>
                <div className="flex items-center gap-4 font-mono text-xs">
                  <span>{t.tested} <strong className="text-[#F4F4F4] font-bold">{testedCount}</strong></span>
                  <span>{t.held} <strong className="text-[#F4F4F4] font-bold">{pressedKeys.size}</strong></span>
                </div>
              </div>

              {/* Dual Section Mechanical Bezel */}
              <div className="flex items-start gap-4 sm:gap-6 select-none">
                {/* 1. Main Typing Block */}
                <div className="flex flex-col gap-2">
                  {KEYBOARD_MAIN_ROWS.map((row, rIdx) => (
                    <div key={rIdx} className="flex items-center gap-1.5 sm:gap-2">
                      {row.map((k, kIdx) => renderKey(k, `main-${rIdx}-${kIdx}`))}
                    </div>
                  ))}
                </div>

                {/* Decorative Separation Channel */}
                <div className="self-stretch w-px bg-gradient-to-b from-transparent via-white/10 to-transparent mx-0.5" />

                {/* 2. Nav & Arrow Cluster Block (Strict 3-Column Columnar Grid) */}
                <div className="flex flex-col gap-2">
                  {KEYBOARD_NAV_ROWS.map((row, rIdx) => (
                    <div key={rIdx} className="flex items-center gap-1.5 sm:gap-2">
                      {row.map((k, kIdx) => renderKey(k, `nav-${rIdx}-${kIdx}`))}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="text-[11px] text-zinc-400 flex flex-wrap items-center justify-between gap-2">
            <span>
              <strong>{t.browserLimitation}</strong> {t.browserLimitationDesc}
            </span>
            {chatterCount > 0 && (
              <span className="text-zinc-300 font-medium">
                {t.switchChatterWarning} ({chatterCount})
              </span>
            )}
          </div>
        </div>
      </GlassCard>

      {/* Typing Speed & Accuracy Benchmark */}
      <TypingSpeedTester onAddRecord={onAddRecord} lang={lang} />
    </div>
  );
};

// ----------------------------------------------------------------------------
// 11.1 MOUSE AIMING & REFLEX TESTER (30s AIM BENCHMARK)
// ----------------------------------------------------------------------------

interface AimTarget {
  id: number;
  x: number; // Percentage 8 - 92
  y: number; // Percentage 12 - 88
  spawnTime: number;
  lifespanMs: number;
}

interface AimFeedback {
  id: number;
  x: number;
  y: number;
  type: 'hit' | 'miss' | 'expire';
}

type AimDifficulty = 'EASY' | 'NORMAL' | 'HARD';

const DIFFICULTY_CONFIG: Record<AimDifficulty, { label: string; labelVi?: string; lifespanMs: number; badge: string }> = {
  EASY: { label: 'Easy', labelVi: 'Tập sự', lifespanMs: 1800, badge: 'text-[#F4F4F4] border-white/20 bg-white/[0.04]' },
  NORMAL: { label: 'Normal', labelVi: 'Tiêu chuẩn', lifespanMs: 1300, badge: 'text-zinc-300 border-white/15 bg-white/[0.03]' },
  HARD: { label: 'Esport Pro', labelVi: 'Chuyên nghiệp', lifespanMs: 900, badge: 'text-zinc-400 border-white/10 bg-white/[0.02]' }
};

const playAimSound = (type: 'hit' | 'miss' | 'countdown' | 'finish' | 'expire', muted = false) => {
  if (muted || typeof window === 'undefined') return;
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    if (ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;

    if (type === 'hit') {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.exponentialRampToValueAtTime(1400, now + 0.07);
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
      osc.start(now);
      osc.stop(now + 0.08);
    } else if (type === 'miss') {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(160, now);
      osc.frequency.exponentialRampToValueAtTime(70, now + 0.06);
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.07);
      osc.start(now);
      osc.stop(now + 0.07);
    } else if (type === 'expire') {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(220, now);
      osc.frequency.exponentialRampToValueAtTime(80, now + 0.12);
      gain.gain.setValueAtTime(0.09, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
      osc.start(now);
      osc.stop(now + 0.12);
    } else if (type === 'countdown') {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(600, now);
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
      osc.start(now);
      osc.stop(now + 0.09);
    } else if (type === 'finish') {
      [523.25, 659.25, 783.99, 1046.5].forEach((freq, idx) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.connect(g);
        g.connect(ctx.destination);
        o.type = 'triangle';
        o.frequency.setValueAtTime(freq, now + idx * 0.07);
        g.gain.setValueAtTime(0.15, now + idx * 0.07);
        g.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.07 + 0.35);
        o.start(now + idx * 0.07);
        o.stop(now + idx * 0.07 + 0.35);
      });
    }
  } catch {
    // Audio ignored if blocked
  }
};

const MouseAimingTester: React.FC<{
  onAddRecord: (rec: Omit<DiagnosticRecord, 'id' | 'timestamp'>) => Promise<void>;
  lang?: Lang;
}> = ({ onAddRecord, lang = 'en' }) => {
  const t = translations[lang].mouse;
  const [gameState, setGameState] = useState<'idle' | 'countdown' | 'playing' | 'finished'>('idle');
  const [countdown, setCountdown] = useState<number>(3);
  const [timeLeft, setTimeLeft] = useState<number>(30.0);
  const [hits, setHits] = useState<number>(0);
  const [misses, setMisses] = useState<number>(0);
  const [expiredCount, setExpiredCount] = useState<number>(0);
  const [difficulty, setDifficulty] = useState<AimDifficulty>('NORMAL');
  const [targets, setTargets] = useState<AimTarget[]>([]);
  const [feedbacks, setFeedbacks] = useState<AimFeedback[]>([]);
  const [soundEnabled, setSoundEnabled] = useState<boolean>(true);
  const [saved, setSaved] = useState<boolean>(false);

  const startTimeRef = useRef<number>(0);
  const targetIdCounterRef = useRef<number>(1);
  const reactionTimesRef = useRef<number[]>([]);

  const spawnTarget = useCallback((existingTargets: AimTarget[], lifespan: number): AimTarget => {
    let bestX = 50;
    let bestY = 50;
    let found = false;

    for (let attempts = 0; attempts < 30; attempts++) {
      const candidateX = Math.round(8 + Math.random() * 84);
      const candidateY = Math.round(12 + Math.random() * 76);

      const minDistance = existingTargets.reduce((minDist, t) => {
        const dist = Math.hypot(candidateX - t.x, candidateY - t.y);
        return Math.min(minDist, dist);
      }, 999);

      if (minDistance >= 18) {
        bestX = candidateX;
        bestY = candidateY;
        found = true;
        break;
      }
      if (attempts === 0) {
        bestX = candidateX;
        bestY = candidateY;
      }
    }

    if (!found) {
      bestX = Math.round(10 + Math.random() * 80);
      bestY = Math.round(15 + Math.random() * 70);
    }

    targetIdCounterRef.current += 1;
    return {
      id: targetIdCounterRef.current,
      x: bestX,
      y: bestY,
      spawnTime: performance.now(),
      lifespanMs: lifespan
    };
  }, []);

  // Start test -> enter countdown
  const startAimTest = useCallback(() => {
    setHits(0);
    setMisses(0);
    setExpiredCount(0);
    setTimeLeft(30.0);
    setFeedbacks([]);
    setSaved(false);
    reactionTimesRef.current = [];
    setCountdown(3);
    playAimSound('countdown', !soundEnabled);
    setGameState('countdown');
  }, [soundEnabled]);

  // 1. Countdown Loop (3 -> 2 -> 1 -> START)
  useEffect(() => {
    if (gameState !== 'countdown') return;

    let currentCd = 3;
    setCountdown(3);

    const timer = window.setInterval(() => {
      currentCd -= 1;
      if (currentCd > 0) {
        setCountdown(currentCd);
        playAimSound('countdown', !soundEnabled);
      } else {
        clearInterval(timer);
        setGameState('playing');
        startTimeRef.current = performance.now();

        const currentLifespan = DIFFICULTY_CONFIG[difficulty].lifespanMs;
        const initTargets: AimTarget[] = [];
        for (let i = 0; i < 3; i++) {
          initTargets.push(spawnTarget(initTargets, currentLifespan));
        }
        setTargets(initTargets);
      }
    }, 1000);

    return () => {
      clearInterval(timer);
    };
  }, [gameState, soundEnabled, spawnTarget, difficulty]);

  // 2. Playing 30s Game Loop with Dynamic Target Decay (Expiration)
  useEffect(() => {
    if (gameState !== 'playing') return;

    const timer = window.setInterval(() => {
      const now = performance.now();
      const elapsed = (now - startTimeRef.current) / 1000;
      const remain = Math.max(0, 30.0 - elapsed);
      const rounded = Math.round(remain * 10) / 10;
      setTimeLeft(rounded);

      if (remain <= 0) {
        clearInterval(timer);
        setGameState('finished');
        setTargets([]);
        playAimSound('finish', !soundEnabled);
        return;
      }

      // Check expired targets that decay over time
      const currentLifespan = DIFFICULTY_CONFIG[difficulty].lifespanMs;
      setTargets((prevTargets) => {
        let hasExpired = false;
        const validTargets: AimTarget[] = [];
        const newFbs: AimFeedback[] = [];

        for (const t of prevTargets) {
          if (now - t.spawnTime >= t.lifespanMs) {
            hasExpired = true;
            setExpiredCount((c) => c + 1);
            const fid = Date.now() + Math.random();
            newFbs.push({ id: fid, x: t.x, y: t.y, type: 'expire' });
            setTimeout(() => {
              setFeedbacks((f) => f.filter((item) => item.id !== fid));
            }, 450);
          } else {
            validTargets.push(t);
          }
        }

        if (hasExpired) {
          playAimSound('expire', !soundEnabled);
          if (newFbs.length > 0) {
            setFeedbacks((prev) => [...prev.slice(-8), ...newFbs]);
          }
          while (validTargets.length < 3) {
            validTargets.push(spawnTarget(validTargets, currentLifespan));
          }
          return validTargets;
        }

        return prevTargets;
      });
    }, 35);

    return () => {
      clearInterval(timer);
    };
  }, [gameState, soundEnabled, difficulty, spawnTarget]);

  const handleTargetClick = (e: React.MouseEvent, target: AimTarget) => {
    e.stopPropagation();
    if (gameState !== 'playing') return;

    const reaction = Math.round(performance.now() - target.spawnTime);
    reactionTimesRef.current.push(reaction);
    setHits((prev) => prev + 1);
    playAimSound('hit', !soundEnabled);

    const fid = Date.now() + Math.random();
    setFeedbacks((prev) => [...prev.slice(-8), { id: fid, x: target.x, y: target.y, type: 'hit' }]);
    setTimeout(() => {
      setFeedbacks((prev) => prev.filter((f) => f.id !== fid));
    }, 450);

    const currentLifespan = DIFFICULTY_CONFIG[difficulty].lifespanMs;
    setTargets((prev) => {
      const remaining = prev.filter((t) => t.id !== target.id);
      const nextTarget = spawnTarget(remaining, currentLifespan);
      return [...remaining, nextTarget];
    });
  };

  const handleArenaClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (gameState !== 'playing') return;

    setMisses((prev) => prev + 1);
    playAimSound('miss', !soundEnabled);

    const rect = e.currentTarget.getBoundingClientRect();
    const xPct = Math.round(((e.clientX - rect.left) / rect.width) * 100);
    const yPct = Math.round(((e.clientY - rect.top) / rect.height) * 100);

    const fid = Date.now() + Math.random();
    setFeedbacks((prev) => [...prev.slice(-8), { id: fid, x: xPct, y: yPct, type: 'miss' }]);
    setTimeout(() => {
      setFeedbacks((prev) => prev.filter((f) => f.id !== fid));
    }, 400);
  };

  const handleCancelTest = () => {
    setGameState('idle');
    setTargets([]);
    setFeedbacks([]);
    setTimeLeft(30.0);
    setCountdown(3);
  };

  const totalClicks = hits + misses;
  const accuracy = totalClicks > 0 ? Math.round((hits / totalClicks) * 100) : 0;
  const totalTargetsEncountered = hits + expiredCount;
  const catchRate = totalTargetsEncountered > 0 ? Math.round((hits / totalTargetsEncountered) * 100) : 0;
  const avgReactionMs =
    reactionTimesRef.current.length > 0
      ? Math.round(reactionTimesRef.current.reduce((a, b) => a + b, 0) / reactionTimesRef.current.length)
      : 0;
  const targetsPerSec = Math.round((hits / 30) * 100) / 100;
  const score = Math.max(0, Math.round(hits * 110 + accuracy * 10 - expiredCount * 15));

  const handleSaveAimReport = async () => {
    if (saved) return;
    await onAddRecord({
      moduleId: 'mouse',
      moduleName: 'Mouse Lab',
      testName: '30s Mouse Aiming & Reflex Benchmark',
      device: 'Pointer / Mouse Device',
      method: 'REALTIME',
      status: accuracy >= 70 && hits >= 20 ? 'PASS' : 'WARNING',
      metrics: {
        difficulty: DIFFICULTY_CONFIG[difficulty].label,
        score: `${score} pts`,
        targetsHit: `${hits} targets`,
        expiredTargets: `${expiredCount} missed`,
        missClicks: `${misses} clicks`,
        totalClicks: totalClicks,
        accuracy: `${accuracy}%`,
        catchRate: `${catchRate}%`,
        avgReactionTime: `${avgReactionMs}ms`,
        firingSpeed: `${targetsPerSec} targets/s`,
        duration: '30.0s'
      },
      notes: `Hạ ${hits} mục tiêu, lỡ ${expiredCount} mục tiêu trong 30s (${lang === 'en' ? DIFFICULTY_CONFIG[difficulty].label : ((DIFFICULTY_CONFIG[difficulty] as any).labelVi || DIFFICULTY_CONFIG[difficulty].label)}) với độ chính xác ${accuracy}%.`
    });
    setSaved(true);
  };

  return (
    <GlassCard
      title="Aim Test"
      icon={<Crosshair className="w-5 h-5 text-white" />}
      rightSlot={
        <div className="flex items-center gap-2">
          <button
            onClick={() => setSoundEnabled((s) => !s)}
            className="p-1.5 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] text-zinc-300 transition cursor-pointer"
            title={soundEnabled ? t.mute : t.unmute}
          >
            {soundEnabled ? <Volume2 className="w-4 h-4 text-white" /> : <VolumeX className="w-4 h-4 text-zinc-500" />}
          </button>
          {gameState === 'playing' ? (
            <button
              onClick={handleCancelTest}
              className="px-3 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] border border-white/10 text-zinc-300 hover:text-white text-xs font-medium cursor-pointer transition"
            >
              {t.cancelTest}
            </button>
          ) : gameState === 'finished' ? (
            <div className="flex items-center gap-2">
              <button
                onClick={startAimTest}
                className="px-3 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] text-zinc-200 text-xs font-medium cursor-pointer"
              >
                {t.playAgain}
              </button>
            </div>
          ) : null}
        </div>
      }
    >
      <div className="space-y-4">
        {(gameState === 'playing' || gameState === 'finished') && (
          <div className="space-y-2">
            <div className="grid grid-cols-2 sm:grid-cols-6 gap-3 text-xs">
              <div className="p-3 rounded-xl liquid-glass-sub">
                <div className="text-zinc-400 text-[11px]">{t.timeRemaining}</div>
                <div
                  className={`text-2xl font-bold font-mono mt-0.5 flex items-baseline gap-1 ${timeLeft <= 5 ? 'text-[#F4F4F4] animate-pulse' : 'text-zinc-200'
                    }`}
                >
                  <span>{timeLeft.toFixed(1)}</span>
                  <span className="text-xs font-normal text-zinc-400">s</span>
                </div>
              </div>

              <div className="p-3 rounded-xl liquid-glass-sub">
                <div className="text-zinc-400 text-[11px]">{t.hits}</div>
                <div className="text-2xl font-bold font-mono text-[#F4F4F4] mt-0.5">
                  {hits} <span className="text-xs font-normal text-zinc-400">target</span>
                </div>
              </div>

              <div className="p-3 rounded-xl liquid-glass-sub">
                <div className="text-zinc-400 text-[11px]">{t.expired}</div>
                <div className="text-2xl font-bold font-mono text-zinc-300 mt-0.5">
                  {expiredCount} <span className="text-xs font-normal text-zinc-400">{lang === 'en' ? 'missed' : 'lỡ'}</span>
                </div>
                <div className="text-[10px] text-zinc-500 mt-0.5">{t.timedOut}</div>
              </div>

              <div className="p-3 rounded-xl liquid-glass-sub">
                <div className="text-zinc-400 text-[11px]">{t.aimAccuracyLabel}</div>
                <div className="text-2xl font-bold font-mono text-[#F4F4F4] mt-0.5">
                  {accuracy}%
                </div>
                <div className="text-[10px] text-zinc-500 mt-0.5">
                  {hits}/{totalClicks} {t.clicksHit}
                </div>
              </div>

              <div className="p-3 rounded-xl liquid-glass-sub">
                <div className="text-zinc-400 text-[11px]">{t.avgReaction}</div>
                <div className="text-2xl font-bold font-mono text-[#F4F4F4] mt-0.5">
                  {avgReactionMs} <span className="text-xs font-normal text-zinc-400">ms</span>
                </div>
              </div>

              <div className="p-3 rounded-xl liquid-glass-sub">
                <div className="text-zinc-400 text-[11px]">{t.aimSpeed}</div>
                <div className="text-2xl font-bold font-mono text-zinc-300 mt-0.5">
                  {targetsPerSec} <span className="text-xs font-normal text-zinc-400">t/s</span>
                </div>
              </div>
            </div>

            {gameState === 'playing' && (
              <div className="w-full h-1.5 bg-[#191919] rounded-full overflow-hidden border border-white/5">
                <div
                  className="h-full transition-all duration-75 rounded-full bg-[#F4F4F4]"
                  style={{ width: `${(timeLeft / 30) * 100}%` }}
                />
              </div>
            )}
          </div>
        )}

        {gameState === 'idle' && (
          <div className="p-10 sm:p-14 rounded-3xl bg-zinc-900/40 backdrop-blur-2xl border border-white/10 flex flex-col items-center justify-center text-center space-y-6 relative overflow-hidden shadow-[0_8px_32px_rgba(0,0,0,0.4),inset_0_1px_1px_rgba(255,255,255,0.1)]">
            {/* 3 Difficulty Selector Buttons */}
            <div className="flex flex-wrap items-center justify-center gap-3 relative z-10">
              {(['EASY', 'NORMAL', 'HARD'] as AimDifficulty[]).map((diff) => (
                <button
                  key={diff}
                  onClick={() => setDifficulty(diff)}
                  className={`px-5 py-2.5 rounded-2xl text-xs font-semibold transition-all duration-200 cursor-pointer border ${difficulty === diff
                    ? 'bg-white text-zinc-950 border-white shadow-[0_0_20px_rgba(255,255,255,0.35)] scale-105'
                    : 'bg-white/[0.05] text-zinc-400 hover:text-white border-white/10 hover:border-white/20 hover:bg-white/[0.1]'
                    }`}
                >
                  {lang === 'en' ? DIFFICULTY_CONFIG[diff].label : ((DIFFICULTY_CONFIG[diff] as any).labelVi || DIFFICULTY_CONFIG[diff].label)}
                </button>
              ))}
            </div>

            <button
              onClick={startAimTest}
              className="relative z-10 inline-flex items-center gap-2.5 px-8 py-3 rounded-2xl bg-white hover:bg-zinc-200 text-zinc-950 font-bold text-sm shadow-[0_4px_25px_rgba(255,255,255,0.25)] transition-all duration-200 cursor-pointer transform hover:scale-[1.03] active:scale-[0.98]"
            >
              <Play className="w-4 h-4 fill-zinc-950" />
              <span>{t.btnStartAim}</span>
            </button>
          </div>
        )}

        {gameState === 'countdown' && (
          <div className="h-[420px] rounded-2xl bg-[#030303] border border-white/20 flex flex-col items-center justify-center text-center space-y-4 relative overflow-hidden select-none liquid-glass">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.08)_0%,transparent_60%)]" />
            <div className="text-zinc-400 text-sm font-medium uppercase tracking-widest">
              {t.getReady}
            </div>
            <div className="text-7xl sm:text-8xl font-black font-mono text-white animate-ping">
              {countdown}
            </div>
            <div className="text-xs text-zinc-500">
              {t.aimCountdownPrompt}
            </div>
          </div>
        )}

        {gameState === 'playing' && (
          <div
            onClick={handleArenaClick}
            onContextMenu={(e) => e.preventDefault()}
            className="relative h-[420px] w-full rounded-2xl overflow-hidden bg-[#030303] border border-white/15 select-none cursor-crosshair shadow-[inset_0_0_50px_rgba(0,0,0,0.8)]"
            style={{
              backgroundImage:
                'radial-gradient(circle at center, rgba(255, 255, 255, 0.03) 0%, transparent 70%), linear-gradient(rgba(255, 255, 255, 0.02) 1px, transparent 1px), linear-gradient(90deg, rgba(255, 255, 255, 0.02) 1px, transparent 1px)',
              backgroundSize: '100% 100%, 30px 30px, 30px 30px'
            }}
          >
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-10">
              <Crosshair className="w-48 h-48 text-white stroke-1" />
            </div>

            {feedbacks.map((fb) => (
              <div
                key={fb.id}
                className={`absolute pointer-events-none rounded-full transform -translate-x-1/2 -translate-y-1/2 flex items-center justify-center ${fb.type === 'hit'
                  ? 'w-16 h-16 border-2 border-white bg-white/20 animate-ping'
                  : fb.type === 'expire'
                    ? 'w-16 h-16 border border-white/40 bg-white/10 aim-expire-effect'
                    : 'w-6 h-6 border border-white/30 bg-white/5'
                  }`}
                style={{ left: `${fb.x}%`, top: `${fb.y}%` }}
              >
                {fb.type === 'expire' && (
                  <span className="text-[9px] font-bold font-mono text-zinc-300 uppercase tracking-widest">
                    {t.miss}
                  </span>
                )}
              </div>
            ))}

            {targets.map((target) => (
              <div
                key={target.id}
                onClick={(e) => handleTargetClick(e, target)}
                className="absolute transform -translate-x-1/2 -translate-y-1/2 w-12 h-12 sm:w-14 sm:h-14 rounded-full flex items-center justify-center cursor-pointer transition-transform duration-75 active:scale-90 hover:scale-110 group select-none"
                style={{ left: `${target.x}%`, top: `${target.y}%` }}
              >
                {/* Dynamic Shrinking Approach Ring (Vòng co báo hiệu sắp hết hạn) */}
                <div
                  className="absolute inset-0 rounded-full border border-dashed aim-approach-ring pointer-events-none"
                  style={{ animationDuration: `${target.lifespanMs}ms` }}
                />

                {/* Outer Ring */}
                <div className="absolute inset-0 rounded-full border border-white/60 bg-white/10 shadow-[0_0_20px_rgba(255,255,255,0.4)] group-hover:shadow-[0_0_25px_rgba(255,255,255,0.7)] group-hover:border-white transition-all" />

                {/* Middle Ring */}
                <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-full border border-white/50 bg-white/10 flex items-center justify-center pointer-events-none">
                  {/* Center Bullseye Dot */}
                  <div className="w-2.5 h-2.5 sm:w-3 sm:h-3 rounded-full bg-[#F4F4F4] shadow-[0_0_10px_rgba(255,255,255,0.85)]" />
                </div>
              </div>
            ))}
          </div>
        )}

        {gameState === 'finished' && (
          <div className="space-y-4">
            <div className="p-6 rounded-3xl bg-[#141414]/90 backdrop-blur-2xl border border-white/10 shadow-[0_8px_32px_rgba(0,0,0,0.5)] flex flex-col sm:flex-row items-center justify-between gap-5 text-center sm:text-left">
              <div className="flex items-center gap-4">
                <div className="p-3.5 rounded-2xl bg-white/[0.05] border border-white/15 text-[#F4F4F4] shrink-0">
                  <Crosshair className="w-7 h-7" />
                </div>
                <div>
                  <div className="flex items-center gap-2.5 justify-center sm:justify-start">
                    <h3 className="text-lg font-bold text-[#F4F4F4]">{t.benchmarkResult}</h3>
                    <span className="text-xs text-zinc-300 font-mono px-3 py-1 rounded-full bg-white/[0.08] border border-white/15">
                      {DIFFICULTY_CONFIG[difficulty].label}
                    </span>
                  </div>
                  <div className="text-xs text-zinc-300 mt-1">
                    {t.score} <strong className="text-[#F4F4F4] font-mono text-sm">{score} pts</strong> • {t.hits}: <strong className="text-[#F4F4F4] font-mono">{hits}</strong> • {t.expired}: <strong className="text-zinc-400 font-mono">{expiredCount}</strong> • {t.aimAccuracyLabel}: <strong className="text-[#F4F4F4] font-mono">{accuracy}%</strong>
                  </div>
                </div>
              </div>

              <div className="shrink-0 flex items-center gap-2 w-full sm:w-auto">
                <button
                  onClick={startAimTest}
                  className="flex-1 sm:flex-initial inline-flex items-center justify-center gap-2 px-6 py-2.5 rounded-2xl bg-[#F4F4F4] hover:bg-white text-[#030303] font-bold text-xs shadow-[0_4px_20px_rgba(255,255,255,0.2)] transition cursor-pointer"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>{t.playAgain}</span>
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-6 gap-3 text-xs">
              <div className="p-3.5 rounded-xl liquid-glass-sub">
                <div className="text-zinc-400 text-[11px]">{lang === 'en' ? 'Hits' : 'Bắn trúng (Hits)'}</div>
                <div className="text-xl font-bold font-mono text-[#F4F4F4] mt-1">{hits}</div>
                <div className="text-[10px] text-zinc-500 mt-0.5">{t.targetsCleared}</div>
              </div>

              <div className="p-3.5 rounded-xl liquid-glass-sub">
                <div className="text-zinc-400 text-[11px]">{lang === 'en' ? 'Expired' : 'Biến mất (Quá hạn)'}</div>
                <div className="text-xl font-bold font-mono text-zinc-300 mt-1">{expiredCount}</div>
                <div className="text-[10px] text-zinc-500 mt-0.5">{t.expiredTargets}</div>
              </div>

              <div className="p-3.5 rounded-xl liquid-glass-sub">
                <div className="text-zinc-400 text-[11px]">{t.misses}</div>
                <div className="text-xl font-bold font-mono text-zinc-400 mt-1">{misses}</div>
                <div className="text-[10px] text-zinc-500 mt-0.5">{t.clicksOffTarget}</div>
              </div>

              <div className="p-3.5 rounded-xl liquid-glass-sub">
                <div className="text-zinc-400 text-[11px]">{lang === 'en' ? 'Accuracy' : 'Độ chính xác'}</div>
                <div className="text-xl font-bold font-mono text-[#F4F4F4] mt-1">{accuracy}%</div>
                <div className="text-[10px] text-zinc-500 mt-0.5">{hits}/{totalClicks} {lang === 'en' ? 'clicks hit' : 'clicks trúng'}</div>
              </div>

              <div className="p-3.5 rounded-xl liquid-glass-sub">
                <div className="text-zinc-400 text-[11px]">{t.catchRate}</div>
                <div className="text-xl font-bold font-mono text-[#F4F4F4] mt-1">{catchRate}%</div>
                <div className="text-[10px] text-zinc-500 mt-0.5">{t.hitBeforeDecay}</div>
              </div>

              <div className="p-3.5 rounded-xl liquid-glass-sub">
                <div className="text-zinc-400 text-[11px]">{lang === 'en' ? 'Avg Reaction' : 'Phản xạ trung bình'}</div>
                <div className="text-xl font-bold font-mono text-[#F4F4F4] mt-1">{avgReactionMs} ms</div>
                <div className="text-[10px] text-zinc-500 mt-0.5">Time to kill (TTK)</div>
              </div>
            </div>
          </div>
        )}
      </div>
    </GlassCard>
  );
};

// ============================================================================
// 11. MODULE: MOUSE LAB
// ============================================================================

const MouseLabModule: React.FC<{
  onAddRecord: (rec: Omit<DiagnosticRecord, 'id' | 'timestamp'>) => Promise<void>;
  lang?: Lang;
}> = ({ onAddRecord, lang = 'en' }) => {
  const t = translations[lang].mouse;
  const [coords, setCoords] = useState({ x: 0, y: 0 });
  const [buttonCounts, setButtonCounts] = useState<Record<number, number>>({
    0: 0,
    1: 0,
    2: 0,
    3: 0,
    4: 0
  });
  const [activeButtons, setActiveButtons] = useState<Set<number>>(new Set());
  const [scrollStats, setScrollStats] = useState({ up: 0, down: 0, lastDirection: 'None' });
  const [estimatedHz, setEstimatedHz] = useState<number>(0);
  const [peakHz, setPeakHz] = useState<number>(0);
  const [doubleClickFaults, setDoubleClickFaults] = useState<number>(0);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pointsRef = useRef<{ x: number; y: number }[]>([]);
  const moveTimestampsRef = useRef<number[]>([]);
  const lastClickTimeRef = useRef<Record<number, number>>({});

  const resetMouseTest = () => {
    setButtonCounts({ 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 });
    setScrollStats({ up: 0, down: 0, lastDirection: 'None' });
    setEstimatedHz(0);
    setPeakHz(0);
    setDoubleClickFaults(0);
    pointsRef.current = [];
    moveTimestampsRef.current = [];
    const c = canvasRef.current;
    if (c) {
      const ctx = c.getContext('2d');
      ctx?.clearRect(0, 0, c.width, c.height);
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.round(e.clientX - rect.left);
    const y = Math.round(e.clientY - rect.top);
    setCoords({ x, y });

    // Coalesced events for higher accuracy polling rate estimation
    const nativeEv = e.nativeEvent as PointerEvent;
    const coalesced =
      typeof nativeEv.getCoalescedEvents === 'function'
        ? nativeEv.getCoalescedEvents()
        : [nativeEv];

    const now = performance.now();
    for (const ev of coalesced) {
      const ts = ev.timeStamp || now;
      moveTimestampsRef.current.push(ts);
    }

    // Keep timestamps within last 350ms
    const cutoff = (coalesced[coalesced.length - 1]?.timeStamp || now) - 350;
    moveTimestampsRef.current = moveTimestampsRef.current.filter((t) => t >= cutoff);

    if (moveTimestampsRef.current.length >= 4) {
      const intervals: number[] = [];
      for (let i = 1; i < moveTimestampsRef.current.length; i++) {
        const dt = moveTimestampsRef.current[i] - moveTimestampsRef.current[i - 1];
        if (dt > 0.25 && dt < 50) intervals.push(dt);
      }
      if (intervals.length > 0) {
        const avgDt = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        const hz = Math.min(2000, Math.round(1000 / avgDt));
        setEstimatedHz(hz);
        if (hz > peakHz) setPeakHz(hz);
      }
    }

    // Draw trail
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (canvas.width !== Math.floor(rect.width) || canvas.height !== Math.floor(rect.height)) {
      canvas.width = Math.floor(rect.width);
      canvas.height = Math.floor(rect.height);
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    pointsRef.current.push({ x, y });
    if (pointsRef.current.length > 80) pointsRef.current.shift();

    ctx.fillStyle = 'rgba(9, 9, 9, 0.35)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = 'rgba(244, 244, 244, 0.7)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    pointsRef.current.forEach((pt, idx) => {
      if (idx === 0) ctx.moveTo(pt.x, pt.y);
      else ctx.lineTo(pt.x, pt.y);
    });
    ctx.stroke();

    ctx.fillStyle = '#F4F4F4';
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const btn = e.button;
    const now = performance.now();
    const prev = lastClickTimeRef.current[btn] || 0;
    if (now - prev > 0 && now - prev < 42) {
      setDoubleClickFaults((f) => f + 1);
    }
    lastClickTimeRef.current[btn] = now;

    setButtonCounts((prevCounts) => ({
      ...prevCounts,
      [btn]: (prevCounts[btn] || 0) + 1
    }));
    setActiveButtons((prevSet) => new Set(prevSet).add(btn));
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const btn = e.button;
    setActiveButtons((prevSet) => {
      const next = new Set(prevSet);
      next.delete(btn);
      return next;
    });
  };

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (e.deltaY < 0) {
      setScrollStats((s) => ({ up: s.up + 1, down: s.down, lastDirection: lang === 'en' ? 'Scroll Up' : 'Cuộn Lên' }));
    } else if (e.deltaY > 0) {
      setScrollStats((s) => ({ up: s.up, down: s.down + 1, lastDirection: lang === 'en' ? 'Scroll Down' : 'Cuộn Xuống' }));
    }
  };

  return (
    <div className="space-y-6">
      <GlassCard
        title={t.cardMouseLabTitle}
        icon={<MousePointer className="w-5 h-5" />}
        badge="ESTIMATED"
        rightSlot={
          <div className="flex items-center gap-2">
            <button
              onClick={resetMouseTest}
              title={t.resetStats}
              className="p-2 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] text-zinc-200 text-xs font-medium cursor-pointer transition"
            >
              <RotateCcw className="w-4 h-4" />
            </button>
          </div>
        }
      >
        <div className="space-y-4 text-xs">
          {/* Button Indicators */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            {[
              { id: 0, name: t.btnLeftClick },
              { id: 1, name: t.btnMiddleClick },
              { id: 2, name: t.btnRightClick },
              { id: 3, name: t.btnBackClick },
              { id: 4, name: t.btnForwardClick }
            ].map((b) => {
              const isDown = activeButtons.has(b.id);
              return (
                <div
                  key={b.id}
                  className={`p-3 rounded-xl border transition ${isDown
                    ? 'bg-white text-zinc-950 border-white font-bold shadow-[0_0_15px_rgba(255,255,255,0.6)]'
                    : 'liquid-glass-sub border-white/10 text-zinc-200'
                    }`}
                >
                  <div className="text-[11px] opacity-80">{b.name}</div>
                  <div className="text-lg font-mono font-bold mt-0.5">
                    {buttonCounts[b.id] || 0} {t.clicksUnit}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Telemetry Row */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="p-3 rounded-xl liquid-glass-sub">
              <div className="text-zinc-400 text-[11px]">{t.canvasCoords}</div>
              <div className="text-base font-bold font-mono text-[#F4F4F4] mt-0.5">
                X: {coords.x}px, Y: {coords.y}px
              </div>
            </div>
            <div className="p-3 rounded-xl liquid-glass-sub">
              <div className="text-zinc-400 text-[11px]">{t.scrollWheel}</div>
              <div className="text-base font-bold font-mono text-[#F4F4F4] mt-0.5">
                ↑{scrollStats.up} / ↓{scrollStats.down} ({scrollStats.lastDirection})
              </div>
            </div>
            <div className="p-3 rounded-xl liquid-glass-sub">
              <div className="text-zinc-400 text-[11px]">{t.estimatedPolling}</div>
              <div className="text-base font-bold font-mono text-[#F4F4F4] mt-0.5">
                {estimatedHz} Hz ({t.peak} {peakHz} Hz)
              </div>
            </div>
            <div className="p-3 rounded-xl liquid-glass-sub">
              <div className="text-zinc-400 text-[11px]">{t.doubleClickDetection}</div>
              <div
                className={`text-base font-bold font-mono mt-0.5 ${doubleClickFaults > 0 ? 'text-zinc-400' : 'text-zinc-300'
                  }`}
              >
                {doubleClickFaults} {t.faultsUnit}
              </div>
            </div>
          </div>

          {/* Interactive Mouse Test Arena */}
          <div
            onMouseDown={handleMouseDown}
            onMouseUp={handleMouseUp}
            onContextMenu={(e) => e.preventDefault()}
            onWheel={handleWheel}
            className="relative h-64 w-full rounded-2xl overflow-hidden bg-[#030303] border border-white/15 select-none cursor-crosshair"
          >
            <canvas
              ref={canvasRef}
              onPointerMove={handlePointerMove}
              className="w-full h-full block"
            />
            <div className="absolute top-3 left-3 pointer-events-none text-[11px] text-zinc-400 bg-[#191919]/90 px-3 py-1.5 rounded-lg border border-white/10">
              {t.arenaNotice}
            </div>
          </div>

          <p className="text-[11px] text-zinc-400">
            {t.techNote}
          </p>
        </div>
      </GlassCard>

      {/* 30s Aiming & Reflex Benchmark */}
      <MouseAimingTester onAddRecord={onAddRecord} lang={lang} />
    </div>
  );
};

// ============================================================================
// 12. MODULE: DISPLAY LAB
// ============================================================================

interface DisplayPattern {
  id: string;
  name: string;
  nameVi: string;
  desc: string;
  descVi: string;
  bg: string;
}

const DISPLAY_PATTERNS: DisplayPattern[] = [
  {
    id: 'red',
    name: 'Pure Red',
    nameVi: 'Đỏ Thuần',
    desc: 'Detect dead or stuck red sub-pixels on the panel matrix',
    descVi: 'Phát hiện điểm chết hoặc kẹt sub-pixel Đỏ trên ma trận tấm nền',
    bg: '#ff0000'
  },
  {
    id: 'green',
    name: 'Pure Green',
    nameVi: 'Xanh Lá Thuần',
    desc: 'Inspect green sub-pixel integrity & stuck phosphor dots',
    descVi: 'Kiểm tra độ toàn vẹn sub-pixel Lục và điểm kẹt phát quang',
    bg: '#00ff00'
  },
  {
    id: 'blue',
    name: 'Pure Blue',
    nameVi: 'Xanh Dương Thuần',
    desc: 'Check blue sub-pixel response & dead diode points',
    descVi: 'Kiểm tra đáp ứng sub-pixel Lam và điểm chết diode',
    bg: '#0000ff'
  },
  {
    id: 'white',
    name: 'Pure White',
    nameVi: 'Trắng Thuần',
    desc: 'Spot total dead pixels (black dots) & trapped screen dust particles',
    descVi: 'Phát hiện điểm chết hoàn toàn (chấm đen) và bụi lọt trong tấm nền',
    bg: '#ffffff'
  },
  {
    id: 'black',
    name: 'Pure Black',
    nameVi: 'Đen Thuần',
    desc: 'Identify stuck bright pixels & edge backlight bleeding (IPS glow)',
    descVi: 'Phát hiện điểm kẹt sáng (chấm sáng) và hiện tượng hở sáng viền màn hình',
    bg: '#000000'
  },
  {
    id: 'gray50',
    name: '50% Uniformity Gray',
    nameVi: 'Xám Đồng nhất 50%',
    desc: 'Test gray uniformity, color tinting & Dirty Screen Effect (DSE)',
    descVi: 'Kiểm tra độ đồng đều màu xám, ám màu và hiện tượng bẩn màn (DSE)',
    bg: '#808080'
  },
  {
    id: 'gradient',
    name: 'Dynamic Banding Gradient',
    nameVi: 'Dải Chuyển Sắc Động',
    desc: 'Examine 8-bit/10-bit color transitions & posterization steps',
    descVi: 'Kiểm tra độ sâu màu 8-bit/10-bit và độ mượt chuyển sắc thái màu',
    bg: 'linear-gradient(90deg, #000000, #06b6d4, #a855f7, #ffffff)'
  },
  {
    id: 'rainbow',
    name: 'Full Color Spectrum (Rainbow)',
    nameVi: 'Dải Quang Phổ Màu Đa Sắc (Rainbow)',
    desc: 'Verify color transitions & sub-pixel uniformity across all RGB hues',
    descVi: 'Kiểm tra độ mượt chuyển màu và tính đồng nhất trên dải màu RGB',
    bg: 'linear-gradient(90deg, #ff0000, #ff8000, #ffff00, #00ff00, #00ffff, #0000ff, #8000ff, #ff00ff)'
  }
];

const ScreenRefreshRateTester: React.FC<{
  onAddRecord: (rec: Omit<DiagnosticRecord, 'id' | 'timestamp'>) => Promise<void>;
  lang?: Lang;
}> = ({ onAddRecord, lang = 'en' }) => {
  const t = translations[lang].display;
  const [active, setActive] = useState(true);
  const [measuredHz, setMeasuredHz] = useState<number>(60);
  const [nominalHz, setNominalHz] = useState<number>(60);
  const [frameTimeMs, setFrameTimeMs] = useState<number>(16.67);
  const [jitterMs, setJitterMs] = useState<number>(0);
  const [stutterCount, setStutterCount] = useState<number>(0);
  const [speed, setSpeed] = useState<number>(960);
  const [testPattern, setTestPattern] = useState<'ufo' | 'grating'>('ufo');
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const oscCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // References for pure RAF performance (no React state updates in the 144Hz/240Hz render loop!)
  const activeRef = useRef<boolean>(true);
  const speedRef = useRef<number>(speed);
  const testPatternRef = useRef<'ufo' | 'grating'>(testPattern);
  const nominalHzRef = useRef<number>(60);
  const frameDeltasRef = useRef<number[]>([]);
  const lastTimeRef = useRef<number>(performance.now());
  const lastUiUpdateRef = useRef<number>(performance.now());
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);

  useEffect(() => {
    testPatternRef.current = testPattern;
  }, [testPattern]);

  useEffect(() => {
    nominalHzRef.current = nominalHz;
  }, [nominalHz]);

  // Fullscreen change listener
  useEffect(() => {
    const handleFsChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFsChange);
    return () => document.removeEventListener('fullscreenchange', handleFsChange);
  }, []);

  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().catch(() => { });
    } else {
      document.exitFullscreen().catch(() => { });
    }
  };

  // Main Canvas Render Loop (Zero React State updates during RAF!)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let localStutters = 0;

    const renderLoop = (now: number) => {
      if (!activeRef.current) {
        rafRef.current = requestAnimationFrame(renderLoop);
        return;
      }

      const delta = now - lastTimeRef.current;
      lastTimeRef.current = now;

      // Filter abnormal pauses (tab switch, window resize)
      if (delta > 0 && delta < 200) {
        frameDeltasRef.current.push(delta);
        if (frameDeltasRef.current.length > 90) {
          frameDeltasRef.current.shift();
        }

        // Periodic UI State update (debounced to ~400ms to eliminate React re-render lag)
        if (now - lastUiUpdateRef.current >= 400 && frameDeltasRef.current.length >= 24) {
          lastUiUpdateRef.current = now;
          const sum = frameDeltasRef.current.reduce((a, b) => a + b, 0);
          const avgDelta = sum / frameDeltasRef.current.length;
          const currentHz = Math.round((1000 / avgDelta) * 10) / 10;

          const variance =
            frameDeltasRef.current.reduce((acc, d) => acc + Math.pow(d - avgDelta, 2), 0) /
            frameDeltasRef.current.length;
          const jitter = Math.round(Math.sqrt(variance) * 100) / 100;

          // Match closest display hardware standard tier
          const tiers = [60, 75, 90, 100, 120, 144, 165, 180, 240, 280, 360, 480, 540];
          let bestTier = 60;
          let bestDiff = 999;
          for (const t of tiers) {
            const diff = Math.abs(t - currentHz);
            if (diff < bestDiff) {
              bestDiff = diff;
              bestTier = t;
            }
          }
          if (bestDiff > 6) bestTier = Math.round(currentHz);

          setMeasuredHz(currentHz);
          setNominalHz(bestTier);
          setFrameTimeMs(Math.round(avgDelta * 100) / 100);
          setJitterMs(jitter);

          if (delta > avgDelta * 1.55) {
            localStutters++;
            setStutterCount(localStutters);
          }
        }
      }

      // Draw Motion Lanes on Canvas
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        const displayW = Math.floor(rect.width);
        const displayH = Math.floor(rect.height);

        if (canvas.width !== displayW * dpr || canvas.height !== displayH * dpr) {
          canvas.width = displayW * dpr;
          canvas.height = displayH * dpr;
        }

        ctx.save();
        ctx.scale(dpr, dpr);

        const curNominal = nominalHzRef.current || 60;
        const curSpeed = speedRef.current;
        const curPattern = testPatternRef.current;

        // Determine lanes based on hardware refresh rate
        const lanes =
          curNominal >= 100
            ? [
              {
                id: 'native',
                fps: curNominal,
                title: `${curNominal} FPS / ${curNominal} Hz (${lang === 'en' ? 'Native Monitor Rate' : 'Tần số gốc màn hình'})`,
                sub: lang === 'en' ? 'Native Hardware V-Sync - Silky smooth & crisp' : 'Native Hardware V-Sync - Siêu mượt, sắc nét',
                badgeBg: 'rgba(255, 255, 255, 0.12)',
                badgeBorder: 'rgba(255, 255, 255, 0.35)',
                accent: '#F4F4F4',
                textMsg: lang === 'en' ? `⚡ ${curNominal}Hz NATIVE: CRISP TEXT • SILKY SMOOTH NO GHOSTING` : `⚡ ${curNominal}Hz NATIVE: CHỮ NÉT CĂNG • LƯỚT MƯỢT TUYỆT ĐỐI KHÔNG BÓNG MA`
              },
              {
                id: '60fps',
                fps: 60,
                title: `60 FPS / 60 Hz (${lang === 'en' ? 'Standard 60Hz Rate' : 'Chuẩn màn hình phổ thông'})`,
                sub: lang === 'en' ? 'Visible stutter & text blur when tracking' : 'Bắt đầu xuất hiện giật khựng và nhòe chữ khi mắt đuổi theo',
                badgeBg: 'rgba(255, 255, 255, 0.06)',
                badgeBorder: 'rgba(255, 255, 255, 0.18)',
                accent: '#cccccc',
                textMsg: lang === 'en' ? '⚠️ 60 FPS: VISIBLE JITTER & MOTION BLUR WHEN TRACKING' : '⚠️ 60 FPS: BẮT ĐẦU MỜ & GIẬT KHỰNG RỜI RẠC KHI MẮT ĐUỔI THEO'
              },
              {
                id: '30fps',
                fps: 30,
                title: `30 FPS / 30 Hz (${lang === 'en' ? 'Low 30Hz Rate' : 'Tần số thấp Console/Video'})`,
                sub: lang === 'en' ? 'Severe stutter, tearing & unreadable text' : 'Rất giật cục, xé hình, chữ bị nhòe không đọc được',
                badgeBg: 'rgba(255, 255, 255, 0.03)',
                badgeBorder: 'rgba(255, 255, 255, 0.1)',
                accent: '#999999',
                textMsg: lang === 'en' ? '🛑 30 FPS: SEVERE STUTTER • TEARING & UNREADABLE TEXT' : '🛑 30 FPS: RẤT GIẬT CỤC • XÉ HÌNH VÀ KHÔNG THỂ ĐỌC ĐƯỢC CHỮ'
              }
            ]
            : [
              {
                id: 'native',
                fps: curNominal,
                title: `${curNominal} FPS / ${curNominal} Hz (${lang === 'en' ? 'Native Monitor Rate' : 'Tần số gốc màn hình'})`,
                sub: 'Native Hardware V-Sync',
                badgeBg: 'rgba(255, 255, 255, 0.12)',
                badgeBorder: 'rgba(255, 255, 255, 0.35)',
                accent: '#F4F4F4',
                textMsg: lang === 'en' ? `⚡ ${curNominal}Hz NATIVE: CRISP TEXT • SMOOTHEST REFRESH RATE` : `⚡ ${curNominal}Hz NATIVE: CHỮ NÉT CĂNG • LƯỚT MƯỢT NHẤT CỦA MÀN HÌNH`
              },
              {
                id: 'half',
                fps: Math.round(curNominal / 2),
                title: `${Math.round(curNominal / 2)} FPS (${lang === 'en' ? 'Simulated 1/2 Rate' : 'Mô phỏng 1/2 Tần số'})`,
                sub: lang === 'en' ? 'Double stepping, noticeable blur' : 'Nhảy bước gấp đôi, bắt đầu mờ nhòe',
                badgeBg: 'rgba(255, 255, 255, 0.06)',
                badgeBorder: 'rgba(255, 255, 255, 0.18)',
                accent: '#cccccc',
                textMsg: lang === 'en' ? `⚠️ ${Math.round(curNominal / 2)} FPS: NOTICEABLE STUTTER VS ${curNominal}Hz` : `⚠️ ${Math.round(curNominal / 2)} FPS: BẮT ĐẦU GIẬT RÕ RỆT SO VỚI ${curNominal}Hz`
              },
              {
                id: 'quarter',
                fps: Math.round(curNominal / 4),
                title: `${Math.round(curNominal / 4)} FPS (${lang === 'en' ? 'Simulated 1/4 Rate' : 'Mô phỏng 1/4 Tần số'})`,
                sub: lang === 'en' ? 'Severe stutter & judder' : 'Rất giật cục, xé hình',
                badgeBg: 'rgba(255, 255, 255, 0.03)',
                badgeBorder: 'rgba(255, 255, 255, 0.1)',
                accent: '#999999',
                textMsg: lang === 'en' ? `🛑 ${Math.round(curNominal / 4)} FPS: HEAVY JUDDER • UNREADABLE TEXT` : `🛑 ${Math.round(curNominal / 4)} FPS: RẤT GIẬT CỤC • KHÔNG THỂ ĐỌC ĐƯỢC CHỮ`
              }
            ];

        const laneH = displayH / lanes.length;

        // Clear canvas
        ctx.fillStyle = '#030303';
        ctx.fillRect(0, 0, displayW, displayH);

        // Draw vertical background grid ticks (every 100px)
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
        ctx.lineWidth = 1;
        for (let gx = 0; gx < displayW; gx += 100) {
          ctx.beginPath();
          ctx.moveTo(gx, 0);
          ctx.lineTo(gx, displayH);
          ctx.stroke();
        }

        // Loop period width (so it wraps smoothly across screen)
        const loopWidth = Math.max(displayW + 600, 1400);

        lanes.forEach((lane, idx) => {
          const laneY = idx * laneH;

          // Lane background alternating subtle tint
          if (idx % 2 === 1) {
            ctx.fillStyle = 'rgba(255, 255, 255, 0.015)';
            ctx.fillRect(0, laneY, displayW, laneH);
          }

          // Lane separator line
          if (idx > 0) {
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, laneY);
            ctx.lineTo(displayW, laneY);
            ctx.stroke();
          }

          // Lane Header Badge
          ctx.save();
          ctx.fillStyle = lane.badgeBg;
          ctx.strokeStyle = lane.badgeBorder;
          ctx.lineWidth = 1;
          const badgeX = 14;
          const badgeY = laneY + 10;
          const badgeW = 260;
          const badgeH = 22;
          ctx.beginPath();
          ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 6);
          ctx.fill();
          ctx.stroke();

          ctx.font = 'bold 11px monospace';
          ctx.fillStyle = lane.accent;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(lane.title, badgeX + 10, badgeY + badgeH / 2);
          ctx.restore();

          // Calculate precise quantized position for this lane's FPS
          // Lane 1 uses exact hardware time. Lane 2 & 3 quantize time steps to target FPS.
          let posX: number;
          if (lane.id === 'native') {
            posX = (curSpeed * (now / 1000)) % loopWidth;
          } else {
            const frameInterval = 1000 / lane.fps;
            const quantizedTime = Math.floor(now / frameInterval) * frameInterval;
            posX = (curSpeed * (quantizedTime / 1000)) % loopWidth;
          }

          // Offsets: position craft and moving text horizontally
          const craftX = posX - 120;
          const craftY = laneY + (laneH / 2) - 18;

          // Draw UFO or Grating Craft (with wraparound duplicate to prevent edge popping)
          const drawObjectsAt = (drawX: number) => {
            if (curPattern === 'grating') {
              // High-contrast grating bars (reveals ghosting and pixel response time)
              const barW = 8;
              const barCount = 14;
              ctx.save();
              ctx.fillStyle = '#030303';
              ctx.fillRect(drawX, craftY - 2, barCount * barW, 40);
              for (let b = 0; b < barCount; b++) {
                ctx.fillStyle = b % 2 === 0 ? lane.accent : '#000000';
                ctx.fillRect(drawX + b * barW, craftY - 2, barW, 40);
              }
              ctx.strokeStyle = lane.accent;
              ctx.lineWidth = 1.5;
              ctx.strokeRect(drawX, craftY - 2, barCount * barW, 40);
              ctx.restore();
            } else {
              // Vector UFO Craft
              ctx.save();
              ctx.translate(drawX, craftY);

              // 1. Thruster jet glow extending left
              const flameGrad = ctx.createLinearGradient(-40, 18, 0, 18);
              flameGrad.addColorStop(0, 'rgba(0,0,0,0)');
              flameGrad.addColorStop(0.7, lane.accent + '55');
              flameGrad.addColorStop(1, '#ffffff');
              ctx.fillStyle = flameGrad;
              ctx.beginPath();
              ctx.moveTo(0, 12);
              ctx.lineTo(-35, 18);
              ctx.lineTo(0, 24);
              ctx.closePath();
              ctx.fill();

              // 2. Saucer Main Metallic Body
              ctx.beginPath();
              ctx.ellipse(36, 18, 38, 12, 0, 0, Math.PI * 2);
              const bodyGrad = ctx.createLinearGradient(0, 6, 0, 30);
              bodyGrad.addColorStop(0, '#52525b');
              bodyGrad.addColorStop(0.5, '#27272a');
              bodyGrad.addColorStop(1, '#030303');
              ctx.fillStyle = bodyGrad;
              ctx.fill();
              ctx.lineWidth = 1.5;
              ctx.strokeStyle = lane.accent;
              ctx.stroke();

              // 3. Vertical grating teeth at bottom (instant ghosting indicator)
              for (let t = 0; t < 7; t++) {
                ctx.fillStyle = t % 2 === 0 ? lane.accent : '#000000';
                ctx.fillRect(16 + t * 6, 23, 4, 6);
              }

              // 4. Glass Canopy Dome
              ctx.beginPath();
              ctx.ellipse(36, 12, 18, 11, 0, Math.PI, 0);
              const domeGrad = ctx.createLinearGradient(0, 2, 0, 14);
              domeGrad.addColorStop(0, lane.accent);
              domeGrad.addColorStop(1, 'rgba(25, 25, 25, 0.85)');
              ctx.fillStyle = domeGrad;
              ctx.fill();
              ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
              ctx.lineWidth = 1;
              ctx.stroke();

              // 5. Alien Pilot Silhouette
              ctx.fillStyle = '#030303';
              ctx.beginPath();
              ctx.ellipse(36, 11, 5, 6, 0, 0, Math.PI * 2);
              ctx.fill();
              ctx.fillStyle = '#ffffff';
              ctx.beginPath();
              ctx.arc(34, 10, 1.2, 0, Math.PI * 2);
              ctx.arc(38, 10, 1.2, 0, Math.PI * 2);
              ctx.fill();

              // 6. Saucer Beacon Lights (3 glowing points)
              [14, 36, 58].forEach((bx, bIdx) => {
                ctx.beginPath();
                ctx.arc(bx, 18, 2.5, 0, Math.PI * 2);
                ctx.fillStyle = bIdx === 1 ? lane.accent : '#ffffff';
                ctx.shadowColor = lane.accent;
                ctx.shadowBlur = 6;
                ctx.fill();
                ctx.shadowBlur = 0;
              });

              // 7. Mini FPS Stamp on Saucer
              ctx.font = 'bold 9px monospace';
              ctx.fillStyle = '#ffffff';
              ctx.textAlign = 'center';
              ctx.fillText(`${lane.fps}Hz`, 36, 28);

              ctx.restore();
            }

            // Draw Moving Text (Readability benchmark!)
            const textX = drawX + 90;
            const textY = craftY + 18;
            ctx.save();
            ctx.font = 'bold 12px "Inter", "Segoe UI", system-ui, sans-serif';
            ctx.fillStyle = lane.accent;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
            ctx.shadowBlur = 4;
            ctx.fillText(lane.textMsg, textX, textY);
            ctx.restore();
          };

          // Render primary and wraparound duplicate to ensure continuous flow
          drawObjectsAt(craftX);
          if (craftX > loopWidth - 1100) {
            drawObjectsAt(craftX - loopWidth);
          }
          if (craftX < 1100) {
            drawObjectsAt(craftX + loopWidth);
          }
        });

        ctx.restore();
      }

      // Draw Real-time Frame-Time Oscilloscope mini graph
      const oscCanvas = oscCanvasRef.current;
      if (oscCanvas) {
        const oscCtx = oscCanvas.getContext('2d');
        if (oscCtx) {
          const oscDpr = window.devicePixelRatio || 1;
          const oscRect = oscCanvas.getBoundingClientRect();
          const oscW = Math.floor(oscRect.width);
          const oscH = Math.floor(oscRect.height);

          if (oscCanvas.width !== oscW * oscDpr || oscCanvas.height !== oscH * oscDpr) {
            oscCanvas.width = oscW * oscDpr;
            oscCanvas.height = oscH * oscDpr;
          }

          oscCtx.save();
          oscCtx.scale(oscDpr, oscDpr);

          oscCtx.fillStyle = '#030303';
          oscCtx.fillRect(0, 0, oscW, oscH);

          // Grid lines at 5ms, 10ms, 16.6ms, 33.3ms
          const deltas = frameDeltasRef.current;
          const maxMs = 35; // 0 to 35ms range
          const curNominal = nominalHzRef.current || 60;
          const targetMs = 1000 / curNominal;
          const targetY = oscH - (targetMs / maxMs) * oscH;

          // Ideal target line
          oscCtx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
          oscCtx.lineWidth = 1;
          oscCtx.setLineDash([3, 3]);
          oscCtx.beginPath();
          oscCtx.moveTo(0, targetY);
          oscCtx.lineTo(oscW, targetY);
          oscCtx.stroke();
          oscCtx.setLineDash([]);

          // Plot waveform
          if (deltas.length > 2) {
            oscCtx.strokeStyle = '#F4F4F4';
            oscCtx.lineWidth = 1.5;
            oscCtx.beginPath();
            const step = oscW / (deltas.length - 1);
            deltas.forEach((d, i) => {
              const clamped = Math.min(d, maxMs);
              const y = oscH - (clamped / maxMs) * oscH;
              if (i === 0) oscCtx.moveTo(0, y);
              else oscCtx.lineTo(i * step, y);
            });
            oscCtx.stroke();
          }

          // Target MS label
          oscCtx.font = '9px monospace';
          oscCtx.fillStyle = '#a1a1aa';
          oscCtx.textAlign = 'right';
          oscCtx.fillText(`${t.targetMsLabel} ${targetMs.toFixed(1)}ms`, oscW - 6, Math.max(targetY - 4, 10));

          oscCtx.restore();
        }
      }

      rafRef.current = requestAnimationFrame(renderLoop);
    };

    rafRef.current = requestAnimationFrame(renderLoop);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const saveReport = () => {
    onAddRecord({
      moduleId: 'display',
      moduleName: 'Display Lab',
      testName: 'Screen Refresh Rate (V-Sync Hardware Test)',
      device: `${window.screen.width}×${window.screen.height} @ ${nominalHz}Hz`,
      method: 'REALTIME',
      status: Math.abs(measuredHz - nominalHz) < 2.5 ? 'PASS' : 'WARNING',
      metrics: {
        nominalHz: `${nominalHz} Hz`,
        measuredHz: `${measuredHz} Hz`,
        frameTimeMs: `${frameTimeMs} ms`,
        jitterMs: `±${jitterMs} ms`,
        stutterEvents: stutterCount,
        vSyncLock: Math.abs(measuredHz - nominalHz) < 1.5 ? 'LOCKED' : 'VARIABLE'
      },
      notes: lang === 'en' ? 'Measured display refresh rate via hardware-accelerated V-Sync RAF loop.' : 'Đo lường tần số quét thực tế của màn hình thông qua vòng lặp V-Sync Canvas Hardware Acceleration.'
    });
  };

  return (
    <GlassCard
      title={t.cardHzTitle}
      icon={<Gauge className="w-5 h-5 text-white" />}
      badge="REALTIME"
      rightSlot={
        <div className="flex items-center gap-2">
          <button
            onClick={() => setActive((v) => !v)}
            title={active ? (lang === 'en' ? 'Pause' : 'Tạm dừng') : (lang === 'en' ? 'Resume' : 'Tiếp tục')}
            className={`p-2 rounded-lg text-xs font-semibold cursor-pointer transition ${active
              ? 'bg-white/[0.12] text-[#F4F4F4] border border-white/20 hover:bg-white/[0.18]'
              : 'bg-white/[0.04] text-zinc-400 hover:text-white border border-white/10'
              }`}
          >
            {active ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 fill-current" />}
          </button>
          <button
            onClick={toggleFullscreen}
            title={isFullscreen ? (lang === 'en' ? 'Minimize' : 'Thu nhỏ') : (lang === 'en' ? 'Fullscreen' : 'Toàn màn hình')}
            className="p-2 rounded-lg bg-white/10 hover:bg-white/20 border border-white/20 text-[#F4F4F4] text-xs font-semibold cursor-pointer transition"
          >
            {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        {/* Metric Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-xs">
          <div className="p-3.5 rounded-xl liquid-glass-sub">
            <div className="text-zinc-400 text-[11px]">{t.measuredHzLabel}</div>
            <div className="text-2xl font-bold font-mono text-[#F4F4F4] mt-1 flex items-baseline gap-1">
              <span>{measuredHz}</span>
              <span className="text-xs font-normal text-zinc-400">Hz</span>
            </div>
            <div className="text-[10px] text-zinc-400 mt-0.5">{t.vsyncStatus}</div>
          </div>

          <div className="p-3.5 rounded-xl liquid-glass-sub">
            <div className="text-zinc-400 text-[11px]">{t.targetHzLabel}</div>
            <div className="text-xl font-bold font-mono text-[#F4F4F4] mt-1">{nominalHz} Hz</div>
            <div className="text-[10px] text-zinc-400 mt-0.5">
              {nominalHz >= 240
                ? 'Ultra Gaming 240Hz+'
                : nominalHz >= 144
                  ? 'Pro Gaming 144Hz+'
                  : nominalHz >= 100
                    ? 'High Refresh 100Hz+'
                    : 'Standard 60Hz'}
            </div>
          </div>

          <div className="p-3.5 rounded-xl liquid-glass-sub">
            <div className="text-zinc-400 text-[11px]">{t.frameTimeLabel}</div>
            <div className="text-xl font-bold font-mono text-[#F4F4F4] mt-1">
              {frameTimeMs} <span className="text-xs font-normal text-zinc-400">ms</span>
            </div>
            <div className="text-[10px] text-zinc-500 mt-0.5">
              {t.targetLabel} {(1000 / nominalHz).toFixed(2)} ms
            </div>
          </div>

          <div className="p-3.5 rounded-xl liquid-glass-sub">
            <div className="text-zinc-400 text-[11px]">{t.jitterLabel}</div>
            <div className="text-xl font-bold font-mono text-[#F4F4F4] mt-1">
              ±{jitterMs} <span className="text-xs font-normal text-zinc-400">ms</span>
            </div>
            <div className="text-[10px] text-zinc-500 mt-0.5">
              {jitterMs < 0.5 ? t.vsyncLocked : t.minorVariance}
            </div>
          </div>

          <div className="p-3.5 rounded-xl liquid-glass-sub">
            <div className="text-zinc-400 text-[11px]">{t.stutterEvents}</div>
            <div
              className={`text-xl font-bold font-mono mt-1 ${stutterCount > 0 ? 'text-zinc-400' : 'text-[#F4F4F4]'
                }`}
            >
              {stutterCount}
            </div>
            <div className="text-[10px] text-zinc-500 mt-0.5">{t.frameDelayNotice}</div>
          </div>
        </div>

        {/* Real-time Oscilloscope Mini Card */}
        <div className="p-3 rounded-xl liquid-glass-sub flex flex-col sm:flex-row items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2 text-zinc-300">
            <Activity className="w-4 h-4 text-[#F4F4F4] shrink-0" />
            <span className="font-semibold text-xs text-[#F4F4F4]">{t.oscilloscopeTitle}</span>
            
          </div>
          <div className="w-full sm:w-64 h-11 bg-[#030303] rounded-lg overflow-hidden border border-white/10 shrink-0">
            <canvas ref={oscCanvasRef} className="w-full h-full block" />
          </div>
        </div>

        {/* Visual Motion Arena (Hardware Accelerated Canvas Container) */}
        <div
          ref={containerRef}
          className={`relative rounded-2xl bg-[#030303] border border-white/15 liquid-glass overflow-hidden flex flex-col ${isFullscreen ? 'fixed inset-0 z-50 rounded-none border-none' : 'p-3'
            }`}
        >
          {/* Arena Top Toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-3 text-xs pb-3 border-b border-white/10 px-1">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-[#F4F4F4]" />
              <span className="font-semibold text-[#F4F4F4]">
                {t.arenaTitle}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {/* Pattern Selector */}
              <div className="flex items-center rounded-lg bg-[#141414] p-0.5 border border-white/10">
                <button
                  onClick={() => setTestPattern('ufo')}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium cursor-pointer transition ${testPattern === 'ufo'
                    ? 'bg-white/20 text-[#F4F4F4] border border-white/30'
                    : 'text-zinc-400 hover:text-[#F4F4F4]'
                    }`}
                >
                  {t.ufoTest}
                </button>
                <button
                  onClick={() => setTestPattern('grating')}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium cursor-pointer transition ${testPattern === 'grating'
                    ? 'bg-white/20 text-[#F4F4F4] border border-white/30'
                    : 'text-zinc-400 hover:text-[#F4F4F4]'
                    }`}
                >
                  {t.gratingTest}
                </button>
              </div>

              {/* Speed Buttons */}
              <div className="flex items-center gap-1">
                <span className="text-zinc-400 text-[11px]">{t.speedLabel}</span>
                {[
                  { s: 480, label: '480 px/s' },
                  { s: 960, label: '960 px/s' },
                  { s: 1440, label: '1440 px/s' },
                  { s: 1920, label: '1920 px/s' }
                ].map(({ s, label }) => (
                  <button
                    key={s}
                    onClick={() => setSpeed(s)}
                    className={`px-2 py-1 rounded text-[11px] font-mono cursor-pointer transition ${speed === s
                      ? 'bg-white/25 text-[#F4F4F4] border border-white/40 font-bold'
                      : 'bg-white/[0.04] text-zinc-400 hover:bg-white/[0.08]'
                      }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {isFullscreen && (
                <button
                  onClick={toggleFullscreen}
                  className="px-2.5 py-1 rounded bg-white/[0.1] hover:bg-white/20 border border-white/20 text-[#F4F4F4] text-[11px] font-medium cursor-pointer"
                >
                  {t.exitFs}
                </button>
              )}
            </div>
          </div>

          {/* Canvas Viewport */}
          <div className="relative w-full flex-1 my-2 rounded-xl overflow-hidden bg-[#030303] border border-white/10">
            <canvas
              ref={canvasRef}
              className="w-full block"
              style={{ height: isFullscreen ? 'calc(100vh - 120px)' : '320px' }}
            />
          </div>
        </div>
      </div>
    </GlassCard>
  );
};

const DisplayLabModule: React.FC<{
  sysInfo: SystemEnvironmentInfo;
  onAddRecord: (rec: Omit<DiagnosticRecord, 'id' | 'timestamp'>) => Promise<void>;
  lang?: Lang;
}> = ({ sysInfo, onAddRecord, lang = 'en' }) => {
  const t = translations[lang].display;
  const [inspectOpen, setInspectOpen] = useState(false);
  const [patternIdx, setPatternIdx] = useState(0);
  const [markMode, setMarkMode] = useState(false);
  const [markedPixels, setMarkedPixels] = useState<{ x: number; y: number; pattern: string }[]>([]);
  const overlayRef = useRef<HTMLDivElement | null>(null);

  const startInspection = async (index = 0) => {
    setPatternIdx(index);
    setInspectOpen(true);
    setTimeout(() => {
      if (overlayRef.current && overlayRef.current.requestFullscreen) {
        overlayRef.current.requestFullscreen().catch(() => { });
      }
    }, 50);
  };

  const exitInspection = useCallback(() => {
    setInspectOpen(false);
    if (document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(() => { });
    }
  }, []);

  useEffect(() => {
    if (!inspectOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') exitInspection();
      else if (e.key === 'ArrowRight' || e.key === ' ') {
        setPatternIdx((i) => (i + 1) % DISPLAY_PATTERNS.length);
      } else if (e.key === 'ArrowLeft') {
        setPatternIdx((i) => (i - 1 + DISPLAY_PATTERNS.length) % DISPLAY_PATTERNS.length);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [inspectOpen, exitInspection]);

  const currentPattern = DISPLAY_PATTERNS[patternIdx];

  return (
    <div className="space-y-6">
      {/* Screen Refresh Rate (Hz) Realtime Benchmark */}
      <ScreenRefreshRateTester onAddRecord={onAddRecord} lang={lang} />

      <GlassCard
        title={t.cardMetricsTitle}
        icon={<Monitor className="w-5 h-5" />}
        badge="REALTIME"
      >
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <div className="p-3 rounded-xl liquid-glass-sub border border-white/5">
            <div className="text-zinc-400">{t.screenResLabel}</div>
            <div className="text-base font-bold font-mono text-white mt-0.5">
              {sysInfo.screenWidth} × {sysInfo.screenHeight}
            </div>
          </div>
          <div className="p-3 rounded-xl liquid-glass-sub">
            <div className="text-zinc-400">{t.viewportLabel}</div>
            <div className="text-base font-bold font-mono text-[#F4F4F4] mt-0.5">
              {sysInfo.viewportWidth} × {sysInfo.viewportHeight}
            </div>
          </div>
          <div className="p-3 rounded-xl liquid-glass-sub">
            <div className="text-zinc-400">{t.dprLabel}</div>
            <div className="text-base font-bold font-mono text-[#F4F4F4] mt-0.5">
              {sysInfo.pixelRatio}x ({sysInfo.colorDepth}-bit)
            </div>
          </div>
          <div className="p-3 rounded-xl liquid-glass-sub">
            <div className="text-zinc-400">{t.markedDefectsLabel}</div>
            <div className="text-base font-bold font-mono text-zinc-300 mt-0.5">
              {markedPixels.length} {t.defectsCount}
            </div>
          </div>
        </div>
      </GlassCard>

      <GlassCard
        title={t.cardDeadPixelTitle}
        icon={<Eye className="w-5 h-5" />}
        badge="REALTIME"
      >
        <div className="space-y-4 text-xs">
          <p className="text-zinc-300 leading-relaxed">{t.deadPixelNotice}</p>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
            {DISPLAY_PATTERNS.map((pat, idx) => {
              const patName = lang === 'en' ? pat.name : pat.nameVi;
              const patDesc = lang === 'en' ? pat.desc : pat.descVi;
              return (
                <button
                  key={pat.id}
                  onClick={() => startInspection(idx)}
                  className="p-3.5 rounded-2xl liquid-glass-sub hover:bg-white/[0.08] border border-white/10 hover:border-white/20 flex flex-col justify-between gap-3 transition-all duration-200 cursor-pointer text-left group shadow-[0_4px_16px_rgba(0,0,0,0.4)]"
                >
                  <div className="flex items-center gap-3">
                    <span
                      className="w-10 h-10 rounded-xl border border-white/25 shrink-0 shadow-[0_2px_10px_rgba(0,0,0,0.6),inset_0_1px_1px_rgba(255,255,255,0.4)] transition-all duration-200 group-hover:scale-105 group-hover:border-white/50"
                      style={{ background: pat.bg }}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-[#F4F4F4] text-xs group-hover:text-white flex items-center justify-between">
                        <span className="truncate">{patName}</span>
                        <span className="text-[10px] font-mono text-zinc-500 uppercase shrink-0 ml-1">{pat.id}</span>
                      </div>
                      <div className="text-[10px] text-zinc-400 font-mono mt-0.5">
                        {lang === 'en' ? `Pattern #${idx + 1}` : `Mẫu #${idx + 1}`}
                      </div>
                    </div>
                  </div>
                  <div className="text-[11px] text-zinc-400 leading-relaxed group-hover:text-zinc-300">
                    {patDesc}
                  </div>
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
            <div className="flex items-center gap-2">
              <button
                onClick={() => startInspection(0)}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-2xl bg-white hover:bg-zinc-200 text-zinc-950 font-bold text-xs shadow-[0_4px_20px_rgba(255,255,255,0.2)] transition cursor-pointer"
              >
                <Maximize2 className="w-4 h-4" />
                {t.btnStartInspection}
              </button>
              {markedPixels.length > 0 && (
                <button
                  onClick={() => setMarkedPixels([])}
                  className="px-3 py-2 rounded-xl bg-white/[0.06] text-zinc-300 hover:bg-white/[0.12] cursor-pointer"
                >
                  {t.btnClearMarks} ({markedPixels.length})
                </button>
              )}
            </div>
          </div>
        </div>
      </GlassCard>

      {/* Fullscreen Display Test Overlay */}
      {inspectOpen && (
        <div
          ref={overlayRef}
          onClick={(e) => {
            if (!markMode) return;
            setMarkedPixels((prev) => [
              ...prev,
              { x: e.clientX, y: e.clientY, pattern: currentPattern.name }
            ]);
          }}
          className={`fixed inset-0 z-50 select-none ${markMode ? 'cursor-crosshair' : 'cursor-default'
            }`}
          style={{ background: currentPattern.bg }}
        >
          {/* Marked pixel pins */}
          {markedPixels.map((mp, idx) => (
            <div
              key={idx}
              style={{ left: mp.x - 8, top: mp.y - 8 }}
              className="fixed w-4 h-4 rounded-full border border-white bg-white/40 pointer-events-none shadow-[0_0_8px_rgba(255,255,255,0.8)]"
              title={`${mp.x}, ${mp.y} (${mp.pattern})`}
            />
          ))}

          {/* Floating Control Bar */}
          <div
            onClick={(e) => e.stopPropagation()}
            className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-[#141414]/90 backdrop-blur-2xl border border-white/20 rounded-2xl px-4 py-3 shadow-2xl flex flex-wrap items-center gap-3 text-xs text-[#F4F4F4]"
          >
            <div className="flex items-center gap-2 mr-2">
              <span
                className="w-4 h-4 rounded-full border border-white/40 shadow-sm shrink-0"
                style={{ background: currentPattern.bg }}
              />
              <span className="font-semibold text-[#F4F4F4]">
                {lang === 'en' ? currentPattern.name : currentPattern.nameVi}
              </span>
            </div>
            <button
              onClick={() =>
                setPatternIdx((i) => (i - 1 + DISPLAY_PATTERNS.length) % DISPLAY_PATTERNS.length)
              }
              className="px-3 py-1.5 rounded-lg bg-white/[0.08] hover:bg-white/[0.15] border border-white/10 text-[#F4F4F4] font-medium cursor-pointer transition"
            >
              {lang === 'en' ? '◀ Previous Color' : '◀ Màu Trước'}
            </button>
            <button
              onClick={() => setPatternIdx((i) => (i + 1) % DISPLAY_PATTERNS.length)}
              className="px-3 py-1.5 rounded-lg bg-white/[0.08] hover:bg-white/[0.15] border border-white/10 text-[#F4F4F4] font-medium cursor-pointer transition"
            >
              {lang === 'en' ? 'Next Color ▶' : 'Màu Kế ▶'}
            </button>
            <button
              onClick={() => setMarkMode((m) => !m)}
              className={`px-3 py-1.5 rounded-lg border cursor-pointer transition ${markMode
                ? 'bg-[#F4F4F4] text-[#030303] border-white font-medium shadow-[0_0_15px_rgba(255,255,255,0.3)]'
                : 'bg-white/[0.08] text-zinc-300 border-white/10 hover:bg-white/[0.14]'
                }`}
            >
              {markMode ? (lang === 'en' ? 'Click to Mark Defect' : 'Click để Đánh dấu lỗi') : (lang === 'en' ? 'Enable Mark Mode' : 'Bật Đánh dấu Điểm lỗi')}
            </button>
            <button
              onClick={exitInspection}
              className="px-3 py-1.5 rounded-lg bg-white/[0.12] hover:bg-white/20 border border-white/20 text-[#F4F4F4] font-medium cursor-pointer transition"
            >
              {t.exitFullscreen} (Esc)
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// 13. MODULE: WEBCAM & MICROPHONE LAB (CAMERA LAB)
// ============================================================================

const CameraLabModule: React.FC<{
  devices: ConnectedDevicesSummary;
  onRefreshDevices: () => Promise<void>;
  onAddRecord: (rec: Omit<DiagnosticRecord, 'id' | 'timestamp'>) => Promise<void>;
  lang?: Lang;
}> = ({ devices, onRefreshDevices, onAddRecord, lang = 'en' }) => {
  const t = translations[lang].camera;
  const [selectedCamId, setSelectedCamId] = useState<string>('default');
  const [camActive, setCamActive] = useState(false);
  const [camError, setCamError] = useState<string | null>(null);
  const [camStats, setCamStats] = useState<{
    width: number;
    height: number;
    measuredFps: number;
    label: string;
  } | null>(null);
  const [snapshotUrl, setSnapshotUrl] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fpsTimerRef = useRef<number | null>(null);

  const stopCamera = useCallback(() => {
    if (fpsTimerRef.current) {
      cancelAnimationFrame(fpsTimerRef.current);
      fpsTimerRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setCamActive(false);
  }, []);

  const startCamera = async () => {
    stopCamera();
    setCamError(null);

    try {
      const constraints: MediaStreamConstraints = {
        video:
          selectedCamId && selectedCamId !== 'default'
            ? { deviceId: { exact: selectedCamId }, width: { ideal: 1280 }, height: { ideal: 720 } }
            : { width: { ideal: 1280 }, height: { ideal: 720 } }
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;
      await onRefreshDevices();

      const track = stream.getVideoTracks()[0];
      const settings = track.getSettings();

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      setCamActive(true);
      setCamStats({
        width: settings.width || 640,
        height: settings.height || 480,
        measuredFps: Math.round(settings.frameRate || 30),
        label: track.label || 'USB / Integrated Webcam'
      });

      await onAddRecord({
        moduleId: 'camera',
        moduleName: 'Webcam Lab',
        testName: 'Webcam Stream & Resolution Verification',
        device: track.label || 'Webcam',
        method: 'REALTIME',
        status: 'PASS',
        metrics: {
          width: settings.width || 0,
          height: settings.height || 0,
          reportedFps: Math.round(settings.frameRate || 30)
        },
        notes: lang === 'en' ? 'Video stream initialized and tracks freed on close.' : 'Khởi tạo luồng video thành công và giải phóng track khi đóng.'
      });
    } catch (err) {
      setCamError(lang === 'en' ? `Unable to start Camera: ${String(err)}` : `Không thể bật Camera: ${String(err)}`);
      await onAddRecord({
        moduleId: 'camera',
        moduleName: 'Webcam Lab',
        testName: 'Webcam Stream Test',
        device: 'Webcam',
        method: 'REALTIME',
        status: 'FAIL',
        metrics: {},
        notes: lang === 'en' ? 'Camera access denied or no camera device found.' : 'Quyền truy cập Camera bị từ chối hoặc không có thiết bị.',
        error: String(err)
      });
    }
  };

  const captureSnapshot = () => {
    const v = videoRef.current;
    if (!v || !camActive) return;
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth || 640;
    canvas.height = v.videoHeight || 480;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    setSnapshotUrl(canvas.toDataURL('image/png'));
  };

  useEffect(() => {
    return () => {
      stopCamera();
    };
  }, [stopCamera]);

  return (
    <div className="space-y-6">
      <GlassCard
        title={t.cardTitle}
        icon={<Camera className="w-5 h-5" />}
        badge="REALTIME"
      >
        <div className="space-y-4 text-xs">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[240px]">
              <label className="block text-zinc-400 mb-1">{t.selectCameraLabel}</label>
              <select
                value={selectedCamId}
                onChange={(e) => setSelectedCamId(e.target.value)}
                disabled={camActive}
                className="w-full rounded-xl bg-[#030303] border border-white/10 px-3 py-2 text-[#F4F4F4]"
              >
                <option value="default">{t.defaultCam}</option>
                {devices.videoInputs.map((d, idx) => (
                  <option key={d.deviceId || idx} value={d.deviceId}>
                    {d.label || `Camera #${idx + 1}`}
                  </option>
                ))}
              </select>
            </div>

            {!camActive ? (
              <button
                onClick={startCamera}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-2xl bg-white hover:bg-zinc-200 text-zinc-950 font-bold text-xs shadow-[0_4px_20px_rgba(255,255,255,0.2)] transition cursor-pointer"
              >
                <Camera className="w-4 h-4" />
                {t.btnStartCamera}
              </button>
            ) : (
              <>
                <button
                  onClick={stopCamera}
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white/[0.08] hover:bg-white/[0.14] border border-white/20 text-[#F4F4F4] font-medium transition cursor-pointer"
                >
                  <Square className="w-4 h-4" />
                  {t.btnStopCamera}
                </button>
                <button
                  onClick={captureSnapshot}
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white/10 hover:bg-white/20 border border-white/20 text-white font-semibold transition cursor-pointer"
                >
                  {t.btnSnapshot}
                </button>
              </>
            )}
          </div>

          {camError && (
            <div className="p-3 rounded-xl bg-white/[0.04] border border-white/10 text-zinc-300">
              {camError}
            </div>
          )}

          {camStats && camActive && (
            <div className="w-full max-w-4xl mx-auto grid grid-cols-3 gap-3">
              <div className="p-3 rounded-xl liquid-glass-sub">
                <div className="text-zinc-400">{lang === 'en' ? 'Device' : 'Thiết bị'}</div>
                <div className="font-medium text-zinc-100 mt-0.5 truncate">{camStats.label}</div>
              </div>
              <div className="p-3 rounded-xl liquid-glass-sub">
                <div className="text-zinc-400">{lang === 'en' ? 'Native Resolution' : 'Độ phân giải thực'}</div>
                <div className="font-bold font-mono text-[#F4F4F4] mt-0.5">
                  {camStats.width} × {camStats.height} px
                </div>
              </div>
              <div className="p-3 rounded-xl liquid-glass-sub">
                <div className="text-zinc-400">{lang === 'en' ? 'Framerate' : 'Tốc độ khung hình'}</div>
                <div className="font-bold font-mono text-[#F4F4F4] mt-0.5">
                  ~{camStats.measuredFps} FPS
                </div>
              </div>
            </div>
          )}

          <div className="w-full max-w-4xl mx-auto space-y-4">
            <div className="relative w-full aspect-video rounded-3xl overflow-hidden bg-[#030303] border border-white/15 shadow-[0_0_50px_rgba(0,0,0,0.8)] flex items-center justify-center">
              <video ref={videoRef} playsInline muted className="w-full h-full object-contain" />
              {!camActive && (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-zinc-400 text-center p-6 bg-[#030303]/80">
                  <Camera className="w-12 h-12 text-zinc-600 mb-3" />
                  <p className="text-sm text-zinc-300 font-medium">{lang === 'en' ? 'Camera is currently stopped' : 'Camera đang tắt'}</p>
                  <p className="text-xs text-zinc-500 mt-1 max-w-sm">
                    {lang === 'en' ? 'Click "Request Permission & Start Camera" to test video feed' : 'Nhấn "Yêu cầu Quyền & Bật Camera" để kiểm tra luồng video trực tiếp'}
                  </p>
                </div>
              )}
            </div>

            {snapshotUrl && (
              <div className="rounded-2xl overflow-hidden liquid-glass-sub p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-white">{lang === 'en' ? 'Captured Test Snapshot:' : 'Ảnh chụp kiểm thử:'}</span>
                  <a
                    href={snapshotUrl}
                    download={`pc-doctor-webcam-${Date.now()}.png`}
                    className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 border border-white/20 text-white text-xs font-semibold cursor-pointer transition"
                  >
                    {lang === 'en' ? 'Download Image' : 'Tải Ảnh Xuống'}
                  </a>
                </div>
                <img
                  src={snapshotUrl}
                  alt="Webcam Snapshot"
                  className="w-full max-h-96 object-contain rounded-xl bg-black"
                />
              </div>
            )}
          </div>
        </div>
      </GlassCard>
    </div>
  );
};

// ============================================================================
// 14. MODULE: GAMEPAD & PERIPHERAL LAB
// ============================================================================

const GamepadLabModule: React.FC<{
  devices: ConnectedDevicesSummary;
  onAddRecord: (rec: Omit<DiagnosticRecord, 'id' | 'timestamp'>) => Promise<void>;
  lang?: Lang;
}> = ({ devices, onAddRecord, lang = 'en' }) => {
  const t = translations[lang].gamepad;
  const [livePads, setLivePads] = useState<
    {
      index: number;
      id: string;
      axes: readonly number[];
      buttons: { pressed: boolean; value: number }[];
    }[]
  >([]);
  const [hidInfo, setHidInfo] = useState<string | null>(null);

  useEffect(() => {
    let animId = 0;
    const pollGamepads = () => {
      if (navigator.getGamepads) {
        const raw = navigator.getGamepads();
        const active: {
          index: number;
          id: string;
          axes: readonly number[];
          buttons: { pressed: boolean; value: number }[];
        }[] = [];
        for (const gp of raw) {
          if (gp && gp.connected) {
            active.push({
              index: gp.index,
              id: gp.id,
              axes: gp.axes,
              buttons: gp.buttons.map((b) => ({ pressed: b.pressed, value: b.value }))
            });
          }
        }
        setLivePads(active);
      }
      animId = requestAnimationFrame(pollGamepads);
    };
    animId = requestAnimationFrame(pollGamepads);
    return () => cancelAnimationFrame(animId);
  }, []);

  const requestHidDevice = async () => {
    const navAny = navigator as unknown as {
      hid?: { requestDevice: (opts: { filters: unknown[] }) => Promise<{ productName?: string }[]> };
    };
    if (!navAny.hid) {
      setHidInfo(lang === 'en' ? 'UNSUPPORTED: Current browser does not support WebHID API.' : 'UNSUPPORTED: Trình duyệt hiện tại không hỗ trợ WebHID API.');
      return;
    }
    try {
      const list = await navAny.hid.requestDevice({ filters: [] });
      if (list.length > 0) {
        setHidInfo(
          lang === 'en' ? `Detected HID device: ${list.map((d) => d.productName || 'HID Device').join(', ')}` : `Đã phát hiện thiết bị HID: ${list.map((d) => d.productName || 'HID Device').join(', ')}`
        );
      } else {
        setHidInfo(lang === 'en' ? 'User cancelled the WebHID device selection dialog.' : 'Người dùng đã đóng hộp thoại chọn thiết bị WebHID.');
      }
    } catch (err) {
      setHidInfo(lang === 'en' ? `WebHID restricted by permissions policy: ${String(err)}` : `WebHID bị giới hạn bởi chính sách quyền (Permissions Policy): ${String(err)}`);
    }
  };

  return (
    <div className="space-y-6">
      <GlassCard
        title={t.cardTitle}
        icon={<Gamepad2 className="w-5 h-5" />}
        badge="REALTIME"
      >
        {livePads.length === 0 ? (
          <div className="p-8 rounded-2xl liquid-glass-sub border border-dashed border-white/10 text-center space-y-2 text-xs text-zinc-400">
            <Gamepad2 className="w-8 h-8 text-zinc-500 mx-auto" />
            <div className="text-zinc-200 font-semibold">
              {t.noGamepadTitle}
            </div>
            <p>
              {t.noGamepadSubtitle}
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            {livePads.map((gp) => (
              <div
                key={gp.index}
                className="p-4 rounded-2xl liquid-glass-sub space-y-4 text-xs"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <span className="text-white font-mono font-bold">Gamepad #{gp.index}:</span>{' '}
                    <span className="text-[#F4F4F4] font-semibold">{gp.id}</span>
                  </div>
                </div>

                {/* Analog Stick Deadzone Visualizers */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {[
                    { title: 'Left Analog Stick (Axes 0, 1)', x: gp.axes[0] || 0, y: gp.axes[1] || 0 },
                    { title: 'Right Analog Stick (Axes 2, 3)', x: gp.axes[2] || 0, y: gp.axes[3] || 0 }
                  ].map((stick, sIdx) => {
                    const driftMag = Math.sqrt(stick.x * stick.x + stick.y * stick.y);
                    return (
                      <div
                        key={sIdx}
                        className="p-3 rounded-xl liquid-glass-sub flex items-center gap-4"
                      >
                        <div className="relative w-24 h-24 rounded-full bg-[#030303] border border-white/15 shrink-0 flex items-center justify-center">
                          {/* 10% inner deadzone ring */}
                          <div className="w-6 h-6 rounded-full border border-dashed border-white/30" />
                          <div
                            className="w-3.5 h-3.5 rounded-full bg-[#F4F4F4] shadow-[0_0_10px_rgba(255,255,255,0.8)] absolute"
                            style={{
                              transform: `translate(${stick.x * 38}px, ${stick.y * 38}px)`
                            }}
                          />
                        </div>
                        <div className="space-y-1">
                          <div className="font-semibold text-zinc-200">{stick.title}</div>
                          <div className="font-mono text-white">
                            X: {stick.x.toFixed(3)} • Y: {stick.y.toFixed(3)}
                          </div>
                          <div className="text-[11px] text-zinc-400">
                            {t.driftLabel} {(driftMag * 100).toFixed(1)}%
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Buttons Matrix */}
                <div className="grid grid-cols-4 sm:grid-cols-8 gap-2">
                  {gp.buttons.map((b, bIdx) => (
                    <div
                      key={bIdx}
                      className={`p-2 rounded-lg border text-center font-mono ${b.pressed
                        ? 'bg-white text-zinc-950 border-white font-bold shadow-[0_0_15px_rgba(255,255,255,0.5)]'
                        : 'bg-[#191919] text-zinc-300 border-white/5'
                        }`}
                    >
                      <div>B{bIdx}</div>
                      <div className="text-[10px] opacity-80">{Math.round(b.value * 100)}%</div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </GlassCard>

      <GlassCard
        title={t.webhidTitle}
        icon={<Usb className="w-5 h-5" />}
        badge="LIMITED"
      >
        <div className="space-y-3 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-zinc-300">
              {t.webhidDesc}
            </span>
            <button
              onClick={requestHidDevice}
              className="px-3.5 py-2 rounded-xl bg-white/10 hover:bg-white/20 border border-white/20 text-white font-medium cursor-pointer transition"
            >
              {t.btnScanWebhid}
            </button>
          </div>
          {hidInfo && (
            <div className="p-3 rounded-xl bg-[#030303] border border-white/10 text-zinc-300">
              {hidInfo}
            </div>
          )}
          <p className="text-[11px] text-zinc-400">
            {t.webhidLimitation}
          </p>
        </div>
      </GlassCard>
    </div>
  );
};

// 17. MAIN APPLICATION SHELL & NAVIGATION
// ============================================================================

const getNavItems = (tNav: typeof translations.en.nav) => [
  { id: 'dashboard' as ModuleId, label: tNav.dashboard, desc: tNav.dashboardDesc, icon: <Activity className="w-4 h-4" /> },
  { id: 'network' as ModuleId, label: tNav.network, desc: tNav.networkDesc, icon: <Wifi className="w-4 h-4" /> },
  { id: 'audio' as ModuleId, label: tNav.audio, desc: tNav.audioDesc, icon: <Volume2 className="w-4 h-4" /> },
  { id: 'keyboard' as ModuleId, label: tNav.keyboard, desc: tNav.keyboardDesc, icon: <Keyboard className="w-4 h-4" /> },
  { id: 'mouse' as ModuleId, label: tNav.mouse, desc: tNav.mouseDesc, icon: <MousePointer className="w-4 h-4" /> },
  { id: 'display' as ModuleId, label: tNav.display, desc: tNav.displayDesc, icon: <Monitor className="w-4 h-4" /> },
  { id: 'camera' as ModuleId, label: tNav.camera, desc: tNav.cameraDesc, icon: <Camera className="w-4 h-4" /> },
  { id: 'gamepad' as ModuleId, label: tNav.gamepad, desc: tNav.gamepadDesc, icon: <Gamepad2 className="w-4 h-4" /> }
];

export function App() {
  const [activeModule, setActiveModule] = useState<ModuleId>('dashboard');
  const [lang, setLang] = useState<Lang>(() => {
    const saved = localStorage.getItem('pcdoctor_lang');
    return saved === 'vi' ? 'vi' : 'en';
  });
  const [sysInfo, setSysInfo] = useState<SystemEnvironmentInfo>(() => readSystemEnvironment());
  const [devices, setDevices] = useState<ConnectedDevicesSummary>({
    audioInputs: [],
    audioOutputs: [],
    videoInputs: [],
    gamepads: [],
    permissionsGranted: { audio: false, video: false }
  });

  const t = translations[lang];

  const toggleLang = () => {
    const next: Lang = lang === 'en' ? 'vi' : 'en';
    setLang(next);
    localStorage.setItem('pcdoctor_lang', next);
  };

  // Refresh connected devices via MediaDevices & Gamepad APIs
  const refreshDevices = useCallback(async () => {
    setSysInfo(readSystemEnvironment());
    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
      try {
        const list = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = list.filter((d) => d.kind === 'audioinput');
        const audioOutputs = list.filter((d) => d.kind === 'audiooutput');
        const videoInputs = list.filter((d) => d.kind === 'videoinput');
        const hasAudioLabel = audioInputs.some((d) => Boolean(d.label));
        const hasVideoLabel = videoInputs.some((d) => Boolean(d.label));

        const gps: ConnectedDevicesSummary['gamepads'] = [];
        if (navigator.getGamepads) {
          for (const gp of navigator.getGamepads()) {
            if (gp && gp.connected) {
              gps.push({
                index: gp.index,
                id: gp.id,
                buttons: gp.buttons.length,
                axes: gp.axes.length,
                mapping: gp.mapping
              });
            }
          }
        }

        setDevices({
          audioInputs,
          audioOutputs,
          videoInputs,
          gamepads: gps,
          permissionsGranted: { audio: hasAudioLabel, video: hasVideoLabel }
        });
      } catch {
        // ignore if restricted
      }
    }
  }, []);

  // Load initial IndexedDB history and listen for device hot-plug events
  useEffect(() => {
    refreshDevices();

    const handleResize = () => setSysInfo(readSystemEnvironment());
    window.addEventListener('resize', handleResize);
    window.addEventListener('gamepadconnected', refreshDevices);
    window.addEventListener('gamepaddisconnected', refreshDevices);

    if (navigator.mediaDevices) {
      navigator.mediaDevices.addEventListener?.('devicechange', refreshDevices);
    }

    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('gamepadconnected', refreshDevices);
      window.removeEventListener('gamepaddisconnected', refreshDevices);
      if (navigator.mediaDevices) {
        navigator.mediaDevices.removeEventListener?.('devicechange', refreshDevices);
      }
    };
  }, [refreshDevices]);

  const handleAddRecord = useCallback(
    async (rec: Omit<DiagnosticRecord, 'id' | 'timestamp'>) => {
      const full: DiagnosticRecord = {
        ...rec,
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        timestamp: new Date().toISOString()
      };
      await diagnosticDB.addRecord(full);
    },
    []
  );

  return (
    <div className="min-h-screen bg-[#030303] text-[#F4F4F4] flex flex-col md:flex-row selection:bg-white/20 selection:text-white relative">
      {/* Capsule Navigation Dock (Fixed position: stays completely rock-solid and stationary across tab switches) */}
      <aside className="fixed z-40 pointer-events-auto bottom-4 left-1/2 -translate-x-1/2 md:bottom-auto md:left-6 md:top-1/2 md:-translate-y-1/2 md:translate-x-0">
        <div className="flex md:flex-col items-center gap-3 p-2.5 md:py-5 md:px-2.5 rounded-full liquid-glass-dock shadow-[0_24px_60px_rgba(0,0,0,0.85),inset_0_1.5px_1px_rgba(255,255,255,0.22)]">
          {/* Navigation Capsule Icons */}
          {getNavItems(t.nav).map((item) => {
            const isActive = activeModule === item.id;
            return (
              <div key={item.id} className="relative group">
                <button
                  onClick={() => setActiveModule(item.id)}
                  className={`w-11 h-11 rounded-full flex items-center justify-center cursor-pointer transition-all duration-300 ease-out origin-center ${isActive
                    ? 'bg-[#F4F4F4] text-[#030303] font-bold shadow-[0_0_25px_rgba(255,255,255,0.35)] scale-110 hover:scale-[1.38]'
                    : 'text-zinc-400 hover:text-[#F4F4F4] hover:bg-white/10 hover:scale-[1.35] hover:shadow-[0_0_20px_rgba(255,255,255,0.2)]'
                    }`}
                  aria-label={item.label}
                >
                  {item.icon}
                </button>

                {/* Floating Tooltip Title on Hover */}
                <div className="absolute left-full ml-4 top-1/2 -translate-y-1/2 px-3.5 py-1.5 rounded-xl liquid-glass text-[#F4F4F4] text-xs font-medium whitespace-nowrap shadow-2xl pointer-events-none opacity-0 group-hover:opacity-100 transition-all duration-200 z-50 translate-x-1 group-hover:translate-x-0 hidden md:block border border-white/10 border-t-white/20">
                  <div className="font-semibold text-white">{item.label}</div>
                  <div className="text-[10px] text-zinc-400 font-normal">{item.desc}</div>
                </div>
              </div>
            );
          })}

          <div className="w-5 h-[1px] bg-white/10 my-0.5 hidden md:block" />

          {/* Language Switch Button */}
          <div className="relative group">
            <button
              onClick={toggleLang}
              className="w-11 h-11 rounded-full flex items-center justify-center cursor-pointer transition-all duration-300 ease-out origin-center bg-white/[0.06] hover:bg-white/15 text-[#F4F4F4] border border-white/15 shadow-[0_4px_16px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.2)] hover:scale-[1.3] hover:shadow-[0_0_20px_rgba(255,255,255,0.25)] active:scale-110"
              aria-label={t.nav.langSwitch}
              title={t.nav.langSwitch}
            >
              <span className="text-[11px] font-bold tracking-wider font-mono">
                {lang.toUpperCase()}
              </span>
            </button>

            {/* Floating Tooltip */}
            <div className="absolute left-full ml-4 top-1/2 -translate-y-1/2 px-3.5 py-1.5 rounded-xl liquid-glass text-[#F4F4F4] text-xs font-medium whitespace-nowrap shadow-2xl pointer-events-none opacity-0 group-hover:opacity-100 transition-all duration-200 z-50 translate-x-1 group-hover:translate-x-0 hidden md:block border border-white/10 border-t-white/20">
              {t.nav.langSwitch} ({lang === 'en' ? 'English' : 'Tiếng Việt'})
            </div>
          </div>
        </div>
      </aside>

      {/* Main Content Area (Clean view with no redundant top title header and steady left padding) */}
      <main className="relative z-10 flex-1 flex flex-col min-w-0 md:pl-28 pb-24 md:pb-8">
        <div className="p-4 sm:p-6 lg:p-8 max-w-7xl w-full mx-auto flex-1">
          {activeModule === 'dashboard' && (
            <DashboardModule
              sysInfo={sysInfo}
              devices={devices}
              onRefreshDevices={refreshDevices}
              lang={lang}
            />
          )}

          {activeModule === 'network' && (
            <NetworkLabModule onAddRecord={handleAddRecord} lang={lang} />
          )}

          {activeModule === 'audio' && (
            <AudioLabModule
              devices={devices}
              onRefreshDevices={refreshDevices}
              onAddRecord={handleAddRecord}
              lang={lang}
            />
          )}
          {activeModule === 'keyboard' && <KeyboardLabModule onAddRecord={handleAddRecord} lang={lang} />}
          {activeModule === 'mouse' && <MouseLabModule onAddRecord={handleAddRecord} lang={lang} />}
          {activeModule === 'display' && (
            <DisplayLabModule sysInfo={sysInfo} onAddRecord={handleAddRecord} lang={lang} />
          )}
          {activeModule === 'camera' && (
            <CameraLabModule
              devices={devices}
              onRefreshDevices={refreshDevices}
              onAddRecord={handleAddRecord}
              lang={lang}
            />
          )}
          {activeModule === 'gamepad' && (
            <GamepadLabModule devices={devices} onAddRecord={handleAddRecord} lang={lang} />
          )}
        </div>
      </main>
    </div>
  );
}

export default App;