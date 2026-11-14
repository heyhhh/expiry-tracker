// 제품 사진 → 제품 정보(JSON) 분석 프록시 (OpenRouter, OpenAI 호환 chat/completions)
// 시크릿: OPENROUTER_API_KEY (필수), (인증: 로그인한 리스트 멤버만)
//         AI_MODELS (선택, 쉼표 구분. 앞에서부터 시도하고 실패하면 다음 모델로 폴백)
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'apikey, authorization, content-type, x-client-info, x-admin-token',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const CATS = ['유제품', '육류', '수산물', '채소/과일', '음료', '과자/간식', '냉동식품', '가공식품', '소스/양념', '의약품', '건강기능식품', '화장품', '생활용품', '기타'];
const EXP_TYPES = ['소비기한', '유통기한', '사용기한'];
const DEFAULT_MODELS = 'google/gemma-4-31b-it:free,particle-ai/particle-1:free,google/gemma-4-26b-a4b-it:free,nvidia/nemotron-3.5-super-vl:free,google/gemini-2.5-flash-lite'; // 무료 모델 먼저, 모두 실패했을 때만 마지막에 유료 flash-lite
// 비용 보호: 무료(:free) 모델과 지정한 유료 모델 1개만 허용 (AI_MODELS 시크릿·요청에서 다른 유료 모델을 넣어도 사용하지 않음)
const PAID_ALLOWED = ['google/gemini-2.5-flash-lite'];
const allowed = (m: string) => m.endsWith(':free') || PAID_ALLOWED.includes(m);
const MAX_IMAGE_CHARS = 1_800_000; // data URL 길이 상한 (약 1.3MB)

const PROMPT = `당신은 한국·일본 제품(식품, 의약품, 건강기능식품, 화장품, 생활용품 등) 포장 사진을 읽는 도우미입니다. 사진은 1번부터 순서대로 주어집니다.
- 같은 제품의 앞면/뒷면/날짜 인쇄면이면 하나의 제품으로 합쳐서 한 항목만 만드세요. 서로 다른 제품이면 제품마다 항목을 따로 만드세요.
- 포장에 실제로 인쇄된 글자만 근거로 하세요. 아래 JSON 하나만 출력하고 설명이나 코드블록은 쓰지 마세요.
{"items":[
 {
  "name": "포장 앞면에 가장 크게 인쇄된 상품명을 인쇄된 언어 그대로(일본어면 일본어 원문 그대로). 맛/종류가 이름의 일부면 포함(예: ライチミント味). 용량·홍보 문구는 제외",
  "name_ko": "name의 한국어 번역 또는 발음 표기. 한글만 사용(가나·한자 금지). 한국어 제품이면 name과 같게",
  "brand": "브랜드 또는 제조사 (인쇄된 원문 그대로. 예: サクマ, Asahi, 龍角散)",
  "brand_ko": "brand의 한국어 표기 (예: 사쿠마, 아사히, 류카쿠산). 한국어 브랜드면 brand와 같게",
  "category": "${CATS.join(' | ')} 중 하나 (사탕·캔디·츄잉껌·민트·타블렛 과자는 과자/간식. 약은 의약품, 영양제·비타민·홍삼 등은 건강기능식품)",
  "exp_type": "소비기한 | 유통기한 | 사용기한 | null (消費期限=소비기한, 賞味期限=유통기한, 使用期限=사용기한. 문구가 없으면 null)",
  "expiry_text": "사진에 실제로 인쇄된 기한 날짜 글자를 보이는 그대로 (예: 'EXP 25.08.14', '27年07月', '2027.8'). 기한 날짜가 인쇄되어 있지 않거나 읽을 수 없으면 반드시 null",
  "expiry": "expiry_text를 YYYY-MM-DD로 변환. 일(日)이 없이 연·월만 인쇄되어 있으면 그 달의 마지막 날로. expiry_text가 null이면 반드시 null",
  "photo": "이 제품의 포장(앞면)이 가장 잘 보이는 사진 번호(1부터). 모르면 null",
  "confidence": "high | medium | low"
 }
]}
규칙:
- 일본 제품 기한은 '賞味期限'/'消費期限' 문구 근처 또는 봉지 윗부분·아랫부분에 인쇄된 날짜입니다. 두 자리 연도('27年07月', '27.07')는 20YY로 해석. '2027.8/B8 2DL', '2027.10/P59 +TP'처럼 날짜 뒤에 붙은 영문·숫자 코드(공장/로트 기호)는 날짜가 아니니 무시하고 앞의 연.월만 사용. 令和 연호는 서기로 변환.
- 보이지 않는 값은 추측하지 말고 null. 제조일자와 기한을 혼동하지 말 것. 제품명·용량·바코드·영양성분 숫자를 날짜로 해석하지 말 것. 같은 제품을 중복 항목으로 만들지 말 것.`;

