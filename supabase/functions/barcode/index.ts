// 식품안전나라 C005(바코드연계제품정보) 프록시. 키는 시크릿 MFDS_KEY에만 존재합니다.
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'apikey, authorization, content-type, x-client-info',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const code = (new URL(req.url).searchParams.get('code') || '').trim();
  if (!/^\d{8,14}$/.test(code)) return json({ found: false, error: 'bad code' }, 400);
  const key = Deno.env.get('MFDS_KEY');
  if (!key) return json({ found: false, error: 'server key missing' }, 500);
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(`https://openapi.foodsafetykorea.go.kr/api/${key}/C005/json/1/1/BAR_CD=${code}`, { signal: ctl.signal });
    clearTimeout(t);
    const j = await r.json();
    const row = j?.C005?.row?.[0];
    if (!row) return json({ found: false });
    return json({
      found: true,
      name: row.PRDLST_NM || '',
      brand: (row.BSSH_NM || '').replace(/\(주\)|㈜|주식회사/g, '').trim(),
      type: row.PRDLST_DCNM || '',
      shelf: row.POG_DAYCNT || '',
    });
  } catch (_e) {
    // 에러 문구에 요청 URL(=키)이 섞일 수 있으므로 내용을 돌려주지 않습니다.
    return json({ found: false, error: 'upstream error' }, 502);
  }
});
