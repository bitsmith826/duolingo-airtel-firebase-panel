FROM node:20-slim

# Install Chromium dan library dependensi yang dibutuhkan di Linux
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-freefont-ttf \
    ca-certificates \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Konfigurasi Puppeteer untuk menggunakan Chromium bawaan container
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    HEADLESS=true \
    NODE_ENV=production

WORKDIR /app

# Salin dependensi package
COPY package*.json ./

# Install dependensi
RUN npm install --omit=dev

# Salin seluruh kode proyek
COPY . .

# Jalankan bot
CMD ["node", "index.js"]
