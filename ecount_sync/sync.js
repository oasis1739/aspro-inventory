// ASPRO 이카운트 재고 → 구글시트 이카운트원본 매일 동기화
// 실행: node sync.js   (dry-run: node sync.js --dry-run)
//
// 이카운트 OAPI 제약:
//   - 재고현황(단건) API만 검증됨 → 품목 1개씩 호출 필요
//   - 1초/호출 (실서버), 1일 5000건, 시간당 오류 30건
//
// 흐름:
//   1) Zone 조회 → 로그인 → SESSION_ID
//   2) 「이카운트원본」 시트에서 기존 PROD_CD 목록 추출 (마스터데이터 유지용)
//   3) 각 PROD_CD에 대해 단건 API 호출 → BAL_QTY 수집 (1.2초 간격)
//   4) 기존 행의 재고 컬럼(F)만 업데이트, 다른 컬럼은 보존
//   5) Apps Script로 시트 업로드

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const DRY_RUN = process.argv.includes('--dry-run');
const UPLOAD_ONLY = process.argv.includes('--upload-only'); // 백업 JSON으로 시트 업로드만
const LIMIT_ARG = process.argv.find(a => a.startsWith('--limit='));
const LIMIT = LIMIT_ARG ? parseInt(LIMIT_ARG.split('=')[1]) : 0; // 0=전체

const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);

const {
  ECOUNT_COM_CODE,
  ECOUNT_USER_ID,
  ECOUNT_API_CERT_KEY,
  ECOUNT_PASSWORD,
  SHEETS_WEBAPP_URL,
  ECOUNT_INVENTORY_API_PATH = '/OAPI/V2/InventoryBalance/ViewInventoryBalanceStatus',
  ECOUNT_TEST_MODE = 'false',
  ECOUNT_RATE_MS = '1200',  // 호출 간격 (ms)
  SHEET_ID = '1cl-uZ9s0_VNF_YwagnujAhPTdREuzfcaPisWRRp7zwY',
} = process.env;

const IS_TEST = String(ECOUNT_TEST_MODE).toLowerCase() === 'true';
const apiHost = (zone) => `https://${IS_TEST ? 'sboapi' : 'oapi'}${zone}.ecount.com`;
const ZONE_HOST = IS_TEST ? 'https://sboapi.ecount.com' : 'https://oapi.ecount.com';
const RATE_MS = parseInt(ECOUNT_RATE_MS);

function log(msg, level = 'info') {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level.toUpperCase()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(path.join(LOG_DIR, 'sync.log'), line + '\n');
}

