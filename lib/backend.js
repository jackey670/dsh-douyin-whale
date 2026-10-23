/**
 * Douyin backend adapter: subprocess lifecycle, JSON-envelope parsing, error
 * mapping, a single-worker rate gate, credential redaction, and structured
 * logging. No Douyin signing, login protocol, or scraping logic is
 * reimplemented here — that stays in ``dy-cli`` and in the small Playwright
 * bridge that only the login state machine and the comment tool need.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

const BROWSER_CANDIDATES = [
  // Windows
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  // Linux
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium',
  // macOS
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

/**
 * Playwright's browser cache embeds a revision number
 * (``chromium-<rev>/chrome-linux64/chrome``), so its path can only be scanned,
 * never hard-coded. Returns the newest match first.
 */
function playwrightChromiumCandidates() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const roots = [
    join(home, '.cache', 'ms-playwright'),
    join(home, 'Library', 'Caches', 'ms-playwright'),
    join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'ms-playwright'),
  ];
  const layouts = [
    ['chrome-linux64', 'chrome'],
    ['chrome-linux', 'chrome'],
    ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
    ['chrome-win', 'chrome.exe'],
  ];
  const found = [];
  for (const root of roots) {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('chromium-')) continue;
      for (const layout of layouts) {
        const candidate = join(root, entry.name, ...layout);
        if (existsSync(candidate)) found.push(candidate);
      }
    }
  }
  return found.sort().reverse();
}

const ERROR_CODES = [
  'not_authenticated',
  'challenge_required',
  'rate_limited',
  'not_found',
  'parse_failed',
  'profile_in_use',
  'backend_unavailable',
];

export class DouyinError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'DouyinError';
    this.code = ERROR_CODES.includes(code) ? code : 'backend_unavailable';
    this.details = details;
  }
}

const ANSI_RE = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const stripAnsi = (text) => String(text ?? '').replace(ANSI_RE, '');

