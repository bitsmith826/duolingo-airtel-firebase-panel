import fs from 'fs';
import path from 'path';

const DUO_RESULT = path.join(process.cwd(), 'duolingo_result.txt');
const DUO_SOLD = path.join(process.cwd(), 'duolingo_sold.txt');
const ADOBE_RESULT = path.join(process.cwd(), 'adobe_result.txt');
const ADOBE_SOLD = path.join(process.cwd(), 'adobe_sold.txt');

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);
}

function writeLines(file, lines) {
  const content = lines.length > 0 ? lines.join('\n') + '\n' : '';
  fs.writeFileSync(file, content, 'utf8');
}

function appendLines(file, lines) {
  if (lines.length === 0) return;
  fs.appendFileSync(file, lines.join('\n') + '\n', 'utf8');
}

function extractLink(line) {
  return line.split('|')[0].trim();
}

function showStatus() {
  const duoReady = readLines(DUO_RESULT);
  const duoSold = readLines(DUO_SOLD);
  const adobeReady = readLines(ADOBE_RESULT);
  const adobeSold = readLines(ADOBE_SOLD);

  console.log('\n======================================================');
  console.log('             📦 MANAJEMEN STOK VOUCHER                ');
  console.log('======================================================');
  console.log(`🦉 Super Duolingo 1-Tahun :`);
  console.log(`   - Ready Siap Jual      : \x1b[32m\x1b[1m${duoReady.length} voucher\x1b[0m`);
  console.log(`   - Sudah Terjual        : \x1b[33m${duoSold.length} voucher\x1b[0m`);
  console.log('');
  console.log(`🎨 Adobe Express 12-Bulan :`);
  console.log(`   - Ready Siap Jual      : \x1b[32m\x1b[1m${adobeReady.length} voucher\x1b[0m`);
  console.log(`   - Sudah Terjual        : \x1b[33m${adobeSold.length} voucher\x1b[0m`);
  console.log('======================================================');
  console.log('\nPerintah yang tersedia:');
  console.log('  node stock.mjs sell duo [jumlah]     -> Ambil voucher Duolingo & tandai terjual');
  console.log('  node stock.mjs sell adobe [jumlah]   -> Ambil voucher Adobe & tandai terjual');
  console.log('  node stock.mjs list [duo|adobe]      -> Lihat daftar link ready\n');
}

function sell(type, count = 1) {
  const isAdobe = type.toLowerCase().startsWith('ad');
  const resFile = isAdobe ? ADOBE_RESULT : DUO_RESULT;
  const soldFile = isAdobe ? ADOBE_SOLD : DUO_SOLD;
  const name = isAdobe ? 'Adobe Express Premium 12 Bulan' : 'Super Duolingo 1 Tahun';

  const readyLines = readLines(resFile);
  if (readyLines.length === 0) {
    console.log(`\n\x1b[31m❌ Stok ${name} sedang KOSONG di ${path.basename(resFile)}!\x1b[0m\n`);
    return;
  }

  const takeCount = Math.min(count, readyLines.length);
  const soldItems = readyLines.splice(0, takeCount);

  // Simpan sisa ready & append ke sold
  writeLines(resFile, readyLines);
  appendLines(soldFile, soldItems);

  console.log(`\n\x1b[32m✔ Berhasil mengambil ${takeCount} voucher ${name}!\x1b[0m`);
  console.log(`ℹ Sisa stok ready: ${readyLines.length} voucher\n`);
  console.log('------------------------------------------------------');
  console.log('📋 FORMAT SIAP KIRIM KE PEMBELI (Tinggal Copy-Paste):');
  console.log('------------------------------------------------------\n');

  soldItems.forEach((item, idx) => {
    const link = extractLink(item);
    if (!isAdobe) {
      console.log(`🎁 [VOUCHER #${idx + 1}] Super Duolingo (12 Bulan / 1 Tahun)`);
      console.log(`🔗 Link Aktivasi: ${link}`);
      console.log(`📖 Panduan Pakai:`);
      console.log(`1. Buka link aktivasi di atas lewat browser.`);
      console.log(`2. Login ke akun Duolingo Anda.`);
      console.log(`3. Klik tombol "Redeem" / "Tukarkan". Akun langsung aktif Super Duolingo!\n`);
    } else {
      console.log(`🎁 [VOUCHER #${idx + 1}] Adobe Express Premium (12 Bulan)`);
      console.log(`🔗 Link Aktivasi: ${link}`);
      console.log(`📖 Panduan Pakai: Buka link di browser, login akun Adobe Anda, lalu klaim aktivasi.\n`);
    }
  });

  console.log('------------------------------------------------------\n');
}

function list(type) {
  const isAdobe = (type || '').toLowerCase().startsWith('ad');
  const resFile = isAdobe ? ADOBE_RESULT : DUO_RESULT;
  const name = isAdobe ? 'Adobe Express' : 'Super Duolingo';
  const readyLines = readLines(resFile);

  console.log(`\n📋 Daftar Stok Ready ${name} (${readyLines.length} item):`);
  readyLines.forEach((l, i) => {
    console.log(`  ${(i + 1).toString().padStart(2, ' ')}. ${extractLink(l)}`);
  });
  console.log('');
}

// CLI Argument handling
const [cmd, arg1, arg2] = process.argv.slice(2);

if (!cmd) {
  showStatus();
} else if (cmd === 'sell') {
  const type = arg1 || 'duo';
  const count = parseInt(arg2 || '1', 10);
  sell(type, count);
} else if (cmd === 'list') {
  list(arg1 || 'duo');
} else {
  showStatus();
}