function die(msg) { log(msg, 'error'); process.exit(1); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function requireEnv(name, val) {
  if (!val || String(val).includes('여기에_')) die(`.env 누락 또는 미입력: ${name}`);
}

// ── 0. 기존 시트 읽기 ──
async function loadExistingSheet() {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&headers=0&sheet=${encodeURIComponent('이카운트원본')}&cb=${Date.now()}`;
  const res = await fetch(url);
  if (!res.ok) die(`시트 읽기 실패: ${res.status}`);
  const csv = await res.text();
  // CSV → 2D array (간단 파서, 쉼표/따옴표 처리)
  const rows = [];
  const lines = csv.split(/\r?\n/);
  for (const line of lines) {
    if (line === '') { rows.push([]); continue; }
    const cells = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) {
        if (c === '"' && line[i+1] === '"') { cur += '"'; i++; }
        else if (c === '"') inQ = false;
        else cur += c;
      } else {
        if (c === '"') inQ = true;
        else if (c === ',') { cells.push(cur); cur = ''; }
        else cur += c;
      }
    }
    cells.push(cur);
    rows.push(cells);
  }
  log(`기존 시트 ${rows.length}행 로드`);
  return rows;
}

// ── 1. Zone 조회 ──
async function fetchZone() {
  const res = await fetch(`${ZONE_HOST}/OAPI/V2/Zone`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({COM_CODE: ECOUNT_COM_CODE}),
  });
  const d = await res.json();
  if (!d?.Data?.ZONE) die(`Zone 조회 실패: ${JSON.stringify(d)}`);
  log(`Zone: ${d.Data.ZONE}`);
  return d.Data;
}

// ── 2. 로그인 ──
async function login(zone) {
  const url = `${apiHost(zone.ZONE)}/OAPI/V2/OAPILogin`;
  const body = {
    COM_CODE: ECOUNT_COM_CODE, USER_ID: ECOUNT_USER_ID,
    API_CERT_KEY: ECOUNT_API_CERT_KEY, LAN_TYPE: 'ko-KR',
    ZONE: zone.ZONE, PASSWORD: ECOUNT_PASSWORD,
  };
  const res = await fetch(url, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)});
  const d = await res.json();
  const sid = d?.Data?.Datas?.SESSION_ID;
  if (!sid) die(`로그인 실패: ${JSON.stringify(d)}`);
  log(`로그인 성공`);
  return sid;
}

// ── 3. 재고 단건 조회 (재시도 포함) ──
async function fetchSingleStock(zone, sid, prodCd, baseDate, retries = 3) {
  const url = `${apiHost(zone.ZONE)}${ECOUNT_INVENTORY_API_PATH}?SESSION_ID=${sid}`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({BASE_DATE: baseDate, PROD_CD: prodCd}),
      });
      const txt = await res.text();
      // HTML 응답 (rate limit / 서버에러) 감지
      if (txt.trim().startsWith('<')) {
        if (attempt < retries) {
          await sleep(3000 * attempt); // 지수 백오프
          continue;
        }
        return { error: `HTML 응답 (${res.status})` };
      }
      let d;
      try { d = JSON.parse(txt); }
      catch(e) {
        if (attempt < retries) { await sleep(2000); continue; }
        return { error: `JSON 파싱 실패: ${txt.slice(0,80)}` };
      }
      if (d?.Errors) return { error: d.Errors[0]?.Message };
      const result = d?.Data?.Result || [];
      if (result.length === 0) return { qty: 0, found: false };
      return { qty: Number(result[0].BAL_QTY || 0), found: true };
    } catch(e) {
      if (attempt < retries) { await sleep(2000); continue; }
      return { error: `fetch 실패: ${e.message}` };
    }
  }
  return { error: '재시도 한도 초과' };
}

// ── 시트 업로드 (재시도 + HTML 응답 감지) ──
async function uploadWithRetry(rows, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    log(`Apps Script로 시트 업로드 중 (시도 ${attempt}/${retries})...`);
    try {
      const res = await fetch(SHEETS_WEBAPP_URL, {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ icRawUpload: { rows } }),
        redirect: 'follow',
      });
      const txt = await res.text();
      if (txt.trim().startsWith('<')) {
        log(`업로드 응답이 HTML (Apps Script 배포가 "Anyone" 미설정?) ─ 응답앞 200자: ${txt.slice(0,200)}`, 'warn');
        if (attempt < retries) { await sleep(3000); continue; }
        die('업로드 실패 — Apps Script Web App 배포 권한이 "모든 사용자"로 되어있는지 확인');
      }
      const json = JSON.parse(txt);
      if (!json?.ok) {
        if (attempt < retries) { await sleep(3000); continue; }
        die(`업로드 실패: ${JSON.stringify(json)}`);
      }
      log(`✅ 시트 업로드 완료: ${json.saved}행`);
      return;
    } catch(e) {
      if (attempt < retries) { log(`업로드 예외: ${e.message} — 재시도`, 'warn'); await sleep(3000); continue; }
      die(`업로드 예외 최종: ${e.message}`);
    }
  }
}

// ── 4. 메인 ──
(async () => {
  try {
    // upload-only: 백업 JSON으로 시트 업로드만 재시도
    if (UPLOAD_ONLY) {
      requireEnv('SHEETS_WEBAPP_URL', SHEETS_WEBAPP_URL);
      const backupPath = path.join(LOG_DIR, 'last_collected.json');
      if (!fs.existsSync(backupPath)) die(`백업 파일 없음: ${backupPath}`);
      const rows = JSON.parse(fs.readFileSync(backupPath, 'utf-8'));
      log(`=== UPLOAD-ONLY 모드: ${rows.length}행 ===`);
      await uploadWithRetry(rows);
      log('=== 완료 ===');
      return;
    }

    requireEnv('ECOUNT_COM_CODE', ECOUNT_COM_CODE);
    requireEnv('ECOUNT_USER_ID',  ECOUNT_USER_ID);
    requireEnv('ECOUNT_API_CERT_KEY', ECOUNT_API_CERT_KEY);
    requireEnv('ECOUNT_PASSWORD', ECOUNT_PASSWORD);
    requireEnv('SHEETS_WEBAPP_URL', SHEETS_WEBAPP_URL);

    log(`=== 동기화 시작 ${DRY_RUN ? '(DRY-RUN)' : ''} ${IS_TEST ? '[TEST MODE]' : '[PROD]'} ${LIMIT?'limit='+LIMIT:''} ===`);

    // 기존 시트 로드
    const sheetRows = await loadExistingSheet();
    if (sheetRows.length < 3) die('시트가 비어있음 (헤더만 있거나 데이터 없음)');

    // 헤더 2행은 그대로, 데이터는 row index 2부터
    const dataStart = 2;
    let prodCds = [];
    for (let i = dataStart; i < sheetRows.length; i++) {
      const code = (sheetRows[i][0] || '').trim();
      if (code && !code.includes('계') && !code.includes('회사명')) {
        prodCds.push({ rowIdx: i, code });
      }
    }
    if (LIMIT > 0) prodCds = prodCds.slice(0, LIMIT);
    log(`조회 대상 ${prodCds.length}개 품목 (예상 소요: ${Math.ceil(prodCds.length * RATE_MS / 60000)}분)`);

    // 1일 한도 체크
    if (prodCds.length > 4800) {
      log(`경고: ${prodCds.length}개 > 1일 5000건 한도 근접. 분할 권장`, 'warn');
    }

    // 인증
    const zone = await fetchZone();
    const sid  = await login(zone);
    const baseDate = new Date().toISOString().slice(0,10).replace(/-/g,'');

    // 루프
    let okCnt = 0, failCnt = 0, zeroCnt = 0;
    const updated = [...sheetRows.map(r => [...r])];
    const startTs = Date.now();
    for (let i = 0; i < prodCds.length; i++) {
      const { rowIdx, code } = prodCds[i];
      const res = await fetchSingleStock(zone, sid, code, baseDate);
      if (res.error) {
        failCnt++;
        log(`  ❌ ${code}: ${res.error}`, 'warn');
        if (failCnt >= 25) die('오류 누적 25건 — 중단 (시간당 30건 한도 보호)');
      } else {
        // F열(인덱스 5)에 재고 업데이트
        while (updated[rowIdx].length <= 5) updated[rowIdx].push('');
        updated[rowIdx][5] = res.qty;
        if (res.qty > 0) okCnt++; else zeroCnt++;
      }
      if ((i+1) % 100 === 0) {
        const elapsed = Math.round((Date.now() - startTs) / 1000);
        log(`  진행: ${i+1}/${prodCds.length} (재고>0: ${okCnt} / 재고0: ${zeroCnt} / 실패: ${failCnt} / ${elapsed}초 경과)`);
      }
      if (i < prodCds.length - 1) await sleep(RATE_MS);
    }

    // 헤더 첫 행 업데이트 (날짜)
    const today = new Date().toLocaleDateString('ko-KR');
    updated[0] = [`회사명 : 주식회사 아스프로 / ${today} / 재고현황 (OAPI 자동 동기화)`, '', '', '', '', '', '', '', '', '', ''];

    log(`수집 완료: 재고>0 ${okCnt} / 재고0 ${zeroCnt} / 실패 ${failCnt}`);

    // ★ 수집 즉시 백업 (업로드 실패해도 데이터 손실 방지)
    const backupPath = path.join(LOG_DIR, 'last_collected.json');
    fs.writeFileSync(backupPath, JSON.stringify(updated));
    log(`✅ 수집 데이터 백업: ${backupPath}`);

    if (DRY_RUN) {
      fs.writeFileSync(path.join(LOG_DIR, 'rows_preview.json'), JSON.stringify(updated.slice(0, 15), null, 2));
      log(`[DRY-RUN] 업로드 생략. 미리보기: logs/rows_preview.json`);
      return;
    }

    await uploadWithRetry(updated);
    log('=== 동기화 완료 ===');
  } catch (e) {
    die(`예외: ${e.stack || e.message}`);
  }
})();
