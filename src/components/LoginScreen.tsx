import React, { useState, useEffect } from 'react';
import {
  authenticateGASUser,
  sanitizeAuthInput,
  evaluateLoginRateLimit,
  computeNextLockoutState,
  type GASUserAccount,
  type GASConfig,
} from '../utils/arLogic';
import {
  isLiveGASUrl,
  callGASPost,
} from '../utils/gasClient';

interface LoginScreenProps {
  users: GASUserAccount[];
  gasConfig: GASConfig;
  onLoginSuccess: (user: GASUserAccount) => void;
  onUpdateWebAppUrl?: (url: string) => void;
  onRegisterUser?: (user: GASUserAccount) => void;
  onRefreshGASData?: () => Promise<void>;
}

const STORAGE_FAILED_ATTEMPTS_KEY = 'ar_sec_failed_attempts';
const STORAGE_LOCK_UNTIL_KEY = 'ar_sec_lock_until';
const MAX_LOGIN_ATTEMPTS = 5;

export const LoginScreen: React.FC<LoginScreenProps> = ({
  users,
  gasConfig,
  onLoginSuccess,
}) => {
  // Login form state
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);

  // Brute-force protection state persisted in localStorage
  const [failedAttempts, setFailedAttempts] = useState<number>(() => {
    try {
      return Math.max(0, parseInt(localStorage.getItem(STORAGE_FAILED_ATTEMPTS_KEY) || '0', 10) || 0);
    } catch {
      return 0;
    }
  });

  const [lockUntilMs, setLockUntilMs] = useState<number>(() => {
    try {
      return Math.max(0, parseInt(localStorage.getItem(STORAGE_LOCK_UNTIL_KEY) || '0', 10) || 0);
    } catch {
      return 0;
    }
  });

  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  const rateLimit = evaluateLoginRateLimit(
    failedAttempts,
    lockUntilMs,
    nowMs,
    MAX_LOGIN_ATTEMPTS
  );

  // Tick timer while locked out
  useEffect(() => {
    if (lockUntilMs <= Date.now()) return;
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNowMs(current);
      if (current >= lockUntilMs) {
        window.clearInterval(timer);
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, [lockUntilMs]);

  const recordFailedAttempt = (customMessage?: string) => {
    const currentNow = Date.now();
    setNowMs(currentNow);
    const nextState = computeNextLockoutState(
      failedAttempts,
      currentNow,
      MAX_LOGIN_ATTEMPTS,
      60000
    );
    setFailedAttempts(nextState.failedAttempts);
    setLockUntilMs(nextState.lockUntilMs);
    try {
      localStorage.setItem(STORAGE_FAILED_ATTEMPTS_KEY, String(nextState.failedAttempts));
      localStorage.setItem(STORAGE_LOCK_UNTIL_KEY, String(nextState.lockUntilMs));
    } catch {
      // ignore storage errors
    }

    if (nextState.isLocked) {
      const lockSecs = Math.ceil((nextState.lockUntilMs - currentNow) / 1000);
      setErrorMsg(
        `Sistem Keamanan Aktif: Terlalu banyak percobaan gagal (${nextState.failedAttempts}x). Akses login dikunci sementara selama ${lockSecs} detik untuk mencegah serangan brute-force.`
      );
    } else {
      const rem = MAX_LOGIN_ATTEMPTS - (nextState.failedAttempts % MAX_LOGIN_ATTEMPTS);
      setErrorMsg(
        `${customMessage || 'Otentikasi ditolak: Kombinasi Username atau Kata Sandi tidak valid.'} (Sisa kesempatan: ${rem}x sebelum penguncian otomatis)`
      );
    }
  };

  const resetSecurityCounters = () => {
    setFailedAttempts(0);
    setLockUntilMs(0);
    try {
      localStorage.removeItem(STORAGE_FAILED_ATTEMPTS_KEY);
      localStorage.removeItem(STORAGE_LOCK_UNTIL_KEY);
    } catch {
      // ignore
    }
  };

  const isLiveEndpoint = isLiveGASUrl(gasConfig.webAppUrl);

  // Handle Login submission with strict security checks
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const currentNow = Date.now();
    setNowMs(currentNow);
    const currentRate = evaluateLoginRateLimit(
      failedAttempts,
      lockUntilMs,
      currentNow,
      MAX_LOGIN_ATTEMPTS
    );

    if (currentRate.isLocked) {
      setErrorMsg(
        `Akses sedang dikunci demi keamanan. Silakan tunggu ${currentRate.remainingSeconds} detik lagi.`
      );
      return;
    }

    const rawUser = username.trim();
    const rawPass = password.trim();

    if (!rawUser || !rawPass) {
      setErrorMsg('Mohon masukkan Username dan Kata Sandi resmi Anda.');
      return;
    }

    // Check for XSS / SQL / Script injection patterns
    const userSanitized = sanitizeAuthInput(rawUser);
    const passSanitized = sanitizeAuthInput(rawPass);

    if (userSanitized.isSuspicious || passSanitized.isSuspicious) {
      recordFailedAttempt(
        'Peringatan Keamanan: Terdeteksi karakter atau instruksi injeksi terlarang pada input kredensial.'
      );
      return;
    }

    const cleanUser = userSanitized.sanitized;
    const cleanPass = rawPass;

    setErrorMsg(null);
    setIsVerifying(true);

    // 1. If a real Google Apps Script Web App URL is configured, verify against GAS
    if (isLiveEndpoint) {
      const liveResp = await callGASPost<{
        status?: string;
        success?: boolean;
        user?: GASUserAccount;
        error?: string;
        message?: string;
      }>(gasConfig.webAppUrl, {
        action: 'login',
        spreadsheetId: gasConfig.spreadsheetId,
        username: cleanUser,
        password: cleanPass,
      });

      if (liveResp.ok && liveResp.data) {
        const d = liveResp.data;
        const isSuccess = d.status === 'success' || d.success === true;
        if (isSuccess && d.user) {
          resetSecurityCounters();
          setIsVerifying(false);
          onLoginSuccess(d.user);
          return;
        }
      }

      // Check synchronized users list from readAll as fallback before rejecting
      const syncedCheck = authenticateGASUser(users, cleanUser, cleanPass);
      if (syncedCheck.success && syncedCheck.user) {
        resetSecurityCounters();
        setIsVerifying(false);
        onLoginSuccess(syncedCheck.user);
        return;
      }

      setIsVerifying(false);
      recordFailedAttempt(
        'Otentikasi ditolak: Kredensial tidak cocok dengan database otorisasi.'
      );
      return;
    }

    // 2. Local / Synchronized GAS Users_Auth table verification
    await new Promise((r) => setTimeout(r, 350));
    const result = authenticateGASUser(users, cleanUser, cleanPass);
    setIsVerifying(false);

    if (result.success && result.user) {
      resetSecurityCounters();
      onLoginSuccess(result.user);
      return;
    }

    recordFailedAttempt(
      'Otentikasi ditolak: Kombinasi Username atau Kata Sandi tidak valid.'
    );
  };

  return (
    <div className="min-h-screen bg-surface text-on-surface flex flex-col justify-between relative overflow-hidden">
      {/* Top Status Header */}
      <header className="min-h-16 py-2 px-4 sm:px-6 bg-surface-card border-b border-border-grid flex items-center justify-between gap-3 z-10 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 bg-secondary-container border border-secondary flex items-center justify-center shrink-0">
            <span className="material-symbols-outlined text-text-bright text-[20px]">
              account_balance_wallet
            </span>
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-headline-md text-text-bright tracking-tight whitespace-nowrap">
                AR Tracker Pro
              </span>
              <span className="px-1.5 py-0.5 bg-surface-input border border-border-accent text-secondary font-label-caps uppercase whitespace-nowrap">
                ENTERPRISE LEDGER
              </span>
            </div>
            <span className="font-code-audit text-text-dim block truncate text-xs">
              Sistem Piutang Usaha Terintegrasi — Akses Terproteksi
            </span>
          </div>
        </div>

        {/* Header Right Security Status Badge */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-2 bg-surface-input px-3 py-1.5 border border-border-grid">
            <span className="material-symbols-outlined text-status-settled text-[16px]">
              verified_user
            </span>
            <span className="font-code-audit text-text-bright uppercase font-semibold text-xs">
              Proteksi Keamanan Aktif
            </span>
            <span
              className={`w-2 h-2 rounded-full ${
                isLiveEndpoint ? 'bg-status-settled animate-pulse' : 'bg-secondary'
              }`}
            />
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 flex items-center justify-center p-4 sm:p-6 z-10">
        <div className="w-full max-w-lg border border-border-grid bg-surface-card shadow-2xl flex flex-col">
          {/* Locked Single-Header Bar (Public Registration & GAS Config Hidden) */}
          <div className="border-b border-border-grid bg-surface-container-low px-6 py-3 flex items-center justify-between">
            <div className="flex items-center gap-2 text-text-bright font-headline-sm uppercase tracking-wide text-xs font-bold">
              <span className="material-symbols-outlined text-secondary text-[16px]">
                shield_lock
              </span>
              <span>Gerbang Otentikasi Staf Resmi</span>
            </div>
            <span className="px-2 py-0.5 bg-surface-input border border-border-grid font-code-audit text-[10px] text-status-settled uppercase font-semibold">
              Pendaftaran Publik Dikunci
            </span>
          </div>

          {/* FORM LOGIN STAF TERPROTEKSI */}
          <div className="p-6 sm:p-8 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between pb-4 border-b border-border-grid">
                <div>
                  <h1 className="font-headline-md text-text-bright uppercase tracking-wide text-lg sm:text-xl">
                    Masuk ke Sistem Piutang
                  </h1>
                  <p className="font-code-audit text-text-dim text-xs mt-0.5">
                    Masukkan Kredensial Otorisasi Resmi Anda
                  </p>
                </div>
                <div className="w-10 h-10 bg-surface-input border border-border-grid flex items-center justify-center shrink-0">
                  <span className="material-symbols-outlined text-secondary text-[24px]">
                    lock
                  </span>
                </div>
              </div>

              {/* Active Security Shield Status Banner */}
              <div className="mt-4 p-2.5 bg-surface-input border border-border-grid flex items-center justify-between flex-wrap text-xs font-code-audit gap-2">
                <div className="flex items-center gap-2">
                  <span
                    className={`w-2 h-2 shrink-0 rounded-full ${
                      rateLimit.isLocked
                        ? 'bg-status-danger animate-ping'
                        : 'bg-status-settled animate-pulse'
                    }`}
                  />
                  <span className="text-text-dim">
                    Status Proteksi:{' '}
                    <strong className="text-text-bright">
                      {rateLimit.isLocked
                        ? `Terkunci (${rateLimit.remainingSeconds}d)`
                        : 'Firewall & Anti-Bruteforce Aktif'}
                    </strong>
                  </span>
                </div>
                <span className="text-text-dim shrink-0 text-[11px]">
                  Kuota: <strong className="text-secondary">{rateLimit.remainingAttempts}/{MAX_LOGIN_ATTEMPTS}</strong>
                </span>
              </div>

              {/* Login Form */}
              <form
                onSubmit={handleSubmit}
                className="mt-5 flex flex-col gap-4"
                autoComplete="off"
              >
                {/* Lockout Banner */}
                {rateLimit.isLocked && (
                  <div
                    role="alert"
                    className="p-3.5 bg-status-danger-surface border border-status-danger text-error font-code-audit text-xs flex flex-col gap-1.5"
                  >
                    <div className="flex items-center gap-2 font-bold uppercase">
                      <span className="material-symbols-outlined text-[18px]">
                        gpp_bad
                      </span>
                      <span>Akses Login Dikunci Sementara</span>
                    </div>
                    <p className="leading-relaxed">
                      Terdeteksi {failedAttempts} kali percobaan login tidak sah. Demi mencegah peretasan akun, formulir dikunci selama{' '}
                      <strong className="underline">{rateLimit.remainingSeconds} detik</strong>.
                    </p>
                  </div>
                )}

                {/* Error Notification Alert (No Bypass or Quick Register leaked) */}
                {errorMsg && !rateLimit.isLocked && (
                  <div
                    role="alert"
                    className="p-3 bg-status-danger-surface border border-status-danger text-error font-body-sm flex items-start gap-2 text-xs sm:text-sm"
                  >
                    <span className="material-symbols-outlined text-[18px] shrink-0">
                      error
                    </span>
                    <span className="leading-snug">{errorMsg}</span>
                  </div>
                )}

                {/* Username Field */}
                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor="login-username"
                    className="font-label-caps text-text-dim uppercase flex items-center justify-between text-xs"
                  >
                    <span>Username / ID Pegawai *</span>
                    <span className="font-code-audit text-text-dim text-[11px]">
                      Terverifikasi
                    </span>
                  </label>
                  <div className="relative flex items-center bg-surface-input border border-border-grid focus-within:border-secondary">
                    <span className="material-symbols-outlined text-[18px] text-text-dim pl-3">
                      person
                    </span>
                    <input
                      id="login-username"
                      type="text"
                      value={username}
                      disabled={rateLimit.isLocked || isVerifying}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder="Masukkan ID Staf Resmi..."
                      autoComplete="username"
                      maxLength={64}
                      className="w-full h-11 px-3 bg-transparent text-text-bright font-code-audit focus:outline-none text-sm disabled:opacity-50"
                    />
                  </div>
                </div>

                {/* Password Field */}
                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor="login-password"
                    className="font-label-caps text-text-dim uppercase flex items-center justify-between text-xs"
                  >
                    <span>Password / Kata Sandi *</span>
                    <span className="font-code-audit text-text-dim text-[11px]">
                      Terenkripsi
                    </span>
                  </label>
                  <div className="relative flex items-center bg-surface-input border border-border-grid focus-within:border-secondary">
                    <span className="material-symbols-outlined text-[18px] text-text-dim pl-3">
                      key
                    </span>
                    <input
                      id="login-password"
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      disabled={rateLimit.isLocked || isVerifying}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Masukkan kata sandi..."
                      autoComplete="current-password"
                      maxLength={128}
                      className="w-full h-11 px-3 bg-transparent text-text-bright font-code-audit focus:outline-none text-sm disabled:opacity-50"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      disabled={rateLimit.isLocked}
                      aria-label={
                        showPassword
                          ? 'Sembunyikan Password'
                          : 'Tampilkan Password'
                      }
                      className="px-3 text-text-dim hover:text-text-bright cursor-pointer disabled:opacity-40"
                    >
                      <span className="material-symbols-outlined text-[18px]">
                        {showPassword ? 'visibility_off' : 'visibility'}
                      </span>
                    </button>
                  </div>
                </div>

                {/* Submit Button */}
                <button
                  type="submit"
                  disabled={isVerifying || rateLimit.isLocked}
                  className="w-full h-11 mt-2 bg-secondary-container hover:bg-on-secondary-fixed-variant text-text-bright border border-secondary font-headline-sm uppercase tracking-wider flex items-center justify-center gap-2 transition-colors cursor-pointer disabled:opacity-50 text-sm font-bold shadow-lg"
                >
                  <span className="material-symbols-outlined text-[18px]">
                    {rateLimit.isLocked
                      ? 'lock_clock'
                      : isVerifying
                      ? 'sync'
                      : 'login'}
                  </span>
                  <span>
                    {rateLimit.isLocked
                      ? `Terkunci (${rateLimit.remainingSeconds} Detik)`
                      : isVerifying
                      ? 'Memverifikasi Kredensial...'
                      : 'Masuk ke Sistem'}
                  </span>
                </button>
              </form>

              {/* Hardened Security Policy Notice */}
              <div className="mt-5 p-3 bg-surface-container-low border border-border-grid font-code-audit text-[11px] text-text-dim space-y-1">
                <div className="flex items-center gap-1.5 text-text-bright font-semibold">
                  <span className="material-symbols-outlined text-status-settled text-[15px]">
                    security
                  </span>
                  <span>Protokol Perlindungan Sistem Aktif:</span>
                </div>
                <ul className="list-disc list-inside space-y-0.5 text-[10.5px] leading-relaxed">
                  <li>Pendaftaran akun publik &amp; perubahan URL endpoint ditutup sepenuhnya.</li>
                  <li>Otentikasi dilindungi penguncian otomatis (Anti-Bruteforce) &amp; filter anti-injeksi.</li>
                  <li>Penambahan personel hanya dapat dilakukan oleh Administrator melalui bagian internal.</li>
                </ul>
              </div>
            </div>

            <div className="mt-6 pt-4 border-t border-border-grid flex items-center justify-between font-code-audit text-text-dim text-xs">
              <span>Akses Khusus Staf Terdaftar</span>
              <span className="text-secondary font-medium">SHA-256 Session Guard</span>
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="py-3 px-6 bg-surface-card border-t border-border-grid flex flex-col sm:flex-row items-center justify-between gap-2 font-code-audit text-text-dim text-xs z-10">
        <span>&copy; {new Date().getFullYear()} AR Tracker Pro — Enterprise Financial Ledger</span>
        <span>Protected Cloud Gateway</span>
      </footer>
    </div>
  );
};
