import puppeteer, {Page} from 'puppeteer';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import archiver from 'archiver';
import nodemailer from 'nodemailer';

const USER = process.env.USER || '';
const PASS = process.env.PASS || '';
const EMAIL_TO = process.env.EMAIL_TO || '';
const EMAIL_FROM = process.env.EMAIL_FROM || '';
const EMAIL_PASS = process.env.EMAIL_PASS || '';
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 465;

const BASE_URL = 'https://wykop.pl/mikroblog/gorace/24';
const DATE_PREFIX = new Date().toISOString().split('T')[0].replace(/-/g, '');
const PAGE_DIR = path.join(__dirname, '../output', DATE_PREFIX);
const NAME = `wykop_mirko_${DATE_PREFIX}`;
const ZIP_FILE_NAME = `${NAME}.zip`;
const ZIP_DIR = path.join(__dirname, '../output', 'zips');
const ZIP_PATH = path.join(ZIP_DIR, ZIP_FILE_NAME);
const PAGES_TO_SCRAPE = 4;

async function downloadFile(url: string, dest: string) {
  const writer = fs.createWriteStream(dest);
  const response = await axios({ url, method: 'GET', responseType: 'stream' });
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

async function handleCookieMessage(page: Page) {
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
}

async function scrapPageWithNext(page: Page, url: string, pageNum: number) {
  if(url !== page.url()) {
    await page.goto(url, { waitUntil: 'networkidle2' });
  }
  await handleCookieMessage(page);

  let reachedEnd = false;
  let currentOffset = 0;
  do {
    const processed = await page.evaluate(() => {
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
        orig.querySelectorAll<HTMLButtonElement>('button.more').forEach(btn => btn.click());
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
      return entries.length;
    });
    console.log('Processed entries:', processed);

    await new Promise(r => setTimeout(r, 600));

    await page.evaluate(() => {
        window.scrollTo(0, window.pageYOffset + window.outerHeight);
    });
    console.log('Scrolled to next');

    const offsetScrolled = await page.evaluate(() => (window.pageYOffset));
    if (offsetScrolled === currentOffset) { reachedEnd = true; }
    currentOffset = offsetScrolled;
  } while (!reachedEnd);

  await page.evaluate(() => {
    document.querySelectorAll<HTMLAnchorElement>('a').forEach(btn => btn.target = '_blank');
  });

  const html = await page.content();
  const pageDir = PAGE_DIR;
  fs.mkdirSync(pageDir, { recursive: true });
  const fileName = `wykop_mirko_${pageNum}.html`;
  const filePath = path.join(pageDir, fileName);
  fs.writeFileSync(filePath, html);
  fs.mkdirSync(pageDir, { recursive: true });
  const assetsDir = path.join(pageDir, `${pageNum}`);
  fs.mkdirSync(assetsDir, { recursive: true });

  const resources = await page.evaluate(() => {
    const toDownload: {tag: string, attr: string, url: string}[] = [];
    document.querySelectorAll('img[src]')?.forEach(img => {
      const src = img.getAttribute('src');
      if (src && !src.startsWith('http') && !src.startsWith('data:')) {
        toDownload.push({tag: 'img', attr: 'src', url: src});
      }
    });
    document.querySelectorAll('link[rel="stylesheet"][href]')?.forEach(link => {
      const href = link.getAttribute('href');
      if (href && !href.startsWith('http') && !href.startsWith('data:')) {
        toDownload.push({tag: 'link', attr: 'href', url: href});
      }
    });
    return toDownload;
  });

  const resourceMap: Record<string, string> = {};
  for (const res of resources) {
    const absUrl = new URL(res.url, url).href;
    const resName = path.basename(new URL(absUrl).pathname);
    const resPath = path.join(assetsDir, resName);
    resourceMap[res.url] = resName;
    try {
      await downloadFile(absUrl, resPath);
    } catch (e) {
      console.warn('Failed to download resource:', absUrl);
    }
  }

  const imgUrls = await page.$$eval('img', (imgs: any[], base: string) =>
    imgs.map((img: any) => img.src).filter((src: string) => src.startsWith(base)), new URL(url).origin);
  for (const imgUrl of imgUrls) {
    const imgName = path.basename(new URL(imgUrl).pathname);
    const imgPath = path.join(assetsDir, imgName);
    resourceMap[imgUrl] = imgName;
    try {
      await downloadFile(imgUrl, imgPath);
    } catch (e) {
      console.warn('Failed to download image:', imgUrl);
    }
  }

  let updatedHtml = html;
  for (const [original, local] of Object.entries(resourceMap)) {
    updatedHtml = updatedHtml.replace(new RegExp(`(["'])${original}(["'])`, 'g'), `$1${local}$2`);
  }
  fs.writeFileSync(filePath, updatedHtml);
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
    subject: NAME,
    text: NAME,
    attachments: [{ filename: ZIP_FILE_NAME, path: ZIP_PATH }],
  });
}

async function login(page: Page) {
  await page.goto(BASE_URL, {waitUntil: 'networkidle2'});
  await handleCookieMessage(page);
  await page.click('a[href="/logowanie"]');
  await handleCookieMessage(page);
  await page.waitForSelector('.modal.login', {visible: true, timeout: 5000});

  const html = await page.content();
  const pageDir = path.join(PAGE_DIR,`login`);
  fs.mkdirSync(pageDir, { recursive: true });
  const fileName = `login.html`;
  const filePath = path.join(pageDir, fileName);

  fs.writeFileSync(filePath, html);

  await page.waitForSelector('.login.modal .form-group input[type=text]');
  await page.type('.login.modal .form-group input[type=text]', USER, {delay: 50});
  await page.type('.login.modal .form-group.password input[type=password]', PASS, {delay: 50});
  await page.click('.login.modal .button button.target');
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
  await page.setViewport({ width: 800, height: 600 });
  await page.emulateMediaFeatures([
    { name: 'prefers-color-scheme', value: 'dark' }
  ]);
  await login(page);
  await page.evaluate(() => {
    document.body.setAttribute('data-color-scheme', 'dark');
    document.documentElement.setAttribute('data-color-scheme', 'dark');
  });
  let url = BASE_URL;
  for (let i = 1; i <= PAGES_TO_SCRAPE; i++) {
    console.log(`Downloading page ${i}...`);
    await scrapPageWithNext(page, url, i);
    url = await page.$eval('.from-pagination-microblog .next a', el => el.getAttribute('href')).catch(() => null) || url;
    if (url && !url.startsWith('http')) url = new URL(url, BASE_URL).href;
    await new Promise(r => setTimeout(r, 2000));
  }
  console.log('Packing to ZIP...');
  await zipOutput();
  console.log('Sending e-mail...');
  await sendEmail();
  console.log('Done!');
  await browser.close();
})();