function parse(text: string) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}
function clean(o: any, imageCount = 0) {
  if (!o || typeof o !== 'object') return null;
  const s = (v: unknown) => (typeof v === 'string' && v.trim() && v.trim().toLowerCase() !== 'null' ? v.trim() : null);
  // 기한 날짜 검증: 사진에서 읽은 원문(expiry_text)이 있고, 그 숫자에 변환된 날짜(연·월·일)가 들어 있을 때만 인정 (모델이 지어낸 날짜 차단)
  let exp = s(o.expiry);
  if (exp) {
    const txt = (s(o.expiry_text) || '').replace(/\D/g, '');
    const m = exp.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const full = !!m && txt.length >= 4 && txt.includes(m[1].slice(2)) && txt.includes(m[2]) && txt.includes(m[3]);
    // 일본 제품처럼 연·월만 인쇄된 경우: 연·월이 원문에 있고 변환값이 그 달의 마지막 날이면 인정
    const lastDay = m ? new Date(Number(m[1]), Number(m[2]), 0).getDate() : 0;
    const monthOnly = !!m && txt.length >= 3 && txt.includes(m[1].slice(2)) && txt.includes(String(Number(m[2]))) && Number(m[3]) === lastDay;
    const okText = full || monthOnly;
    const yr = m ? Number(m[1]) : 0;
    if (!okText || yr < 2000 || yr > 2045) exp = null;
  }
  const barcode = s(o.barcode)?.replace(/\D/g, '') || null;
  const kana = /[぀-ヿ㐀-鿿]/;
  const ko = (v: unknown) => { const t = s(v); return t && !kana.test(t) ? t : null; };  // 한글/영문 표기만 인정 (가나·한자가 섞이면 버림)
  const toType = (v: unknown) => { const t = s(v) || ''; return /賞味|유통/.test(t) ? '유통기한' : /消費|소비/.test(t) ? '소비기한' : /使用|사용/.test(t) ? '사용기한' : null; };
  return {
    name: s(o.name),
    name_ko: ko(o.name_ko),
    brand: s(o.brand),
    brand_ko: ko(o.brand_ko),
    category: CATS.includes(o.category) ? o.category : '기타',
    barcode: barcode && /^\d{8,14}$/.test(barcode) ? barcode : null,
    exp_type: EXP_TYPES.includes(o.exp_type) ? o.exp_type : toType(o.exp_type),
    expiry: exp && /^\d{4}-\d{2}-\d{2}$/.test(exp) ? exp : null,
    confidence: ['high', 'medium', 'low'].includes(o.confidence) ? o.confidence : 'low',
    photo: Number.isInteger(Number(o.photo)) && Number(o.photo) >= 1 && Number(o.photo) <= imageCount ? Number(o.photo) : null, // 앱이 이 번호의 사진으로 썸네일을 만든다
  };
}

