// 제품 대표 이미지 검색 프록시 (네이버 검색 API: 쇼핑 → 결과가 없거나 쇼핑 API를 쓸 수 없으면 이미지 검색으로 대체)
// 시크릿: NAVER_CLIENT_ID, NAVER_CLIENT_SECRET (필수), ANALYZE_TOKEN (analyze와 같은 임시 접근 토큰)
// 이미지 파일은 저장하지 않고 "이미지 주소"만 앱으로 돌려준다.
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'apikey, authorization, content-type, x-client-info, x-admin-token',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const stripTags = (t: unknown) => String(t ?? '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();

type Item = { image: string; title: string; brand: string; mall: string };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);

  const token = Deno.env.get('ANALYZE_TOKEN');
  if (!token || req.headers.get('x-admin-token') !== token) return json({ ok: false, error: 'unauthorized' }, 401);

  // 붙여넣기 실수(앞뒤 공백/줄바꿈, 따옴표) 정리
  const clean = (v: string | undefined) => (v || '').trim().replace(/^["']|["']$/g, '').trim();
  const id = clean(Deno.env.get('NAVER_CLIENT_ID'));
  const secret = clean(Deno.env.get('NAVER_CLIENT_SECRET'));
  if (!id || !secret) return json({ ok: false, error: 'naver keys missing' }, 500);

  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const name = String(body?.q ?? '').trim().slice(0, 60);
  const brand = String(body?.brand ?? '').trim().slice(0, 30);
  if (name.length < 2) return json({ ok: false, error: 'query too short' }, 400);
  const query = brand && !name.includes(brand) ? `${brand} ${name}` : name;

  // 네이버 호출. 실패 시 {status} 만 돌려준다(요청 헤더/키가 섞인 오류 문구는 돌려주지 않음)
  const naver = async (url: string): Promise<{ ok: boolean; status: number; data?: any; why?: string }> => {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 8000);
      const r = await fetch(url, { headers: { 'X-Naver-Client-Id': id, 'X-Naver-Client-Secret': secret }, signal: ctl.signal });
      clearTimeout(t);
      if (!r.ok) {
        // 네이버가 알려주는 거절 사유(errorCode/errorMessage)만 짧게 전달. 요청 헤더/키는 포함되지 않음
        let why = '';
        try { const e = await r.json(); why = `${e?.errorCode ?? ''} ${String(e?.errorMessage ?? '')}`.trim().slice(0, 80); } catch { /* ignore */ }
        return { ok: false, status: r.status, why };
      }
      return { ok: true, status: r.status, data: await r.json() };
    } catch (_e) {
      return { ok: false, status: 0 };
    }
  };

  const collect = (raw: any[], pick: (it: any) => string): Item[] => {
    const seen = new Set<string>();
    const out: Item[] = [];
    for (const it of raw ?? []) {
      const image = pick(it);
      if (!image.startsWith('https://') || seen.has(image)) continue;
      seen.add(image);
      out.push({ image, title: stripTags(it.title).slice(0, 80), brand: stripTags(it.brand || it.maker), mall: stripTags(it.mallName) });
      if (out.length >= 6) break;
    }
    return out;
  };

  // 1) 쇼핑 검색: 상품 포장 이미지가 잘 나옴
  const shop = await naver(`https://openapi.naver.com/v1/search/shop.json?query=${encodeURIComponent(query)}&display=12&sort=sim&exclude=used:rental:cbshop`);
  let items = shop.ok ? collect(shop.data?.items, (it) => String(it?.image ?? '')) : [];
  let source = 'shop';

  // 2) 쇼핑 결과가 없거나 쇼핑 API를 쓸 수 없으면 이미지 검색으로 대체
  let img: { ok: boolean; status: number; data?: any; why?: string } | null = null;
  if (!items.length) {
    img = await naver(`https://openapi.naver.com/v1/search/image?query=${encodeURIComponent(query + ' 제품')}&display=12&sort=sim&filter=all`);
    if (img.ok) { items = collect(img.data?.items, (it) => String(it?.thumbnail ?? '')); source = 'image'; }
  }

  if (!items.length && !shop.ok && !(img && img.ok)) {
    const d = (x: { status: number; why?: string } | null) => (x ? `${x.status}${x.why ? ' ' + x.why : ''}` : '-');
    return json({ ok: false, error: `naver shop=${d(shop)} | image=${d(img)}` }, 502);
  }
  return json({ ok: true, query, source, items });
});
