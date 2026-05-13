// ============================================================
//  DCA Simulator — Cloudflare Worker
//  Deploy ที่: https://dash.cloudflare.com → Workers & Pages
//
//  สิ่งที่ Worker นี้ทำ:
//  1. รับ request จาก frontend (symbol + period)
//  2. Fetch Yahoo Finance โดยตรง (server-side ไม่มี CORS ปัญหา)
//  3. Cache ผลไว้ใน Cloudflare Edge Cache 10 นาที
//  4. ส่ง JSON กลับพร้อม CORS headers ให้ browser อ่านได้
// ============================================================

const CACHE_SECONDS = 600; // 10 นาที (ปรับได้)

// ─── CORS HEADERS ─────────────────────────────────────────────────────────────
// เปลี่ยน * เป็น domain จริงของคุณเมื่อ deploy จริง เช่น
// "https://myportfolio.com"
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
};

// ─── ENTRY POINT ──────────────────────────────────────────────────────────────
export default {
    async fetch(request, env, ctx) {
        // Handle CORS preflight (browser ส่งมาก่อนทุกครั้ง)
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        // รับเฉพาะ GET
        if (request.method !== 'GET') {
            return jsonError('Method not allowed', 405);
        }

        const url = new URL(request.url);

        // ─── Router ───────────────────────────────────────────────────────────
        // GET /price?symbol=AAPL&years=5   → Yahoo Finance monthly candles
        // GET /rate                        → USD→THB exchange rate
        // GET /health                      → health check

        const path = url.pathname.replace(/\/$/, ''); // ตัด trailing slash

        if (path === '/price') return handlePrice(request, ctx);
        if (path === '/rate')  return handleRate(request, ctx);
        if (path === '/health') return new Response(
            JSON.stringify({ status: 'ok', ts: Date.now() }),
            { headers: CORS_HEADERS }
        );

        return jsonError('Not found', 404);
    },
};