// 로그인 확인: 요청의 사용자 토큰으로 my_household()를 호출 — 유효한 로그인이면서 리스트에 속한 계정만 통과
async function authed(req: Request): Promise<boolean> {
  const tok = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const apikey = req.headers.get('apikey') || Deno.env.get('SUPABASE_ANON_KEY') || '';
  const url = Deno.env.get('SUPABASE_URL');
  if (!tok || !url) return false;
  try {
    const r = await fetch(`${url}/rest/v1/rpc/my_household`, { method: 'POST', headers: { apikey, Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: '{}' });
    if (!r.ok) return false;
    const v = await r.json();
    return typeof v === 'string' && v.length > 0;
  } catch { return false; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);

  // 로그인한 리스트 멤버만 허용 (비용 보호)
  if (!(await authed(req))) return json({ ok: false, error: 'unauthorized' }, 401);

  // 붙여넣기 실수(앞뒤 공백/줄바꿈, 따옴표, "Bearer " 접두어)를 정리
  const key = (Deno.env.get('OPENROUTER_API_KEY') || '').trim().replace(/^["']|["']$/g, '').replace(/^Bearer\s+/i, '').trim();
  if (!key) return json({ ok: false, error: 'server key missing' }, 500);

  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  // 사용량/한도 조회: {"action":"quota"} — OpenRouter /api/v1/key 결과 중 안전한 필드만 반환 (label은 키 일부를 포함할 수 있어 제외)
  if (body.action === 'quota') {
    try {
      const r = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${key}` } });
      const j = await r.json().catch(() => ({}));
      const d = j?.data ?? {};
      return json({
        ok: r.ok,
        http: r.status,
        is_free_tier: d.is_free_tier,
        limit: d.limit,
        limit_remaining: d.limit_remaining,
        limit_reset: d.limit_reset,
        usage: d.usage,
        usage_daily: d.usage_daily,
        usage_weekly: d.usage_weekly,
        usage_monthly: d.usage_monthly,
        rate_limit: d.rate_limit,
        error: r.ok ? undefined : String(j?.error?.message ?? '').slice(0, 160),
      }, r.ok ? 200 : 502);
    } catch (_e) {
      return json({ ok: false, error: 'quota lookup failed' }, 502);
    }
  }
  const images: string[] = (Array.isArray(body.images) ? body.images : [body.image]).filter(Boolean).slice(0, 10);
  if (!images.length) return json({ ok: false, error: 'no image' }, 400);
  for (const im of images) {
    if (typeof im !== 'string' || !im.startsWith('data:image/') || im.length > MAX_IMAGE_CHARS)
      return json({ ok: false, error: 'invalid or too large image' }, 400);
  }

  let models = (typeof body.models === 'string' && body.models ? body.models : (Deno.env.get('AI_MODELS') || DEFAULT_MODELS))
    .split(',').map((m: string) => m.trim()).filter((m: string) => m && allowed(m));
  if (!models.includes(PAID_ALLOWED[0])) models.push(PAID_ALLOWED[0]);   // 무료가 모두 실패했을 때의 마지막 수단

  const debug = body.debug === true;
  const tried: { model: string; status: string; raw?: string }[] = [];
  const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
  for (const model of models) {
    // 429(무료 모델 혼잡/한도)·5xx는 1회 재시도 후 다음 모델로 폴백
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 60000);
        const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          signal: ctl.signal,
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'expiry-tracker' },
          body: JSON.stringify({
            model,
            temperature: 0,
            max_tokens: 2500,
            reasoning: { effort: 'low' }, // 추론형 모델이 토큰을 생각에 다 쓰지 않도록 (미지원 모델은 무시)
            response_format: { type: 'json_object' },
            messages: [{
              role: 'user',
              content: [{ type: 'text', text: PROMPT }, ...images.map((u) => ({ type: 'image_url', image_url: { url: u } }))],
            }],
          }),
        });
        clearTimeout(t);
        if (!r.ok) {
          // OpenRouter의 오류 사유만 짧게 전달 (요청 헤더/키는 포함되지 않음)
          let why = '';
          try {
            const e = await r.json();
            why = [e?.error?.message, typeof e?.error?.metadata?.raw === 'string' ? e.error.metadata.raw : ''].filter(Boolean).join(' | ').slice(0, 200);
          } catch { /* ignore */ }
          if ((r.status === 429 || r.status >= 500) && attempt === 0) { await sleep(2500); continue; }
          tried.push({ model, status: `http ${r.status}${why ? ': ' + why : ''}` });
          break;
        }
        const j = await r.json();
        const text = j?.choices?.[0]?.message?.content;
        const str = typeof text === 'string' ? text : JSON.stringify(text ?? '');
        const parsed = parse(str);
        const rawItems = Array.isArray(parsed?.items) ? parsed.items : (parsed ? [parsed] : []);
        const list = rawItems.slice(0, 10).map((o: any) => clean(o, images.length)).filter((d: any) => d && (d.name || d.brand || d.expiry));
        const data = list[0];
        if (!data) {
          const fin = j?.choices?.[0]?.finish_reason;
          tried.push({ model, status: `unparsable${fin ? ' (' + fin + ')' : ''}`, ...(debug ? { raw: str.slice(0, 300) } : {}) });
          break;
        }
        tried.push({ model, status: 'ok' });
        return json({ ok: true, model, data, items: list, tried }); // data = 첫 항목(구버전 앱 호환), items = 제품별 목록
      } catch (_e) {
        tried.push({ model, status: 'error' }); // 오류 내용은 키/주소 노출 방지를 위해 돌려주지 않음
        break;
      }
    }
  }
  return json({ ok: false, error: 'all models failed', tried }, 502);
});
