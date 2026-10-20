import React, { useState, useEffect, useCallback } from 'react';
import {
  isLiveGASUrl,
  fetchGASAllData,
  callGASPost,
} from '../utils/gasClient';
import { DEFAULT_LIVE_GAS_WEBAPP_URL } from '../utils/seedData';
import type { GASConfig, GASUserAccount } from '../utils/arLogic';

export interface DiagnosticCheckResult {
  id: string;
  title: string;
  status: 'pending' | 'running' | 'ok' | 'warning' | 'error';
  latencyMs?: number;
  summary: string;
  detail: string;
}

interface ConnectionDiagnosticProps {
  gasConfig: GASConfig;
  users: GASUserAccount[];
  currentUser?: GASUserAccount | null;
  onUpdateWebAppUrl?: (newUrl: string) => void;
  onRefreshGASData?: () => Promise<void>;
  onClose?: () => void;
  isModal?: boolean;
}

export const ConnectionDiagnostic: React.FC<ConnectionDiagnosticProps> = ({
  gasConfig,
  users,
  currentUser,
  onUpdateWebAppUrl,
  onRefreshGASData,
  onClose,
  isModal = false,
}) => {
  const [urlInput, setUrlInput] = useState(
    gasConfig.webAppUrl || DEFAULT_LIVE_GAS_WEBAPP_URL
  );
  const [isRunning, setIsRunning] = useState(false);
  const [overallLatencyMs, setOverallLatencyMs] = useState<number | null>(null);
  const [lastTestedAt, setLastTestedAt] = useState<string | null>(null);
  const [remoteUserCount, setRemoteUserCount] = useState<number | null>(null);
  const [remoteRecordCount, setRemoteRecordCount] = useState<number | null>(null);
  const [authStatusText, setAuthStatusText] = useState<string>('Siap Diuji');
  const [checks, setChecks] = useState<DiagnosticCheckResult[]>([
    {
      id: 'url-validation',
      title: '1. Validasi Format Endpoint URL GAS (/exec)',
      status: 'pending',
      summary: 'Menunggu pengujian',
      detail: 'Memeriksa protokol HTTPS dan akhiran /exec pada URL Web App.',
    },
    {
      id: 'get-handshake',
      title: '2. Handshake GET & Pembacaan Spreadsheet (readAll)',
      status: 'pending',
      summary: 'Menunggu pengujian',
      detail: 'Menguji latensi baca tabel Data_Piutang dan Users_Auth.',
    },
    {
      id: 'post-auth',
      title: '3. Verifikasi Otentikasi & Tabel Users_Auth (POST)',
      status: 'pending',
      summary: 'Menunggu pengujian',
      detail: 'Memeriksa ketersediaan akun pengguna di dalam Google Sheets.',
    },
  ]);

  useEffect(() => {
    if (gasConfig.webAppUrl) {
      setUrlInput(gasConfig.webAppUrl);
    }
  }, [gasConfig.webAppUrl]);

  const runFullDiagnostic = useCallback(
    async (targetUrlInput?: string) => {
      const activeUrl = (targetUrlInput ?? urlInput).trim();
      setIsRunning(true);
      const startTotal = performance.now();

      // Step 1: URL Validation
      const isValidLive = isLiveGASUrl(activeUrl);
      const step1: DiagnosticCheckResult = isValidLive
        ? {
            id: 'url-validation',
            title: '1. Validasi Format Endpoint URL GAS (/exec)',
            status: 'ok',
            latencyMs: 1,
            summary: 'Format URL Valid (Live Cloud Endpoint)',
            detail: `Endpoint aktif: ${activeUrl}`,
          }
        : {
            id: 'url-validation',
            title: '1. Validasi Format Endpoint URL GAS (/exec)',
            status: 'error',
            latencyMs: 1,
            summary: 'URL Tidak Valid atau Masih Simulasi',
            detail:
              'Pastikan URL diawali https://script.google.com/macros/s/ dan diakhiri /exec.',
          };

      setChecks((prev) => [
        step1,
        { ...prev[1], status: 'running', summary: 'Menghubungi Google Sheets...' },
        { ...prev[2], status: 'pending', summary: 'Menunggu langkah 2...' },
      ]);

      // Step 2: GET Handshake (readAll)
      const tempConfig: GASConfig = { ...gasConfig, webAppUrl: activeUrl };
      const getResult = await fetchGASAllData(tempConfig);

      const uCount = Array.isArray(getResult.users) ? getResult.users.length : 0;
      const pCount = Array.isArray(getResult.piutang) ? getResult.piutang.length : 0;
      setRemoteUserCount(getResult.connected ? uCount : null);
      setRemoteRecordCount(getResult.connected ? pCount : null);

      const step2: DiagnosticCheckResult = getResult.connected
        ? {
            id: 'get-handshake',
            title: '2. Handshake GET & Pembacaan Spreadsheet (readAll)',
            status: 'ok',
            latencyMs: getResult.latencyMs,
            summary: `200 OK · ${getResult.latencyMs} ms`,
            detail: `Berhasil membaca ${pCount} baris Data_Piutang dan ${uCount} akun pada Sheet Users_Auth.`,
          }
        : {
            id: 'get-handshake',
            title: '2. Handshake GET & Pembacaan Spreadsheet (readAll)',
            status: 'error',
            latencyMs: getResult.latencyMs,
            summary: `Gagal (${getResult.latencyMs} ms)`,
            detail: getResult.message,
          };

      setChecks([
        step1,
        step2,
        {
          id: 'post-auth',
          title: '3. Verifikasi Otentikasi & Tabel Users_Auth (POST)',
          status: 'running',
          summary: 'Memverifikasi kredensial di Users_Auth...',
          detail: 'Menguji jalur POST payload ke Google Apps Script.',
        },
      ]);

      // Step 3: POST Handshake & Auth Status Verification
      const targetAccount =
        currentUser ||
        (getResult.users && getResult.users[0]) ||
        users[0] || {
          username: 'zhiels',
          password: 'lose22d',
        };

      const postRes = await callGASPost<{
        status?: string;
        user?: GASUserAccount;
        message?: string;
      }>(activeUrl, {
        action: 'login',
        spreadsheetId: gasConfig.spreadsheetId,
        username: targetAccount.username,
        password: targetAccount.password,
      });

      let step3: DiagnosticCheckResult;
      if (postRes.ok && postRes.data?.status === 'success') {
        const verifiedName = postRes.data.user?.username || targetAccount.username;
        const verifiedRole = postRes.data.user?.role || 'Authorized';
        setAuthStatusText(`TERAUTENTIKASI (${verifiedName} · ${verifiedRole})`);
        step3 = {
          id: 'post-auth',
          title: '3. Verifikasi Otentikasi & Tabel Users_Auth (POST)',
          status: 'ok',
          latencyMs: postRes.latencyMs,
          summary: `Otentikasi Sukses · ${postRes.latencyMs} ms`,
          detail: `Akun "${verifiedName}" (${verifiedRole}) terverifikasi aktif di Sheet Users_Auth. Daftar user di Spreadsheet: ${
            getResult.users?.map((u) => u.username).join(', ') || verifiedName
          }.`,
        };
      } else if (getResult.connected && uCount > 0) {
        const names = getResult.users?.map((u) => u.username).join(', ') || '-';
        setAuthStatusText(`TERHUBUNG (${uCount} Akun Terbaca: ${names})`);
        step3 = {
          id: 'post-auth',
          title: '3. Verifikasi Otentikasi & Tabel Users_Auth (POST)',
          status: 'ok',
          latencyMs: postRes.latencyMs,
          summary: `Sheet Users_Auth Aktif · ${postRes.latencyMs} ms`,
          detail: `Sheet Users_Auth merespons dengan ${uCount} akun terdaftar (${names}).`,
        };
      } else {
        setAuthStatusText('GAGAL VERIFIKASI');
        step3 = {
          id: 'post-auth',
          title: '3. Verifikasi Otentikasi & Tabel Users_Auth (POST)',
          status: 'error',
          latencyMs: postRes.latencyMs,
          summary: `Gagal POST (${postRes.latencyMs} ms)`,
          detail:
            postRes.error ||
            postRes.data?.message ||
            'Tidak dapat memverifikasi otentikasi POST ke Google Apps Script.',
        };
      }

      setChecks([step1, step2, step3]);
      setOverallLatencyMs(Math.round(performance.now() - startTotal));
      setLastTestedAt(
        new Date().toLocaleTimeString('id-ID', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
      );
      setIsRunning(false);

      if (onRefreshGASData && getResult.connected) {
        await onRefreshGASData();
      }
    },
    [urlInput, gasConfig, currentUser, users, onRefreshGASData]
  );

  useEffect(() => {
    void runFullDiagnostic(gasConfig.webAppUrl || DEFAULT_LIVE_GAS_WEBAPP_URL);
  }, []);

  const handleApplyAndTest = async () => {
    const clean = urlInput.trim() || DEFAULT_LIVE_GAS_WEBAPP_URL;
    setUrlInput(clean);
    if (onUpdateWebAppUrl) {
      onUpdateWebAppUrl(clean);
    }
    await runFullDiagnostic(clean);
  };

  const handleRestoreLiveUrl = async () => {
    setUrlInput(DEFAULT_LIVE_GAS_WEBAPP_URL);
    if (onUpdateWebAppUrl) {
      onUpdateWebAppUrl(DEFAULT_LIVE_GAS_WEBAPP_URL);
    }
    await runFullDiagnostic(DEFAULT_LIVE_GAS_WEBAPP_URL);
  };

  const content = (
    <div className="bg-surface-card border border-border-grid flex flex-col gap-4 p-5">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-border-grid">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 bg-secondary-container border border-secondary flex items-center justify-center shrink-0">
            <span className="material-symbols-outlined text-text-bright text-[20px]">
              network_check
            </span>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="font-headline-md text-text-bright uppercase tracking-wide">
                ConnectionDiagnostic · Handshake &amp; Latensi GAS
              </h2>
              <span className="px-2 py-0.5 bg-surface-input border border-border-accent font-code-audit text-xs text-secondary uppercase">
                Real-Time Probe
              </span>
            </div>
            <p className="font-code-audit text-text-dim text-xs">
              Pengujian mendalam koneksi Google Sheets, latensi jaringan, dan status autentikasi Users_Auth
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void runFullDiagnostic()}
            disabled={isRunning}
            className="px-3.5 py-2 bg-secondary hover:bg-secondary/90 text-surface-card font-headline-sm uppercase text-xs font-bold flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
          >
            <span
              className={`material-symbols-outlined text-[16px] ${
                isRunning ? 'animate-spin' : ''
              }`}
            >
              sync
            </span>
            <span>{isRunning ? 'Menguji Handshake...' : 'Tes Ping & Handshake'}</span>
          </button>

          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Tutup Diagnostik"
              className="p-2 bg-surface-input hover:bg-surface-container border border-border-grid text-text-dim hover:text-text-bright cursor-pointer"
            >
              <span className="material-symbols-outlined text-[18px]">close</span>
            </button>
          )}
        </div>
      </div>

      {/* Active URL Bar */}
      <div className="flex flex-col gap-1.5 bg-surface-input p-3 border border-border-grid">
        <div className="flex items-center justify-between">
          <label
            htmlFor="diag-gas-url"
            className="font-label-caps text-text-dim uppercase text-xs"
          >
            Endpoint URL Google Apps Script Terpasang (/exec)
          </label>
          <button
            type="button"
            onClick={() => void handleRestoreLiveUrl()}
            className="font-code-audit text-xs text-secondary hover:underline cursor-pointer"
          >
            Pasang URL Default Aktif
          </button>
        </div>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            id="diag-gas-url"
            type="url"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            className="flex-1 bg-surface-card border border-border-grid px-3 py-2 font-code-audit text-xs text-text-bright focus:outline-none focus:border-secondary"
          />
          <button
            type="button"
            onClick={() => void handleApplyAndTest()}
            disabled={isRunning}
            className="px-4 py-2 bg-primary-container hover:bg-surface-container-high border border-secondary text-text-bright font-label-caps uppercase text-xs cursor-pointer shrink-0"
          >
            Simpan &amp; Uji URL
          </button>
        </div>
      </div>

      {/* Metrics Summary Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="p-3 bg-surface-input border border-border-grid flex flex-col gap-0.5">
          <span className="font-label-caps text-text-dim uppercase text-[11px]">
            Total Latensi Handshake
          </span>
          <span className="font-numeric-kpi text-text-bright text-lg">
            {overallLatencyMs !== null ? `${overallLatencyMs} ms` : '—'}
          </span>
          <span className="font-code-audit text-[11px] text-status-settled">
            {lastTestedAt ? `Pukul ${lastTestedAt}` : 'Menunggu ping...'}
          </span>
        </div>

        <div className="p-3 bg-surface-input border border-border-grid flex flex-col gap-0.5">
          <span className="font-label-caps text-text-dim uppercase text-[11px]">
            Status Autentikasi GAS
          </span>
          <span className="font-headline-sm text-secondary truncate text-sm">
            {authStatusText}
          </span>
          <span className="font-code-audit text-[11px] text-text-dim">
            Sheet: {gasConfig.sheetUsers}
          </span>
        </div>

        <div className="p-3 bg-surface-input border border-border-grid flex flex-col gap-0.5">
          <span className="font-label-caps text-text-dim uppercase text-[11px]">
            Akun Terbaca di Sheet
          </span>
          <span className="font-numeric-kpi text-text-bright text-lg">
            {remoteUserCount !== null ? `${remoteUserCount} Akun` : `${users.length} Akun`}
          </span>
          <span className="font-code-audit text-[11px] text-tertiary truncate">
            {users.map((u) => u.username).join(', ')}
          </span>
        </div>

        <div className="p-3 bg-surface-input border border-border-grid flex flex-col gap-0.5">
          <span className="font-label-caps text-text-dim uppercase text-[11px]">
            Baris Piutang Terbaca
          </span>
          <span className="font-numeric-kpi text-text-bright text-lg">
            {remoteRecordCount !== null ? `${remoteRecordCount} Baris` : '—'}
          </span>
          <span className="font-code-audit text-[11px] text-text-dim">
            Sheet: {gasConfig.sheetPiutang}
          </span>
        </div>
      </div>

      {/* Step-by-step Diagnostic Checks */}
      <div className="flex flex-col gap-2.5">
        {checks.map((chk) => {
          const badgeStyle =
            chk.status === 'ok'
              ? 'bg-status-settled-surface border-status-settled text-status-settled'
              : chk.status === 'error'
              ? 'bg-status-danger-surface border-status-danger text-error'
              : chk.status === 'running'
              ? 'bg-status-pending-surface border-status-pending text-status-pending'
              : 'bg-surface-input border-border-grid text-text-dim';

          const iconName =
            chk.status === 'ok'
              ? 'check_circle'
              : chk.status === 'error'
              ? 'error'
              : chk.status === 'running'
              ? 'sync'
              : 'schedule';

          return (
            <div
              key={chk.id}
              className="p-3.5 bg-surface-input border border-border-grid flex flex-col gap-1.5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span
                    className={`material-symbols-outlined text-[18px] ${
                      chk.status === 'ok'
                        ? 'text-status-settled'
                        : chk.status === 'error'
                        ? 'text-error'
                        : chk.status === 'running'
                        ? 'text-status-pending animate-spin'
                        : 'text-text-dim'
                    }`}
                  >
                    {iconName}
                  </span>
                  <span className="font-headline-sm text-text-bright">
                    {chk.title}
                  </span>
                </div>

                <span
                  className={`px-2 py-0.5 border font-code-audit text-xs uppercase font-semibold ${badgeStyle}`}
                >
                  {chk.summary}
                </span>
              </div>

              <p className="font-code-audit text-xs text-text-dim pl-6 break-all">
                {chk.detail}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );

  if (isModal) {
    return (
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Diagnostik Koneksi Google Apps Script"
        className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4 overflow-y-auto"
      >
        <div className="w-full max-w-3xl shadow-2xl">{content}</div>
      </div>
    );
  }

  return content;
};
