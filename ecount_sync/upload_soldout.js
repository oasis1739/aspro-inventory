// 발주서에서 추출한 물류품번 영구품절 목록 → aspro_soldout_logistics 시트 업로드
// 사용: node upload_soldout.js <seed.json>
import 'dotenv/config';
import fs from 'fs';

const seed = process.argv[2] || 'logs/soldout_seed.json';
if (!fs.existsSync(seed)) { console.error('파일 없음:', seed); process.exit(1); }
const items = JSON.parse(fs.readFileSync(seed, 'utf-8'));
const today = new Date().toISOString().slice(0,10);
const payload = {
  soldoutLogistics: {
    mode: 'merge',  // 기존 데이터 보존하고 추가만
    items: items.map(it => ({
      code: it.code, color: it.color, size: it.size,
      name: it.name, source: it.source, memo: it.memo, date: today
    }))
  }
};
const res = await fetch(process.env.SHEETS_WEBAPP_URL, {
  method: 'POST', headers: {'Content-Type':'application/json'},
  body: JSON.stringify(payload), redirect: 'follow'
});
const txt = await res.text();
if (txt.trim().startsWith('<')) { console.error('HTML 응답 — 배포 권한 확인'); process.exit(1); }
console.log(JSON.parse(txt));
