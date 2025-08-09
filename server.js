// index.js — Node 23+, CommonJS
// Rode com: node --dns-result-order=ipv4first index.js

const express = require('express');
const cors = require('cors');
const dns = require('dns');

let setGlobalDispatcher, Agent;
try {
    ({ setGlobalDispatcher, Agent } = require('undici'));
} catch (_) { }

// ===== Preferir IPv4 =====
try { dns.setDefaultResultOrder('ipv4first'); } catch { }

// ===== Undici Agent opcional =====
(function configureDispatcher() {
    try {
        if (setGlobalDispatcher && Agent) {
            const dispatcher = new Agent({
                keepAliveTimeout: 10_000,
                keepAliveMaxTimeout: 30_000,
                connections: 100,
                pipelining: 0,
                connect: { timeout: 7_000 }
            });
            setGlobalDispatcher(dispatcher);
        }
    } catch { }
})();

const app = express();
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});

app.use(cors());
app.use(express.json());

// ===== Utils =====
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function withQuery(url, params) {
    if (!params || !Object.keys(params).length) return url;
    const u = new URL(url);
    for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null) continue;
        u.searchParams.set(k, String(v));
    }
    return u.toString();
}

function explainFetchError(err) {
    const parts = [];
    if (!err) return 'Erro desconhecido';
    parts.push(err.message || String(err));
    const cause = err.cause || err;
    if (cause && typeof cause === 'object') {
        if (cause.code) parts.push(`code=${cause.code}`);
        if (cause.errno) parts.push(`errno=${cause.errno}`);
        if (cause.address) parts.push(`addr=${cause.address}`);
        if (cause.port) parts.push(`port=${cause.port}`);
        if (cause.syscall) parts.push(`syscall=${cause.syscall}`);
        if (cause.host) parts.push(`host=${cause.host}`);
    }
    return parts.join(' | ');
}

// Fetch JSON com timeout e retries exponenciais
async function fetchJSON(url, {
    method = 'GET',
    params,
    headers = {},
    body,
    timeoutMs = 12_000,
    retries = 4,
    baseDelayMs = 350
} = {}) {
    const finalUrl = withQuery(url, params);
    let lastErr;

    for (let attempt = 0; attempt <= retries; attempt++) {
        const controller = new AbortController();
        const to = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const res = await fetch(finalUrl, {
                method,
                headers: {
                    'User-Agent': 'TravelInfo/1.0 (+contato@seudominio.com)',
                    'Accept': 'application/json',
                    ...(body ? { 'Content-Type': 'application/json' } : {}),
                    ...headers
                },
                body: body ? JSON.stringify(body) : undefined,
                signal: controller.signal
            });

            if (res.ok) {
                const text = await res.text();
                try {
                    return JSON.parse(text);
                } catch (e) {
                    const err = new Error(`JSON inválido de ${finalUrl}`);
                    err.cause = e;
                    if (attempt === retries) throw err;
                    lastErr = err;
                }
            } else {
                const retryable = [408, 425, 429, 500, 502, 503, 504].includes(res.status);
                if (!retryable || attempt === retries) {
                    const bodyTxt = await res.text().catch(() => '');
                    throw new Error(`HTTP ${res.status} em ${finalUrl}${bodyTxt ? ` - ${bodyTxt.slice(0, 200)}` : ''}`);
                }
                lastErr = new Error(`HTTP ${res.status} (tentativa ${attempt + 1}/${retries + 1})`);
            }
        } catch (err) {
            const msg = explainFetchError(err);
            const transient = /abort|timed out|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|socket hang up|Client network socket disconnected/i.test(msg);
            if (!transient && attempt === retries) throw new Error(msg);
            if (attempt === retries) throw new Error(msg);
            lastErr = err;
        } finally {
            clearTimeout(to);
        }

        const delay = baseDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
        await sleep(delay);
    }

    throw lastErr || new Error('Falha desconhecida');
}

// ===== Health externo =====
async function externalHealthcheck() {
    const tests = [
        ['https://www.google.com/generate_204', 204],
        ['https://cloudflare.com/cdn-cgi/trace', 200]
    ];
    for (const [url, expected] of tests) {
        try {
            const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(5000) });
            if (res.status === expected) return { ok: true, url, status: res.status };
        } catch { }
    }
    return { ok: false };
}

