import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASPRO_ROOT = path.dirname(HERE);
const HANA_ROOT = '/Users/junghakjun/ai_work/codex/매출대시보드/hana-ops-src';
const HTML_PATH = path.join(ASPRO_ROOT, 'aspro_v42.html');
const IMPORT_SCRIPT = path.join(HANA_ROOT, 'scripts/import-aspro-stock.mjs');
const LOG_DIR = path.join(HERE, 'logs');
const OUTPUT_PATH = path.join(LOG_DIR, 'aspro_hana_hub_stock_latest.json');
const STATUS_PATH = path.join(LOG_DIR, 'daily-recalculate-status.json');
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CONFIRM = process.argv.includes('--confirm');
const FORCE = process.argv.includes('--force');

mkdirSync(LOG_DIR, { recursive: true });

function nowKoreaDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
}

function log(message, level = 'INFO') {
  const line = `[${new Date().toISOString()}] [${level}] ${message}`;
  console.log(line);
  writeFileSync(path.join(LOG_DIR, 'daily-recalculate.log'), `${line}\n`, { flag: 'a' });
}

function previousStatus() {
  try { return JSON.parse(readFileSync(STATUS_PATH, 'utf8')); }
  catch { return null; }
}

function writeStatus(status) {
  const temp = `${STATUS_PATH}.tmp`;
  writeFileSync(temp, `${JSON.stringify(status, null, 2)}\n`);
  renameSync(temp, STATUS_PATH);
}

function runImporter(mode, payloadPath) {
  const result = spawnSync(process.execPath, [IMPORT_SCRIPT, mode, payloadPath], {
    cwd: HANA_ROOT,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      PATH: `/Users/junghakjun/google-cloud-sdk/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}`
    }
  });
  if (result.status !== 0) throw new Error(`하나허브 ${mode} 실패: ${(result.stderr || result.stdout || '').trim()}`);
  return JSON.parse(result.stdout);
}

function createLocalServer() {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
    if (pathname !== '/' && pathname !== '/aspro_v42.html') {
      response.writeHead(404).end('not found');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(readFileSync(HTML_PATH));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const today = nowKoreaDate();
const last = previousStatus();
if (!FORCE && last?.status === 'succeeded' && last?.koreaDate === today) {
  log(`오늘(${today}) 이미 성공한 계산이 있어 중복 실행을 건너뜁니다.`);
  process.exit(0);
}

let browser;
let server;
try {
  log(`일일 재고 재계산 시작 (${CONFIRM ? '운영 반영' : '검증만'})`);
  server = await createLocalServer();
  const address = server.address();
  browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--disable-dev-shm-usage', '--no-first-run']
  });
  const page = await browser.newPage();
  page.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));
  await page.goto(`http://127.0.0.1:${address.port}/aspro_v42.html`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => Boolean(window.asproAutoLoadPromise), null, { timeout: 15_000 });
  await page.evaluate(() => window.asproAutoLoadPromise);

  const sourceCounts = await page.evaluate(() => ({
    sabangOptions: sabData.length,
    ecountGroups: Object.keys(icMap).length,
    ecountCodes: new Set(Object.values(icMap).flat().map((row) => row.품목코드).filter(Boolean)).size,
    gimpoCodes: Object.keys(gpMap).length,
    kcfiOptions: Object.keys(kcfiMap).length,
    kcfiRaw: window.asproSourceMeta?.kcfiRaw || null
  }));
  if (sourceCounts.sabangOptions < 3000) throw new Error(`사방넷 원본이 부족합니다: ${sourceCounts.sabangOptions}행`);
  if (sourceCounts.ecountCodes < 1500) throw new Error(`이카운트 원본이 부족합니다: ${sourceCounts.ecountCodes}개`);
  if (sourceCounts.gimpoCodes < 500) throw new Error(`김포 원본이 부족합니다: ${sourceCounts.gimpoCodes}개`);
  if (sourceCounts.kcfiOptions < 50) throw new Error(`KCFI 원본이 부족합니다: ${sourceCounts.kcfiOptions}개`);
  if (sourceCounts.kcfiRaw?.status !== 'loaded' || sourceCounts.kcfiRaw.matched < 50) {
    throw new Error(`kcfi_원본 자동파싱을 확인해 주세요: ${JSON.stringify(sourceCounts.kcfiRaw)}`);
  }

  await page.evaluate(() => runMatch());
  const payload = await page.evaluate(() => buildHanaHubStockPayload());
  const unresolved = payload.optionRows.filter((row) => row.status === 'unmatched').length;
  if (payload.rows.length < 400 || payload.optionRows.length < 3000) {
    throw new Error(`계산 결과가 부족합니다: 상품 ${payload.rows.length} / 옵션 ${payload.optionRows.length}`);
  }
  if (unresolved / payload.optionRows.length > 0.25) {
    throw new Error(`미연결 비율이 25%를 넘어 반영을 중단합니다: ${unresolved}/${payload.optionRows.length}`);
  }

  const tempOutput = `${OUTPUT_PATH}.tmp`;
  writeFileSync(tempOutput, `${JSON.stringify(payload, null, 2)}\n`);
  renameSync(tempOutput, OUTPUT_PATH);
  const dryRun = runImporter('--dry-run', OUTPUT_PATH);
  let imported = null;
  if (CONFIRM) imported = runImporter('--confirm', OUTPUT_PATH);

  const status = {
    status: 'succeeded',
    koreaDate: today,
    finishedAt: new Date().toISOString(),
    mode: CONFIRM ? 'confirmed' : 'dry-run',
    sourceCounts,
    products: payload.rows.length,
    options: payload.optionRows.length,
    unresolved,
    calculatedAt: payload.calculatedAt,
    hanaGeneration: imported?.generationId || '',
    hanaOptionGeneration: imported?.options?.generationId || '',
    reconciliation: dryRun.reconciliation
  };
  writeStatus(status);
  log(`완료: 원본(이카운트 ${sourceCounts.ecountCodes} / 김포 ${sourceCounts.gimpoCodes} / KCFI ${sourceCounts.kcfiOptions}) → 상품 ${payload.rows.length} / 옵션 ${payload.optionRows.length} / 미연결 ${unresolved}`);
} catch (error) {
  const status = { status: 'failed', koreaDate: today, finishedAt: new Date().toISOString(), error: error.message };
  writeStatus(status);
  log(error.stack || error.message, 'ERROR');
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) await new Promise((resolve) => server.close(resolve));
}
