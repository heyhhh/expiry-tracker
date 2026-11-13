// 제품 대표 이미지 검색 프록시 (NAVER API HUB 검색: 쇼핑 → 결과가 없거나 쓸 수 없으면 이미지 검색으로 대체)
// 시크릿: NAVER_CLIENT_ID, NAVER_CLIENT_SECRET (필수), ANALYZE_TOKEN (analyze와 같은 임시 접근 토큰)
// 키는 NAVER API HUB(console.ncloud.com) 애플리케이션의 Client ID(X-NCP-APIGW-API-KEY-ID) / Client Secret(X-NCP-APIGW-API-KEY).
// 기존 개발자센터(openapi.naver.com) 키도 대체 경로로 시도한다. 이미지 파일은 저장하지 않고 "이미지 주소"만 돌려준다.
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'apikey, authorization, content-type, x-client-info, x-admin-token',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const stripTags = (t: unknown) => String(t ?? '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();

type Item = { image: string; title: string; brand: string; mall: string };
type Res = { ok: boolean; status: number; data?: any; why?: string };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);

  const token = Deno.env.get('ANALYZE_TOKEN');
  if (!token || req.headers.get('x-admin-token') !== token) return json({ ok: false, error: 'unauthorized' }, 401);

  const clean = (v: string | undefined) => (v || '').trim().replace(/^["']|["']$/g, '').trim();
  let id = clean(Deno.env.get('NAVER_CLIENT_ID'));
  let secret = clean(Deno.env.get('NAVER_CLIENT_SECRET'));
  if (!id || !secret) return json({ ok: false, error: 'naver keys missing' }, 500);
  // API HUB 키: ID 10자 / Secret 40자. 서로 바뀌어 저장돼도 길이로 바로잡는다
  if (id.length > secret.length) [id, secret] = [secret, id];
  const shape = (v: string) => `${v.length}자 ${/^[A-Za-z0-9_]+$/.test(v) ? '영숫자' : '특수문자포함'}`;

  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const name = String(body?.q ?? '').trim().slice(0, 60);
  const brand = String(body?.brand ?? '').trim().slice(0, 30);
  if (name.length < 2) return json({ ok: false, error: 'query too short' }, 400);
  const query = brand && !name.includes(brand) ? `${brand} ${name}` : name;

  // 호출. 실패 시 상태/사유만 돌려준다(키는 포함되지 않음)
  const call = async (url: string): Promise<Res> => {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 8000);
      const r = await fetch(url, {
        headers: {
          'X-NCP-APIGW-API-KEY-ID': id, 'X-NCP-APIGW-API-KEY': secret,
          'X-Naver-Client-Id': id, 'X-Naver-Client-Secret': secret,
        },
        signal: ctl.signal,
      });
      clearTimeout(t);
      if (!r.ok) {
        let why = '';
        try { const e = await r.json(); why = JSON.stringify(e?.error ?? e).slice(0, 90); } catch { /* ignore */ }
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

  const HUB = 'https://naverapihub.apigw.ntruss.com/search/v1';
  const OLD = 'https://openapi.naver.com/v1/search';
  const q = encodeURIComponent(query);
  const qi = encodeURIComponent(query + ' 제품');
  const tried: string[] = [];
  let items: Item[] = [];
  let source = '';

  // [종류, 주소, 이미지 추출]
  const plan: [string, string, (it: any) => string][] = [
    ['hub-shop', `${HUB}/shop?query=${q}&display=12&sort=sim`, (it) => String(it?.image ?? '')],
    ['hub-image', `${HUB}/image?query=${qi}&display=12&sort=sim&filter=all`, (it) => String(it?.thumbnail ?? '')],
    ['old-shop', `${OLD}/shop.json?query=${q}&display=12&sort=sim`, (it) => String(it?.image ?? '')],
    ['old-image', `${OLD}/image?query=${qi}&display=12&sort=sim&filter=all`, (it) => String(it?.thumbnail ?? '')],
  ];
  for (const [kind, url, pick] of plan) {
    const r = await call(url);
    if (!r.ok) { tried.push(`${kind}=${r.status}${r.why ? ' ' + r.why : ''}`); continue; }
    const got = collect(r.data?.items, pick);
    tried.push(`${kind}=ok(${got.length})`);
    if (got.length) { items = got; source = kind.endsWith('shop') ? 'shop' : 'image'; break; }
  }

  if (!items.length && tried.every((t) => !t.includes('=ok('))) {
    return json({ ok: false, error: tried.join(' | '), keys: `id=${shape(id)}, secret=${shape(secret)}` }, 502);
  }
  return json({ ok: true, query, source, items, tried });
});