// ===== Geocoding: rate-limit + fallbacks =====
const GEOCODE_MIN_INTERVAL_MS = 1200;
let lastGeocodeAt = 0;

async function waitGeocodeSlot() {
    const now = Date.now();
    const wait = Math.max(0, lastGeocodeAt + GEOCODE_MIN_INTERVAL_MS - now);
    if (wait) await sleep(wait);
    lastGeocodeAt = Date.now();
}

// Open-Meteo → Nominatim oficial → geocode.maps.co ; se faltar cc, reverse Nominatim
async function geocodeCity(city) {
    // 1) Open-Meteo (rápido e sem limites agressivos)
    try {
        const data = await fetchJSON('https://geocoding-api.open-meteo.com/v1/search', {
            params: { name: city, count: 1, language: 'pt', format: 'json' },
            timeoutMs: 12000
        });
        if (data?.results?.length) {
            const r = data.results[0];
            return {
                name: r.name,
                country: r.country,
                country_code: r.country_code, // ISO2
                latitude: r.latitude,
                longitude: r.longitude,
                timezone: r.timezone
            };
        }
    } catch (_) { }

    // 2) Nominatim oficial — respeitando rate limit
    await waitGeocodeSlot();
    try {
        const nomParams = {
            q: city,
            format: 'jsonv2',
            addressdetails: 1,
            limit: 1,
            'accept-language': 'pt'
        };
        const email = process.env.NOMINATIM_EMAIL;
        if (email) nomParams.email = email;

        const data2 = await fetchJSON('https://nominatim.openstreetmap.org/search', {
            params: nomParams,
            timeoutMs: 15000,
            headers: { 'Accept-Language': 'pt' }
        });

        if (Array.isArray(data2) && data2.length > 0) {
            const r = data2[0];
            const lat = parseFloat(r.lat);
            const lon = parseFloat(r.lon);
            let cc = (r.address?.country_code || '').toUpperCase() || null;
            const country = r.address?.country || null;

            // Se país faltou, tenta reverse pra obter cc
            if (!cc && Number.isFinite(lat) && Number.isFinite(lon)) {
                await waitGeocodeSlot();
                try {
                    const rev = await fetchJSON('https://nominatim.openstreetmap.org/reverse', {
                        params: {
                            lat,
                            lon,
                            format: 'jsonv2',
                            addressdetails: 1,
                            'accept-language': 'pt',
                            email
                        },
                        timeoutMs: 12000,
                        headers: { 'Accept-Language': 'pt' }
                    });
                    cc = (rev?.address?.country_code || '').toUpperCase() || cc;
                } catch { }
            }

            return {
                name: (r.display_name?.split(',')[0] || city),
                country: country || null,
                country_code: cc,
                latitude: lat,
                longitude: lon,
                timezone: null // Open-Meteo infere com 'auto'
            };
        }
    } catch (_) { }

    // 3) geocode.maps.co (outro front do Nominatim)
    await waitGeocodeSlot();
    try {
        const data3 = await fetchJSON('https://geocode.maps.co/search', {
            params: { q: city, limit: 1 },
            timeoutMs: 12000,
            headers: { 'Accept-Language': 'pt' }
        });

        if (Array.isArray(data3) && data3.length > 0) {
            const r = data3[0];
            const lat = parseFloat(r.lat);
            const lon = parseFloat(r.lon);
            let cc = (r.address?.country_code || '').toUpperCase() || null;
            const country = r.address?.country || null;

            // Reverse se faltar cc
            if (!cc && Number.isFinite(lat) && Number.isFinite(lon)) {
                await waitGeocodeSlot();
                try {
                    const rev = await fetchJSON('https://nominatim.openstreetmap.org/reverse', {
                        params: {
                            lat,
                            lon,
                            format: 'jsonv2',
                            addressdetails: 1,
                            'accept-language': 'pt',
                            email: process.env.NOMINATIM_EMAIL
                        },
                        timeoutMs: 12000,
                        headers: { 'Accept-Language': 'pt' }
                    });
                    cc = (rev?.address?.country_code || '').toUpperCase() || cc;
                } catch { }
            }

            return {
                name: (r.display_name?.split(',')[0] || city),
                country: country || null,
                country_code: cc,
                latitude: lat,
                longitude: lon,
                timezone: null
            };
        }
    } catch (_) { }

    return null;
}

