// ─── CONFIG ───────────────────────────────────────────────────────────────────
const WORKER_URL = 'https://dca-proxy.yourname.workers.dev'; // ← เปลี่ยนหลัง deploy
const CACHE_TTL  = 10 * 60 * 1000;
const APP_VER    = 'v2.1.0';

let wealthChart = null;
let currentMode = 'single'; // 'single' | 'compare'

// ─── MODE TOGGLE ──────────────────────────────────────────────────────────────
function setMode(mode) {
    currentMode = mode;
    document.getElementById('mode-single').classList.toggle('active', mode === 'single');
    document.getElementById('mode-compare').classList.toggle('active', mode === 'compare');
    document.getElementById('row-single').classList.toggle('hidden', mode === 'compare');
    document.getElementById('row-compare').classList.toggle('hidden', mode === 'single');
    // ซ่อน result เมื่อสลับ mode
    document.getElementById('result-area').classList.add('hidden');
}

// ─── CURRENCY PREFIX ──────────────────────────────────────────────────────────
function onCurrencyChange() {
    const sym = document.getElementById('currency').value === 'THB' ? '฿' : '$';
    document.getElementById('currency-prefix').textContent = sym;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function calculateDCA() {
    const monthlyRaw = parseFloat(document.getElementById('monthly-amount').value);
    const years      = parseInt(document.getElementById('years').value);
    const currency   = document.getElementById('currency').value;

    // Symbols ตามโหมด
    const symbolA = (currentMode === 'single'
        ? document.getElementById('symbol').value
        : document.getElementById('symbol-a').value
    ).trim().toUpperCase();

    const symbolB = currentMode === 'compare'
        ? document.getElementById('symbol-b').value.trim().toUpperCase()
        : null;

    // Validation
    if (!symbolA)                          return showError('Please enter a stock symbol.');
    if (currentMode === 'compare' && !symbolB) return showError('Please enter Stock B symbol.');
    if (currentMode === 'compare' && symbolA === symbolB) return showError('Stock A and B must be different.');
    if (!monthlyRaw || monthlyRaw <= 0)    return showError('Monthly amount must be greater than 0.');
    if (!years || years < 1 || years > 20) return showError('Investment period must be between 1–20 years.');

    clearError();
    setLoading(true);

    try {
        const [exchangeRate, dataA, dataB] = await Promise.all([
            currency === 'THB' ? fetchRate() : Promise.resolve(1),
            fetchPrice(symbolA, years),
            symbolB ? fetchPrice(symbolB, years) : Promise.resolve(null),
        ]);

        const monthlyUSD = currency === 'THB' ? monthlyRaw / exchangeRate : monthlyRaw;

        // ─── Simulate A ───
        const simA   = simulateDCA(dataA.closes, monthlyUSD);
        const priceA = dataA.closes[dataA.closes.length - 1];
        const valueA = simA.totalShares * priceA;
        const labelsA = buildLabels(dataA.timestamps);
        const cagrA  = calcCAGR(simA.investedHistory, simA.portfolioHistory);

        displayPanel('a', symbolA, priceA, simA.totalInvestedUSD, valueA, simA.totalShares, exchangeRate, currency);

        // ─── Simulate B (compare mode) ───
        let simB = null, priceB = null, valueB = null, cagrB = null, labelsB = null;
        if (dataB) {
            simB   = simulateDCA(dataB.closes, monthlyUSD);
            priceB = dataB.closes[dataB.closes.length - 1];
            valueB = simB.totalShares * priceB;
            labelsB = buildLabels(dataB.timestamps);
            cagrB  = calcCAGR(simB.investedHistory, simB.portfolioHistory);
            displayPanel('b', symbolB, priceB, simB.totalInvestedUSD, valueB, simB.totalShares, exchangeRate, currency);
        }

        // ─── Chart ───
        renderChart({
            labelsA, labelsB,
            portfolioA: simA.portfolioHistory,
            investedA:  simA.investedHistory,
            portfolioB: simB ? simB.portfolioHistory : null,
            cagrA, cagrB,
            lastValueA: valueA,
            lastValueB: valueB,
            monthlyUSD,
            currency, exchangeRate,
        });

        // ─── Forecast summary cards ───
        renderForecast({ symbolA, symbolB, cagrA, cagrB, valueA, valueB, monthlyUSD, currency, exchangeRate });

        // ─── Layout ───
        const wrapper = document.getElementById('compare-wrapper');
        document.getElementById('panel-b').classList.toggle('hidden', !dataB);
        wrapper.classList.toggle('side-by-side', !!dataB);

        // Legend
        const legendB = document.getElementById('legend-b-wrap');
        if (dataB) {
            if (!legendB) {
                const frag = document.createElement('span');
                frag.id = 'legend-b-wrap';
                frag.innerHTML = `<span class="dot blue"></span><span id="legend-b-name">${symbolB}</span>`;
                document.getElementById('chart-legend').appendChild(frag);
            } else {
                document.getElementById('legend-b-name').textContent = symbolB;
            }
            document.getElementById('legend-a-name').textContent = symbolA;
        } else {
            if (legendB) legendB.remove();
            document.getElementById('legend-a-name').textContent = 'Portfolio Value';
        }

        document.getElementById('result-area').classList.remove('hidden');
        document.getElementById('result-area').scrollIntoView({ behavior: 'smooth', block: 'start' });

    } catch (err) {
        showError(err.message || 'Something went wrong. Please try again.');
    } finally {
        setLoading(false);
    }
}

// ─── BUG FIX: ตัดเดือนปัจจุบัน (ยังไม่ปิด) ออก ─────────────────────────────
// Yahoo ส่งเดือนปัจจุบันที่ candle ยังไม่สมบูรณ์มาด้วย
// ทำให้นับเกิน 1 เดือน → totalInvested สูงกว่าจริง
function trimCurrentMonth(closes, timestamps) {
    const now       = new Date();
    const curYear   = now.getFullYear();
    const curMonth  = now.getMonth(); // 0-indexed

    // ถ้าเดือนสุดท้ายใน data ตรงกับเดือนปัจจุบัน → ตัดทิ้ง
    const last = new Date(timestamps[timestamps.length - 1] * 1000);
    if (last.getFullYear() === curYear && last.getMonth() === curMonth) {
        return {
            closes:     closes.slice(0, -1),
            timestamps: timestamps.slice(0, -1),
        };
    }
    return { closes, timestamps };
}

// ─── FETCH PRICE ──────────────────────────────────────────────────────────────
async function fetchPrice(symbol, years) {
    const cacheKey = `dca_${symbol}_${years}`;
    try {
        const cached = sessionStorage.getItem(cacheKey);
        if (cached) {
            const { data, ts } = JSON.parse(cached);
            if (Date.now() - ts < CACHE_TTL) return data;
        }
    } catch {}

    const res  = await fetch(`${WORKER_URL}/price?symbol=${symbol}&years=${years}`);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `Server error ${res.status}`);

    // ── Apply bug fix: ตัดเดือนปัจจุบันออก ──
    const { closes, timestamps } = trimCurrentMonth(json.closes, json.timestamps);

    const result = { closes, timestamps };
    try { sessionStorage.setItem(cacheKey, JSON.stringify({ data: result, ts: Date.now() })); } catch {}
    return result;
}

