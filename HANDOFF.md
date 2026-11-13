# 유통기한 지킴이 — 프로젝트 인수인계 문서

> 이 문서는 다른 AI/개발자가 읽고 바로 이어서 작업할 수 있도록 현재 상태를 정리한 것입니다. (작성 기준일: 2026-11-13, 앱 버전 `v12`. **v1은 Git 태그 `v1`(커밋 c9c018d)로 고정됨**, 이후 작업은 v2)
> 사용자는 한국어로 소통합니다. 답변도 한국어로 하세요.

## 1. 목적

식품의 **바코드를 스캔**해 제품 정보를 자동 등록하고, **유통기한/소비기한을 관리·알림**하는 개인/가족용 앱.

- 폰·태블릿(아이폰/아이패드, **갤럭시 S23**/갤럭시탭)이 **같은 데이터를 공유**해야 함
- 우선 범위: **식품**, 카테고리별 분류
- UI는 깔끔하게, 기한 임박순 리스트 + 알림

## 2. 아키텍처 한눈에

```
[폰/태블릿 브라우저 (PWA, GitHub Pages)]
   │  정적 HTML 1개 (index.html) — 프레임워크/빌드 없음
   ├─ 바코드 인식: 브라우저 내장 BarcodeDetector → 없으면 barcode-detector(zxing-cpp wasm, jsdelivr CDN)
   ├─ 제품 조회: ① Supabase Edge Function(식약처 C005) ② 내 기록 ③ Open Food Facts
   ├─ 저장: localStorage(오프라인 우선) + Supabase 테이블 `items` 동기화
   └─ 알림: 앱을 열었을 때 로컬 알림 (서버 푸시는 미구현)

[Supabase (프로젝트 ref: nnrzjgsjwgykafawtimt)]
   ├─ Postgres 테이블 items  (RLS: 임시로 전체 허용 — 아래 보안 참고)
   └─ Edge Function `barcode` → 식약처 OpenAPI 프록시 (키는 시크릿 MFDS_KEY)
```

- 호스팅: **GitHub Pages** — 저장소 `heyhhh/expiry-tracker`, `main` 브랜치 루트. push 후 1~2분 뒤 반영.
- 앱 주소: `https://heyhhh.github.io/expiry-tracker/`
- 저장소: `https://github.com/heyhhh/expiry-tracker` (**공개 저장소**, 비밀값 커밋 금지)

## 3. 파일 구조

| 파일 | 설명 |
|---|---|
| `index.html` | 앱 전체(HTML+CSS+JS 단일 파일). 아래 4장 참고 |
| `manifest.json`, `icon.svg` | PWA 설정/아이콘 (홈 화면 추가용) |
| `sw.js` | 서비스워커. **network-first** 캐시. 버전 문자열 `CACHE='expiry-vN'`을 앱 버전과 함께 올림 |
| `supabase.sql` | `items` 테이블 + RLS 정책 생성 SQL (이미 실행됨) |
| `supabase/functions/barcode/index.ts` | Edge Function 소스 (Supabase 대시보드에서 **수동 배포**) |
| `HANDOFF.md` | 이 문서 |
| `.claude/` | 로컬 미리보기 설정(`launch.json`, `.gitignore`로 제외됨) |

## 4. index.html 내부 구성 (주요 함수)

- **설정/상수**: `CATS`(카테고리 10종: 유제품, 육류, 수산물, 채소/과일, 음료, 과자/간식, 냉동식품, 가공식품, 소스/양념, 기타), `DEFAULTS`(Supabase URL/publishable 키 내장), `cfg`(localStorage `cfg`).
- **설정 링크**: `https://heyhhh.github.io/expiry-tracker/#h=<공유코드>` 로 열면 공유코드(`cfg.hh`)가 자동 복원됨. 사이트 데이터를 지워도 링크 하나로 복구하기 위함.
- **데이터 모델** (localStorage `items`, Supabase `items` 동일):
  `id(text), barcode, name, brand, category, expiry(YYYY-MM-DD), exp_type(소비기한|유통기한), qty, memo, status(active|done|discarded), deleted(bool, 소프트삭제), updated_at(ms), household(Supabase에만 존재)`
- **조회 `lookup(code)` 순서**:
  1. 식약처 C005 — `${sbUrl}/functions/v1/barcode?code=` (헤더 `apikey`), 8초 타임아웃
  2. 내 기록 — 같은 바코드로 이전에 저장한 항목
  3. Open Food Facts — 영문명은 `toKorean()`(브랜드/단어 사전 + 로마자→한글 역변환)으로 한글화
  - 카테고리는 `guessCategory(tags, text)` 정규식 매핑(식약처 식품유형 `PRDLST_DCNM` 포함)