// ===== Demais integrações =====
async function getWeather(lat, lon, tz) {
    const data = await fetchJSON('https://api.open-meteo.com/v1/forecast', {
        params: {
            latitude: lat,
            longitude: lon,
            daily: [
                'temperature_2m_max',
                'temperature_2m_min',
                'precipitation_sum',
                'windspeed_10m_max'
            ].join(','),
            current_weather: true,
            timezone: tz || 'auto',
            forecast_days: 7
        },
        timeoutMs: 12000
    });
    return { current: data?.current_weather || null, daily: data?.daily || null };
}

async function getCountryInfo(iso2) {
    if (!iso2) return null;
    const data = await fetchJSON(`https://restcountries.com/v3.1/alpha/${encodeURIComponent(iso2)}`, {
        timeoutMs: 12000
    });
    const c = Array.isArray(data) ? data[0] : data;
    const currencies = c?.currencies
        ? Object.entries(c.currencies).map(([code, v]) => ({ code, name: v.name, symbol: v.symbol }))
        : [];
    const languages = c?.languages ? Object.values(c.languages) : [];
    return {
        nameOfficial: c?.name?.official,
        region: c?.region,
        subregion: c?.subregion,
        capital: c?.capital?.[0] || null,
        currencies,
        languages,
        callingCode: c?.idd?.root && c?.idd?.suffixes?.[0] ? `${c.idd.root}${c.idd.suffixes[0]}` : null
    };
}

async function getHolidays(iso2) {
    if (!iso2) return null;
    const year = new Date().getFullYear();
    const data = await fetchJSON(`https://date.nager.at/api/v3/PublicHolidays/${year}/${encodeURIComponent(iso2)}`, {
        timeoutMs: 12000
    });
    const today = new Date().toISOString().slice(0, 10);
    const upcoming = data.filter(h => h.date >= today).slice(0, 5);
    const past = data.filter(h => h.date < today).slice(-5);
    return { year, upcoming, past };
}

async function getExchangeRate(base, quote) {
    if (!base) return null;
    const data = await fetchJSON('https://api.exchangerate.host/latest', {
        params: { base, symbols: quote },
        timeoutMs: 10000
    });
    return data?.rates?.[quote] || null;
}

// ===== Core =====
async function makeTravelInfoRequest(city) {
    const geo = await geocodeCity(city);
    if (!geo) throw new Error(`Não foi possível geocodificar "${city}"`);

    const { name, country, country_code, latitude, longitude, timezone } = geo;

    const [weatherRes, countryRes, holidaysRes, fxRes] = await Promise.allSettled([
        getWeather(latitude, longitude, timezone),
        getCountryInfo(country_code),
        getHolidays(country_code),
        (async () => {
            const info = await getCountryInfo(country_code);
            const currencyCode = info?.currencies?.[0]?.code || null;
            return currencyCode ? await getExchangeRate(currencyCode, 'BRL') : null;
        })()
    ]);

    const countryInfo = countryRes.status === 'fulfilled' ? countryRes.value : null;
    const fxRate = fxRes.status === 'fulfilled' ? fxRes.value : null;
    const weather = weatherRes.status === 'fulfilled' ? weatherRes.value : null;
    const holidays = holidaysRes.status === 'fulfilled' ? holidaysRes.value : null;

    return {
        destination: {
            input: city,
            resolvedName: name,
            country,
            countryCode: country_code,
            coordinates: { latitude, longitude },
            timezone
        },
        weather,
        countryInfo,
        holidays,
        exchange: (fxRate && countryInfo?.currencies?.[0]?.code)
            ? { base: countryInfo.currencies[0].code, quote: 'BRL', rate: fxRate }
            : null,
        sources: [
            'https://nominatim.openstreetmap.org/',
            'https://geocode.maps.co/',
            'https://open-meteo.com/en/docs',
            'https://restcountries.com/',
            'https://date.nager.at',
            'https://exchangerate.host'
        ]
    };
}