// ─── FETCH RATE ───────────────────────────────────────────────────────────────
async function fetchRate() {
    try {
        const res  = await fetch(`${WORKER_URL}/rate`);
        const json = await res.json();
        return json.rate ?? 36;
    } catch { return 36; }
}

// ─── DCA SIMULATION ───────────────────────────────────────────────────────────
function simulateDCA(prices, monthlyUSD) {
    let totalShares = 0, totalInvestedUSD = 0;
    const portfolioHistory = [], investedHistory = [];

    prices.forEach(price => {
        totalShares      += monthlyUSD / price;
        totalInvestedUSD += monthlyUSD;
        portfolioHistory.push(parseFloat((totalShares * price).toFixed(2)));
        investedHistory.push(parseFloat(totalInvestedUSD.toFixed(2)));
    });

    return { totalShares, totalInvestedUSD, portfolioHistory, investedHistory };
}

// ─── CAGR (Compound Annual Growth Rate) ──────────────────────────────────────
function calcCAGR(investedHistory, portfolioHistory) {
    const n = portfolioHistory.length;
    if (n < 2) return 0;
    const startVal  = investedHistory[0];
    const endVal    = portfolioHistory[n - 1];
    const yearsHeld = n / 12;
    if (startVal <= 0 || endVal <= 0) return 0;
    return Math.pow(endVal / startVal, 1 / yearsHeld) - 1;
}

