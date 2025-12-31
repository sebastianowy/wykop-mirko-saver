import puppeteer, {Page} from 'puppeteer';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import archiver from 'archiver';
import nodemailer from 'nodemailer';
import Jimp from 'jimp';

const USER = process.env.USER || '';
const PASS = process.env.PASS || '';
const EMAIL_TO = process.env.EMAIL_TO || '';
const EMAIL_FROM = process.env.EMAIL_FROM || '';
const EMAIL_PASS = process.env.EMAIL_PASS || '';
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 465;

const BASE_URL = 'https://wykop.pl';
const MIRKO_URL = BASE_URL + '/mikroblog/gorace/24';
const DATE_PREFIX = new Date().toISOString().split('T')[0].replace(/-/g, '');
const PAGE_DIR = path.join(__dirname, '../output', DATE_PREFIX);
const NAME_PREFIX = `wykop_mirko`;
const NAME = `${DATE_PREFIX}_${NAME_PREFIX}`;
const ZIP_FILE_NAME = `${NAME}.zip`;
const ZIP_DIR = path.join(__dirname, '../output', 'zips');
const ZIP_PATH = path.join(ZIP_DIR, ZIP_FILE_NAME);
const PAGES_TO_SCRAPE = 4;

async function handleCookieMessage(page: Page) {
  console.log('Checking for cookie message...');
  await new Promise(r => setTimeout(r, 2000));
  const hadCoo = await page.evaluate(() => {
    const coo = document.querySelectorAll('[class^="app_gdpr"]');
    coo.forEach(el => el.remove());
    document.body.removeAttribute('style');
    return !!coo.length;
  });
  if (hadCoo) {
    await new Promise(r => setTimeout(r, 2000));
  }
  console.log(`Cookie message ${hadCoo ? 'removed' : 'not found'}.`);
}

async function scrapPageWithNext(page: Page, url: string, pageNum: number) {
  if(url !== page.url()) {
    let navigationTries = 0;
    let navigationSuccess = false;
    while (navigationTries < 2 && !navigationSuccess) {
      try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        navigationSuccess = true;
      } catch (err) {
        navigationTries++;
        if (navigationTries >= 2) throw err;
        console.warn(`Navigation to ${url} failed, retrying (${navigationTries})...`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }
  await handleCookieMessage(page);

  let reachedEnd = false;
  let currentOffset = 0;
  do {
    await page.evaluate(() => {
      const entries = Array.from(document.querySelectorAll<HTMLDivElement>('section.entry.active')).filter(el => {
        const rect = el.getBoundingClientRect();
        return (
          rect.top < window.innerHeight &&
          rect.bottom > 0 &&
          rect.left < window.innerWidth &&
          rect.right > 0
        );
      });
      entries.forEach(orig => {
        orig.querySelectorAll<HTMLButtonElement>('button.more').forEach(btn => (btn).click());
        orig.querySelectorAll<HTMLButtonElement>('.content-spoiler button').forEach(btn => (btn).click());
        const datasetKeys = Object.keys(orig.dataset);
        for (let i = 1; i < datasetKeys.length; i++) {
          delete orig.dataset[datasetKeys[i]];
        }
        const clone = orig.cloneNode(true) as HTMLElement;
        clone.classList.remove('active');
        clone.classList.add('cloned');
        clone.style.opacity = '1';
        orig.insertAdjacentHTML('beforebegin', clone.outerHTML);
        orig.remove();
      });
    });

    await new Promise(r => setTimeout(r, 600));

    await page.evaluate(() => {
        window.scrollTo(0, window.pageYOffset + window.outerHeight);
    });
    const offsetScrolled = await page.evaluate(() => (window.pageYOffset));
    console.log('Scrolled to offset:', offsetScrolled);
    if (offsetScrolled === 0) {
      await handleCookieMessage(page);
    }
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('button.more').forEach(btn => btn.click());
    });
    if (offsetScrolled === currentOffset) { reachedEnd = true; }
    currentOffset = offsetScrolled;
  } while (!reachedEnd);

  await page.evaluate((BASE_URL) => {
    document.querySelectorAll('a').forEach(btn => {
      btn.target = '_blank';
      const href = btn.getAttribute('href');
      if (href && !href.startsWith('http')) {
        btn.setAttribute('href', BASE_URL + href);
      }
    });
    document.querySelectorAll('script').forEach(s => s.remove());
    document.querySelectorAll('[class^="app_gdpr"]').forEach(el => el.remove());
    document.body.removeAttribute('style');
    document.querySelectorAll('[data-label^="ad"]').forEach(el => el.remove());
  }, BASE_URL);

  const imgHandles = await page.$$('img[src]');
  for (const imgHandle of imgHandles) {
    const src = await imgHandle.evaluate((img) => img.getAttribute('src'));
    if (src && !src.startsWith('data:')) {
      let absUrl = src;
      if (!src.startsWith('http')) {
        absUrl = new URL(src, url).href;
      }
      try {
        const response = await axios.get(absUrl, { responseType: 'arraybuffer' });
        let mimeType = response.headers['content-type'];
        let imageBuffer = Buffer.from(response.data);
        let processedBuffer = imageBuffer;
        let metadata;
        try {
          const image = await Jimp.read(imageBuffer);
          metadata = { width: image.bitmap.width, height: image.bitmap.height };
          if (metadata && (metadata.width > 1024 || metadata.height > 1024 || imageBuffer.length > 300 * 1024)) {
            processedBuffer = await image
              .resize(1024, 1024, Jimp.RESIZE_BEZIER)
              .quality(80)
              .getBufferAsync(Jimp.MIME_JPEG);
            mimeType = 'image/jpeg';
          }
        } catch {}
        if (!mimeType || !mimeType.startsWith('image/')) {
          if (absUrl.match(/\.png$/i)) mimeType = 'image/png';
          else if (absUrl.match(/\.jpe?g$/i)) mimeType = 'image/jpeg';
          else if (absUrl.match(/\.webp$/i)) mimeType = 'image/webp';
          else if (absUrl.match(/\.gif$/i)) mimeType = 'image/gif';
          else mimeType = 'image/jpeg';
        }
        const base64 = processedBuffer.toString('base64');
        const dataUrl = `data:${mimeType};base64,${base64}`;
        await imgHandle.evaluate((img, dataUrl) => {
          img.removeAttribute('srcset');
          img.src = dataUrl;
        }, dataUrl);
      } catch (e) {
        console.warn('Failed to download or convert image:', absUrl, e instanceof Error ? e.message : e);
      }
    }
  }

  const stylesheetLinks = await page.$$eval('link[rel="stylesheet"][href]', links => links.map(l => l.getAttribute('href')));
  for (const href of stylesheetLinks) {
    if (!href) continue;
    let absUrl = href;
    if (!href.startsWith('http')) {
      absUrl = new URL(href, url).href;
    }
    try {
      const response = await axios.get(absUrl);
      const css = response.data;
      await page.evaluate((href, css) => {
        const link = document.querySelector<HTMLLinkElement>(`link[rel=stylesheet][href='${href}']`);
        if (link) {
          const style = document.createElement('style');
          style.textContent = css;
          link!.parentNode?.replaceChild(style, link);
        }
      }, href, css);
    } catch (e) {
      console.warn('Failed to download stylesheet:', absUrl);
    }
  }

  const html = await page.content();
  const sanitizedHtml = html.replace(/(data:[^;]+;base64,)([A-Za-z0-9+\/=\s]+)/g, (_m, p1, p2) => p1 + p2.replace(/\s+/g, ''));

  const pageDir = PAGE_DIR;
  fs.mkdirSync(pageDir, { recursive: true });
  const fileName = `${NAME_PREFIX}_${pageNum}.html`;
  const filePath = path.join(pageDir, fileName);
  fs.mkdirSync(pageDir, { recursive: true });
  fs.writeFileSync(filePath, sanitizedHtml);
}