- **스캔**: `startScan`(getUserMedia 1920x1080 요청 + 연속초점 요청, 실패 시 기본 설정 재시도) → 120ms 간격 `decode()` 루프. `🔄 렌즈 전환`(후면 카메라 순환), `📷 사진으로 인식`(원본→축소 순서로 `decode`). 맨 아래 `#camInfo`에 버전/감지된 카메라/오류 표시(진단용).
- **등록 폼**: 제품명/브랜드/카테고리/기한종류/날짜/수량/바코드/메모. `+3일…+1년` 빠른 날짜 버튼. `🔍 코리안넷에서 검색`(링크: `https://www.koreannet.or.kr/front/koreannet/gtinSrch.do?gtin=<바코드>`), `📋 붙여넣기 → 제품명`(클립보드). **작성 중 임시저장**(`draft`)으로 다른 탭에 다녀오다 페이지가 재로드돼도 복원.
- **동기화 `sync()`**: Supabase에서 household 전체 조회 → `updated_at` 기준 last-write-wins 병합 → 로컬이 더 새로우면 upsert. 저장 후 600ms 디바운스, 탭 복귀 시 자동 실행.
- **알림 `checkAlerts()`**: 앱 실행 시 `cfg.notiDays`일 이내 항목이 있으면 하루 1회 알림(권한 허용 필요). **앱이 꺼져 있을 때의 푸시는 미구현.**

## 5. Supabase 설정 상태

- 프로젝트 URL: `https://nnrzjgsjwgykafawtimt.supabase.co`
- 앱에는 **publishable 키**(`sb_publishable_…`, 공개 전제 키)가 `DEFAULTS`에 내장되어 있음. `service_role`/secret 키는 절대 앱·Git에 넣지 말 것.
- `items` 테이블 생성 완료 (`supabase.sql`). RLS 정책 `mvp_all`은 **누구나 읽기/쓰기 가능**(공유코드=household 값으로만 구분하는 임시 구조).
- Edge Function `barcode`: **배포 완료, 정상 동작 확인**. 함수 설정에서 **"Verify JWT" 반드시 OFF** (publishable 키는 JWT가 아니라서 켜면 401). 시크릿 `MFDS_KEY`에 식품안전나라 인증키 저장됨.
- ⚠️ 함수 코드를 바꾸면 **대시보드에서 수동 재배포** 필요(CLI 미사용). 코드 소스는 `supabase/functions/barcode/index.ts`.

## 6. 외부 데이터 소스 현황

| 소스 | 상태 | 비고 |
|---|---|---|
| 식약처 C005 바코드연계제품정보 | ✅ 사용 중 | 도메인은 **`openapi.foodsafetykorea.go.kr`** (`.or.kr` 아님! 과거 오타로 장애 발생). `https://…/api/{KEY}/C005/json/1/1/BAR_CD={바코드}`. 응답 필드: `PRDLST_NM`(제품명), `BSSH_NM`(제조사, `(주)` 제거), `PRDLST_DCNM`(식품유형), `POG_DAYCNT`(표시 기한 문구 → 메모에 "표시: …"로 미리 채움) |
| 식약처 I2570 유통바코드 | ⏳ 활용신청 승인됨, 미연동 | 같은 키 사용. 테스트 바코드로는 데이터 없음. 응답 필드명을 아직 확인하지 못함 → 데이터가 있는 바코드로 확인 후 함수에 C005 실패 시 폴백으로 추가 예정 |
| Open Food Facts | ✅ 사용 중 | 국내 제품 커버리지 낮음, 영문명 반환 → `toKorean()` 처리 |
| 코리안넷(GS1 Korea, koreannet.or.kr) | ❌ **자동 연동 금지** | 국내 바코드 원천 DB라 커버리지 최고이나, `robots.txt`가 `/front/koreannet/gtinSrch*`를 Disallow, 페이지에 "무단 수집·유통 시 법적 제재" 명시. 그래서 **사람이 직접 보는 링크 버튼만** 제공. 스크래핑/프록시 구현 금지 |
| 네이버 쇼핑 검색 API | 💡 제안만 함(미구현) | 바코드 숫자를 검색어로 사용, 정확도는 "추정". Edge Function 중계 + 시크릿 `NAVER_CLIENT_ID/SECRET` 필요. 조회 순서 마지막(추정, 사용자 확인 필수)으로 제안 |

## 7. 개발 중 확인된 중요 사실 / 함정

