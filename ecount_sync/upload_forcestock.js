// 강제재고 (리오더 가능 신상품) → aspro_forcestock 시트 업로드
// 사용: node upload_forcestock.js <seed.json> [기본수량]
//   seed.json: [{"code":"102665-0001","name":"상품명","qty":300}, ...]
//   qty 생략시 두 번째 인자 사용 (기본 300)
import 'dotenv/config';
import fs from 'fs';

const seed = process.argv[2] || 'logs/forcestock_seed.json';
const defaultQty = parseInt(process.argv[3]) || 300;
if (!fs.existsSync(seed)) { console.error('파일 없음:', seed); process.exit(1); }
const items = JSON.parse(fs.readFileSync(seed, 'utf-8'));
const today = new Date().toISOString().slice(0,10);
const payload = {
  forceStock: {
    mode: 'merge',
    items: items.map(it => ({
      code: it.code, qty: it.qty || defaultQty,
      name: it.name || '', date: today, memo: it.memo || '리오더 가능 신상품'
    }))
  }
};
async function postWebApp(url, body) {
  const res = await fetch(url, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify(body), redirect: 'manual',
  });
  if (res.status === 302 || res.status === 303) {
    return await (await fetch(res.headers.get('location'))).text();
  }
  return await res.text();
}
const txt = await postWebApp(process.env.SHEETS_WEBAPP_URL, payload);
if (txt.trim().startsWith('<')) { console.error('HTML 응답'); process.exit(1); }
console.log(JSON.parse(txt));
