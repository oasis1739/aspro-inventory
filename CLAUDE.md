# ASPRO 재고 대시보드 — Claude Code 인수인계

> 이 파일은 Claude Code가 첫 실행 시 자동 로드합니다.
> 맥북에서 처음 여는 거면 아래 **"맥북 첫 세팅"** 섹션부터.

---

## 프로젝트 개요

사방넷 단품 재고를 이카운트 / 김포 물류 / KCFI 신원 / 품절관리 / 수동매핑 기준으로 매칭·보정해
가상재고를 산출하는 단일파일 웹 대시보드.

- **저장소:** `oasis1739/aspro-inventory` (GitHub)
- **데이터 저장:** Google Sheets (id `1cl-uZ9s0_VNF_YwagnujAhPTdREuzfcaPisWRRp7zwY`)
- **백엔드:** Google Apps Script Web App (scriptId `1OA87MU3MlRWoTTtAJkLCr0qVUPnDvH8QgrBUBYJBPw5RVM5tgJwCxRaY`)
- **이카운트 OAPI:** 하루 2회 자동 동기화 (07:00, 17:00) — 이 동기화 cron은 **맥미니에서만** 돌아감

---

## 파일 구조

| 파일 | 역할 | 건드릴 때 주의 |
|---|---|---|
| `aspro_v42.html` | **메인 대시보드 (단일파일)** — 21만 바이트, 모든 로직 인라인 | 부분 grep 후 Edit. 절대 전체 재작성 X |
| `apps_script_aspro_sync.gs` | Apps Script `doGet`/`doPost` 핸들러 (매핑/품절/kcfi/iccodemap/icRawUpload) | 수정 후 반드시 `clasp push --force` + 배포본 갱신 |
| `appsscript.json` | Apps Script 매니페스트 | 손댈 일 거의 없음 |
| `ecount_sync/sync.js` | 이카운트 OAPI → 시트 동기화 Node 스크립트 | API 호출 한도 (1일 5000건) 의식 |
| `ecount_sync/com.aspro.ecount-sync.plist` | launchd 매일 자동 실행 | 맥미니에만 설치됨 |
| `deploy.sh` | git push + clasp push 통합 배포 | 양쪽 한 번에 |
| `.gitignore` / `.claspignore` | `.clasp.json`, `.env`, `ecount_sync/.env` 등 민감정보 제외 | |

**git에 안 올라가는 것들 (각 PC에서 따로 만들어야):**
- `.clasp.json` (scriptId 들어있음 — 아래 세팅 섹션 참고)
- `ecount_sync/.env` (이카운트 비밀번호/API키)
- `ecount_sync/logs/`, `ecount_sync/node_modules/`

---

## 맥북 첫 세팅

```bash
# 1. 도구 설치
brew install node git
npm install -g @google/clasp

# 2. 클론
git clone https://github.com/oasis1739/aspro-inventory.git
cd aspro-inventory

# 3. clasp 연결
clasp login
cat > .clasp.json <<'EOF'
{
  "scriptId": "1OA87MU3MlRWoTTtAJkLCr0qVUPnDvH8QgrBUBYJBPw5RVM5tgJwCxRaY",
  "rootDir": "."
}
EOF

# 4. (선택) 맥북에서도 이카운트 sync 돌릴 거면
cd ecount_sync && npm install
cp .env.example .env
# .env 안의 ECOUNT_PASSWORD 채우고 → 이카운트 [IP등록]에 맥북 IP 추가
# 단, 자동 cron은 맥미니에 이미 돌고 있으니 맥북은 수동 호출용
```

**이카운트 sync는 맥미니에 launchd로 매일 7시/17시 자동 실행 중. 맥북에 cron 또 깔지 말 것 (중복 호출 → 5000건 한도 잠식).**

---

## 작업 흐름

```
시작:    git pull
수정:    Edit / Write로 aspro_v42.html 또는 .gs
배포:    ./deploy.sh        ← git push + clasp push 한 번에
         또는 분리:
           git push origin main           # GitHub만
           clasp push --force             # Apps Script만
Apps Script 핸들러 추가/수정 시:
         clasp push --force
         clasp deploy --deploymentId AKfycbxn_yuxbci4MW3JQla3NPf0TFYapNiR7M7w9pznkQVu6KTqlKxIm8MPOayRjdLTNH-0 \
           --description "변경사항"
         ↑ 위 배포 ID가 HTML 앱이 쓰는 것. 새 배포 만들면 안 됨.
```