1. **카메라는 HTTPS 필수**(GitHub Pages OK). 사용자는 **삼성 인터넷**으로 열기도 함 — 사이트별 카메라 권한이 막혀 있는 경우가 많음(자물쇠 아이콘 → 권한 → 카메라 허용). 안 되면 Chrome 권장.
2. **html5-qrcode는 사용 중단**: 실제 사진(3000×4000, 바코드가 작고 약간 기울어짐)을 원본/축소/타일 모두 못 읽음. `barcode-detector@2.3.1`(zxing-cpp)은 0.3초에 인식. 현재 이 라이브러리 사용.
3. 렌즈 목록(`enumerateDevices`/`getCameras`)을 **카메라 시작 후에 호출하면 영상이 끊기는** 문제가 있었음 → 시작 전/후 순서 주의(현재는 스트림 시작 후 `enumerateDevices`만 사용, 정상 확인 필요).
4. **갤럭시 S23**은 초광각 렌즈가 선택돼 초점이 안 맞는 경우가 있음 → `🔄 렌즈 전환`, `📷 사진으로 인식` 제공.
5. 사진 인식은 PC에서 사용자 제공 사진으로 검증 완료. **실시간 카메라 스캔은 PC에 카메라가 없어 폰 실기기에서 미검증.**
6. **캐시 문제**: 폰/홈 화면 앱이 옛 코드를 잡고 있는 경우가 많았음. 배포 확인용으로 스캔 창 맨 아래 `vN` 표시를 사용. **코드 수정 시 `index.html`의 `vN` 문구와 `sw.js`의 `expiry-vN`을 함께 올릴 것.**
7. Edge Function 오류 응답에 요청 URL(=인증키)이 섞여 나오던 문제는 수정됨(오류 내용 비공개). 과거 응답에 키가 노출된 적이 있어 **키 재발급 권장**(아직 안 함).
8. 사진 전처리/타일링이 아니라 인식기 교체가 해결책이었음. `createImageBitmap`으로 원본→2400→1400px 순서 시도.

## 8. 로컬 개발/테스트 방법

```bash
python -m http.server 8765      # 프로젝트 폴더에서. http://localhost:8765 (localhost는 카메라 허용)
```
- 배포: `git add … && git commit && git push` → GitHub Pages가 1~2분 내 반영 (`gh api repos/heyhhh/expiry-tracker/pages/builds/latest`로 상태 확인 가능)
- 함수 직접 테스트:
  `curl "https://nnrzjgsjwgykafawtimt.supabase.co/functions/v1/barcode?code=8801045570716" -H "apikey: <publishable키>"`
- 검증용 바코드: `8801045570716`(오뚜기 열라면, 식약처 O) / `8801115114154`(서울우유, 식약처 O) / `8809775959139`(그래놀라류, 식약처·OFF·I2570 모두 없음, 코리안넷에는 있음)

## 9. 보안·비밀 관리 규칙

- 공개 저장소이므로 **식약처 키, 네이버 시크릿, service_role 키, 공유코드는 코드/문서/커밋에 넣지 않는다.** (식약처 키는 Supabase 시크릿 `MFDS_KEY`에만)
- 공유코드(household)는 현재 사용자가 약한 값을 쓰고 있어 **길고 무작위인 값으로 교체 권장**(교체 시 `update items set household='새코드' where household='기존코드';` 실행 후 모든 기기에서 설정 변경 + 설정 링크 재생성). 사용자는 "보류"라고 답함.
- 근본 해결은 **Supabase Auth 로그인 + RLS(본인/가족 한정)** — 사용자가 일단 보류.

## 10. 남은 작업 / 제안 (우선순위 순)

1. **폰 실기기 검증**: 실시간 카메라 스캔(v11), 렌즈 전환, 클립보드 붙여넣기, 코리안넷 링크 흐름, 동기화.
2. **I2570 폴백 연동**: 데이터가 있는 바코드로 응답 필드 확인 후 Edge Function에 C005 실패 시 호출 추가 → 재배포.
3. **서버 푸시 알림**: 앱이 꺼져 있어도 D-day 알림. 가장 단순한 방법은 Supabase cron + Telegram 봇(또는 ntfy) 일일 요약. 웹푸시는 아이폰에서 홈 화면 추가 PWA만 가능.
4. **네이버 쇼핑 API 폴백**(추정 표시) — 사용자가 네이버에서 해당 바코드가 검색되는지 먼저 확인해 본 뒤 결정.
5. **보안 강화**: 로그인(Auth)·RLS, 공유코드 교체, 식약처 키 재발급.
6. 개선 아이디어: 카테고리별 통계, 유통기한 문구 OCR, 가족 계정 공유, CSV 내보내기, 수량 증감 UI.

## 11. 사용자 선호/작업 방식 메모

