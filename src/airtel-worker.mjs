import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { sleep, saveClaimLink, logAudit, saveSessionCookies, loadSessionCookies, C } from './utils.mjs';
import { waitForOtp, waitForClaimSms, getPriorUnlockSms } from './firebase-client.mjs';

puppeteer.use(StealthPlugin());

const LOGIN_URL = "https://www.airtel.in/manage-account/login?redirect=%2Fmanage-account%2F";
const THANKS_URL = "https://www.airtel.in/thanks/";
const MOBILE_INPUT = '[data-testid="enterMobileInput"]';
const SEND_OTP_BTN = '[data-testid="sendOtpBtn"]';
const OTP_INPUTS = '[data-testid="otpInput"]';

// ============================================
// ULTRA-BULLETPROOF SCANNER (GrizzlySMS Enhanced + Zero-Leak)
// Tidak akan ada link/kode Duolingo atau Adobe yang terlewat
// ============================================
function createBulletproofScanner(page, browser, keyword, redeemPatterns) {
  let capturedUrl = '';
  const attachedPages = new WeakSet();

  // Listener untuk response jaringan di setiap page/popup
  const onResponse = async (res) => {
    try {
      const u = res.url();
      for (const pat of redeemPatterns) {
        if (pat.test(u)) { capturedUrl = u; return; }
      }
      // Tangkap body response API (GraphQL/REST) yang mengandung kode coupon / redeemUrl
      const ct = String(res.headers()['content-type'] || '').toLowerCase();
      if (ct.includes('json') || ct.includes('text') || ct.includes('javascript')) {
        const body = await res.text().catch(() => '');
        if (body && body.length > 5 && body.length < 300000) {
          // 1. Direct URL di response
          const urlMatch = body.match(/https?:\/\/(?:www\.)?duolingo\.com\/redeem\?[^"'\s\\]+/i);
          if (urlMatch) {
            capturedUrl = urlMatch[0].replace(/\\u0026/g, '&').replace(/\\\//g, '/');
            return;
          }
          if (keyword === 'adobe') {
            const adobeMatch = body.match(/https?:\/\/redeem\.adobe\.com[^"'\s\\]+/i);
            if (adobeMatch) {
              capturedUrl = adobeMatch[0].replace(/\\u0026/g, '&').replace(/\\\//g, '/');
              return;
            }
          }
          // 2. Kode promo spesifik AIRTELLIVES atau DUO
          const codeMatch = body.match(/AIRTELLIVES[A-Z0-9]{6,20}/i) || body.match(/\bDUO[A-Z0-9]{8,25}\b/i);
          if (codeMatch && keyword === 'duolingo') {
            capturedUrl = `https://www.duolingo.com/redeem?code=${codeMatch[0].toUpperCase()}`;
            return;
          }
          // 3. Field JSON couponCode / promoCode / redirectionUrl
          const jsonUrl = body.match(/"(?:redirectionUrl|redeemUrl|redirectUrl|deepLink)"\s*:\s*"([^"]+)"/i);
          if (jsonUrl && jsonUrl[1]) {
            const parsedUrl = jsonUrl[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/');
            for (const pat of redeemPatterns) {
              if (pat.test(parsedUrl)) { capturedUrl = parsedUrl; return; }
            }
          }
          const jsonCode = body.match(/"(?:couponCode|promoCode|voucherCode|coupon_code|code)"\s*:\s*"([A-Z0-9_-]{6,30})"/i);
          if (jsonCode && jsonCode[1] && !/^(SUCCESS|FAILED|PENDING|ERROR|ACTIVE|TRUE|FALSE)$/i.test(jsonCode[1])) {
            if (keyword === 'duolingo') {
              capturedUrl = `https://www.duolingo.com/redeem?code=${jsonCode[1].toUpperCase()}`;
              return;
            }
          }
        }
      }
    } catch (e) {}
  };

  const attachPageListeners = (p) => {
    if (!p || attachedPages.has(p)) return;
    attachedPages.add(p);
    try { p.on('response', onResponse); } catch (e) {}
    try {
      p.on('framenavigated', (frame) => {
        try {
          const fu = frame.url();
          for (const pat of redeemPatterns) {
            if (pat.test(fu)) { capturedUrl = fu; return; }
          }
        } catch (e) {}
      });
      p.on('request', (req) => {
        try {
          const ru = req.url();
          for (const pat of redeemPatterns) {
            if (pat.test(ru)) { capturedUrl = ru; return; }
          }
        } catch (e) {}
      });
    } catch (e) {}
  };

  // Pasang listener pada page awal
  attachPageListeners(page);

  // Listener targetcreated untuk menangkap popup / new tab
  const onTargetCreated = async (target) => {
    try {
      const tu = target.url();
      for (const pat of redeemPatterns) {
        if (pat.test(tu)) { capturedUrl = tu; return; }
      }
      const np = await target.page().catch(() => null);
      if (np) {
        attachPageListeners(np);
        const nu = np.url();
        for (const pat of redeemPatterns) {
          if (pat.test(nu)) { capturedUrl = nu; return; }
        }
      }
    } catch (e) {}
  };
  browser.on('targetcreated', onTargetCreated);

  // Scan function: cek semua layer
  const scan = async () => {
    if (capturedUrl) return capturedUrl;

    const scanDom = async (p) => {
      try {
        const domResult = await p.evaluate((kw, patterns) => {
          // 1. Cek window.__capturedRedeemUrls dari hook window.open
          if (window.__capturedRedeemUrls && window.__capturedRedeemUrls.length > 0) {
            for (const u of window.__capturedRedeemUrls) {
              for (const pat of patterns) {
                if (new RegExp(pat, 'i').test(u)) return u;
              }
              if (kw === 'duolingo' && (/duolingo.*redeem/i.test(u) || /AIRTELLIVES/i.test(u))) {
                return u;
              }
            }
          }
          const lowerKw = kw.toLowerCase();
          // 2. Link <a>
          const links = Array.from(document.querySelectorAll(`a[href*='${lowerKw}'], a[href*='redeem']`));
          for (const a of links) {
            for (const pat of patterns) {
              if (new RegExp(pat, 'i').test(a.href)) return a.href;
            }
          }
          // 3. Regex kode promo di seluruh body
          const bodyText = document.body ? (document.body.innerText || '') : '';
          let codeMatch = bodyText.match(/AIRTELLIVES[A-Z0-9]{6,20}/i) || bodyText.match(/\bDUO[A-Z0-9]{8,25}\b/i);
          if (codeMatch && lowerKw === 'duolingo') {
            return `https://www.duolingo.com/redeem?code=${codeMatch[0].toUpperCase()}`;
          }
          // 4. Input / data-code
          const inputs = Array.from(document.querySelectorAll("input, textarea, [data-code], .coupon-code, .promo-code, .code"));
          for (const inp of inputs) {
            const val = inp.value || inp.getAttribute('data-code') || inp.innerText || '';
            const m = val.match(/AIRTELLIVES[A-Z0-9]{6,20}/i) || val.match(/\bDUO[A-Z0-9]{8,25}\b/i);
            if (m && lowerKw === 'duolingo') {
              return `https://www.duolingo.com/redeem?code=${m[0].toUpperCase()}`;
            }
          }
          return null;
        }, keyword, redeemPatterns.map(p => p.source));
        if (domResult) return domResult;
      } catch (e) {}

      // Iframe di page ini
      try {
        for (const frame of p.frames()) {
          const fu = frame.url();
          for (const pat of redeemPatterns) {
            if (pat.test(fu)) return fu;
          }
          try {
            const fCode = await frame.evaluate((kw) => {
              const txt = document.body ? document.body.innerText : '';
              if (kw === 'duolingo') {
                const m = txt.match(/AIRTELLIVES[A-Z0-9]{6,20}/i) || txt.match(/\bDUO[A-Z0-9]{8,25}\b/i);
                return m ? `https://www.duolingo.com/redeem?code=${m[0].toUpperCase()}` : null;
              }
              return null;
            }, keyword);
            if (fCode) return fCode;
          } catch (e) {}
        }
      } catch (e) {}
      return null;
    };

    try {
      const currentPages = await browser.pages().catch(() => [page]);
      for (const p of currentPages) {
        attachPageListeners(p);
        try {
          const u = p.url();
          for (const pat of redeemPatterns) {
            if (pat.test(u)) return u;
          }
        } catch (e) {}
        const domHit = await scanDom(p);
        if (domHit) return domHit;
      }
    } catch (e) {}

    return capturedUrl || null;
  };

  const cleanup = () => {
    try { browser.off('targetcreated', onTargetCreated); } catch (e) {}
  };

  return { scan, cleanup, setCaptured: (u) => { capturedUrl = u; } };
}

// Klik tombol PROCEED / CLAIM / ACTIVATE setelah klaim (diperluas & presisi via CDP mouse)
async function clickProceedButton(page) {
  try {
    // 1. Cek jika ada pemilihan Billing SI / Account (bottomsheet)
    try {
      await page.evaluate(() => {
        const inactiveOptions = document.querySelectorAll('.option:not(.active)');
        if (inactiveOptions && inactiveOptions.length > 0) {
          inactiveOptions[0].click();
        }
      });
    } catch(e) {}

    // 2. Cari elemen tombol yang tepat (prioritaskan BUTTON dan A spesifik, hindari wrapper DIV)
    const selectors = [
      '.watchbtn button',
      '.watchbtn .btn',
      'button.btn',
      'button:not([disabled])',
      'a.btn',
      'a[role="button"]',
      '[role="button"]'
    ];

    for (const sel of selectors) {
      const handles = await page.$$(sel).catch(() => []);
      for (const h of handles) {
        const info = await h.evaluate(el => {
          const style = window.getComputedStyle(el);
          const isVisible = style && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && el.offsetWidth > 0 && el.offsetHeight > 0;
          const txt = (el.innerText || el.textContent || el.value || '').trim().toUpperCase();
          const disabled = el.disabled || el.classList.contains('claim-btn-disabled');
          return { isVisible, txt, tag: el.tagName, disabled };
        }).catch(() => null);

        if (!info || !info.isVisible || info.disabled) continue;

        const txt = info.txt;
        if (
          txt === 'PROCEED' || txt.includes('PROCEED') ||
          txt === 'CLAIM NOW' || txt === 'REDEEM NOW' ||
          txt === 'ACTIVATE NOW' || txt === 'CONFIRM' ||
          txt === 'GET CODE' || txt === 'COPY CODE' ||
          txt === 'CONTINUE'
        ) {
          if (txt.length < 35) {
            console.log(`  👉 [PROCEED-CLICK] Ditemukan <${info.tag}> "${txt}", klik via CDP real mouse...`);
            await h.scrollIntoViewIfNeeded().catch(() => {});
            await h.click({ delay: 60 }).catch(() => {});
            // Backup synthetic dispatch jika CDP event tertahan
            await h.evaluate(el => {
              try {
                ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(evt => {
                  el.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window }));
                });
                if (typeof el.click === 'function') el.click();
              } catch(e) {}
            }).catch(() => {});
            return true;
          }
        }
      }
    }
  } catch (e) {}

  return false;
}


export async function processAirtelNumber(number, deviceInfo, workerIndex, isHeadless, consumedKeys = new Set()) {
  let browser = null;
  let page = null;
  const result = { success: false, duolingo: null, adobe: null, error: '' };

  try {
    const launchArgs = [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', '--disable-gpu',
      '--window-size=1280,900',
      '--disable-popup-blocking',
      '--disable-web-security',
      '--allow-running-insecure-content',
      '--ignore-certificate-errors',
      '--disable-features=IsolateOrigins,site-per-process'
    ];

    const proxyUrl = process.env.PROXY_URL || '';
    if (proxyUrl) {
      let server = proxyUrl;
      try {
        const u = new URL(proxyUrl);
        server = `${u.protocol}//${u.host}`;
      } catch(e) {}
      launchArgs.push(`--proxy-server=${server}`);
    }

    browser = await puppeteer.launch({
      headless: isHeadless ? 'new' : false,
      protocolTimeout: 600000,
      args: launchArgs
    });
    page = await browser.newPage();
    if (proxyUrl) {
      try {
        const u = new URL(proxyUrl);
        if (u.username && u.password) {
          await page.authenticate({ username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) });
        }
      } catch(e) {}
    }
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Intercept window.open agar URL popup tertangkap instan walau tab belum render
    let directCapturedUrl = '';
    await page.exposeFunction('__captureRedeemUrl', (url) => {
      if (url && typeof url === 'string') {
        const u = url.trim();
        if (/duolingo/i.test(u) || /adobe/i.test(u) || /redeem/i.test(u) || /AIRTELLIVES/i.test(u) || /code=/i.test(u)) {
          directCapturedUrl = u;
        }
      }
    }).catch(() => {});

    await page.evaluateOnNewDocument(() => {
      window.__capturedRedeemUrls = window.__capturedRedeemUrls || [];
      const origOpen = window.open;
      window.open = function(url, ...args) {
        if (url) {
          try {
            window.__capturedRedeemUrls.push(String(url));
            if (window.__captureRedeemUrl) window.__captureRedeemUrl(String(url));
          } catch(e) {}
        }
        return origOpen ? origOpen.apply(this, [url, ...args]) : null;
      };
    });

    console.log(`[Worker ${workerIndex}] ${C.brightCyan}▶ Login Airtel untuk ${number} | device: ${deviceInfo.deviceId || 'unknown'}${C.reset}`);

    let isLoggedIn = false;

    // 0. Cek apakah ada session cookies tersimpan sebelumnya (pola GrizzlySMS Session Persistence)
    const savedCookies = loadSessionCookies(number);
    if (savedCookies && savedCookies.length > 0) {
      console.log(`[Worker ${workerIndex}]   ${C.brightMagenta}🔑 Ditemukan sesi login tersimpan (${savedCookies.length} cookies), memverifikasi...${C.reset}`);
      try {
        await page.setCookie(...savedCookies);
        await page.goto(THANKS_URL, { waitUntil: 'networkidle2', timeout: 35000 });
        await sleep(3000);
        const checkUrl = page.url().toLowerCase();
        if (checkUrl.includes('/thanks') && !checkUrl.includes('login') && !checkUrl.includes('otp')) {
          console.log(`[Worker ${workerIndex}]   ${C.brightGreen}✔ Sesi valid! Berhasil masuk tanpa OTP.${C.reset}`);
          isLoggedIn = true;
        } else {
          console.log(`[Worker ${workerIndex}]   ${C.yellow}⚠ Sesi tersimpan sudah kedaluwarsa, lanjut login via OTP...${C.reset}`);
          try {
            const cdp = await page.target().createCDPSession();
            await cdp.send('Network.clearBrowserCookies');
          } catch(e) {}
        }
      } catch (e) {
        console.log(`[Worker ${workerIndex}]   ${C.yellow}⚠ Gagal restore sesi: ${e.message}, lanjut login via OTP...${C.reset}`);
      }
    }

    if (!isLoggedIn) {
      // 1. Navigasi ke halaman login
      await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await sleep(1500);
      await page.waitForSelector(MOBILE_INPUT, { timeout: 15000 });

    // 2. Input nomor telepon (React native setter dispatch)
    await page.evaluate((sel, num) => {
      const input = document.querySelector(sel);
      if (input) {
        input.focus();
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(input, num);
        else input.value = num;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, MOBILE_INPUT, number);
    await sleep(500);

    // 3. Klik Send OTP
    await page.waitForSelector(SEND_OTP_BTN, { timeout: 10000 });
    let isEnabled = await page.$eval(SEND_OTP_BTN, el => !el.disabled).catch(() => false);
    if (!isEnabled) {
      await page.click(MOBILE_INPUT, { clickCount: 3 });
      await page.keyboard.press('Backspace');
      await page.type(MOBILE_INPUT, number, { delay: 40 });
      for (let i = 0; i < 10; i++) {
        isEnabled = await page.$eval(SEND_OTP_BTN, el => !el.disabled).catch(() => false);
        if (isEnabled) break;
        await sleep(300);
      }
    }
    if (!isEnabled) throw new Error('Tombol SEND OTP disabled');
    await page.click(SEND_OTP_BTN);

    // 4. Tunggu kotak OTP muncul (dengan SALVAGE RECOVERY pola GrizzlySMS asli)
    let otpBoxes = [];
    try {
      await page.waitForSelector(OTP_INPUTS, { timeout: 20000 });
      otpBoxes = await page.$$(OTP_INPUTS);
    } catch (selectorErr) {
      // Salvage recovery: navigasi ulang ke LOGIN_URL (bukan page.reload yang merusak state)
      console.log(`[Worker ${workerIndex}]   ${C.yellow}⚠ OTP selector timeout, salvage recovery (re-login)...${C.reset}`);
      try {
        await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(1500);
        await page.waitForSelector(MOBILE_INPUT, { timeout: 15000 });
        // Input ulang nomor via React setter
        await page.evaluate((sel, num) => {
          const input = document.querySelector(sel);
          if (input) {
            input.focus();
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
            if (setter) setter.call(input, num);
            else input.value = num;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }, MOBILE_INPUT, number);
        await sleep(500);
        // Klik Send OTP lagi
        await page.waitForSelector(SEND_OTP_BTN, { timeout: 10000 });
        await page.click(SEND_OTP_BTN);
        // Tunggu OTP box muncul
        await page.waitForSelector(OTP_INPUTS, { timeout: 20000 });
        otpBoxes = await page.$$(OTP_INPUTS);
      } catch (retryErr) {
        throw new Error('WAIT_OTP_SELECTOR_FAIL');
      }
    }

    // 5. Polling OTP dari Firebase Panel (single resend di detik ke-45 jika belum ada SMS, pola Grizzly)
    const otpRequestTime = Date.now();
    console.log(`[Worker ${workerIndex}] ${C.brightYellow}⏳ Menunggu OTP dari Firebase...${C.reset}`);

    // Fungsi resend: cari tombol Resend/Send OTP lalu klik (hanya dipanggil 1x oleh firebase-client)
    const resendOtp = async () => {
      const RESEND_BTN = '.lego-lr-otp-resend-container button, .lego-lr-otp-resend-container a, button[class*="resend"], [data-testid="resendOtpBtn"], [data-testid="sendOtpBtn"]';
      await page.evaluate(() => window.scrollBy(0, 300)).catch(() => {});
      await sleep(500);

      const btn = await page.$(RESEND_BTN).catch(() => null);
      if (btn) {
        const isBtnEnabled = await page.evaluate(el => !el.disabled && el.offsetParent !== null, btn).catch(() => false);
        if (isBtnEnabled) {
          await page.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }), btn).catch(() => {});
          await sleep(200);
          await btn.click();
          console.log(`[Worker ${workerIndex}] ${C.yellow}🔄 Tombol Resend OTP diklik${C.reset}`);
        } else {
          console.log(`[Worker ${workerIndex}] ${C.yellow}⚠ Tombol Resend disabled, mencoba force click...${C.reset}`);
          await page.evaluate(el => el.click(), btn).catch(() => {});
        }
      } else {
        console.log(`[Worker ${workerIndex}] ${C.yellow}⚠ Tombol Resend tidak ditemukan, mencoba Send OTP...${C.reset}`);
        await page.click(SEND_OTP_BTN).catch(() => {});
      }
      await sleep(1000);
    };

    const otpCode = await waitForOtp(
      deviceInfo.baseUrl, deviceInfo.key, deviceInfo.deviceId,
      consumedKeys, number, otpRequestTime, resendOtp
    );

    if (!otpCode) throw new Error('OTP_TIMEOUT');
    console.log(`[Worker ${workerIndex}] ${C.brightGreen}✔ OTP diterima: ${otpCode}${C.reset}`);

    // 6. Input OTP (pola GrizzlySMS asli: type per box per karakter)
    try {
      const freshBoxes = await page.$$(OTP_INPUTS).catch(() => []);
      const safeBoxes = freshBoxes.length > 0 ? freshBoxes : otpBoxes;
      if (safeBoxes.length > 0) {
        console.log(`[Worker ${workerIndex}]   ${C.cyan}⌨ Input OTP (${safeBoxes.length} boxes, ${otpCode.length} digit)...${C.reset}`);
        // Metode GrizzlySMS: click+type per box per karakter (bukan keyboard.type global)
        for (let i = 0; i < Math.min(otpCode.length, safeBoxes.length); i++) {
          await safeBoxes[i].click({ clickCount: 3 }).catch(() => {}); // Select all existing text
          await sleep(50);
          await safeBoxes[i].type(otpCode[i], { delay: 50 });
          await sleep(80);
        }
        // Jika OTP lebih panjang dari jumlah box (jarang), ketik sisanya via keyboard
        if (otpCode.length > safeBoxes.length) {
          for (let i = safeBoxes.length; i < otpCode.length; i++) {
            await page.keyboard.type(otpCode[i], { delay: 50 });
            await sleep(50);
          }
        }
      } else {
        // Fallback: focus pertama lalu keyboard type
        console.log(`[Worker ${workerIndex}]   ${C.yellow}⚠ OTP boxes kosong, pakai keyboard fallback${C.reset}`);
        await page.focus(OTP_INPUTS).catch(() => {});
        await page.keyboard.type(otpCode, { delay: 80 });
      }
    } catch (e) {
      console.log(`[Worker ${workerIndex}] ${C.yellow}\u26a0 Gagal input via keyboard: ${e.message}, coba evaluate...${C.reset}`);
      await page.evaluate((sel, code) => {
        const boxes = Array.from(document.querySelectorAll(sel));
        for (let i = 0; i < Math.min(code.length, boxes.length); i++) {
          const el = boxes[i];
          if (!el) continue;
          try {
            const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
            if (nativeSetter) nativeSetter.call(el, code[i]);
            else el.value = code[i];
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          } catch(innerErr) {}
        }
      }, OTP_INPUTS, otpCode);
    }
    await sleep(1000);

    // Tekan Enter setelah input OTP (pola GrizzlySMS asli line ~1142)
    // Ini lebih reliable daripada langsung mencari tombol verify/submit
    console.log(`[Worker ${workerIndex}]   ${C.cyan}⏎ Tekan Enter untuk submit OTP...${C.reset}`);
    await page.keyboard.press('Enter');
    await sleep(2000);

    // Fallback: kalau Enter tidak memicu navigasi, coba klik tombol Verify/Submit
    const currentUrlCheck = page.url().toLowerCase();
    if (currentUrlCheck.includes('login') || currentUrlCheck.includes('otp')) {
      const verifyBtn = await page.$('button[type="submit"], button[class*="verify"], button[class*="submit"], a[class*="verify"], [data-testid*="verify"], [data-testid*="submit"]');
      if (verifyBtn) {
        const btnText = await verifyBtn.evaluate(el => (el.innerText || '').trim().toLowerCase()).catch(() => '');
        const isDisabled = await verifyBtn.evaluate(el => el.disabled || el.getAttribute('aria-disabled') === 'true').catch(() => false);
        if (!isDisabled && (btnText.includes('verify') || btnText.includes('submit') || btnText.includes('confirm') || btnText.includes('login') || btnText === '')) {
          console.log(`[Worker ${workerIndex}]   ${C.cyan}🔘 Klik tombol verify/submit (fallback)...${C.reset}`);
          await verifyBtn.click().catch(() => {});
          await sleep(3000);
        }
      }
    }

    // Tunggu redirect otomatis setelah OTP berhasil
    try {
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
    } catch(e) {}

    // 7. Verifikasi login berhasil & simpan cookies sesi (pola GrizzlySMS Session Persistence)
    await sleep(3000);
    let currentUrl = page.url().toLowerCase();
    // KALAU MASIH DI HALAMAN LOGIN/OTP -> login gagal, tidak ada gunanya lanjut
    if (currentUrl.includes('login') || currentUrl.includes('otp')) {
      throw new Error('STILL_AT_LOGIN_AFTER_OTP: ' + currentUrl.substring(0, 80));
    }

    // Login sukses via OTP: simpan session cookies ke sessions/<number>.json
    try {
      const currentCookies = await page.cookies();
      if (currentCookies && currentCookies.length > 0) {
        saveSessionCookies(number, currentCookies);
        console.log(`[Worker ${workerIndex}]   ${C.brightGreen}💾 Sesi login berhasil disimpan ke sessions/${number}.json${C.reset}`);
      }
    } catch(e) {}

    } // Akhir blok if (!isLoggedIn)

    let currentUrl = '';
    // PROMO AIRTEL (termasuk Duolingo) ada di halaman /thanks/, BUKAN di
    // /manage-account/. Setelah login Airtel redirect ke /manage-account/ karena
    // LOGIN_URL memakai redirect=%2Fmanage-account%2F, jadi selalu lanjut ke /thanks.
    currentUrl = page.url().toLowerCase();
    if (!currentUrl.includes('/thanks')) {
      console.log(`[Worker ${workerIndex}]   ${C.cyan}↪ Navigasi ke /thanks (halaman promo)...${C.reset}`);
      await page.goto(THANKS_URL, { waitUntil: 'networkidle2', timeout: 45000 });
      await sleep(4000);
      currentUrl = page.url().toLowerCase();
    }
    // Kalau /thanks melempar balik ke login -> sesi tidak valid
    let tUrl = page.url().toLowerCase();
    console.log(`[Worker ${workerIndex}]   ${C.dim}📍 URL final: ${tUrl}${C.reset}`);
    if (tUrl.includes('login') || tUrl.includes('otp')) {
      throw new Error('REDIRECTED_TO_LOGIN_ON_THANKS: ' + tUrl.substring(0, 80));
    }
    // Airtel mengirim ke /thanks/non-thanks jika nomor tidak eligible rewards.
    // TAPI ini juga bisa terjadi kalau cookie sesi belum ter-commit saat navigasi
    // (race). Reload /thanks sekali lagi untuk memastikan verdict-nya benar.
    if (tUrl.includes('non-thanks')) {
      console.log(`[Worker ${workerIndex}]   ${C.yellow}⚠ non-thanks, reload untuk konfirmasi...${C.reset}`);
      await page.goto(THANKS_URL, { waitUntil: 'networkidle2', timeout: 45000 });
      await sleep(5000);
      tUrl = page.url().toLowerCase();
      console.log(`[Worker ${workerIndex}]   ${C.dim}📍 URL setelah reload: ${tUrl}${C.reset}`);
    }
    if (tUrl.includes('nothanks') || tUrl.includes('non-thanks') || tUrl.includes('/thanks/snap')) {
      throw new Error('NOT_ELIGIBLE');
    }
    if (!tUrl.includes('thanks')) {
      throw new Error('STUCK_AT_' + tUrl.substring(0, 60));
    }

    console.log(`[Worker ${workerIndex}] ${C.brightMagenta}🔍 Scan promo Duolingo...${C.reset}`);

    // Scroll bertahap untuk memicu lazy-loading semua kartu promo
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.4));
    await sleep(1500);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.7));
    await sleep(1500);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(2000);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.3));
    await sleep(1000);

    // 8. Cek status kartu Duolingo (error classification pola GrizzlySMS)
    const claimCheck = await page.evaluate(() => {
      const allEls = Array.from(document.querySelectorAll('*'));
      let hasClaimable = false, isAlreadyClaimed = false;
      for (const el of allEls) {
        const txt = (el.innerText || '').trim();
        if (txt.length < 10 || txt.length > 500) continue;
        const lower = txt.toLowerCase();
        if (!lower.includes('duolingo')) continue;
        if (lower.includes('xstream') || lower.includes('adobe') || lower.includes('wynk')) continue;
        if (lower.includes('manage') || lower.includes('claimed') || lower.includes('already')) { isAlreadyClaimed = true; }
        const claimBtn = el.querySelector('[class*="claimbtn"], [class*="claim-btn"]') ||
          Array.from(el.querySelectorAll('button, a, [role="button"], span, div')).find(btn => {
            const bt = (btn.innerText || '').trim().toLowerCase();
            return (bt.includes('claim') || bt.includes('get') || bt.includes('redeem') || bt.includes('activate')) &&
                   !btn.classList.contains('info-icon') && bt.length < 40;
          });
        if (claimBtn) { hasClaimable = true; break; }
      }
      if (hasClaimable) return 'READY';
      if (isAlreadyClaimed) return 'ALREADY_CLAIMED';
      return 'NO_OFFER';
    });
    console.log(`[Worker ${workerIndex}]   Status Duolingo: ${C.bold}${claimCheck === 'READY' ? C.brightGreen + 'READY TO CLAIM' : claimCheck === 'ALREADY_CLAIMED' ? C.brightYellow + 'ALREADY CLAIMED' : C.red + 'NO OFFER'}${C.reset}`);

    // Dump HTML jika NO_OFFER untuk debugging
    if (claimCheck === 'NO_OFFER') {
      try {
        const dumpUrl = page.url();
        console.log(`[Worker ${workerIndex}]   ${C.dim}📍 URL saat dump: ${dumpUrl}${C.reset}`);
        await page.waitForNetworkIdle({ idleTime: 3000, timeout: 10000 }).catch(() => {});
        await sleep(3000);
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await sleep(2000);
        await page.evaluate(() => window.scrollTo(0, 0));
        await sleep(1000);
        const htmlDump = await page.content();
        const fsMod = await import('fs');
        const pathMod = await import('path');
        const dumpDir = pathMod.default.join(process.cwd(), 'debug_dumps');
        if (!fsMod.existsSync(dumpDir)) fsMod.mkdirSync(dumpDir, { recursive: true });
        const dumpFile = pathMod.default.join(dumpDir, `dump_${number}_${Date.now()}.html`);
        fsMod.writeFileSync(dumpFile, htmlDump, 'utf8');
        console.log(`[Worker ${workerIndex}]   ${C.yellow}📄 HTML dumped: debug_dumps/${pathMod.default.basename(dumpFile)} (${htmlDump.length} chars)${C.reset}`);
      } catch(e) {
        console.log(`[Worker ${workerIndex}]   ${C.dim}⚠ Gagal dump HTML: ${e.message}${C.reset}`);
      }
    }

    // 9. Klaim Duolingo dengan 5-Layer Bulletproof Scanner + PROCEED button
    if (claimCheck === 'READY') {
      // PRE-CLAIM CHECK: kalau SMS unlock Duolingo sudah ada & berusia >2 jam,
      // subscription sudah aktif sebelum run ini — tidak perlu klik Claim
      // (Airtel tidak menampilkan ulang kode). Hemat waktu, langsung ALREADY_CLAIMED.
      try {
        const prior = await getPriorUnlockSms(
          deviceInfo.baseUrl, deviceInfo.key, deviceInfo.deviceId
        );
        if (prior) {
          console.log(`[Worker ${workerIndex}]   ${C.dim}SMS unlock Duolingo sudah ada sejak ${prior.ageHours} jam lalu${C.reset}`);
          throw new Error('ALREADY_CLAIMED');
        }
      } catch (e) {
        if (e.message === 'ALREADY_CLAIMED') throw e;
      }

      const scanner = createBulletproofScanner(page, browser, 'duolingo', [
        /duolingo.*(?:redeem|code=)/i,
        /AIRTELLIVES[A-Z0-9]{6,20}/i,
        /DUO[A-Z0-9]{8,25}/i
      ]);
      if (directCapturedUrl) scanner.setCaptured(directCapturedUrl);

      // Klik tombol Claim Now secara presisi khusus kartu Duolingo
      const clickedClaim = await page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll(".rectangle, div, section, article, [class*='card']"));
        for (const c of cards) {
          const txt = (c.innerText || '');
          const lower = txt.toLowerCase();
          // Filter ketat: Hanya kartu spesifik Duolingo
          if (lower.includes('duolingo') && !lower.includes('xstream') && !lower.includes('adobe') && !lower.includes('wynk') && txt.length < 500) {
            const btn = c.querySelector('.claimbtn, [class*="claim-btn"], [class*="claimbtn"]') ||
              Array.from(c.querySelectorAll('button, a, div, [role="button"], span'))
                .find(el => {
                  const t = (el.innerText || '').trim().toLowerCase();
                  return (t.includes('claim') || t.includes('get') || t.includes('redeem') || t.includes('activate')) && !el.classList.contains('info-icon');
                });
            if (btn) {
              btn.scrollIntoView({ behavior: 'instant', block: 'center' });
              btn.click();
              return true;
            }
          }
        }
        return false;
      });

      if (!clickedClaim) throw new Error('CLICK_CLAIM_FAIL');

      // Catat waktu klik claim untuk verifikasi SMS konfirmasi
      const claimClickTime = Date.now();

      // Tunggu navigasi dan klik PROCEED di SEMUA tab yang terbuka
      let proceedClicked = false;
      let lastProceedClick = 0;
      const proceedStart = Date.now();
      let redeemLink = '';

      while (Date.now() - proceedStart < 35000) {
        if (directCapturedUrl) { redeemLink = directCapturedUrl; break; }
        redeemLink = await scanner.scan();
        if (redeemLink) break;

        if (Date.now() - lastProceedClick > 3000) {
          const allCurrentPages = await browser.pages().catch(() => [page]);
          for (const p of allCurrentPages) {
            const clicked = await clickProceedButton(p);
            if (clicked) {
              proceedClicked = true;
              lastProceedClick = Date.now();
              console.log(`[Worker ${workerIndex}]   ${C.brightYellow}⚡ PROCEED berhasil diklik! Menunggu coupon / voucher link...${C.reset}`);
              break;
            }
          }
        }
        await sleep(500);
      }

      // Polling cepat 25 detik jika PROCEED sudah diklik tapi link belum tertangkap
      if (!redeemLink) {
        const redeemStart = Date.now();
        while (Date.now() - redeemStart < 25000) {
          if (directCapturedUrl) { redeemLink = directCapturedUrl; break; }
          redeemLink = await scanner.scan();
          if (redeemLink) break;

          if (Date.now() - lastProceedClick > 4000) {
            const allCurrentPages = await browser.pages().catch(() => [page]);
            for (const p of allCurrentPages) {
              const clicked = await clickProceedButton(p);
              if (clicked) {
                lastProceedClick = Date.now();
                break;
              }
            }
          }
          await sleep(500);
        }
      }

      // Deteksi status subscription: kalau halaman manage menampilkan
      // "Active" + validity, Duolingo kemungkinan sudah pernah diklaim.
      let activeSubInfo = null;
      const allPagesNow = await browser.pages().catch(() => [page]);
      for (const p of allPagesNow) {
        if (p.url().includes('subscription-manage')) {
          activeSubInfo = await p.evaluate(() => {
            const all = document.body ? (document.body.innerText || '') : '';
            const isActive = /\bactive\b/i.test(all);
            const valMatch = all.match(/validity[:\s]*([0-9]{1,2}-[a-z]{3}-[0-9]{2,4})/i);
            return { isActive, validity: valMatch ? valMatch[1] : '' };
          }).catch(() => null);
          if (activeSubInfo && activeSubInfo.isActive) {
            console.log(`[Worker ${workerIndex}]   ${C.dim}Subscription terlihat Active${activeSubInfo.validity ? ', validity ' + activeSubInfo.validity : ''}. Cek kode...${C.reset}`);
            break;
          }
        }
      }

      // Fallback: halaman subscription-manage sering menampilkan tombol MANAGE
      // yang membuka kode coupon. Klik MANAGE & elemen copy, lalu scan kodenya.
      if (!redeemLink) {
        for (const p of allPagesNow) {
          const pu = p.url().toLowerCase();
          if (pu.includes('subscription-manage') || pu.includes('thanks')) {
            console.log(`[Worker ${workerIndex}]   ${C.dim}Di tab (${pu.slice(0, 45)}), cari kode via MANAGE...${C.reset}`);
            try {
              await p.evaluate(() => {
                const btns = Array.from(document.querySelectorAll('button, a, div, span, [role="button"]'));
                for (const b of btns) {
                  const t = (b.innerText || '').trim().toLowerCase();
                  if (t === 'manage' || t.includes('copy') || t.includes('get code') || t.includes('redeem') || t.includes('view code')) {
                    try { b.scrollIntoView({ behavior: 'instant', block: 'center' }); b.click(); } catch (e) {}
                  }
                }
              });
              await sleep(3000);
              redeemLink = await scanner.scan();
              if (redeemLink) break;
            } catch (e) {}
          }
        }
      }

      scanner.cleanup();

      if (redeemLink) {
        saveClaimLink(redeemLink, 'duolingo', number);
        logAudit('CLAIMED', number, `SUKSES! Super Duolingo 1-Thn berhasil diklaim: ${redeemLink}`);
        result.success = true;
        result.duolingo = redeemLink;
        console.log(`[Worker ${workerIndex}] ${C.brightGreen}✔ DUOLINGO CLAIMED: ${redeemLink}${C.reset}`);

        // Cek & Klaim Adobe Express sebagai bonus ganda
        try {
          console.log(`[Worker ${workerIndex}]   ${C.cyan}Navigasi ke halaman Thanks untuk cek bonus Adobe Express...${C.reset}`);
          await page.goto(THANKS_URL, { waitUntil: 'networkidle2', timeout: 25000 });
          await sleep(2500);
          const adobeLink = await claimAdobeExpress(page, browser, number);
          if (adobeLink) {
            saveClaimLink(adobeLink, 'adobe', number);
            logAudit('ADOBE', number, `BONUS! Adobe Express Premium 12-Bln berhasil diklaim: ${adobeLink}`);
            result.adobe = adobeLink;
            console.log(`[Worker ${workerIndex}] ${C.brightGreen}✔ ADOBE CLAIMED: ${adobeLink}${C.reset}`);
          }
        } catch (e) {}
      } else {
        // Redeem link tidak tertangkap di web
        console.log(`[Worker ${workerIndex}]   ${C.dim}Link tidak tertangkap di web, cek konfirmasi SMS...${C.reset}`);
        let claimSms = null;
        try {
          claimSms = await waitForClaimSms(
            deviceInfo.baseUrl, deviceInfo.key, deviceInfo.deviceId,
            claimClickTime, 90000
          );
        } catch (e) {}

        if (claimSms) {
          const mCode = claimSms.body.match(/AIRTELLIVES[A-Z0-9]{6,20}/i) || claimSms.body.match(/\bDUO[A-Z0-9]{8,25}\b/i);
          const mUrl = claimSms.body.match(/https?:\/\/(?:www\.)?duolingo\.com\/redeem\?[^\s"']+/i);
          let finalLink = '';
          if (mUrl) finalLink = mUrl[0];
          else if (mCode) finalLink = `https://www.duolingo.com/redeem?code=${mCode[0].toUpperCase()}`;
          else {
            // SMS unlock terdeteksi tapi link belum ada, reload /thanks/ untuk membaca kupon
            console.log(`[Worker ${workerIndex}]   ${C.cyan}SMS unlock terdeteksi, reload /thanks/ untuk membaca voucher...${C.reset}`);
            try {
              await page.goto(THANKS_URL, { waitUntil: 'networkidle2', timeout: 30000 });
              await sleep(3000);
              const postReloadScanner = createBulletproofScanner(page, browser, 'duolingo', [
                /duolingo.*(?:redeem|code=)/i,
                /AIRTELLIVES[A-Z0-9]{6,20}/i,
                /DUO[A-Z0-9]{8,25}/i
              ]);
              finalLink = await postReloadScanner.scan();
              postReloadScanner.cleanup();
            } catch (e) {}
            if (!finalLink) finalLink = `[SMS-VERIFIED] ${number}`;
          }

          saveClaimLink(finalLink, 'duolingo', number);
          logAudit('CLAIMED', number, `KLAIM BERHASIL: ${finalLink}`);
          result.success = true;
          result.duolingo = finalLink;
          console.log(`[Worker ${workerIndex}] ${C.brightGreen}✔ DUOLINGO CLAIMED (SMS): ${finalLink}${C.reset}`);
        } else if (activeSubInfo && activeSubInfo.isActive) {
          console.log(`[Worker ${workerIndex}]   ${C.dim}Tidak ada SMS unlock baru + subscription Active → sudah diklaim sebelumnya${C.reset}`);
          throw new Error('ALREADY_CLAIMED');
        } else {
          // Dump diagnostik: URL semua tab + HTML halaman saat ini
          try {
            const allPages = await browser.pages();
            console.log(`[Worker ${workerIndex}]   ${C.dim}📍 Tab saat gagal (${allPages.length}): ${allPages.map(p => p.url()).join(' | ')}${C.reset}`);
            const htmlDump = await page.content();
            const fsMod = await import('fs');
            const pathMod = await import('path');
            const dumpDir = pathMod.default.join(process.cwd(), 'debug_dumps');
            if (!fsMod.existsSync(dumpDir)) fsMod.mkdirSync(dumpDir, { recursive: true });
            const dumpFile = pathMod.default.join(dumpDir, `claimfail_${number}_${Date.now()}.html`);
            fsMod.writeFileSync(dumpFile, htmlDump, 'utf8');
            console.log(`[Worker ${workerIndex}]   ${C.yellow}📄 Claim-fail dump: debug_dumps/${pathMod.default.basename(dumpFile)} (${htmlDump.length} chars)${C.reset}`);
          } catch(e) {}
          throw new Error('REDEEM_LINK_NOT_FOUND');
        }
      }
    } else if (claimCheck === 'ALREADY_CLAIMED') {
      console.log(`[Worker ${workerIndex}]   ${C.yellow}Duolingo sudah aktif, cek penawaran Adobe Express...${C.reset}`);
      const adobeLink = await claimAdobeExpress(page, browser, number);
      if (adobeLink) {
        saveClaimLink(adobeLink, 'adobe', number);
        logAudit('ADOBE', number, `BONUS! Adobe Express Premium 12-Bln berhasil diklaim: ${adobeLink}`);
        result.success = true;
        result.adobe = adobeLink;
        console.log(`[Worker ${workerIndex}] ${C.brightGreen}✔ ADOBE CLAIMED: ${adobeLink}${C.reset}`);
      } else {
        throw new Error('ALREADY_CLAIMED');
      }
    } else {
      // NO_OFFER: coba klaim Adobe Express sebagai fallback
      const adobeLink = await claimAdobeExpress(page, browser, number);
      if (adobeLink) {
        saveClaimLink(adobeLink, 'adobe');
        logAudit('ADOBE', number, 'BONUS! Adobe Express Premium 12-Bln berhasil diklaim');
        result.success = true;
        result.adobe = adobeLink;
        console.log(`[Worker ${workerIndex}] ${C.brightGreen}✔ ADOBE CLAIMED: ${adobeLink}${C.reset}`);
      } else {
        throw new Error('NO_DUOLINGO_OFFER');
      }
    }

  } catch (err) {
    // Error classification (pola GrizzlySMS)
    result.error = err.message;
    const errorMessages = {
      'SMS_TIMEOUT': 'OTP tidak masuk dalam batas waktu',
      'OTP_TIMEOUT': 'OTP tidak masuk dalam 120 detik',
      'NOT_ELIGIBLE': 'Akun Thanks Snap / Not Eligible (tidak ada paket/tier reward)',
      'ALREADY_CLAIMED': 'Promo Duolingo sudah diklaim sebelumnya',
      'NO_DUOLINGO_OFFER': 'Tidak ada penawaran Duolingo di akun ini',
      'CLICK_CLAIM_FAIL': 'Tombol klaim tidak ditemukan',
      'REDEEM_LINK_NOT_FOUND': 'Kupon luput, link tidak tertangkap',
      'WAIT_OTP_SELECTOR_FAIL': 'Web Airtel delay menampilkan form OTP',
    };
    const humanErr = errorMessages[err.message] || err.message.slice(0, 50);
    logAudit('FAILED', number, `Error: ${humanErr}`);
    console.log(`[Worker ${workerIndex}] ${C.red}✘ Gagal: ${humanErr}${C.reset}`);
  } finally {
    // Cookie clearing via CDP (pola GrizzlySMS)
    if (page) {
      try {
        const cdp = await page.target().createCDPSession();
        await cdp.send('Network.clearBrowserCookies');
        await cdp.send('Network.clearBrowserCache');
      } catch (e) {}
    }
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }
  }
  return result;
}

