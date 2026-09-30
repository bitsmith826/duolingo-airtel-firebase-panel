import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function loadEnv() {
  try {
    const envPath = path.join(process.cwd(), '.env');
    if (!fs.existsSync(envPath)) return;
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const raw of content.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key && process.env[key] === undefined) process.env[key] = val;
    }
  } catch (_) {}
}

let seriesData = null;
function loadSeries() {
  if (seriesData) return seriesData;
  try {
    const seriesPath = path.join(__dirname, 'india_series.json');
    if (fs.existsSync(seriesPath)) {
      const raw = fs.readFileSync(seriesPath, 'utf8');
      const parsed = JSON.parse(raw);
      seriesData = parsed.series || {};
    } else {
      seriesData = {};
    }
  } catch (e) {
    seriesData = {};
  }
  return seriesData;
}

export function checkOperator(number) {
  const digits = String(number || '').replace(/\D/g, '');
  const num10 = digits.length > 10 ? digits.slice(-10) : digits;
  if (num10.length !== 10) return { op: 'unknown', circle: '', verdict: 'unknown' };

  const prefix = num10.slice(0, 4);
  const table = loadSeries();
  const info = table[prefix];
  if (!info) return { op: 'unknown', circle: '', verdict: 'unknown' };

  const op = (info.op || 'unknown').toLowerCase();
  const circle = info.circle || '';

  if (op === 'airtel') return { op, circle, verdict: 'airtel' };
  if (['jio', 'vi', 'bsnl'].includes(op)) return { op, circle, verdict: 'non-airtel' };
  return { op, circle, verdict: 'unknown' };
}

export function saveClaimLink(link, type = 'duolingo', number = '') {
  try {
    const file = type === 'adobe' ? 'adobe_result.txt' : 'duolingo_result.txt';
    const filePath = path.join(process.cwd(), file);

    const mDuo = link.match(/code=([A-Za-z0-9_-]+)/i) || link.match(/AIRTELLIVES?[A-Z0-9]+/i) || link.match(/\bDUO[A-Z0-9]+\b/i);
    const mAdobe = link.match(/rc=([A-Za-z0-9_-]+)/i);
    const code = mDuo ? (mDuo[1] || mDuo[0]) : (mAdobe ? mAdobe[1] : link.trim());

    if (fs.existsSync(filePath)) {
      const existing = fs.readFileSync(filePath, 'utf8');
      if ((code && existing.includes(code)) || existing.includes(link.trim())) {
        console.log(`  ${C.yellow}ℹ [DEDUPLIKASI] Kode voucher (${code || link}) sudah ada di ${file}, tidak disimpan ulang.${C.reset}`);
        return false;
      }
    }

    const timestamp = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    const formatted = number ? `${link} | No: ${number} | ${timestamp}` : `${link} | ${timestamp}`;
    fs.appendFileSync(filePath, `${formatted}\n`, 'utf8');

    return true;
  } catch (e) {
    return false;
  }
}

export function getClaimedNumbers(type = 'duolingo') {
  const claimed = new Set();
  try {
    const file = type === 'adobe' ? 'adobe_result.txt' : 'duolingo_result.txt';
    const filePath = path.join(process.cwd(), file);
    if (fs.existsSync(filePath)) {
      const text = fs.readFileSync(filePath, 'utf8');
      const matches = text.match(/No:\s*(\d{10})/g);
      if (matches) {
        for (const m of matches) {
          const num = m.replace(/\D/g, '').slice(-10);
          claimed.add(num);
        }
      }
    }
  } catch (e) {}
  return claimed;
}

export function logAudit(type, number, message) {
  const filePath = path.join(process.cwd(), 'audit_log.txt');
  const now = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  const line = `[${now}] ${type.padEnd(8)} | No: ${String(number || '-').padEnd(15)} | ${message}\n`;
  try {
    fs.appendFileSync(filePath, line, 'utf8');
  } catch (e) {}
}

export function saveSessionCookies(number, cookies) {
  try {
    const dir = path.join(process.cwd(), 'sessions');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${number}.json`);
    fs.writeFileSync(file, JSON.stringify(cookies, null, 2), 'utf8');
  } catch (e) {}
}

export function loadSessionCookies(number) {
  try {
    const file = path.join(process.cwd(), 'sessions', `${number}.json`);
    if (!fs.existsSync(file)) return null;
    const data = fs.readFileSync(file, 'utf8');
    const cookies = JSON.parse(data);
    return Array.isArray(cookies) && cookies.length > 0 ? cookies : null;
  } catch (e) {
    return null;
  }
}

export const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m",
  white: "\x1b[37m", brightRed: "\x1b[91m", brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m", brightMagenta: "\x1b[95m", brightCyan: "\x1b[96m", brightWhite: "\x1b[97m",
};
