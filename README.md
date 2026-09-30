# DUOLINGO x AIRTEL FIREBASE PANEL WORKER 🚀

Bot otomasi canggih untuk mengambil nomor Airtel dari SMS di Firebase panel (FireX / Annebella), melakukan login otomatis ke Airtel Thanks via OTP real-time, dan mengklaim kupon promo **Super Duolingo (12 Bulan)** serta **Adobe Express Premium (12 Bulan)** secara otomatis.

> [!IMPORTANT]
> **PERNYATAAN HUKUM & TUJUAN EDUKASI (EDUCATIONAL PURPOSES ONLY):**
> Proyek ini dibuat dan dibagikan semata-mata untuk **tujuan riset, edukasi pemrograman Node.js, pemahaman protokol Chrome DevTools (CDP), dan pengujian sistem otomasi**. Segala bentuk penyalahgunaan, pelanggaran terhadap ketentuan layanan (*Terms of Service*) pihak ketiga, maupun kerugian akibat penggunaan skrip ini berada di luar tanggung jawab pembuat repository. Harap gunakan secara etis dan bertanggung jawab.

---

## ✨ Fitur Unggulan

- **Zero-Cost:** Menggunakan SMS live dari Firebase panel sendiri tanpa perlu menyewa nomor berbayar.
- **Auto Klaim Ganda (Duolingo + Adobe):** Mengklaim voucher Duolingo Super 1-Tahun dan langsung melanjutkan klaim bonus Adobe Express Premium.
- **Eksekusi PROCEED Handal:** Klik native CDP (Chrome DevTools Protocol) yang kompatibel penuh dengan React 18 SPA.
- **Sistem Deduplikasi Otomatis:** Kode kupon yang sudah pernah didapatkan tidak akan disimpan dobel ke file hasil. Nomor yang sudah berhasil otomatis di-skip pada run berikutnya.
- **Session Persistence:** Sesi login disimpan di folder `sessions/` untuk meminimalisir request OTP ulang.
- **Filter SIM Cerdas:** Mendeteksi prefix operator India (Airtel vs Jio/VI/BSNL) serta memfilter SIM mati/stale (>30 hari) agar hemat waktu.

---

## 🛠️ Persyaratan

- **Node.js 18+** ([Unduh Node.js LTS](https://nodejs.org/))
- Koneksi internet stabil

---

## 🚀 Cara Penggunaan

### 1. Instalasi
```bash
npm install
```

### 2. Konfigurasi
1. Salin file konfigurasi environment:
   ```bash
   cp .env.example .env
   ```
2. Salin template daftar panel:
   ```bash
   cp panels.example.mjs panels.mjs
   ```
   Lalu masukkan daftar URL panel Firebase milikmu ke dalam `panels.mjs`.

### 3. Menjalankan Bot
Cukup jalankan:
```bash
npm start
```
*(Atau double-click file `START.bat` di Windows)*

---

## ⚙️ Opsi Konfigurasi (`.env`)

| Variabel | Default | Keterangan |
|---|---|---|
| `HEADLESS` | `false` | `false` = Tampilkan jendela Chrome di layar, `true` = Sembunyikan di background |
| `MAX_WORKERS` | `1` | Jumlah worker pemroses paralel (disarankan 1 - 2 agar stabil) |
| `MAX_NUMBERS` | `0` | Batas nomor yang diproses per eksekusi (`0` = semua nomor yang tersedia) |

---

## 📂 Struktur File

| File / Folder | Keterangan |
|---|---|
| `index.js` | Entry point utama bot: scan panel, filter nomor, kelola antrian worker |
| `panels.mjs` | Daftar URL database panel Firebase (ditaruh di root agar mudah diedit) |
| `src/` | Folder modul inti (`airtel-worker.mjs`, `firebase-client.mjs`, `utils.mjs`, `india_series.json`) |
| `START.bat` | Shortcut sekali klik untuk menjalankan di Windows |
| `duolingo_result.txt` | Output hasil voucher Super Duolingo |
| `adobe_result.txt` | Output hasil voucher Adobe Express Premium |

---

## ⚠️ Disclaimer

Aplikasi ini ditujukan semata-mata untuk tujuan edukasi dan otomatisasi tugas pribadi. Pengguna bertanggung jawab penuh atas segala bentuk kepatuhan terhadap ketentuan layanan pihak ketiga.