async function claimAdobeExpress(page, browser, number) {
  try {
    console.log(`  ${C.brightMagenta}🔍 Scan promo Adobe Express...${C.reset}`);
    const scanner = createBulletproofScanner(page, browser, 'adobe', [
      /redeem\.adobe\.com.*rc=/i
    ]);

    // Scroll bertahap untuk memicu lazy-loading kartu Adobe
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.4));
    await sleep(1500);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.7));
    await sleep(1500);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(2000);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.3));
    await sleep(1000);

    const adobeCheck = await page.evaluate(() => {
      const allEls = Array.from(document.querySelectorAll('*'));
      let hasClaimable = false, isAlreadyClaimed = false;
      for (const el of allEls) {
        const txt = (el.innerText || '').trim();
        if (txt.length < 10 || txt.length > 500) continue;
        const lower = txt.toLowerCase();
        if (!lower.includes('adobe')) continue;
        if (lower.includes('duolingo') || lower.includes('xstream') || lower.includes('wynk')) continue;
        if (lower.includes('manage') || lower.includes('claimed') || lower.includes('already')) isAlreadyClaimed = true;
        const claimBtn = el.querySelector('[class*="claimbtn"], [class*="claim-btn"]') ||
          Array.from(el.querySelectorAll('button, a, [role="button"], span, div')).find(btn => {
            const bt = (btn.innerText || '').trim().toLowerCase();
            return (bt.includes('claim') || bt.includes('get') || bt.includes('redeem') || bt.includes('activate')) &&
                   !btn.classList.contains('info-icon') && bt.length < 40;
          });
        if (claimBtn) { hasClaimable = true; break; }
      }
      if (hasClaimable) return 'READY';
      if (isAlreadyClaimed) return 'ALREADY_CLAIMED';
      return 'NO_OFFER';
    });

    console.log(`    Status Adobe: ${adobeCheck === 'READY' ? C.brightGreen + 'READY TO CLAIM' : adobeCheck === 'ALREADY_CLAIMED' ? C.brightYellow + 'ALREADY CLAIMED' : C.dim + 'NO OFFER (Tidak ada di paket nomor ini)'}${C.reset}`);

    if (adobeCheck !== 'READY') {
      scanner.cleanup();
      return null;
    }

    const clicked = await page.evaluate(() => {
      const allEls = Array.from(document.querySelectorAll('*'));
      for (const el of allEls) {
        const txt = (el.innerText || '').trim();
        if (txt.length < 10 || txt.length > 500) continue;
        const lower = txt.toLowerCase();
        if (!lower.includes('adobe')) continue;
        if (lower.includes('duolingo') || lower.includes('xstream') || lower.includes('wynk')) continue;
        const claimBtn = el.querySelector('[class*="claimbtn"], [class*="claim-btn"]') ||
          Array.from(el.querySelectorAll('button, a, [role="button"], span, div')).find(btn => {
            const bt = (btn.innerText || '').trim().toLowerCase();
            return (bt.includes('claim') || bt.includes('get') || bt.includes('redeem') || bt.includes('activate')) &&
                   !btn.classList.contains('info-icon') && bt.length < 40;
          });
        if (claimBtn) { claimBtn.scrollIntoView({behavior:'instant',block:'center'}); claimBtn.click(); return true; }
      }
      return false;
    });

    let capturedUrl = '';
    if (clicked) {
      let proceedClicked = false;
      const start = Date.now();
      while (Date.now() - start < 25000) {
        capturedUrl = await scanner.scan();
        if (capturedUrl) break;
        const allCurrentPages = await browser.pages().catch(() => [page]);
        for (const p of allCurrentPages) {
          const clicked = await clickProceedButton(p);
          if (clicked) proceedClicked = true;
        }
        await sleep(500);
      }
    }

    scanner.cleanup();
    if (capturedUrl) return capturedUrl;
  } catch(e) {}
  return null;
}