- 한국어 소통. 설명은 단계별로 구체적으로 요청하는 편(대시보드 조작 등은 직접 수행하고 막히면 스크린샷 공유).
- Supabase 대시보드 조작(함수 배포, 시크릿 등)은 사용자가 직접 한다. 계정 생성/로그인/키 입력은 AI가 대행하지 말 것.
- 변경 후에는 GitHub push까지 해서 URL에 반영하는 흐름을 사용 중. 외부 서비스(저장소 생성, 공개 설정 등)는 사전에 확인받고 진행했음.
- 이 작업 폴더는 앱이 만든 임시 세션 폴더였고, 세션 삭제 시 함께 지워진다. **원본 소스는 GitHub 저장소가 기준.**

## 12. v2 — 제품 사진 AI 분석 (진행 중)

**목표**: 바코드가 없어도 제품 사진을 찍으면 LLM이 제품명/브랜드/카테고리/바코드(선택)/기한 종류·날짜를 읽어 등록 폼에 자동 입력.

### 구조
```
사진 촬영(📸 제품 사진으로 AI 분석 / 폼의 📸 날짜면 AI 읽기)
 ├─ 로컬: barcode-detector로 같은 사진에서 바코드 숫자 인식 (LLM은 숫자를 틀리기 쉬워서 바코드는 인식기 우선)
 │    └─ 바코드가 있으면 v1 lookup(식약처→내 기록→OFF) 결과를 이름/브랜드/카테고리에 우선 사용
 └─ 1280px JPEG(≈300KB)로 줄여 Edge Function `analyze` 호출 → OpenRouter(OpenAI 호환 chat/completions)
      → {name, brand, category, barcode, exp_type, expiry(YYYY-MM-DD), confidence}
앱은 결과를 폼에 채우고 "AI가 읽은 값" 경고 + 기한 칸 주황 강조. 사용자가 확인 후 저장 (이후는 v1과 동일)
```
- 폼이 열린 상태에서 2번째 사진(날짜면 등)을 찍으면 **빈 칸만** 채움 (사용자가 고친 값은 덮어쓰지 않음).
- 구현 위치: `index.html`의 `/* v2: 제품 사진 AI 분석 */` 블록(`photoToDataUrl`, `callAnalyze`, `analyzeFile`), 서버: `supabase/functions/analyze/index.ts`.

### Edge Function `analyze` (Supabase에 **수동 배포 필요**, Verify JWT = OFF)
- 시크릿: `OPENROUTER_API_KEY`(필수), `ANALYZE_TOKEN`(임시 접근 토큰), `AI_MODELS`(선택, 쉼표 구분 모델 폴백 목록)
- 기본 모델 폴백: `google/gemma-4-31b-it:free` → `nvidia/nemotron-3.5-super-vl:free` (OpenRouter 무료, 2026-11-13 조회 기준. 무료 모델은 예고 없이 바뀌므로 `AI_MODELS`로 교체 가능하게 설계)
- 요청 헤더 `x-admin-token`이 `ANALYZE_TOKEN`과 같아야 처리(로그인 도입 전 **비용/한도 보호용 임시 장치**). 앱에서는 ⚙ 설정의 "AI 분석 토큰"(또는 설정 링크 `#h=…&t=…`)으로 전달 → localStorage 저장. **토큰을 코드/Git에 넣지 말 것.**
- 결과 검증: 카테고리는 10종 내, 날짜는 `YYYY-MM-DD`, 바코드는 8~14자리 숫자일 때만 인정. 오류 상세는 응답에 포함하지 않음(키 노출 방지).

### 상태
- ✅ 앱 쪽 구현 및 **모의 응답으로** 흐름 검증(신규 등록, 빈 칸만 채우기, 토큰 오류 메시지, 설정 링크 토큰 복원, 전송 크기)
- ⏳ **실제 모델 호출은 미검증**: Supabase에 시크릿 2개 설정 + 함수 배포가 아직 안 됨(사용자 작업). 배포 후 실제 제품 사진 10~20장으로 모델별 정확도 비교 필요(한글 제품명, 기한 날짜 위주)
- ⏳ 무료 모델의 한도/품질이 부족하면 `AI_MODELS`에 저렴한 유료 모델 또는 Claude(`claude-haiku-5-5` 등)를 추가. 동일 인터페이스라 설정 변경 수준
- ⚠️ 무료 모델은 입력이 로깅/학습될 수 있음 → 사진에 개인정보가 찍히지 않게 안내. 사진 자체는 저장하지 않음
- 🔒 로그인(Supabase Auth) 도입 시 `ANALYZE_TOKEN` 방식은 JWT 검증으로 교체
