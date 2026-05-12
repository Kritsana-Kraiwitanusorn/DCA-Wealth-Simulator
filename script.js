// ─── CONFIG ───────────────────────────────────────────────────────────────────
// 👇 เปลี่ยนเป็น URL Worker ของคุณหลัง deploy
// ตัวอย่าง: 'https://dca-proxy.yourname.workers.dev'
const WORKER_URL = 'https://dca-proxy.k-data-api.workers.dev';

const CACHE_TTL = 10 * 60 * 1000; // 10 นาที (client-side cache สำรอง)

let wealthChart = null;

// ─── CURRENCY PREFIX ──────────────────────────────────────────────────────────
document.getElementById('currency').addEventListener('change', function () {
    document.getElementById('currency-prefix').textContent =
        this.value === 'THB' ? '฿' : '$';
});

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function calculateDCA() {
    const symbol     = document.getElementById('symbol').value.trim().toUpperCase();
    const monthlyRaw = parseFloat(document.getElementById('monthly-amount').value);
    const years      = parseInt(document.getElementById('years').value);
    const currency   = document.getElementById('currency').value;

    if (!symbol)                           return showError('Please enter a stock symbol.');
    if (!monthlyRaw || monthlyRaw <= 0)    return showError('Monthly amount must be greater than 0.');
    if (!years || years < 1 || years > 20) return showError('Investment period must be between 1–20 years.');

    clearError();
    setLoading(true);

    try {
        // ดึง exchange rate และ price data พร้อมกัน (parallel)
        const [exchangeRate, { closes, timestamps }] = await Promise.all([
            currency === 'THB' ? fetchRate() : Promise.resolve(1),
            fetchPrice(symbol, years),
        ]);

        const monthlyUSD = currency === 'THB' ? monthlyRaw / exchangeRate : monthlyRaw;

        const { totalShares, totalInvestedUSD, portfolioHistory, investedHistory } =
            simulateDCA(closes, monthlyUSD);

        const currentValueUSD = totalShares * closes[closes.length - 1];
        const labels          = buildLabels(timestamps);

        displayResults(totalInvestedUSD, currentValueUSD, totalShares, exchangeRate, currency);
        renderChart(labels, portfolioHistory, investedHistory, currency, exchangeRate);

        document.getElementById('result-area').classList.remove('hidden');
        document.getElementById('result-area').scrollIntoView({ behavior: 'smooth', block: 'start' });

    } catch (err) {
        showError(err.message || 'Something went wrong. Please try again.');
    } finally {
        setLoading(false);
    }
}

// ─── FETCH PRICE (จาก Worker ของเรา) ─────────────────────────────────────────
async function fetchPrice(symbol, years) {
    // 1. ตรวจ client-side cache ก่อน (สำรองกรณี Worker ไม่ตอบ)
    const cacheKey = `dca_${symbol}_${years}`;
    try {
        const cached = sessionStorage.getItem(cacheKey);
        if (cached) {
            const { data, ts } = JSON.parse(cached);
            if (Date.now() - ts < CACHE_TTL) {
                console.log(`[Client Cache HIT] ${symbol} ${years}Y`);
                return data;
            }
        }
    } catch { /* private mode — ข้ามไป */ }

    // 2. เรียก Worker
    const res = await fetch(`${WORKER_URL}/price?symbol=${symbol}&years=${years}`);
    const json = await res.json();

    if (!res.ok) {
        throw new Error(json.error || `Server error ${res.status}`);
    }

    const result = { closes: json.closes, timestamps: json.timestamps };

    // 3. บันทึก client-side cache
    try {
        sessionStorage.setItem(cacheKey, JSON.stringify({ data: result, ts: Date.now() }));
    } catch { /* ignore */ }

    return result;
}

// ─── FETCH RATE (จาก Worker ของเรา) ──────────────────────────────────────────
async function fetchRate() {
    try {
        const res  = await fetch(`${WORKER_URL}/rate`);
        const json = await res.json();
        return json.rate ?? 36;
    } catch {
        console.warn('Rate fetch failed. Using fallback: 36');
        return 36;
    }
}

// ─── DCA SIMULATION ───────────────────────────────────────────────────────────
function simulateDCA(prices, monthlyUSD) {
    let totalShares = 0, totalInvestedUSD = 0;
    const portfolioHistory = [], investedHistory = [];

    prices.forEach((price) => {
        totalShares      += monthlyUSD / price;
        totalInvestedUSD += monthlyUSD;
        portfolioHistory.push(parseFloat((totalShares * price).toFixed(2)));
        investedHistory.push(parseFloat(totalInvestedUSD.toFixed(2)));
    });

    return { totalShares, totalInvestedUSD, portfolioHistory, investedHistory };
}

