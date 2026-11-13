// 제품 사진 → 제품 정보(JSON) 분석 프록시 (OpenRouter, OpenAI 호환 chat/completions)
// 시크릿: OPENROUTER_API_KEY (필수), ANALYZE_TOKEN (임시 접근 토큰, 로그인 도입 전까지),
//         AI_MODELS (선택, 쉼표 구분. 앞에서부터 시도하고 실패하면 다음 모델로 폴백)
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'apikey, authorization, content-type, x-client-info, x-admin-token',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const CATS = ['유제품', '육류', '수산물', '채소/과일', '음료', '과자/간식', '냉동식품', '가공식품', '소스/양념', '기타'];
const DEFAULT_MODELS = 'google/gemma-4-31b-it:free,particle-ai/particle-1:free,google/gemma-4-26b-a4b-it:free,nvidia/nemotron-3.5-super-vl:free';
const MAX_IMAGE_CHARS = 1_800_000; // data URL 길이 상한 (약 1.3MB)

const PROMPT = `당신은 한국 식품 포장 사진을 읽는 도우미입니다. 사진이 여러 장이면 모두 같은 제품의 앞면/뒷면/날짜 인쇄면 등 서로 다른 면입니다. 모든 사진에 실제로 인쇄된 글자만 근거로 종합해서 아래 JSON 하나만 출력하세요. 설명이나 코드블록은 쓰지 마세요.
{
 "name": "제품명 (포장에 가장 크게 인쇄된 상품 이름만. 한국어 그대로. 용량·규격·부제·설명 문구·홍보 문구(예: 대용량, 1+1, 신제품, 건면, 매운맛 설명)는 제외하되, 맛/종류가 이름의 일부인 경우(예: 딸기맛 우유)는 포함)",
 "brand": "브랜드 또는 제조사",
 "category": "${CATS.join(' | ')} 중 하나",
 "exp_type": "소비기한 | 유통기한 | null (문구가 보일 때만)",
 "expiry": "YYYY-MM-DD 형식의 기한 날짜, 보이지 않거나 불확실하면 null",
 "confidence": "high | medium | low"
}
규칙: 보이지 않는 값은 추측하지 말고 null. 날짜는 '2027.03.15까지', '27/03/15' 같은 표기를 YYYY-MM-DD로 변환. 제조일자와 기한을 혼동하지 말 것.`;

function parse(text: string) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}
function clean(o: any) {
  if (!o || typeof o !== 'object') return null;
  const s = (v: unknown) => (typeof v === 'string' && v.trim() && v.trim().toLowerCase() !== 'null' ? v.trim() : null);
  const exp = s(o.expiry);
  const barcode = s(o.barcode)?.replace(/\D/g, '') || null;
  return {
    name: s(o.name),
    brand: s(o.brand),
    category: CATS.includes(o.category) ? o.category : '기타',
    barcode: barcode && /^\d{8,14}$/.test(barcode) ? barcode : null,
    exp_type: o.exp_type === '유통기한' || o.exp_type === '소비기한' ? o.exp_type : null,
    expiry: exp && /^\d{4}-\d{2}-\d{2}$/.test(exp) ? exp : null,
    confidence: ['high', 'medium', 'low'].includes(o.confidence) ? o.confidence : 'low',
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);

  // 임시 접근 제어: 로그인(Auth) 도입 전까지 토큰이 맞는 호출만 허용 (비용 보호)
  const token = Deno.env.get('ANALYZE_TOKEN');
  if (!token || req.headers.get('x-admin-token') !== token) return json({ ok: false, error: 'unauthorized' }, 401);

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
  const images: string[] = (Array.isArray(body.images) ? body.images : [body.image]).filter(Boolean).slice(0, 5);
  if (!images.length) return json({ ok: false, error: 'no image' }, 400);
  for (const im of images) {
    if (typeof im !== 'string' || !im.startsWith('data:image/') || im.length > MAX_IMAGE_CHARS)
      return json({ ok: false, error: 'invalid or too large image' }, 400);
  }

  const models = (typeof body.models === 'string' && body.models ? body.models : (Deno.env.get('AI_MODELS') || DEFAULT_MODELS))
    .split(',').map((m: string) => m.trim()).filter(Boolean);

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
        const data = clean(parse(str));
        if (!data || !(data.name || data.brand || data.barcode || data.expiry)) {
          const fin = j?.choices?.[0]?.finish_reason;
          tried.push({ model, status: `unparsable${fin ? ' (' + fin + ')' : ''}`, ...(debug ? { raw: str.slice(0, 300) } : {}) });
          break;
        }
        tried.push({ model, status: 'ok' });
        return json({ ok: true, model, data, tried });
      } catch (_e) {
        tried.push({ model, status: 'error' }); // 오류 내용은 키/주소 노출 방지를 위해 돌려주지 않음
        break;
      }
    }
  }
  return json({ ok: false, error: 'all models failed', tried }, 502);
});