**중요:** Apps Script `clasp push`만 하면 `@HEAD` 버전만 갱신됨. HTML이 쓰는 배포본은 별도 갱신 필요 (위 `clasp deploy`).

---

## Apps Script Web App 배포 권한

배포본은 반드시 **다음 사용자로 실행: 나 / 액세스 권한: 모든 사용자** 로 설정.
이걸 안 하면 서버사이드 fetch (sync.js)가 HTML 로그인 페이지로 redirect 됨.
설정은 clasp으로 변경 불가 — Apps Script 에디터 → 배포 관리 → 편집에서 수동.

---

## 핵심 로직 위치 (`aspro_v42.html` 내부)

| 기능 | 검색 키워드 |
|---|---|
| 김포 파서 (판매상태 필터 포함) | `parseGimpoStockRow`, `findSaleStatusIdx`, `isGimpoRowActive` |
| KCFI 신원 시트 파싱 | `loadKCFIFromSheetRaw`, `isKcfiBlockHeader` |
| 세트 상품 재고 계산 | `setRuleMap`, `findGimpoRuleForJache`, `getGimpoQty` |
| 매칭 메인 로직 | `runMatch`, `getIcountQty`, `getGimpoQty` |
| 사방넷 내보내기 (안전재고 N% / N개 미만 0) | `doExport` |
| 품번 변경 대응 (252MX18 → 252MX18CD) | `resolveLogisticsCode` |
| Sheets 자동 로드 | `autoLoadFromSheets`, `loadBaseViaCSV`, `loadRawViaCSV` |
| 매핑 저장 (Apps Script POST) | `saveSheetsBatch`, `cleanMatchMap` |

---

## 이카운트 OAPI 제약 (반드시 의식)

- **검증된 API는 `재고현황(단건)` 하나뿐** — 한 번에 PROD_CD 하나씩만 조회
- **호출 한도:** 1초/호출, 1일 5000건, 시간당 오류 30건 누적 시 차단
- **로그인:** 1회/10분 (재로그인 자제)
- **테스트 도메인:** `sboapi{ZONE}.ecount.com` / **운영:** `oapi{ZONE}.ecount.com`
- 응답에 `PROD_CD`, `BAL_QTY`만 있고 상품명 등 마스터데이터 없음 → 기존 시트 다른 컬럼 보존하고 F열만 갱신하는 구조

추가 API (다건 조회 등) 쓰려면 이카운트 `API인증현황`에서 테스트키로 한 번 호출 → 검증 통과 → 운영키 발급 절차 필요.

---

## 주의사항

- **destructive git 명령 (force push, reset --hard 등)은 사용자 명시 허가 후에만.**
- **`.env` / `.clasp.json` / `.clasprc.json`는 절대 커밋 금지** (이미 gitignore됨)
- **이카운트 sync 수동 실행 시 시간 주의:**
  - 7시/17시 자동 실행 직전·직후엔 수동 실행 피하기 (한도 잠식)
  - 호출 끝나면 `logs/last_collected.json` 자동 백업 → `--upload-only`로 시트 업로드만 재시도 가능
- **김포원본 시트 A열은 "판매상태" 컬럼 (필수)** — 판매중지 행은 자동 제외됨
- 사용자는 한국어로 답변 받기 선호. 간결한 응답 좋아함.

---

## 이력 메모리

상세한 작업 이력 (KCFI 파싱, 김포 우선 로직, 세트재고, 품번 변경 등)은
이 PC의 Claude 메모리에 별도 저장돼 있음:
`~/.claude/projects/{프로젝트-key}/memory/project_aspro_history.md`

맥북 Claude Code는 자기 메모리가 따로라 비어있음. 필요하면 첫 대화에서
"이력 메모리 저장해줘" 요청하면 됨.

---

## 자주 쓰는 명령 빠른 참조

```bash
# 동기화 수동 실행
cd ecount_sync && node sync.js              # 60분 소요
cd ecount_sync && node sync.js --dry-run    # 시트 업로드 없이
cd ecount_sync && node sync.js --limit=5    # 5건만 빠른 테스트
cd ecount_sync && node sync.js --upload-only  # 백업 데이터로 업로드만

# 로그 확인
tail -f ecount_sync/logs/sync.log

# launchd 상태 (맥미니)
launchctl list | grep aspro

# 배포
./deploy.sh
```
