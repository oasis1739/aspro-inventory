// ASPRO 이카운트 재고 → 구글시트 이카운트원본 매일 동기화
// 실행: node sync.js   (dry-run: node sync.js --dry-run)
//
// 흐름:
//   1) Zone 조회 (회사코드로 어느 zone 서버 쓰는지 확인)
//   2) OAPI 로그인 (SESSION_ID 발급)
//   3) 재고 조회 API 호출
//   4) [품목코드, 품번, 브랜드, 진행시즌, 품목명, 재고, ...] 행 빌드
//   5) Apps Script web app으로 POST → 「이카운트원본」 시트 통째 덮어쓰기
//
// 이카운트 API 응답 필드명은 회사별/계약별로 다를 수 있어
// 첫 실행 시 응답 샘플을 dry-run으로 확인 후 mapping 조정 필요.

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const DRY_RUN = process.argv.includes('--dry-run');
const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);

const {
  ECOUNT_COM_CODE,
  ECOUNT_USER_ID,
  ECOUNT_API_CERT_KEY,
  ECOUNT_PASSWORD,
  SHEETS_WEBAPP_URL,
  ECOUNT_INVENTORY_API_PATH = '/OAPI/V2/InventoryBasic/ViewInventoryBalanceStatusByLocation',
} = process.env;

function log(msg, level = 'info') {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level.toUpperCase()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(path.join(LOG_DIR, 'sync.log'), line + '\n');
}

function die(msg) {
  log(msg, 'error');
  process.exit(1);
}

function requireEnv(name, val) {
  if (!val || val.includes('여기에_')) die(`.env 누락 또는 미입력: ${name}`);
}

// ── 1. Zone 조회 ──
async function fetchZone() {
  const res = await fetch('https://oapi.ecount.com/OAPI/V2/Zone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ COM_CODE: ECOUNT_COM_CODE }),
  });
  const data = await res.json();
  if (!data?.Data?.ZONE) {
    die(`Zone 조회 실패: ${JSON.stringify(data)}`);
  }
  log(`Zone: ${data.Data.ZONE} / Domain: ${data.Data.DOMAIN}`);
  return data.Data; // { ZONE, DOMAIN, ... }
}

// ── 2. OAPI 로그인 ──
async function login(zone) {
  const url = `https://oapi${zone.ZONE}.ecount.com/OAPI/V2/OAPILogin`;
  const body = {
    COM_CODE: ECOUNT_COM_CODE,
    USER_ID:  ECOUNT_USER_ID,
    API_CERT_KEY: ECOUNT_API_CERT_KEY,
    LAN_TYPE: 'ko-KR',
    ZONE: zone.ZONE,
    PASSWORD: ECOUNT_PASSWORD,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  const sid = data?.Data?.Datas?.SESSION_ID;
  if (!sid) die(`로그인 실패: ${JSON.stringify(data)}`);
  log(`로그인 성공 (SESSION 만료: ${data.Data?.Datas?.EXPIRE_DATE || '?'})`);
  return sid;
}

// ── 3. 재고 조회 ──
async function fetchInventory(zone, sid) {
  const url = `https://oapi${zone.ZONE}.ecount.com${ECOUNT_INVENTORY_API_PATH}?SESSION_ID=${sid}`;
  // 검색 조건 — 이카운트 API매뉴얼 참고하여 필요 필드 추가
  const body = {
    BASE_DATE: new Date().toISOString().slice(0,10).replace(/-/g,''), // YYYYMMDD
    PROD_CD: '',
    WH_CD: '',
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  // 디버그용 원본 저장
  fs.writeFileSync(
    path.join(LOG_DIR, `inventory_raw_${Date.now()}.json`),
    JSON.stringify(data, null, 2),
  );
  const result = data?.Data?.Result || data?.Data?.Datas || [];
  if (!Array.isArray(result)) die(`재고 응답 구조 예상과 다름: ${JSON.stringify(data).slice(0,500)}`);
  log(`재고 ${result.length}건 조회`);
  return result;
}

// ── 4. 시트 행 빌드 ──
// 「이카운트원본」 시트 컬럼 순서:
//   A:품목코드  B:품번  C:브랜드  D:진행시즌  E:품목명[규격]  F:재고  G:진행채널  H:송장출력명
// 이카운트 응답 필드명에 맞춰 매핑 — API매뉴얼 확인 후 PROD_CD/PROD_DES 등 보정
function buildSheetRows(inventoryList) {
  const today = new Date().toLocaleDateString('ko-KR');
  const rows = [
    [`회사명 : 주식회사 아스프로 / ${today} / 재고현황 (OAPI 자동)`, '', '', '', '', '', '', ''],
    ['품목코드','품번','브랜드','진행시즌','품목명[규격]','재고','진행채널','송장출력명'],
  ];
  for (const item of inventoryList) {
    const code  = item.PROD_CD || item.ITEM_CD || '';
    const name  = item.PROD_DES || item.ITEM_NM || item.PROD_NM || '';
    const qty   = Number(item.BAL_QTY || item.QTY || item.BALANCE_QTY || 0);
    const brand = item.CLASS_CD3 || item.CLASS_NM3 || '';
    const season = item.CLASS_CD2 || item.CLASS_NM2 || '';
    // 품번 = 품목코드의 prefix (하이픈 앞)
    const prodPrefix = code.split('-')[0];
    rows.push([code, prodPrefix, brand, season, name, qty, '', '']);
  }
  return rows;
}

// ── 5. Apps Script로 업로드 ──
async function uploadToSheet(rows) {
  if (DRY_RUN) {
    log(`[DRY-RUN] 업로드 생략, ${rows.length}행 준비됨`);
    fs.writeFileSync(path.join(LOG_DIR, 'rows_preview.json'), JSON.stringify(rows.slice(0,10), null, 2));
    return;
  }
  const res = await fetch(SHEETS_WEBAPP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ icRawUpload: { rows } }),
    redirect: 'follow',
  });
  const data = await res.json();
  if (!data?.ok) die(`시트 업로드 실패: ${JSON.stringify(data)}`);
  log(`시트 업로드 완료: ${data.saved}행`);
}

// ── main ──
(async () => {
  try {
    requireEnv('ECOUNT_COM_CODE', ECOUNT_COM_CODE);
    requireEnv('ECOUNT_USER_ID',  ECOUNT_USER_ID);
    requireEnv('ECOUNT_API_CERT_KEY', ECOUNT_API_CERT_KEY);
    requireEnv('ECOUNT_PASSWORD', ECOUNT_PASSWORD);
    requireEnv('SHEETS_WEBAPP_URL', SHEETS_WEBAPP_URL);

    log(`=== 동기화 시작 ${DRY_RUN ? '(DRY-RUN)' : ''} ===`);
    const zone = await fetchZone();
    const sid  = await login(zone);
    const inv  = await fetchInventory(zone, sid);
    const rows = buildSheetRows(inv);
    await uploadToSheet(rows);
    log('=== 동기화 완료 ===');
  } catch (e) {
    die(`예외: ${e.stack || e.message}`);
  }
})();