// ─── DISPLAY RESULTS ──────────────────────────────────────────────────────────
function displayResults(invested, value, shares, rate, currency) {
    const mul      = currency === 'THB' ? rate : 1;
    const sym      = currency === 'THB' ? '฿' : '$';
    const decimals = currency === 'THB' ? 0 : 2;

    document.getElementById('total-invested').textContent =
        `${sym}${(invested * mul).toLocaleString('en-US', { maximumFractionDigits: decimals })}`;
    document.getElementById('current-value').textContent =
        `${sym}${(value * mul).toLocaleString('en-US', { maximumFractionDigits: decimals })}`;

    const profit   = ((value - invested) / invested) * 100;
    const profitEl = document.getElementById('total-profit');
    profitEl.textContent = `${profit >= 0 ? '+' : ''}${profit.toFixed(2)}%`;
    profitEl.style.color = profit >= 0 ? 'var(--green)' : 'var(--red)';

    document.getElementById('total-shares').textContent = shares.toFixed(4);
}

// ─── CHART ────────────────────────────────────────────────────────────────────
function renderChart(labels, portfolioData, investedData, currency, rate) {
    const mul = currency === 'THB' ? rate : 1;
    const sym = currency === 'THB' ? '฿' : '$';

    if (wealthChart) { wealthChart.destroy(); wealthChart = null; }

    const ctx = document.getElementById('wealthChart').getContext('2d');

    const gradientGreen = ctx.createLinearGradient(0, 0, 0, 300);
    gradientGreen.addColorStop(0, 'rgba(16, 185, 129, 0.35)');
    gradientGreen.addColorStop(1, 'rgba(16, 185, 129, 0)');

    const gradientGray = ctx.createLinearGradient(0, 0, 0, 300);
    gradientGray.addColorStop(0, 'rgba(148, 163, 184, 0.15)');
    gradientGray.addColorStop(1, 'rgba(148, 163, 184, 0)');

    wealthChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: 'Portfolio Value',
                    data: portfolioData.map(v => parseFloat((v * mul).toFixed(2))),
                    borderColor: '#10b981',
                    backgroundColor: gradientGreen,
                    borderWidth: 2.5,
                    pointRadius: portfolioData.length > 48 ? 0 : 3,
                    pointHoverRadius: 5,
                    tension: 0.4,
                    fill: true,
                },
                {
                    label: 'Amount Invested',
                    data: investedData.map(v => parseFloat((v * mul).toFixed(2))),
                    borderColor: '#475569',
                    backgroundColor: gradientGray,
                    borderWidth: 1.5,
                    borderDash: [5, 4],
                    pointRadius: 0,
                    pointHoverRadius: 4,
                    tension: 0.1,
                    fill: true,
                },
            ],
        },
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
                    callbacks: {
                        label: (ctx) =>
                            ` ${ctx.dataset.label}: ${sym}${ctx.parsed.y.toLocaleString('en-US', {
                                maximumFractionDigits: currency === 'THB' ? 0 : 2,
                            })}`,
                    },
                },
            },
            scales: {
                x: {
                    grid: { color: 'rgba(51,65,85,0.5)', drawTicks: false },
                    ticks: { color: '#64748b', font: { size: 11 }, maxRotation: 0, maxTicksLimit: 8 },
                },
                y: {
                    grid: { color: 'rgba(51,65,85,0.5)', drawTicks: false },
                    ticks: {
                        color: '#64748b',
                        font: { size: 11 },
                        callback: (v) => `${sym}${v >= 1000 ? (v / 1000).toFixed(0) + 'k' : v}`,
                    },
                },
            },
        },
    });
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function buildLabels(timestamps) {
    if (!timestamps) return [];
    return timestamps.map((t) => {
        const d = new Date(t * 1000);
        return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
    });
}

function setLoading(isLoading) {
    document.getElementById('calculate-btn').disabled = isLoading;
    document.getElementById('btn-text').classList.toggle('hidden', isLoading);
    document.getElementById('btn-loader').classList.toggle('hidden', !isLoading);
}

function showError(msg) {
    const el = document.getElementById('error-msg');
    el.textContent = `⚠️ ${msg}`;
    el.classList.remove('hidden');
}

function clearError() {
    document.getElementById('error-msg').classList.add('hidden');
}