const SECRET_PATTERNS = [
  [/((?:sessionid|sessionid_ss|sid_guard|odin_tt|msToken|ttwid|passport_csrf_token|passport_auth_status|s_v_web_id|sid_tt|uid_tt|uid_tt_ss)\s*[=:]\s*)[^;&,\s"'}]+/gi, '$1<redacted>'],
  [/((?:cookie|set-cookie|authorization)\s*[:=]\s*)[^\n\r]+/gi, '$1<redacted>'],
  [/((?:localStorage|storage_state)[^\n]{0,40})["'][^"']{20,}["']/gi, '$1<redacted>'],
];

export function redact(value) {
  if (typeof value === 'string') {
    let out = value;
    for (const [re, replacement] of SECRET_PATTERNS) out = out.replace(re, replacement);
    return out;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (/^(cookie|cookies|sessionid|passport|localStorage|storage_state)$/i.test(key)) {
        out[key] = '<redacted>';
      } else {
        out[key] = redact(item);
      }
    }
    return out;
  }
  return value;
}

const clamp = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

/** Normalize the loader config with hard safety ceilings. */
export function resolveConfig(root, raw = {}) {
  const dataDir = raw.dataDir ? resolve(String(raw.dataDir)) : join(root, 'data');
  const toolKeys = ['hot', 'search', 'video', 'user', 'status', 'login', 'verify', 'comment', 'publish'];
  return {
    enabled: raw.enabled !== false,
    writesEnabled: raw.writesEnabled === true,
    toolEnabled: Object.fromEntries(
      toolKeys.map((key) => [key, raw.toolEnabled?.[key] !== false]),
    ),
    maxResults: clamp(raw.maxResults, 1, 20, 20),
    maxSearchPages: clamp(raw.maxSearchPages, 1, 3, 1),
    hourlyRequestBudget: clamp(raw.hourlyRequestBudget, 1, 500, 60),
    pageDelayMinMs: clamp(raw.pageDelayMinMs, 3000, 8000, 3000),
    pageDelayMaxMs: clamp(raw.pageDelayMaxMs, 3000, 8000, 8000),
    callDelayMinMs: clamp(raw.callDelayMinMs, 1200, 10000, 1800),
    callDelayMaxMs: clamp(raw.callDelayMaxMs, 1200, 15000, 3200),
    pythonPath: raw.pythonPath ? String(raw.pythonPath) : '',
    edgePath: raw.edgePath ? String(raw.edgePath) : '',
    logLevel: ['silent', 'error', 'info', 'debug'].includes(raw.logLevel) ? raw.logLevel : 'info',
    dataDir,
    root,
    homeDir: join(dataDir, 'home'),
    tmpDir: join(dataDir, 'tmp'),
    stateDir: join(dataDir, 'state'),
    logDir: join(dataDir, 'logs'),
    profileDir: join(dataDir, 'browser-profile'),
  };
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Box–Muller normal sample, used for human-like jitter rather than fixed sleeps. */
function gaussian(mean, stddev) {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return mean + stddev * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function jitterBetween(min, max) {
  const mid = (min + max) / 2;
  const sigma = Math.max(120, (max - min) / 4);
  return Math.min(max, Math.max(min, Math.round(gaussian(mid, sigma))));
}

function onceAbort(signal, onAbort) {
  if (!signal) return () => {};
  if (signal.aborted) {
    onAbort();
    return () => {};
  }
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

function mapErrorText(text) {
  const t = String(text ?? '');
  if (/请先登录|未登录|登录已失效|cookie\s*已失效|需要登录|重新登录/i.test(t)) return 'not_authenticated';
  if (/验证码|verify_check|verify|challenge|滑块|安全验证|人机验证/i.test(t)) return 'challenge_required';
  if (/429|rate.?limit|限流|请求频繁|操作频繁|too many/i.test(t)) return 'rate_limited';
  if (/不存在|未找到|not found|无数据|数据为空|已删除/i.test(t)) return 'not_found';
  if (/JSON|解析失败|parse|expecting|unexpected token/i.test(t)) return 'parse_failed';
  if (/profile.?in.?use|目录被占用|EBUSY|ProcessSingleton|user data directory is already in use/i.test(t)) {
    return 'profile_in_use';
  }
  return 'backend_unavailable';
}

/** Pull the dy-cli JSON envelope out of stdout that may also carry Rich progress lines. */
function extractEnvelope(stdout) {
  const clean = stripAnsi(stdout).replace(/\r\n/g, '\n');
  const lines = clean.split('\n');
  const starts = [];
  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (t === '{' || t.startsWith('{"') || t.startsWith('{ "')) starts.push(i);
  }
  for (let k = starts.length - 1; k >= 0; k -= 1) {
    const candidate = lines.slice(starts[k]).join('\n').trim();
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && 'ok' in parsed) return parsed;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

export class Backend {
  constructor(config) {
    this.config = config;
    this.lastError = null;
    this.counter = 0;
    this.logQueue = Promise.resolve();
    this.gateChain = Promise.resolve();
    this.lastAttemptAt = 0;
    this.blockedUntil = 0;
    this.backoffLevel = 0;
    this.recent = [];
    this.dyModule = null;
    this.dyModuleCheckedAt = 0;
    this.loginHint = null;
    this.detailApiBroken = false;
    this.root = config.root;
    this.bridgeScript = join(config.root, 'python', 'douyin_bridge.py');
    this.ensureDirs();
  }

  ensureDirs() {
    for (const dir of [this.config.dataDir, this.config.homeDir, this.config.tmpDir,
      this.config.stateDir, this.config.logDir, this.config.profileDir]) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /** Resolve the Python interpreter that owns dy-cli + playwright. */
  resolvePython() {
    const candidates = [];
    if (this.config.pythonPath) candidates.push(this.config.pythonPath);
    if (process.env.DOUYIN_PYTHON) candidates.push(process.env.DOUYIN_PYTHON);
    candidates.push(join(this.config.root, '.venv', 'Scripts', 'python.exe'));
    candidates.push(join(this.config.root, '.venv', 'bin', 'python'));
    for (const candidate of candidates) {
      if (candidate && existsSync(candidate)) return candidate;
    }
    return this.config.pythonPath || 'python';
  }

  /**
   * Resolve the browser binary the Playwright bridge should drive.
   *
   * Priority: ``config.edgePath`` → ``DOUYIN_BROWSER`` → ``DOUYIN_EDGE_PATH``
   * → platform defaults (Edge on Windows, Chromium/Chrome on Linux/macOS)
   * → Playwright's own download under its versioned cache directory.
   */
  resolveBrowser() {
    const explicit = [this.config.edgePath, process.env.DOUYIN_BROWSER, process.env.DOUYIN_EDGE_PATH];
    for (const candidate of explicit) {
      if (candidate && existsSync(candidate)) return candidate;
    }
    for (const candidate of BROWSER_CANDIDATES) {
      if (existsSync(candidate)) return candidate;
    }
    return playwrightChromiumCandidates()[0] ?? null;
  }

  childEnv() {
    return {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
      PYTHONUNBUFFERED: '1',
      USERPROFILE: this.config.homeDir,
      HOME: this.config.homeDir,
      TMP: this.config.tmpDir,
      TEMP: this.config.tmpDir,
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      TERM: 'dumb',
      DOUYIN_DATA_DIR: this.config.dataDir,
      DOUYIN_EDGE_PATH: this.config.edgePath || '',
      DOUYIN_BROWSER: this.config.edgePath || this.resolveBrowser() || '',
      DOUYIN_HEADLESS: process.env.DOUYIN_HEADLESS || '',
    };
  }

  /** Spawn one child and capture bounded stdout/stderr. */
  runProcess(file, args, { timeoutMs = 60000, signal, capture = true } = {}) {
    return new Promise((resolvePromise, reject) => {
      let child;
      try {
        child = spawn(file, args, {
          cwd: this.config.root,
          env: this.childEnv(),
          windowsHide: true,
          stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'ignore',
        });
      } catch (error) {
        reject(new DouyinError('backend_unavailable', `无法启动子进程：${error.message}`));
        return;
      }
      const startedAt = Date.now();
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timer;
      const cleanup = onceAbort(signal, () => {
        try { child.kill(); } catch { /* already gone */ }
      });
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        fn(value);
      };
      timer = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        finish(reject, new DouyinError(
          'backend_unavailable',
          `子进程超时（${timeoutMs}ms）：${file} ${args.slice(0, 4).join(' ')}`,
        ));
      }, timeoutMs);
      if (capture) {
        child.stdout.on('data', (chunk) => {
          if (stdout.length < 4_000_000) stdout += chunk.toString('utf8');
        });
        child.stderr.on('data', (chunk) => {
          if (stderr.length < 2_000_000) stderr += chunk.toString('utf8');
        });
      }
      child.on('error', (error) => finish(reject, new DouyinError(
        'backend_unavailable',
        `无法执行 ${file}：${error.message}`,
      )));
      child.on('close', (code) => finish(resolvePromise, {
        code: code ?? 1,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
      }));
      if (signal?.aborted) {
        try { child.kill(); } catch { /* ignore */ }
      }
    });
  }

  /** Serialize every Douyin operation through one worker. */
  runExclusive(task) {
    const next = this.gateChain.then(task);
    this.gateChain = next.then(() => undefined, () => undefined);
    return next;
  }

  quotaState() {
    const now = Date.now();
    this.recent = this.recent.filter((ts) => now - ts < 3_600_000);
    return {
      limit: this.config.hourlyRequestBudget,
      used: this.recent.length,
      remaining: Math.max(0, this.config.hourlyRequestBudget - this.recent.length),
      windowMs: 3_600_000,
    };
  }

  /**
   * Run one backend request behind the gate: hourly budget, single worker,
   * human-like spacing, exponential backoff after a rate-limit/challenge.
   */
  async guarded(tool, units, task) {
    return this.runExclusive(async () => {
      const now = Date.now();
      if (now < this.blockedUntil) {
        const retryAfterMs = this.blockedUntil - now;
        throw new DouyinError(
          'rate_limited',
          `退避中：还需等待 ${Math.ceil(retryAfterMs / 1000)} 秒（上一次触发限流/验证）。不要立即重试。`,
          { retryAfterMs },
        );
      }
      const quota = this.quotaState();
      if (quota.remaining < units) {
        throw new DouyinError(
          'rate_limited',
          `本小时请求预算已用尽（${quota.used}/${quota.limit}），请稍后再试。`,
          { retryAfterMs: 3_600_000 },
        );
      }
      const wait = this.lastAttemptAt
        ? jitterBetween(this.config.callDelayMinMs, this.config.callDelayMaxMs) - (Date.now() - this.lastAttemptAt)
        : 0;
      if (wait > 0) await sleep(wait);
      this.lastAttemptAt = Date.now();
      for (let i = 0; i < units; i += 1) this.recent.push(Date.now());
      this.counter += 1;
      const callIndex = this.counter;
      try {
        const result = await task(callIndex);
        this.backoffLevel = 0;
        return result;
      } catch (error) {
        const code = error instanceof DouyinError ? error.code : 'backend_unavailable';
        if (code === 'rate_limited' || code === 'challenge_required') {
          this.backoffLevel = Math.min(this.backoffLevel + 1, 5);
          const cooldown = Math.min(15 * 60_000, 60_000 * 2 ** (this.backoffLevel - 1));
          this.blockedUntil = Date.now() + cooldown;
        }
        throw error;
      }
    });
  }

  /** Run one dy-cli command and return the parsed envelope data. */
  async runDy(args, { tool, timeoutMs = 90000, signal, units = 1 } = {}) {
    const startedAt = Date.now();
    try {
      const out = await this.guarded(tool, units, async () => {
        const result = await this.runProcess(
          this.resolvePython(),
          ['-m', 'dy_cli.main', ...args],
          { timeoutMs, signal },
        );
        return result;
      });
      const envelope = extractEnvelope(out.stdout);
      if (out.code !== 0 || !envelope || envelope.ok !== true) {
        const raw = `${out.stderr}\n${out.stdout}`.trim();
        const code = envelope?.error?.code
          ? (ERROR_CODES.includes(envelope.error.code) ? envelope.error.code : mapErrorText(envelope.error.message))
          : mapErrorText(raw);
        const message = envelope?.error?.message
          ? String(envelope.error.message)
          : (stripAnsi(raw).split('\n').filter(Boolean).slice(-3).join(' ') || `dy ${args[0]} 失败（exit ${out.code}）`);
        throw new DouyinError(code, redact(message), { command: args[0] });
      }
      return {
        data: envelope.data,
        durationMs: Date.now() - startedAt,
        requests: units,
        stderr: redact(stripAnsi(out.stderr)),
      };
    } catch (error) {
      const wrapped = error instanceof DouyinError
        ? error
        : new DouyinError('backend_unavailable', String(error?.message ?? error));
      this.lastError = { code: wrapped.code, message: redact(wrapped.message), at: new Date().toISOString(), tool };
      this.log({ tool, command: args.slice(0, 3).join(' '), ok: false, code: wrapped.code, message: wrapped.message });
      throw wrapped;
    }
  }

  /** Search through dy-cli's own client, adding only the missing offset flag. */
  async runDyQuery(args, { tool, timeoutMs = 90000, signal, units = 1 } = {}) {
    const script = join(this.config.root, 'python', 'dy_query.py');
    const startedAt = Date.now();
    try {
      const out = await this.guarded(tool, units, () => this.runProcess(
        this.resolvePython(),
        [script, ...args],
        { timeoutMs, signal },
      ));
      const envelope = extractEnvelope(out.stdout);
      if (out.code !== 0 || !envelope || envelope.ok !== true) {
        const raw = `${out.stderr}\n${out.stdout}`.trim();
        const code = envelope?.error?.code
          ? (ERROR_CODES.includes(envelope.error.code) ? envelope.error.code : mapErrorText(envelope.error.message))
          : mapErrorText(raw);
        const message = envelope?.error?.message
          ? String(envelope.error.message)
          : (stripAnsi(raw).split('\n').filter(Boolean).slice(-3).join(' ') || `dy_query ${args[0]} 失败（exit ${out.code}）`);
        throw new DouyinError(code, redact(message), { command: args[0] });
      }
      return { data: envelope.data, durationMs: Date.now() - startedAt, requests: units };
    } catch (error) {
      const wrapped = error instanceof DouyinError
        ? error
        : new DouyinError('backend_unavailable', String(error?.message ?? error));
      this.lastError = { code: wrapped.code, message: redact(wrapped.message), at: new Date().toISOString(), tool };
      this.log({ tool, command: args.slice(0, 3).join(' '), ok: false, code: wrapped.code, message: wrapped.message });
      throw wrapped;
    }
  }

  /** Browser work shares the same single-worker gate as API work. */
  async runBrowser(command, args = [], { tool, timeoutMs = 90000, signal } = {}) {
    return this.guarded(tool, 1, () => this.runBridge(command, args, { timeoutMs, signal }));
  }

  /** Run one bridge subcommand (login state machine / browser comment). */
  async runBridge(command, args = [], { timeoutMs = 60000, signal } = {}) {
    const result = await this.runProcess(
      this.resolvePython(),
      [this.bridgeScript, command, ...args],
      { timeoutMs, signal },
    );
    const envelope = extractEnvelope(result.stdout);
    if (!envelope) {
      const message = stripAnsi(result.stderr).split('\n').filter(Boolean).slice(-3).join(' ')
        || `bridge ${command} 未返回 JSON（exit ${result.code}）`;
      throw new DouyinError(mapErrorText(message), redact(message));
    }
    if (envelope.ok !== true) {
      const code = ERROR_CODES.includes(envelope.error?.code)
        ? envelope.error.code
        : mapErrorText(envelope.error?.message);
      throw new DouyinError(code, redact(String(envelope.error?.message ?? 'bridge failed')));
    }
    return envelope.data;
  }

  readJson(path) {
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return null;
    }
  }

  writeJson(path, value) {
    const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    renameSync(tmp, path);
  }

  loginStatePath() {
    return join(this.config.stateDir, 'login.json');
  }

  accountPath() {
    return join(this.config.stateDir, 'account.json');
  }

  cookiePath() {
    return join(this.config.homeDir, '.dy', 'cookies', 'default.json');
  }

  /**
   * Liveness is judged from the daemon's own heartbeat, never from a signal
   * probe: on Windows both `os.kill(pid, 0)` (Python) and
   * `process.kill(pid, 0)` (Node/libuv) terminate the target process instead
   * of merely testing it. The bridge rewrites `updated_at` every second.
   */
  daemonFresh(state) {
    const ts = Date.parse(state?.updated_at ?? '');
    if (!Number.isFinite(ts)) return false;
    return Date.now() - ts < 6000;
  }

  loginSnapshot() {
    const state = this.readJson(this.loginStatePath());
    const alive = this.daemonFresh(state);
    const cookiePresent = existsSync(this.cookiePath());
    let authenticated = null;
    let note = null;
    if (state?.phase === 'logged_in') {
      if (cookiePresent) authenticated = true;
      else note = '登录记录存在，但 Cookie 文件缺失，需要重新登录。';
    } else if (cookiePresent) {
      note = '检测到 Cookie 文件，但本次会话尚未验证登录态（unknown，不判定为未登录）。';
    } else if (!state) {
      note = '没有登录记录，也没有 Cookie 文件；登录态未知。可以调用 douyin_login_start 扫码。';
    }
    const terminal = ['logged_in', 'expired', 'failed', 'stopped'].includes(state?.phase);
    const screenshot = state?.screenshot && existsSync(state.screenshot) ? state.screenshot : null;
    return {
      phase: state?.phase ?? 'idle',
      alive,
      daemonRunning: alive && !terminal,
      authenticated,
      cookiePresent,
      screenshot,
      sec_uid: state?.sec_uid ?? null,
      nickname: state?.nickname ?? null,
      unique_id: state?.unique_id ?? null,
      verified_via: state?.verified_via ?? null,
      started_at: state?.started_at ?? null,
      updated_at: state?.updated_at ?? null,
      note: note ?? state?.note ?? null,
      error: state?.error ?? null,
      url: state?.url ?? null,
    };
  }

  async loginStatus() {
    let bridge = null;
    let bridgeError = null;
    try {
      bridge = await this.runBridge('login-status', [], { timeoutMs: 20000 });
    } catch (error) {
      bridgeError = error instanceof DouyinError ? error.message : String(error);
    }
    const snap = this.loginSnapshot();
    if (bridge) {
      snap.phase = bridge.phase ?? snap.phase;
      snap.alive = Boolean(bridge.alive);
      snap.screenshot = bridge.screenshot ?? snap.screenshot;
      snap.sec_uid = bridge.sec_uid ?? snap.sec_uid;
      snap.nickname = bridge.nickname ?? snap.nickname;
      snap.verified_via = bridge.verified_via ?? snap.verified_via;
      snap.note = bridge.note ?? snap.note;
      snap.error = bridge.error ?? snap.error;
      if (snap.phase === 'logged_in' && bridge.cookie_present) snap.authenticated = true;
    }
    if (bridgeError) snap.note = [snap.note, `bridge: ${bridgeError}`].filter(Boolean).join(' | ');
    if (snap.authenticated && !snap.sec_uid) {
      try {
        const identity = await this.runBridge('identity', [], { timeoutMs: 120_000 });
        snap.sec_uid = identity.sec_uid ?? null;
        snap.nickname = identity.nickname ?? snap.nickname;
        snap.unique_id = identity.unique_id ?? snap.unique_id;
      } catch (error) {
        snap.note = [snap.note, `sec_uid 暂不可得: ${error.message}`].filter(Boolean).join(' | ');
      }
    }
    if (snap.authenticated && !this.readJson(this.accountPath())) {
      try {
        await this.ensureAccount();
      } catch (error) {
        snap.note = [snap.note, `账号指纹暂未建立: ${error.message}`].filter(Boolean).join(' | ');
      }
    }
    return snap;
  }

  /** Detached browser start; returns as soon as the state machine publishes a phase. */
  async loginStart({ signal } = {}) {
    const before = this.loginSnapshot();
    if (before.daemonRunning) {
      throw new DouyinError(
        'profile_in_use',
        `登录浏览器已在运行（phase=${before.phase}, pid 已持有专用 profile）。先调用 douyin_login_status 轮询，不要抢占。`,
        { phase: before.phase, screenshot: before.screenshot },
      );
    }
    if (before.phase === 'logged_in' && before.cookiePresent) {
      return { ...before, already_logged_in: true, note: '已处于登录状态，无需重新扫码。' };
    }
    const py = this.resolvePython();
    if (!existsSync(py) && py !== 'python') {
      throw new DouyinError('backend_unavailable', `Python 解释器不存在：${py}`);
    }
    if (!existsSync(this.bridgeScript)) {
      throw new DouyinError('backend_unavailable', `登录桥接脚本缺失：${this.bridgeScript}`);
    }
    const child = spawn(py, [this.bridgeScript, 'login-daemon'], {
      cwd: this.config.root,
      env: this.childEnv(),
      detached: true,
      windowsHide: false,
      stdio: 'ignore',
    });
    child.unref();
    const deadline = Date.now() + 15000;
    let current = before;
    while (Date.now() < deadline) {
      await sleep(400);
      if (signal?.aborted) break;
      current = this.loginSnapshot();
      if (current.daemonRunning && ['qrcode', 'sms_verification', 'sms_code_input', 'challenge_required', 'logged_in'].includes(current.phase)) {
        break;
      }
      if (['failed', 'expired'].includes(current.phase)) break;
    }
    return { ...current, action_required: current.phase === 'qrcode' ? 'scan_qr' : undefined };
  }

  async loginSubmit(codes, { signal } = {}) {
    const snap = this.loginSnapshot();
    if (!snap.daemonRunning) {
      throw new DouyinError('not_authenticated', '没有正在进行的登录会话，请先调用 douyin_login_start。');
    }
    const data = await this.runBridge('login-submit', ['--codes', String(codes)], {
      timeoutMs: 45000,
      signal,
    });
    return { ...this.loginSnapshot(), ...data };
  }

  /**
   * Account identity fingerprint. Prefers an irreversible digest over the
   * account's recent (title, publish time) list; falls back to hashing the
   * stable sec_uid when the works list is unavailable.
   */
  async ensureAccount({ signal } = {}) {
    const state = this.loginSnapshot();
    const rawState = this.readJson(this.loginStatePath()) ?? {};
    const stored = this.readJson(this.accountPath());
    if (!state.sec_uid) return { record: stored, currentSecUid: null, mismatch: false };
    if (stored?.sec_uid && stored.sec_uid !== state.sec_uid) {
      return {
        record: stored,
        currentSecUid: state.sec_uid,
        currentNickname: state.nickname,
        mismatch: true,
      };
    }
    if (stored?.sec_uid === state.sec_uid) {
      return { record: stored, currentSecUid: state.sec_uid, mismatch: false };
    }
    const cachedFp = typeof rawState.works_fingerprint === 'string'
      && /^[a-f0-9]{64}$/.test(rawState.works_fingerprint)
      ? rawState.works_fingerprint
      : null;
    if (cachedFp) {
      const record = {
        sec_uid: state.sec_uid,
        unique_id: rawState.unique_id ?? null,
        fingerprint: cachedFp,
        source: 'works:title+publish_time',
        samples: Number(rawState.works_count) || 0,
        nickname: state.nickname ?? null,
        created_at: new Date().toISOString(),
      };
      this.writeJson(this.accountPath(), record);
      return { record, currentSecUid: state.sec_uid, mismatch: false };
    }
    let sample = [];
    let source = 'sec_uid';
      try {
        const result = await this.runDy(
          ['profile', state.sec_uid, '--posts', '--post-count', '5', '--json-output'],
          { tool: 'account_fingerprint', timeoutMs: 60000, signal, units: 1 },
        );
        const posts = Array.isArray(result.data?.posts) ? result.data.posts : [];
        sample = posts.map((post) => [post?.desc ?? null, post?.create_time ?? null, post?.aweme_id ?? null]);
        if (sample.length > 0) source = 'works:title+publish_time';
      } catch (error) {
        this.log({ tool: 'account_fingerprint', ok: false, code: error.code, message: error.message, fallback: 'browser' });
        try {
          const captured = await this.runBrowser(
            'user',
            ['--sec-uid', state.sec_uid, '--post-limit', '5'],
            { tool: 'account_fingerprint', timeoutMs: 150_000 },
          );
          const posts = Array.isArray(captured.posts) ? captured.posts : [];
          sample = posts.map((post) => [post?.desc ?? null, post?.create_time ?? null, post?.aweme_id ?? null]);
          if (sample.length > 0) source = 'works:title+publish_time';
        } catch (browserError) {
          this.log({ tool: 'account_fingerprint', ok: false, code: browserError.code, message: browserError.message, fallback: 'sec_uid' });
        }
      }
    const basis = source === 'sec_uid'
      ? `sec_uid:${state.sec_uid}`
      : JSON.stringify(sample.sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    const record = {
      sec_uid: state.sec_uid,
      unique_id: rawState.unique_id ?? null,
      fingerprint: createHash('sha256').update(basis).digest('hex'),
      source,
      samples: sample.length,
      nickname: state.nickname ?? null,
      created_at: new Date().toISOString(),
    };
    this.writeJson(this.accountPath(), record);
    return { record, currentSecUid: state.sec_uid, mismatch: false };
  }

  /** Write operations must refuse when the fingerprint identifies another account. */
  async assertAccountMatch({ signal } = {}) {
    const check = await this.ensureAccount({ signal });
    if (check.mismatch) {
      throw new DouyinError(
        'account_mismatch',
        `当前登录账号（sec_uid 尾号 ${String(check.currentSecUid).slice(-6)}）与首次记录的账号不一致，已拒绝执行写操作。若确实要换号，请删除 data/state/account.json 后重试。`,
        { expected_tail: String(check.record?.sec_uid ?? '').slice(-6) },
      );
    }
    return check.record;
  }

  async checkDyModule() {
    const now = Date.now();
    if (this.dyModule !== null && now - this.dyModuleCheckedAt < 120000) return this.dyModule;
    this.dyModuleCheckedAt = now;
    try {
      const result = await this.runProcess(
        this.resolvePython(),
        ['-c', 'import dy_cli, playwright; print(dy_cli.__version__)'],
        { timeoutMs: 20000 },
      );
      this.dyModule = result.code === 0
        ? { ok: true, version: result.stdout.trim() }
        : { ok: false, error: redact(stripAnsi(result.stderr).slice(-500)) };
    } catch (error) {
      this.dyModule = { ok: false, error: redact(error.message) };
    }
    return this.dyModule;
  }

  async status({ signal } = {}) {
    const login = await this.loginStatus();
    const dy = await this.checkDyModule();
    const python = this.resolvePython();
    const edge = this.resolveBrowser();
    const quota = this.quotaState();
    const account = this.readJson(this.accountPath());
    let mismatch = false;
    if (account?.sec_uid && login.sec_uid && account.sec_uid !== login.sec_uid) mismatch = true;
    const problems = [];
    if (!existsSync(python) && python !== 'python') problems.push(`Python 不存在：${python}`);
    if (!dy.ok) problems.push('dy-cli / playwright 未就绪');
    if (!edge) problems.push('未找到可用浏览器（Edge / Chromium）');
    if (!existsSync(this.bridgeScript)) problems.push('登录桥接脚本缺失');
    if (mismatch) problems.push('账号指纹不匹配（写操作已禁用）');
    if (this.lastError?.code === 'challenge_required') {
      problems.push('触发人机验证：请在专用 Edge 窗口手动完成后重试（可调用 douyin_verify）');
    }
    if (!login.authenticated) problems.push('登录态未确认（只读搜索/详情可能需要先扫码）');
    let summary;
    if (problems.length === 0 && login.authenticated) {
      summary = '可用：后端就绪，登录态已确认。';
    } else if (!dy.ok) {
      summary = '不可用：Python 依赖未安装（见 README 的安装步骤）。';
    } else if (!login.authenticated) {
      summary = login.cookiePresent
        ? '部分可用：热榜可读；登录态未验证，搜索/详情可能失败。调用 douyin_login_status 或 douyin_login_start。'
        : '部分可用：热榜可读；尚未登录，搜索/详情需要先调用 douyin_login_start 扫码。';
    } else {
      summary = `可用但有提示：${problems.join('；')}`;
    }
    return {
      summary,
      authenticated: login.authenticated,
      login,
      backend: {
        python,
        python_exists: existsSync(python) || python === 'python',
        dy_cli: dy,
        bridge_script: this.bridgeScript,
        edge: edge ?? null,
        profile_dir: this.config.profileDir,
      },
      quota,
      account: account ? {
        fingerprint: account.fingerprint,
        source: account.source,
        samples: account.samples,
        nickname: account.nickname,
        sec_uid_tail: String(account.sec_uid ?? '').slice(-6),
        mismatch,
      } : null,
      config: {
        writesEnabled: this.config.writesEnabled,
        maxResults: this.config.maxResults,
        maxSearchPages: this.config.maxSearchPages,
        hourlyRequestBudget: this.config.hourlyRequestBudget,
      },
      last_error: this.lastError,
      problems,
    };
  }

  log(entry) {
    if (this.config.logLevel === 'silent') return;
    const record = redact({
      ts: new Date().toISOString(),
      ...entry,
    });
    const line = `${JSON.stringify(record)}\n`;
    try {
      const file = join(this.config.logDir, `douyin-${new Date().toISOString().slice(0, 10)}.log`);
      appendFileSync(file, line, 'utf8');
    } catch {
      /* logging must never break a tool call */
    }
  }

  noteRequest(tool, info) {
    this.log({ tool, ok: true, ...info });
  }

  dispose() {
    this.recent = [];
  }
}

export { ERROR_CODES, jitterBetween, sleep, stripAnsi };
