import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Wifi,
  ArrowDown,
  ArrowUp,
  Activity,
  Zap,
  Play,
  Square,
  RotateCcw,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  HelpCircle,
  Info,
  ExternalLink,
  Copy,
  Check,
  ShieldCheck
} from 'lucide-react';
import SpeedTest, { type Results, type PhaseChangePayload } from '@cloudflare/speedtest';
import { translations, type Lang } from '../../i18n';
import type { TestStatus, DataAccuracyBadge, DiagnosticRecord } from '../../App';

// ============================================================================
// UI HELPERS (LIQUID GLASS & COMPACT STATUS BADGES)
// ============================================================================

interface GlassCardProps {
  title?: string;
  icon?: React.ReactNode;
  badge?: DataAccuracyBadge;
  status?: TestStatus;
  rightSlot?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}

const GlassCard: React.FC<GlassCardProps> = ({
  title,
  icon,
  status,
  rightSlot,
  className = '',
  children
}) => (
  <div
    className={`rounded-2xl liquid-glass-card p-5 md:p-6 transition-all duration-300 relative overflow-hidden group shadow-[0_24px_60px_rgba(0,0,0,0.7),inset_0_1.5px_1px_rgba(255,255,255,0.22)] ${className}`}
  >
    <div className="absolute inset-0 bg-gradient-to-br from-white/[0.035] via-transparent to-transparent pointer-events-none opacity-60 group-hover:opacity-100 transition-opacity duration-300" />
    <div className="relative z-10">
      {(title || status || rightSlot) && (
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4 pb-3 border-b border-white/[0.07]">
          <div className="flex items-center gap-2.5">
            {icon && (
              <div className="p-2 rounded-xl bg-white/[0.05] border border-white/12 text-[#F4F4F4] shadow-[inset_0_1px_0_rgba(255,255,255,0.18)] backdrop-blur-xl">
                {icon}
              </div>
            )}
            {title && (
              <h3 className="text-sm md:text-base font-semibold text-[#F4F4F4] tracking-tight">
                {title}
              </h3>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {status && <LocalStatusBadge status={status} />}
            {rightSlot}
          </div>
        </div>
      )}
      {children}
    </div>
  </div>
);

const LocalStatusBadge: React.FC<{ status: TestStatus; size?: 'sm' | 'md' }> = ({
  status,
  size = 'sm'
}) => {
  const config: Record<
    TestStatus,
    { bg: string; icon: React.ReactNode; label: string }
  > = {
    PASS: {
      bg: 'bg-white/[0.09] text-[#F4F4F4] border-white/20 shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]',
      icon: <CheckCircle2 className="w-3 h-3 text-[#F4F4F4]" />,
      label: 'PASS'
    },
    WARNING: {
      bg: 'bg-white/[0.05] text-zinc-300 border-white/12 shadow-[inset_0_1px_0_rgba(255,255,255,0.1)]',
      icon: <AlertTriangle className="w-3 h-3 text-zinc-300" />,
      label: 'WARNING'
    },
    FAIL: {
      bg: 'bg-white/[0.03] text-zinc-400 border-white/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]',
      icon: <XCircle className="w-3 h-3 text-zinc-400" />,
      label: 'FAIL'
    },
    SKIPPED: {
      bg: 'bg-white/[0.02] text-zinc-500 border-white/[0.07]',
      icon: <HelpCircle className="w-3 h-3 text-zinc-500" />,
      label: 'SKIPPED'
    },
    UNSUPPORTED: {
      bg: 'bg-transparent text-zinc-500 border-white/[0.06]',
      icon: <Info className="w-3 h-3 text-zinc-500" />,
      label: 'UNSUPPORTED'
    },
    UNTESTED: {
      bg: 'bg-white/[0.02] text-zinc-500 border-white/[0.06]',
      icon: <HelpCircle className="w-3 h-3 text-zinc-500" />,
      label: 'UNTESTED'
    }
  };

  const item = config[status];
  return (
    <span
      className={`inline-flex items-center gap-1 font-medium tracking-wider uppercase rounded-full border ${
        item.bg
      } ${size === 'sm' ? 'px-2 py-0.5 text-[10px]' : 'px-2.5 py-1 text-xs'}`}
    >
      {item.icon}
      {item.label}
    </span>
  );
};

// ============================================================================
// TYPES & PROGRESSIVE MEASUREMENT CONFIG
// ============================================================================

export type SpeedTestPhase =
  | 'idle'
  | 'latency'
  | 'download'
  | 'upload'
  | 'completed'
  | 'stopped'
  | 'error';

export interface SpeedMetrics {
  downloadMbps: number | null;
  uploadMbps: number | null;
  pingMs: number | null;
  jitterMs: number | null;
  packetLossPercent: number | null;
  downLoadedLatencyMs: number | null;
  upLoadedLatencyMs: number | null;
  scores: {
    streaming?: { points: number; label: string };
    gaming?: { points: number; label: string };
    rtc?: { points: number; label: string };
  } | null;
}

interface NetworkLabModuleProps {
  onAddRecord?: (rec: Omit<DiagnosticRecord, 'id' | 'timestamp'>) => Promise<void>;
  lang?: Lang;
}

// Progressive sequential measurement pipeline for fast, smooth data points
const OPTIMIZED_MEASUREMENTS = [
  // 1. Latency & Jitter (fast 15 pings)
  { type: 'latency' as const, numPackets: 15 },

  // 2. Download bandwidth (progressive payload sizes)
  { type: 'download' as const, bytes: 1e5, count: 4, bypassMinDuration: true }, // 100KB
  { type: 'download' as const, bytes: 1e6, count: 5 },                          // 1MB
  { type: 'download' as const, bytes: 1e7, count: 4 },                          // 10MB
  { type: 'download' as const, bytes: 25e6, count: 3 },                         // 25MB

  // 3. Upload bandwidth (finely-tuned steps to avoid stall on large POST requests)
  { type: 'upload' as const, bytes: 1e5, count: 4, bypassMinDuration: true },   // 100KB
  { type: 'upload' as const, bytes: 5e5, count: 4 },                            // 500KB
  { type: 'upload' as const, bytes: 1e6, count: 4 },                            // 1MB
  { type: 'upload' as const, bytes: 3e6, count: 4 },                            // 3MB
  { type: 'upload' as const, bytes: 8e6, count: 3 },                            // 8MB
  { type: 'upload' as const, bytes: 15e6, count: 2 }                            // 15MB
];

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export const NetworkLabModule: React.FC<NetworkLabModuleProps> = ({
  onAddRecord,
  lang = 'en'
}) => {
  const t = translations[lang].network;

  // State
  const [phase, setPhase] = useState<SpeedTestPhase>('idle');
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [metrics, setMetrics] = useState<SpeedMetrics>({
    downloadMbps: null,
    uploadMbps: null,
    pingMs: null,
    jitterMs: null,
    packetLossPercent: null,
    downLoadedLatencyMs: null,
    upLoadedLatencyMs: null,
    scores: null
  });
  const [currentSpeed, setCurrentSpeed] = useState<number>(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState<boolean>(false);
  const [overallStatus, setOverallStatus] = useState<TestStatus>('UNTESTED');

  // Engine & throttling references
  const engineRef = useRef<SpeedTest | null>(null);
  const isManuallyStoppedRef = useRef<boolean>(false);
  const rafRef = useRef<number | null>(null);
  const lastFlushTimeRef = useRef<number>(0);
  const bufferedMetricsRef = useRef<SpeedMetrics>(metrics);
  const bufferedSpeedRef = useRef<number>(0);

  // Clean up engine & animation frames on unmount
  useEffect(() => {
    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (engineRef.current) {
        try {
          engineRef.current.pause();
        } catch {
          // ignore
        }
        engineRef.current = null;
      }
    };
  }, []);

  // Compute metrics from engine results
  const extractMetrics = useCallback((results: Results): { metrics: SpeedMetrics; liveSpeed: number } => {
    const summary = results.getSummary();

    const rawDownload = summary.download ?? results.getDownloadBandwidth?.();
    const rawUpload = summary.upload ?? results.getUploadBandwidth?.();
    const rawPing = summary.latency ?? results.getUnloadedLatency?.();
    const rawJitter = summary.jitter ?? results.getUnloadedJitter?.();
    const rawPacketLoss = summary.packetLoss ?? results.getPacketLoss?.();
    const downLoadedLat = summary.downLoadedLatency ?? results.getDownLoadedLatency?.();
    const upLoadedLat = summary.upLoadedLatency ?? results.getUpLoadedLatency?.();

    // Check latest individual chunk if aggregate is still computing
    let downloadMbps: number | null = null;
    if (rawDownload !== undefined && rawDownload > 0) {
      downloadMbps = Number((rawDownload / 1e6).toFixed(1));
    } else {
      const pnts = results.getDownloadBandwidthPoints?.() || [];
      if (pnts.length > 0 && pnts[pnts.length - 1].bps > 0) {
        downloadMbps = Number((pnts[pnts.length - 1].bps / 1e6).toFixed(1));
      }
    }

    let uploadMbps: number | null = null;
    if (rawUpload !== undefined && rawUpload > 0) {
      uploadMbps = Number((rawUpload / 1e6).toFixed(1));
    } else {
      const pnts = results.getUploadBandwidthPoints?.() || [];
      if (pnts.length > 0 && pnts[pnts.length - 1].bps > 0) {
        uploadMbps = Number((pnts[pnts.length - 1].bps / 1e6).toFixed(1));
      }
    }

    const pingMs = rawPing !== undefined && rawPing > 0 ? Number(rawPing.toFixed(1)) : null;
    const jitterMs = rawJitter !== undefined && rawJitter !== null ? Number(rawJitter.toFixed(1)) : null;
    const packetLossPercent = rawPacketLoss !== undefined && rawPacketLoss !== null ? Number((rawPacketLoss * 100).toFixed(1)) : null;
    const downLoadedLatencyMs = downLoadedLat !== undefined && downLoadedLat > 0 ? Number(downLoadedLat.toFixed(1)) : null;
    const upLoadedLatencyMs = upLoadedLat !== undefined && upLoadedLat > 0 ? Number(upLoadedLat.toFixed(1)) : null;

    let scoresObj: SpeedMetrics['scores'] = null;
    try {
      const scores = results.getScores?.();
      if (scores) {
        scoresObj = {
          streaming: scores.streaming ? { points: scores.streaming.points, label: scores.streaming.classificationName } : undefined,
          gaming: scores.gaming ? { points: scores.gaming.points, label: scores.gaming.classificationName } : undefined,
          rtc: scores.rtc ? { points: scores.rtc.points, label: scores.rtc.classificationName } : undefined
        };
      }
    } catch {
      // not yet ready
    }

    const computedMetrics: SpeedMetrics = {
      downloadMbps,
      uploadMbps,
      pingMs,
      jitterMs,
      packetLossPercent,
      downLoadedLatencyMs,
      upLoadedLatencyMs,
      scores: scoresObj
    };

    return {
      metrics: computedMetrics,
      liveSpeed: (phase === 'upload' ? uploadMbps : downloadMbps) || 0
    };
  }, [phase]);

  // Throttled UI updater (prevents browser lag during high-frequency micro-packet events)
  const scheduleThrottledUpdate = useCallback((results: Results) => {
    const { metrics: m, liveSpeed: s } = extractMetrics(results);
    bufferedMetricsRef.current = m;
    bufferedSpeedRef.current = s;

    const now = performance.now();
    if (now - lastFlushTimeRef.current >= 75) {
      lastFlushTimeRef.current = now;
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      setMetrics(m);
      setCurrentSpeed(s);
    } else if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        lastFlushTimeRef.current = performance.now();
        setMetrics(bufferedMetricsRef.current);
        setCurrentSpeed(bufferedSpeedRef.current);
      });
    }
  }, [extractMetrics]);

  // Stop test
  const handleStopTest = useCallback(() => {
    isManuallyStoppedRef.current = true;
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (engineRef.current) {
      try {
        engineRef.current.pause();
      } catch {
        // ignore
      }
    }
    setIsRunning(false);
    setPhase('stopped');
  }, []);

  // Start test
  const handleStartTest = useCallback(async () => {
    if (isRunning) return;

    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setErrorMessage(t.offlineError);
      setOverallStatus('FAIL');
      setPhase('error');
      return;
    }

    if (engineRef.current) {
      try {
        engineRef.current.pause();
      } catch {
        // ignore
      }
      engineRef.current = null;
    }

    isManuallyStoppedRef.current = false;
    setErrorMessage(null);
    setPhase('latency');
    setIsRunning(true);
    setCurrentSpeed(0);
    setMetrics({
      downloadMbps: null,
      uploadMbps: null,
      pingMs: null,
      jitterMs: null,
      packetLossPercent: null,
      downLoadedLatencyMs: null,
      upLoadedLatencyMs: null,
      scores: null
    });

    try {
      const engine = new SpeedTest({
        autoStart: false,
        measurements: OPTIMIZED_MEASUREMENTS,
        bandwidthFinishRequestDuration: 1200,
        measureDownloadLoadedLatency: true,
        measureUploadLoadedLatency: true
      });

      engineRef.current = engine;

      engine.onRunningChange = (running) => {
        setIsRunning(running);
      };

      engine.onPhaseChange = (payload: PhaseChangePayload) => {
        if (isManuallyStoppedRef.current) return;
        const type = payload.measurement?.type;
        if (type === 'latency') {
          setPhase('latency');
        } else if (type === 'download') {
          setPhase('download');
        } else if (type === 'upload') {
          setPhase('upload');
        }
      };

      engine.onResultsChange = () => {
        if (isManuallyStoppedRef.current) return;
        scheduleThrottledUpdate(engine.results);
      };

      engine.onFinish = async (results: Results) => {
        if (isManuallyStoppedRef.current) return;
        if (rafRef.current) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }

        const { metrics: finalMetrics } = extractMetrics(results);
        setMetrics(finalMetrics);
        setCurrentSpeed(finalMetrics.downloadMbps || 0);
        setIsRunning(false);
        setPhase('completed');

        let status: TestStatus = 'PASS';
        if (!finalMetrics.downloadMbps || finalMetrics.downloadMbps < 5) {
          status = 'WARNING';
        } else if (finalMetrics.pingMs && finalMetrics.pingMs > 150) {
          status = 'WARNING';
        }
        setOverallStatus(status);

        if (onAddRecord) {
          try {
            await onAddRecord({
              moduleId: 'network',
              moduleName: 'Network Lab',
              testName: 'Internet Speed Test (Cloudflare Edge)',
              device: 'Default Network Interface',
              method: 'REALTIME',
              status,
              metrics: {
                downloadMbps: finalMetrics.downloadMbps ?? 0,
                uploadMbps: finalMetrics.uploadMbps ?? 0,
                pingMs: finalMetrics.pingMs ?? 0,
                jitterMs: finalMetrics.jitterMs ?? 0,
                packetLoss: 'UNCONFIGURED'
              },
              notes: `Download: ${finalMetrics.downloadMbps ?? 0} Mbps, Upload: ${finalMetrics.uploadMbps ?? 0} Mbps, Ping: ${finalMetrics.pingMs ?? 0} ms, Jitter: ${finalMetrics.jitterMs ?? 0} ms`
            });
          } catch {
            // ignore
          }
        }
      };

      engine.onError = (message: string) => {
        if (isManuallyStoppedRef.current) return;
        setIsRunning(false);
        setPhase('error');
        setOverallStatus('FAIL');
        setErrorMessage(message && message.length > 0 ? message : t.blockedError);
      };

      engine.play();
    } catch (err) {
      setIsRunning(false);
      setPhase('error');
      setOverallStatus('FAIL');
      setErrorMessage(err instanceof Error ? err.message : t.blockedError);
    }
  }, [isRunning, onAddRecord, t, extractMetrics, scheduleThrottledUpdate]);

  // Copy results
  const handleCopySummary = useCallback(() => {
    const lines = [
      `PC Doctor - Speed Test`,
      `Download: ${metrics.downloadMbps !== null ? `${metrics.downloadMbps} Mbps` : 'N/A'}`,
      `Upload: ${metrics.uploadMbps !== null ? `${metrics.uploadMbps} Mbps` : 'N/A'}`,
      `Ping: ${metrics.pingMs !== null ? `${metrics.pingMs} ms` : 'N/A'}`,
      `Jitter: ${metrics.jitterMs !== null ? `${metrics.jitterMs} ms` : 'N/A'}`,
      metrics.downLoadedLatencyMs ? `Loaded Ping (Down): ${metrics.downLoadedLatencyMs} ms` : null,
      metrics.upLoadedLatencyMs ? `Loaded Ping (Up): ${metrics.upLoadedLatencyMs} ms` : null
    ].filter(Boolean);

    navigator.clipboard.writeText(lines.join('\n')).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [metrics]);

  // Live speed value for gauge
  const displaySpeed =
    phase === 'upload'
      ? metrics.uploadMbps ?? currentSpeed
      : phase === 'download'
      ? metrics.downloadMbps ?? currentSpeed
      : metrics.downloadMbps ?? 0;

  const gaugePercent = Math.min(100, Math.round((displaySpeed / 250) * 100));

  return (
    <div className="space-y-4 md:space-y-5">
      {/* 1. TOP HEADER & CONTROLS (Clean, no wordy subtitles) */}
      <div className="rounded-2xl liquid-glass-card p-5 relative overflow-hidden shadow-[0_24px_60px_rgba(0,0,0,0.7),inset_0_1.5px_1px_rgba(255,255,255,0.22)]">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-white/[0.06] border border-white/15 text-white">
              <Wifi className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg md:text-xl font-bold tracking-tight text-[#F4F4F4]">
                  {t.cardHeroTitle}
                </h1>
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            {isRunning ? (
              <button
                onClick={handleStopTest}
                className="px-5 py-2 rounded-xl bg-white/10 hover:bg-white/15 text-white border border-white/20 font-medium text-xs md:text-sm flex items-center gap-2 transition-all cursor-pointer active:scale-95"
              >
                <Square className="w-3.5 h-3.5 text-red-400 fill-red-400" />
                <span>{t.btnStop}</span>
              </button>
            ) : (
              <button
                onClick={handleStartTest}
                className="px-5 py-2 rounded-xl bg-white text-[#030303] hover:bg-zinc-200 font-semibold text-xs md:text-sm flex items-center gap-2 transition-all cursor-pointer shadow-[0_0_20px_rgba(255,255,255,0.3)] hover:scale-[1.02] active:scale-95"
              >
                {phase === 'completed' || phase === 'stopped' || phase === 'error' ? (
                  <>
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>{t.btnRetest}</span>
                  </>
                ) : (
                  <>
                    <Play className="w-3.5 h-3.5 fill-current" />
                    <span>{t.btnStart}</span>
                  </>
                )}
              </button>
            )}

            <a
              href="https://speed.cloudflare.com"
              target="_blank"
              rel="noopener noreferrer"
              className="p-2 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] text-zinc-400 hover:text-white border border-white/10 transition-all"
              title={t.officialToolBtn}
            >
              <ExternalLink className="w-4 h-4" />
            </a>
          </div>
        </div>

        {/* Minimal 4-stage pills */}
        <div className="mt-4 pt-3.5 border-t border-white/[0.06] grid grid-cols-4 gap-2">
          {[
            { id: 'latency', label: t.stageLatency, active: phase === 'latency', done: ['download', 'upload', 'completed'].includes(phase) },
            { id: 'download', label: t.stageDownload, active: phase === 'download', done: ['upload', 'completed'].includes(phase) },
            { id: 'upload', label: t.stageUpload, active: phase === 'upload', done: phase === 'completed' },
            { id: 'completed', label: t.stageFinished, active: phase === 'completed', done: phase === 'completed' }
          ].map((st) => (
            <div
              key={st.id}
              className={`py-1.5 px-2 rounded-lg border text-[11px] text-center font-medium transition-all ${
                st.active
                  ? 'bg-white/15 border-white/30 text-white shadow-[0_0_12px_rgba(255,255,255,0.2)]'
                  : st.done
                  ? 'bg-white/[0.03] border-white/10 text-zinc-300'
                  : 'bg-transparent border-white/[0.04] text-zinc-600'
              }`}
            >
              {st.label}
            </div>
          ))}
        </div>
      </div>

      {/* 2. COMPACT 1-LINE DATA WARNING */}
      <div className="px-3.5 py-2 rounded-xl bg-white/[0.02] border border-amber-500/20 text-xs text-amber-300/90 flex items-center gap-2">
        <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
        <span className="truncate">{t.dataWarningNotice}</span>
      </div>

      {/* 3. ERROR ALERT (IF ANY) */}
      {errorMessage && (
        <div className="p-3 rounded-xl bg-red-950/25 border border-red-500/30 text-xs text-red-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <XCircle className="w-4 h-4 text-red-400 shrink-0" />
            <span>{errorMessage}</span>
          </div>
          <button onClick={() => setErrorMessage(null)} className="text-zinc-500 hover:text-zinc-300 text-xs px-1.5">
            ✕
          </button>
        </div>
      )}

      {/* 4. SPEED DIAL (Clean, responsive, fast) */}
      <GlassCard className="text-center py-6">
        <div className="max-w-xs mx-auto flex flex-col items-center">
          <div className="relative w-44 h-44 flex items-center justify-center">
            <svg className="w-full h-full -rotate-90 transform" viewBox="0 0 120 120">
              <circle
                cx="60"
                cy="60"
                r="48"
                fill="none"
                stroke="rgba(255, 255, 255, 0.06)"
                strokeWidth="5"
                strokeDasharray="301.59"
                strokeDashoffset="75.4"
                strokeLinecap="round"
              />
              <circle
                cx="60"
                cy="60"
                r="48"
                fill="none"
                stroke={isRunning ? '#FFFFFF' : 'rgba(255, 255, 255, 0.4)'}
                strokeWidth="5"
                strokeDasharray="301.59"
                strokeDashoffset={301.59 - (gaugePercent / 100) * 226}
                strokeLinecap="round"
                className="transition-all duration-150 ease-out"
                style={{
                  filter: isRunning ? 'drop-shadow(0 0 6px rgba(255,255,255,0.7))' : 'none'
                }}
              />
            </svg>

            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-[10px] uppercase tracking-wider text-zinc-400 font-mono">
                {phase === 'latency'
                  ? t.stageLatency
                  : phase === 'upload'
                  ? t.uploadLabel
                  : t.downloadLabel}
              </span>
              <div className="text-3xl font-extrabold tracking-tight text-white font-mono my-0.5">
                {displaySpeed > 0 ? displaySpeed.toFixed(1) : '--'}
              </div>
              <span className="text-[11px] text-zinc-400 font-medium">
                {t.speedUnit}
              </span>
            </div>
          </div>

          <div className="mt-2 text-xs text-zinc-300 font-medium flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full ${isRunning ? 'bg-emerald-400 animate-ping' : 'bg-zinc-600'}`} />
            <span>
              {phase === 'idle' && t.phaseIdle}
              {phase === 'latency' && t.phaseLatency}
              {phase === 'download' && t.phaseDownload}
              {phase === 'upload' && t.phaseUpload}
              {phase === 'completed' && t.phaseCompleted}
              {phase === 'stopped' && t.phaseStopped}
              {phase === 'error' && t.phaseError}
            </span>
          </div>
        </div>
      </GlassCard>

      {/* 5. 5 CORE METRIC CARDS (No subtitles, sharp & minimal) */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {/* Download */}
        <div className="rounded-xl liquid-glass-sub p-4 border border-white/10 hover:border-white/20 transition-all">
          <div className="flex items-center justify-between text-zinc-400 mb-2">
            <span className="text-xs font-semibold uppercase">{t.downloadLabel}</span>
            <ArrowDown className="w-3.5 h-3.5 text-white" />
          </div>
          <div className="flex items-baseline gap-1 my-0.5">
            <span className="text-2xl font-bold text-white font-mono">
              {metrics.downloadMbps !== null ? metrics.downloadMbps.toFixed(1) : '--'}
            </span>
            <span className="text-[11px] text-zinc-400">{t.speedUnit}</span>
          </div>
          {metrics.downloadMbps !== null && (
            <div className="text-[10px] text-zinc-500 font-mono">
              ≈ {(metrics.downloadMbps / 8).toFixed(1)} {t.byteConversion}
            </div>
          )}
        </div>

        {/* Upload */}
        <div className="rounded-xl liquid-glass-sub p-4 border border-white/10 hover:border-white/20 transition-all">
          <div className="flex items-center justify-between text-zinc-400 mb-2">
            <span className="text-xs font-semibold uppercase">{t.uploadLabel}</span>
            <ArrowUp className="w-3.5 h-3.5 text-white" />
          </div>
          <div className="flex items-baseline gap-1 my-0.5">
            <span className="text-2xl font-bold text-white font-mono">
              {metrics.uploadMbps !== null ? metrics.uploadMbps.toFixed(1) : '--'}
            </span>
            <span className="text-[11px] text-zinc-400">{t.speedUnit}</span>
          </div>
          {metrics.uploadMbps !== null && (
            <div className="text-[10px] text-zinc-500 font-mono">
              ≈ {(metrics.uploadMbps / 8).toFixed(1)} {t.byteConversion}
            </div>
          )}
        </div>

        {/* Ping */}
        <div className="rounded-xl liquid-glass-sub p-4 border border-white/10 hover:border-white/20 transition-all">
          <div className="flex items-center justify-between text-zinc-400 mb-2">
            <span className="text-xs font-semibold uppercase">{t.pingLabel}</span>
            <Activity className="w-3.5 h-3.5 text-white" />
          </div>
          <div className="flex items-baseline gap-1 my-0.5">
            <span className="text-2xl font-bold text-white font-mono">
              {metrics.pingMs !== null ? metrics.pingMs.toFixed(1) : '--'}
            </span>
            <span className="text-[11px] text-zinc-400">{t.msUnit}</span>
          </div>
        </div>

        {/* Jitter */}
        <div className="rounded-xl liquid-glass-sub p-4 border border-white/10 hover:border-white/20 transition-all">
          <div className="flex items-center justify-between text-zinc-400 mb-2">
            <span className="text-xs font-semibold uppercase">{t.jitterLabel}</span>
            <Zap className="w-3.5 h-3.5 text-white" />
          </div>
          <div className="flex items-baseline gap-1 my-0.5">
            <span className="text-2xl font-bold text-white font-mono">
              {metrics.jitterMs !== null ? metrics.jitterMs.toFixed(1) : '--'}
            </span>
            <span className="text-[11px] text-zinc-400">{t.msUnit}</span>
          </div>
        </div>

        {/* Packet Loss (Transparent, truthful, no subtitle) */}
        <div className="rounded-xl liquid-glass-sub p-4 border border-white/10 hover:border-white/20 transition-all col-span-2 sm:col-span-1">
          <div className="flex items-center justify-between text-zinc-400 mb-2">
            <span className="text-xs font-semibold uppercase">{t.packetLossLabel}</span>
            <ShieldCheck className="w-3.5 h-3.5 text-zinc-400" />
          </div>
          <div className="my-0.5">
            {metrics.packetLossPercent !== null ? (
              <div className="flex items-baseline gap-1">
                <span className="text-2xl font-bold text-white font-mono">
                  {metrics.packetLossPercent.toFixed(1)}
                </span>
                <span className="text-[11px] text-zinc-400">{t.percentUnit}</span>
              </div>
            ) : (
              <span className="text-xs font-medium text-zinc-400 bg-white/[0.05] px-2 py-0.5 rounded border border-white/10">
                {t.packetLossStatus}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* 6. BUFFERBLOAT & AIM SCORES (Compact) */}
      <GlassCard
        title={t.bufferbloatTitle}
        icon={<Activity className="w-4 h-4" />}
        status={overallStatus}
        rightSlot={
          phase === 'completed' && (
            <button
              onClick={handleCopySummary}
              className="px-2.5 py-1 rounded-lg bg-white/[0.06] hover:bg-white/15 text-zinc-200 border border-white/10 text-xs flex items-center gap-1.5 transition-all cursor-pointer"
            >
              {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
              <span>{copied ? t.copied : t.copyResults}</span>
            </button>
          )
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <div className="p-3 rounded-xl liquid-glass-sub border border-white/[0.06]">
            <div className="text-[11px] text-zinc-400 mb-0.5">{t.downLoadedLatencyLabel}</div>
            <div className="text-base font-bold font-mono text-white">
              {metrics.downLoadedLatencyMs !== null ? `${metrics.downLoadedLatencyMs} ${t.msUnit}` : '--'}
            </div>
          </div>

          <div className="p-3 rounded-xl liquid-glass-sub border border-white/[0.06]">
            <div className="text-[11px] text-zinc-400 mb-0.5">{t.upLoadedLatencyLabel}</div>
            <div className="text-base font-bold font-mono text-white">
              {metrics.upLoadedLatencyMs !== null ? `${metrics.upLoadedLatencyMs} ${t.msUnit}` : '--'}
            </div>
          </div>
        </div>

        {metrics.scores && (
          <div className="mt-3 pt-3 border-t border-white/[0.06] flex items-center justify-between gap-2 flex-wrap text-xs">
            <span className="text-zinc-400 text-[11px] font-medium">{t.aimTitle}:</span>
            <div className="flex items-center gap-2">
              {metrics.scores.streaming && (
                <span className="px-2 py-0.5 rounded bg-white/[0.05] border border-white/10 text-zinc-300 text-[10px]">
                  {t.aimStreaming}: <strong className="text-white capitalize">{metrics.scores.streaming.label}</strong>
                </span>
              )}
              {metrics.scores.gaming && (
                <span className="px-2 py-0.5 rounded bg-white/[0.05] border border-white/10 text-zinc-300 text-[10px]">
                  {t.aimGaming}: <strong className="text-white capitalize">{metrics.scores.gaming.label}</strong>
                </span>
              )}
              {metrics.scores.rtc && (
                <span className="px-2 py-0.5 rounded bg-white/[0.05] border border-white/10 text-zinc-300 text-[10px]">
                  {t.aimRtc}: <strong className="text-white capitalize">{metrics.scores.rtc.label}</strong>
                </span>
              )}
            </div>
          </div>
        )}
      </GlassCard>
    </div>
  );
};

export default NetworkLabModule;