// ─── /price ───────────────────────────────────────────────────────────────────
async function handlePrice(request, ctx) {
    const url    = new URL(request.url);
    const symbol = (url.searchParams.get('symbol') || '').toUpperCase().trim();
    const years  = parseInt(url.searchParams.get('years') || '5');

    // Validate
    if (!symbol || !/^[A-Z]{1,6}$/.test(symbol)) {
        return jsonError('Invalid symbol. Use 1-6 uppercase letters (e.g. AAPL)', 400);
    }
    if (isNaN(years) || years < 1 || years > 20) {
        return jsonError('years must be between 1 and 20', 400);
    }

    // ─── Cloudflare Cache API ──────────────────────────────────────────────
    // Worker ใช้ Cache API เหมือน browser แต่ cache อยู่ที่ edge ทั่วโลก
    const cacheKey  = new Request(`https://cache.dca-worker/price/${symbol}/${years}`);
    const cacheStore = caches.default;

    const cached = await cacheStore.match(cacheKey);
    if (cached) {
        // เพิ่ม header บอกว่ามาจาก cache
        const resp = new Response(cached.body, cached);
        resp.headers.set('X-Cache', 'HIT');
        return resp;
    }

    // ─── Fetch Yahoo Finance ───────────────────────────────────────────────
    const end   = Math.floor(Date.now() / 1000);
    const start = Math.floor(end - years * 365.25 * 24 * 60 * 60);
    const yahooUrl =
        `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}` +
        `?interval=1mo&period1=${start}&period2=${end}&includePrePost=false`;

    let yahooRes;
    try {
        yahooRes = await fetch(yahooUrl, {
            headers: {
                // Yahoo ต้องการ User-Agent ไม่งั้นอาจ block
                'User-Agent': 'Mozilla/5.0 (compatible; DCAWorker/1.0)',
                'Accept': 'application/json',
            },
            // Worker timeout 10 วินาที (Cloudflare default 30s แต่เราตั้งสั้นกว่า)
            signal: AbortSignal.timeout(10_000),
        });
    } catch (err) {
        return jsonError(`Failed to reach Yahoo Finance: ${err.message}`, 502);
    }

    if (!yahooRes.ok) {
        return jsonError(`Yahoo Finance returned HTTP ${yahooRes.status}`, 502);
    }

    let json;
    try {
        json = await yahooRes.json();
    } catch {
        return jsonError('Yahoo Finance returned invalid JSON', 502);
    }

    const result = json?.chart?.result?.[0];
    if (!result) {
        const errMsg = json?.chart?.error?.description || `Symbol "${symbol}" not found`;
        return jsonError(errMsg, 404);
    }

    const rawCloses     = result.indicators?.quote?.[0]?.close  || [];
    const rawTimestamps = result.timestamp || [];

    // กรอง null ที่ Yahoo ส่งมาบางเดือน
    const closes = [], timestamps = [];
    rawCloses.forEach((price, i) => {
        if (price !== null && price > 0) {
            closes.push(parseFloat(price.toFixed(4)));
            timestamps.push(rawTimestamps[i]);
        }
    });

    if (closes.length === 0) {
        return jsonError(`No valid price data for "${symbol}"`, 404);
    }

    // ─── BUG FIX: ตัดเดือนปัจจุบันออก ────────────────────────────────────
    // Yahoo Finance ส่งแท่งเทียนของเดือนปัจจุบันที่ยังไม่ปิดมาด้วย
    // ทำให้ DCA นับเกิน 1 เดือน → totalInvested สูงกว่าความจริง
    // แก้: ถ้า timestamp สุดท้ายอยู่ในเดือนเดียวกับวันนี้ → ตัดทิ้ง
    const now      = new Date();
    const lastDate = new Date(timestamps[timestamps.length - 1] * 1000);
    if (lastDate.getFullYear() === now.getFullYear() &&
        lastDate.getMonth()    === now.getMonth()) {
        closes.pop();
        timestamps.pop();
    }

    // ─── ส่ง Response + บันทึก Cache ──────────────────────────────────────
    const body = JSON.stringify({ symbol, years, closes, timestamps });

    const response = new Response(body, {
        status: 200,
        headers: {
            ...CORS_HEADERS,
            'Cache-Control': `public, max-age=${CACHE_SECONDS}`,
            'X-Cache': 'MISS',
        },
    });

    // ctx.waitUntil = บันทึก cache หลัง response ส่งแล้ว (ไม่บล็อก user)
    ctx.waitUntil(cacheStore.put(cacheKey, response.clone()));

    return response;
}

// ─── /rate ────────────────────────────────────────────────────────────────────
async function handleRate(request, ctx) {
    const cacheKey   = new Request('https://cache.dca-worker/rate/usd-thb');
    const cacheStore = caches.default;

    const cached = await cacheStore.match(cacheKey);
    if (cached) {
        const resp = new Response(cached.body, cached);
        resp.headers.set('X-Cache', 'HIT');
        return resp;
    }

    let rateRes;
    try {
        rateRes = await fetch('https://api.frankfurter.app/latest?from=USD&to=THB', {
            signal: AbortSignal.timeout(5_000),
        });
    } catch (err) {
        // Fallback: ส่งค่าประมาณกลับไปแทน error
        return new Response(
            JSON.stringify({ rate: 36, source: 'fallback' }),
            { headers: { ...CORS_HEADERS, 'X-Cache': 'FALLBACK' } }
        );
    }

    const data = await rateRes.json();
    const rate = data?.rates?.THB ?? 36;

    const body = JSON.stringify({ rate, source: 'frankfurter' });
    const response = new Response(body, {
        status: 200,
        headers: {
            ...CORS_HEADERS,
            // อัตราแลกเปลี่ยนเปลี่ยนรายวัน cache ไว้ 1 ชั่วโมง
            'Cache-Control': 'public, max-age=3600',
            'X-Cache': 'MISS',
        },
    });

    ctx.waitUntil(cacheStore.put(cacheKey, response.clone()));
    return response;
}

// ─── HELPER ───────────────────────────────────────────────────────────────────
function jsonError(message, status = 400) {
    return new Response(
        JSON.stringify({ error: message }),
        { status, headers: CORS_HEADERS }
    );
}