async function processItems(items) {
    const results = [];
    for (let i = 0; i < items.length; i++) {
        const city = String(items[i] || '').trim();
        if (!city) {
            results.push({
                originalItem: items[i],
                processed: false,
                status: 'error',
                error: 'Destino vazio/ inválido',
                processedAt: new Date().toISOString()
            });
            continue;
        }

        try {
            const data = await makeTravelInfoRequest(city);
            results.push({
                originalItem: city,
                processed: true,
                status: 'success',
                processedAt: new Date().toISOString(),
                data
            });
        } catch (err) {
            results.push({
                originalItem: city,
                processed: false,
                status: 'error',
                error: explainFetchError(err),
                processedAt: new Date().toISOString()
            });
        }
    }
    return results;
}

// ===== Endpoints =====
app.get('/', (req, res) => {
    res.json({
        message: 'API Travel Info (Node 23 + fetch) ok',
        endpoints: { 'POST /process': 'Entradas: cidades; Saída: clima, país, moeda, câmbio e feriados' },
        tips: [
            'Opcional: exporte NOMINATIM_EMAIL=seuemail@dominio (melhora aceitação no Nominatim)',
            'Se estiver atrás de proxy, exporte HTTPS_PROXY/HTTP_PROXY',
            'Rode com: node --dns-result-order=ipv4first index.js'
        ]
    });
});

app.get('/health/external', async (req, res) => {
    const ok = await externalHealthcheck();
    if (ok.ok) return res.json({ ok: true, probe: ok });
    res.status(503).json({ ok: false, message: 'Sem acesso externo. Verifique proxy/firewall/DNS.' });
});

app.get('/health/apis', async (req, res) => {
    const checks = [
        ['open-meteo-geocode', 'https://geocoding-api.open-meteo.com/v1/search?name=Lisboa&count=1&format=json'],
        ['open-meteo-forecast', 'https://api.open-meteo.com/v1/forecast?latitude=38.72&longitude=-9.14&current_weather=true&forecast_days=1'],
        ['restcountries', 'https://restcountries.com/v3.1/alpha/PT'],
        ['nager-date', `https://date.nager.at/api/v3/PublicHolidays/${new Date().getFullYear()}/PT`],
        ['exchangerate-host', 'https://api.exchangerate.host/latest?base=EUR&symbols=BRL'],
        ['nominatim-fallback', 'https://nominatim.openstreetmap.org/search?q=Lisboa&format=jsonv2&addressdetails=1&limit=1']
    ];

    const results = [];
    for (const [name, url] of checks) {
        try {
            const r = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(8000), headers: { 'Accept-Language': 'pt' } });
            results.push({ name, status: r.status });
        } catch (e) {
            results.push({ name, error: (e && e.message) || String(e) });
        }
    }
    res.json({ ok: true, results });
});

app.post('/process', async (req, res) => {
    try {
        const { items } = req.body;
        if (!items || !Array.isArray(items)) {
            return res.status(400).json({
                error: 'Campo "items" é obrigatório e deve ser um array',
                example: { items: ['Lisboa', 'Buenos Aires', 'Tokyo'] }
            });
        }
        if (items.length === 0) {
            return res.status(400).json({ error: 'Array "items" não pode estar vazio' });
        }

        const net = await externalHealthcheck();
        if (!net.ok) {
            return res.status(503).json({
                error: 'Sem acesso à internet a partir do servidor',
                hint: 'Configure proxy/firewall/DNS ou rode local com egress liberado',
                details: net
            });
        }

        const results = await processItems(items);
        res.json({ success: true, totalItems: items.length, results });
    } catch (error) {
        res.status(500).json({ error: 'Erro interno do servidor', message: explainFetchError(error) });
    }
});

// ===== Boot =====
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor rodando em http://0.0.0.0:${PORT}`);
    console.log(`GET  /                 - Info`);
    console.log(`GET  /health/external  - Diagnóstico de rede`);
    console.log(`GET  /health/apis      - Diagnóstico por API`);
    console.log(`POST /process          - Processa destinos`);
});

module.exports = app;