// ─── FORECAST (1 ปีข้างหน้า จาก CAGR) ───────────────────────────────────────
function buildForecastPoints(lastValue, monthlyUSD, cagr, months = 12) {
    const monthlyRate = Math.pow(1 + cagr, 1 / 12) - 1;
    const pts = [];
    let val = lastValue;
    for (let i = 1; i <= months; i++) {
        val = (val + monthlyUSD) * (1 + monthlyRate);
        pts.push(parseFloat(val.toFixed(2)));
    }
    return pts;
}

// ─── DISPLAY PANEL ────────────────────────────────────────────────────────────
function displayPanel(side, symbol, lastPrice, invested, value, shares, rate, currency) {
    const mul      = currency === 'THB' ? rate : 1;
    const sym      = currency === 'THB' ? '฿' : '$';
    const decimals = currency === 'THB' ? 0 : 2;
    const fmt      = (v) => `${sym}${(v * mul).toLocaleString('en-US', { maximumFractionDigits: decimals })}`;

    document.getElementById(`label-${side}`).textContent = symbol;
    document.getElementById(`price-${side}`).textContent =
        `Last close: ${sym}${(lastPrice * mul).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

    document.getElementById(`total-invested-${side}`).textContent = fmt(invested);
    document.getElementById(`current-value-${side}`).textContent  = fmt(value);

    const profit   = ((value - invested) / invested) * 100;
    const profitEl = document.getElementById(`total-profit-${side}`);
    profitEl.textContent  = `${profit >= 0 ? '+' : ''}${profit.toFixed(2)}%`;
    profitEl.style.color  = profit >= 0 ? 'var(--green)' : 'var(--red)';

    document.getElementById(`total-shares-${side}`).textContent = shares.toFixed(4);
}

// ─── CHART ────────────────────────────────────────────────────────────────────
function renderChart({ labelsA, labelsB, portfolioA, investedA, portfolioB, cagrA, cagrB,
                       lastValueA, lastValueB, monthlyUSD, currency, exchangeRate }) {

    if (wealthChart) { wealthChart.destroy(); wealthChart = null; }

    const mul = currency === 'THB' ? exchangeRate : 1;
    const sym = currency === 'THB' ? '฿' : '$';
    const dec = currency === 'THB' ? 0 : 2;

    // Forecast points
    const forecastA = buildForecastPoints(lastValueA, monthlyUSD, cagrA);
    const forecastB = portfolioB ? buildForecastPoints(lastValueB, monthlyUSD, cagrB) : null;

    // Labels: historical + 12 forecast months
    const lastTs   = new Date();
    const fcastLbls = Array.from({ length: 12 }, (_, i) => {
        const d = new Date(lastTs.getFullYear(), lastTs.getMonth() + i + 1, 1);
        return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
    });
    const labels = [...labelsA, ...fcastLbls];

    // Pad historical data with null so forecast starts at the right position
    const histLen   = labelsA.length;
    const nullPad   = Array(histLen).fill(null);
    const nullPadB  = labelsB ? Array(labelsB.length).fill(null) : Array(histLen).fill(null);

    // Join historical + null gap for forecast line (connect last point)
    const portfolioAFull  = [...portfolioA.map(v => parseFloat((v * mul).toFixed(2))), ...forecastA.map(v => parseFloat((v * mul).toFixed(2)))];
    const investedAFull   = [...investedA.map(v => parseFloat((v * mul).toFixed(2))), ...Array(12).fill(null)];

    const ctx = document.getElementById('wealthChart').getContext('2d');

    const datasets = [
        {
            label: 'Portfolio A',
            data: portfolioAFull,
            borderColor: '#10b981',
            backgroundColor: 'rgba(16,185,129,0.08)',
            borderWidth: 2.5,
            pointRadius: 0, pointHoverRadius: 5,
            tension: 0.4, fill: false,
            segment: {
                borderDash: (ctx) => ctx.p0DataIndex >= histLen - 1 ? [6, 4] : [],
                borderColor: (ctx) => ctx.p0DataIndex >= histLen - 1 ? 'rgba(16,185,129,0.5)' : '#10b981',
            },
        },
        {
            label: 'Amount Invested',
            data: investedAFull,
            borderColor: '#475569',
            backgroundColor: 'transparent',
            borderWidth: 1.5,
            borderDash: [5, 4],
            pointRadius: 0, pointHoverRadius: 4,
            tension: 0.1, fill: false,
            spanGaps: false,
        },
    ];

    if (portfolioB) {
        const portfolioBFull = [
            ...portfolioB.map(v => parseFloat((v * mul).toFixed(2))),
            ...forecastB.map(v => parseFloat((v * mul).toFixed(2))),
        ];
        const bHistLen = labelsB ? labelsB.length : histLen;
        datasets.push({
            label: 'Portfolio B',
            data: portfolioBFull,
            borderColor: '#38bdf8',
            backgroundColor: 'rgba(56,189,248,0.06)',
            borderWidth: 2.5,
            pointRadius: 0, pointHoverRadius: 5,
            tension: 0.4, fill: false,
            segment: {
                borderDash: (ctx) => ctx.p0DataIndex >= bHistLen - 1 ? [6, 4] : [],
                borderColor: (ctx) => ctx.p0DataIndex >= bHistLen - 1 ? 'rgba(56,189,248,0.5)' : '#38bdf8',
            },
        });
    }

    wealthChart = new Chart(ctx, {
        type: 'line',
        data: { labels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: '#1e293b',
                    borderColor: '#334155',
                    borderWidth: 1,
                    titleColor: '#94a3b8',
                    bodyColor: '#f8fafc',
                    padding: 12,
                    filter: (item) => item.parsed.y !== null,
                    callbacks: {
                        label: (c) => ` ${c.dataset.label}: ${sym}${c.parsed.y.toLocaleString('en-US', { maximumFractionDigits: dec })}`,
                    },
                },
                annotation: {},
            },
            scales: {
                x: {
                    grid: { color: 'rgba(51,65,85,0.4)', drawTicks: false },
                    ticks: { color: '#64748b', font: { size: 11 }, maxRotation: 0, maxTicksLimit: 10 },
                },
                y: {
                    grid: { color: 'rgba(51,65,85,0.4)', drawTicks: false },
                    ticks: {
                        color: '#64748b', font: { size: 11 },
                        callback: (v) => `${sym}${v >= 1000 ? (v / 1000).toFixed(0) + 'k' : v}`,
                    },
                },
            },
        },
    });
}

// ─── FORECAST SUMMARY CARDS ───────────────────────────────────────────────────
function renderForecast({ symbolA, symbolB, cagrA, cagrB, valueA, valueB, monthlyUSD, currency, exchangeRate }) {
    const mul = currency === 'THB' ? exchangeRate : 1;
    const sym = currency === 'THB' ? '฿' : '$';
    const dec = currency === 'THB' ? 0 : 2;
    const fmt = (v) => `${sym}${(v * mul).toLocaleString('en-US', { maximumFractionDigits: dec })}`;

    const fcastA = buildForecastPoints(valueA, monthlyUSD, cagrA);
    const endA   = fcastA[fcastA.length - 1];

    let html = `
        <div class="forecast-item">
            <div class="f-label">${symbolA} — est. value in 1 yr</div>
            <div class="f-val">${fmt(endA)}</div>
            <div class="f-sub">CAGR ${(cagrA * 100).toFixed(1)}%/yr · +${fmt(endA - valueA)} gain</div>
        </div>
        <div class="forecast-item">
            <div class="f-label">${symbolA} — additional invested</div>
            <div class="f-val">${fmt(monthlyUSD * 12)}</div>
            <div class="f-sub">12 months × ${fmt(monthlyUSD)} per month</div>
        </div>
    `;

    if (symbolB && cagrB !== null) {
        const fcastB = buildForecastPoints(valueB, monthlyUSD, cagrB);
        const endB   = fcastB[fcastB.length - 1];
        html += `
            <div class="forecast-item">
                <div class="f-label">${symbolB} — est. value in 1 yr</div>
                <div class="f-val">${fmt(endB)}</div>
                <div class="f-sub">CAGR ${(cagrB * 100).toFixed(1)}%/yr · +${fmt(endB - valueB)} gain</div>
            </div>
        `;
    }

    document.getElementById('forecast-grid').innerHTML = html;
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function buildLabels(timestamps) {
    return (timestamps || []).map(t => {
        const d = new Date(t * 1000);
        return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
    });
}

function setLoading(on) {
    document.getElementById('calculate-btn').disabled = on;
    document.getElementById('btn-text').classList.toggle('hidden', on);
    document.getElementById('btn-loader').classList.toggle('hidden', !on);
}

function showError(msg) {
    const el = document.getElementById('error-msg');
    el.textContent = `⚠️ ${msg}`;
    el.classList.remove('hidden');
}

function clearError() {
    document.getElementById('error-msg').classList.add('hidden');
}