function zipOutput() {
  return new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(ZIP_PATH);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', () => resolve());
    archive.on('error', (err: any) => reject(err));
    archive.pipe(output);
    archive.directory(PAGE_DIR, false);
    archive.finalize();
  });
}

async function sendEmail() {
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: true,
    auth: {
      user: EMAIL_FROM,
      pass: EMAIL_PASS,
    },
    tls: {
      rejectUnauthorized: false
    }
  });
  await transporter.sendMail({
    from: EMAIL_FROM,
    to: EMAIL_TO,
    subject: `auto ${NAME}`,
    text: NAME,
    attachments: [{ filename: ZIP_FILE_NAME, path: ZIP_PATH }],
  });
}

async function login(page: Page) {
  await page.goto(MIRKO_URL, {waitUntil: 'networkidle2'});
  await handleCookieMessage(page);
  await page.click('a[href="/logowanie"]');
  await handleCookieMessage(page);
  await page.waitForSelector('.modal.login', {visible: true, timeout: 5000});
  await page.waitForSelector('.login.modal .form-group input[type=text]');
  await page.type('.login.modal .form-group input[type=text]', USER, {delay: 50});
  await page.type('.login.modal .password input[type=password]', PASS, {delay: 50});
  await page.click('.login.modal .button button[type=submit]');
  try {
    await page.waitForSelector('.modal.login', {hidden: true, timeout: 5000});
  } catch {
    await page.type('.login.modal .form-group input[type=text]', USER, {delay: 50});
    await page.type('.login.modal .form-group.password input[type=password]', PASS, {delay: 50});
    await page.click('.login.modal .button button.target');
    await page.waitForSelector('.modal.login', {hidden: true, timeout: 5000}).catch(async () => {
      await page.evaluate(() => document.querySelectorAll('#modals-container').forEach(el => el.remove()));
      console.log('Login failed after retrying. Hiding logging modal.');
    });
  }
}

(async () => {
  fs.rmSync(PAGE_DIR, { recursive: true, force: true });
  fs.mkdirSync(PAGE_DIR, { recursive: true });
  fs.mkdirSync(ZIP_DIR, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 375, height: 1800 });
  await page.emulateMediaFeatures([
    { name: 'prefers-color-scheme', value: 'dark' }
  ]);
  await login(page);
  await page.evaluate(() => {
    document.body.setAttribute('data-color-scheme', 'dark');
    document.documentElement.setAttribute('data-color-scheme', 'dark');
  });
  let url = MIRKO_URL;
  for (let i = 1; i <= PAGES_TO_SCRAPE; i++) {
    console.log(`Downloading page ${i}...`);
    await scrapPageWithNext(page, url, i);
    url = await page.$eval('.from-pagination-microblog .next a', el => el.getAttribute('href')).catch(() => null) || url;
    if (url && !url.startsWith('http')) url = new URL(url, MIRKO_URL).href;
    await new Promise(r => setTimeout(r, 2000));
  }
  console.log('Packing to ZIP...');
  await zipOutput();
  console.log('Sending e-mail...');
  await sendEmail();
  console.log('Done!');
  await browser.close();
})();