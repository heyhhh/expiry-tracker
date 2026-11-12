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
    const r = await fetch(`https://openapi.foodsafetykorea.or.kr/api/${key}/C005/json/1/1/BAR_CD=${code}`);
    const j = await r.json();
    const row = j?.C005?.row?.[0];
    if (!row) return json({ found: false });
    return json({
      found: true,
      name: row.PRDLST_NM || '',
      brand: row.BSSH_NM || '',
      type: row.PRDLST_DCNM || '',
      shelf: row.POG_DAYCNT || '',
    });
  } catch (e) {
    return json({ found: false, error: String(e) }, 502);
  }
});
