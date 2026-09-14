// =====================================================================
//  kbiz-api.js — API สำหรับส่วนขยาย K BIZ Checker (วางบน Railway)
//  key ทั้งหมดอยู่ที่นี่ผ่าน Environment Variables ไม่ต้องฝังในส่วนขยายอีก
//
//  วิธีใช้ในไฟล์ server หลัก (ที่มี express + socket.io อยู่แล้ว):
//      const kbizApi = require('./kbiz-api');
//      kbizApi(app);            // app = express()
//
//  Environment Variables ที่ต้องตั้งใน Railway → Variables:
//      SUPABASE_URL          = https://xxxx.supabase.co
//      SUPABASE_KEY          = (service_role key แนะนำ  หรือ anon key ก็ได้)
//      GOOGLE_VISION_API_KEY = (ใหม่) API key ของ Cloud Vision — OCR หลัก แม่นไทย/เร็ว
//      THUNDER_TOKEN         = token ตรวจสลิป Thunder Solution
//      EXT_TOKEN             = (ไม่บังคับ) ถ้าตั้ง ส่วนขยายต้องส่ง header X-KBIZ-TOKEN ให้ตรง
//      OCR_DAILY_LIMIT       = (ไม่บังคับ) เพดานต่อ key ของ OCR.space (ดีฟอลต์ 500)
//
//  ── OCR ทำงานแบบไหน ──────────────────────────────────────────────
//  POST /api/ocr/parse จะลอง Google Cloud Vision "ก่อน" (ถ้ามี GOOGLE_VISION_API_KEY)
//  ถ้า Google ล่ม/ตอบพลาด/ไม่พบข้อความ → สลับไป OCR.space อัตโนมัติ
//  ผลลัพธ์ทั้งสองทางถูกจัดรูปให้ "เหมือน OCR.space" (ParsedResults + TextOverlay)
//  ส่วนขยายจึงไม่ต้องแก้โครงสร้างการอ่านผลเลย
// =====================================================================

module.exports = function attachKbizApi(app) {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_KEY;
    const EXT_TOKEN = process.env.EXT_TOKEN || '';
    const DAILY_LIMIT = parseInt(process.env.OCR_DAILY_LIMIT || '500', 10);

    // 🆕 Google Cloud Vision (OCR หลัก)
    const GOOGLE_VISION_API_KEY = process.env.GOOGLE_VISION_API_KEY || '';
    const GV_TIMEOUT_MS = parseInt(process.env.GOOGLE_VISION_TIMEOUT_MS || '8000', 10);
    const GV_DAILY_LIMIT = parseInt(process.env.GOOGLE_DAILY_LIMIT || '0', 10); // 0 = ไม่จำกัด; เกินเพดาน → ใช้ OCR.space แทนอัตโนมัติ

    if (!SUPABASE_URL || !SUPABASE_KEY) {
        console.warn('[kbiz-api] ⚠️ ยังไม่ได้ตั้ง SUPABASE_URL / SUPABASE_KEY ใน Environment Variables');
    }
    if (!GOOGLE_VISION_API_KEY) {
        console.warn('[kbiz-api] ⚠️ ยังไม่ได้ตั้ง GOOGLE_VISION_API_KEY — จะใช้ OCR.space อย่างเดียวไปก่อน');
    }

    const sbHeaders = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

    // body ใหญ่ได้ถึง 5MB (รูป base64)
    const express = require('express');
    const json = express.json({ limit: '5mb' });

    // CORS: ส่วนขยาย Chrome เรียกจาก origin chrome-extension://... หรือจากหน้าเว็บที่ฉีดสคริปต์
    function cors(req, res, next) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-KBIZ-TOKEN');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        if (req.method === 'OPTIONS') return res.sendStatus(204);
        next();
    }
    function auth(req, res, next) {
        if (EXT_TOKEN && req.get('X-KBIZ-TOKEN') !== EXT_TOKEN) return res.status(401).json({ ok: false, error: 'unauthorized' });
        next();
    }

    // ---------- helpers ----------
    async function sbGet(path) {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbHeaders });
        if (!r.ok) throw new Error(`supabase ${r.status}`);
        return r.json();
    }
    async function sbUpsertSetting(key, value) {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/settings`, {
            method: 'POST',
            headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
            body: JSON.stringify({ key, value: JSON.stringify(value) })
        });
        if (!r.ok) throw new Error(`supabase upsert ${r.status}`);
    }
    function todayKey() {
        const n = new Date();
        return n.getUTCFullYear() + '-' + String(n.getUTCMonth() + 1).padStart(2, '0') + '-' + String(n.getUTCDate()).padStart(2, '0');
    }

    // cache รายชื่อ key 30 วินาที ลดการยิง Supabase
    let keyCache = { at: 0, keys: [] };
    async function loadKeys(force = false) {
        if (!force && Date.now() - keyCache.at < 30000) return keyCache.keys;
        const data = await sbGet('settings?key=eq.ocr_api_keys_data&select=value');
        const keys = data && data[0] && data[0].value ? JSON.parse(data[0].value) : [];
        keyCache = { at: Date.now(), keys };
        return keys;
    }

    // เพิ่มโควต้าแบบต่อคิว กันเขียนทับกันเวลาหลายคนใช้พร้อมกัน
    let usageQueue = Promise.resolve();
    function incrementUsage(keyId) {
        usageQueue = usageQueue.then(async () => {
            const keys = await loadKeys(true);
            const k = keys.find(x => String(x.id) === String(keyId));
            if (!k) return;
            const today = todayKey();
            if (k.last_used_date !== today) k.used_count = 0;
            k.used_count = (k.used_count || 0) + 1;
            k.last_used_date = today;
            await sbUpsertSetting('ocr_api_keys_data', keys);
            keyCache = { at: Date.now(), keys };
        }).catch(e => console.error('[kbiz-api] incrementUsage', e.message));
        return usageQueue;
    }

    function isKeyProblem(msg) {
        return /apikey|api key|invalid|unauthorized|limit|quota|exceed|403|401|E101|E102|E103/i.test(msg || '');
    }

    // =====================================================================
    //  🆕 GOOGLE CLOUD VISION — OCR หลัก
    //  คืนผลในรูปแบบ "เหมือน OCR.space" เพื่อให้ส่วนขยายอ่านต่อได้ทันที:
    //      { ParsedResults: [ { ParsedText, TextOverlay: { Lines:[ { LineText, Words:[ {WordText,Left,Top,Height,Width} ] } ] } } ],
    //        IsErroredOnProcessing: false, OCRExitCode: 1, __engine: 'google' }
    // =====================================================================

    // แปลง lang ที่ส่วนขยายส่งมา → languageHints + ชนิดฟีเจอร์ของ Vision
    function gvPlan(language) {
        const l = String(language || '').toLowerCase();
        if (l === 'eng' || l === 'code' || l === 'en') return { hints: ['en'], feature: 'TEXT_DETECTION' };
        if (l === 'tha' || l === 'th') return { hints: ['th', 'en'], feature: 'DOCUMENT_TEXT_DETECTION' };
        return { hints: ['th', 'en'], feature: 'DOCUMENT_TEXT_DETECTION' }; // auto / อื่นๆ
    }

    // vertices ของ Google → กล่องแบบ OCR.space (Left/Top/Width/Height)
    function bboxFromVertices(vertices) {
        const xs = vertices.map(v => v.x || 0);
        const ys = vertices.map(v => v.y || 0);
        const left = Math.min(...xs), top = Math.min(...ys);
        return { Left: left, Top: top, Width: Math.max(...xs) - left, Height: Math.max(...ys) - top };
    }

    // สร้าง TextOverlay.Lines จาก fullTextAnnotation ของ Google
    // (Google ไม่ให้ "บรรทัด" ตรงๆ — เราตัดบรรทัดจาก detectedBreak ของตัวอักษรสุดท้ายในแต่ละคำ)
    function gvBuildOverlay(fta) {
        const lines = [];
        if (!fta || !Array.isArray(fta.pages)) return lines;
        let cur = [];
        const flush = () => {
            if (!cur.length) return;
            const line = {
                LineText: cur.map(w => w.WordText).join(' ').replace(/\s+/g, ' ').trim(),
                Words: cur.map(w => ({ WordText: w.WordText, Left: w.Left, Top: w.Top, Height: w.Height, Width: w.Width })),
                MaxHeight: Math.max(...cur.map(w => w.Height)),
                MinTop: Math.min(...cur.map(w => w.Top))
            };
            if (line.LineText) lines.push(line);
            cur = [];
        };
        for (const page of fta.pages) {
            for (const block of (page.blocks || [])) {
                for (const para of (block.paragraphs || [])) {
                    for (const word of (para.words || [])) {
                        const symbols = word.symbols || [];
                        const wordText = symbols.map(s => s.text || '').join('');
                        const box = word.boundingBox && word.boundingBox.vertices ? bboxFromVertices(word.boundingBox.vertices) : { Left: 0, Top: 0, Width: 0, Height: 0 };
                        if (wordText) cur.push({ WordText: wordText, ...box });
                        // ตัดบรรทัดถ้าตัวอักษรสุดท้ายของคำนี้เป็นจุดจบบรรทัด
                        const lastBreak = symbols.length ? (symbols[symbols.length - 1].property && symbols[symbols.length - 1].property.detectedBreak) : null;
                        const bt = lastBreak && lastBreak.type;
                        if (bt === 'LINE_BREAK' || bt === 'EOL_SURE_SPACE') flush();
                    }
                    flush(); // จบย่อหน้า = จบบรรทัดด้วย
                }
            }
        }
        flush();
        return lines;
    }

    // ยิง Google Vision — คืน object แบบ OCR.space ถ้าสำเร็จ, throw ถ้าล้ม (เพื่อให้ fallback ทำงาน)
    async function googleVisionOCR(base64Image, language) {
        if (!GOOGLE_VISION_API_KEY) throw new Error('no google key');
        const b64 = String(base64Image).replace(/^data:image\/\w+;base64,/, '');
        const { hints, feature } = gvPlan(language);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), GV_TIMEOUT_MS);
        let r;
        try {
            r = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${GOOGLE_VISION_API_KEY}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    requests: [{
                        image: { content: b64 },
                        features: [{ type: feature }],
                        imageContext: { languageHints: hints }
                    }]
                }),
                signal: controller.signal
            });
        } finally { clearTimeout(timer); }

        if (!r.ok) {
            // 401/403 = key ผิด/ยังไม่เปิด API, 429 = เกินโควต้า → ให้ fallback
            const txt = await r.text().catch(() => '');
            throw new Error(`google ${r.status}${txt ? ': ' + txt.slice(0, 200) : ''}`);
        }
        const j = await r.json();
        const resp = j && j.responses && j.responses[0];
        if (!resp) throw new Error('google empty response');
        if (resp.error) throw new Error('google: ' + (resp.error.message || 'error'));

        const fta = resp.fullTextAnnotation;
        const parsedText = (fta && fta.text) ||
            (resp.textAnnotations && resp.textAnnotations[0] && resp.textAnnotations[0].description) || '';
        const clean = parsedText.trim();
        if (!clean) {
            // Google อ่านแล้วไม่เจอข้อความ → ตอบว่างกลับเลย (OCR.space แทบไม่มีทางเจอถ้า Google ไม่เจอ และช้ากว่ามาก)
            return { ParsedResults: [{ ParsedText: '', TextOverlay: { Lines: [], HasOverlay: false, Message: '' }, FileParseExitCode: 1, ErrorMessage: '', ErrorDetails: '' }],
                     OCRExitCode: 1, IsErroredOnProcessing: false, ProcessingTimeInMilliseconds: '0', __engine: 'google', __empty: true };
        }

        const overlay = gvBuildOverlay(fta);
        return {
            ParsedResults: [{
                ParsedText: parsedText,
                TextOverlay: { Lines: overlay, HasOverlay: overlay.length > 0, Message: '' },
                FileParseExitCode: 1,
                ErrorMessage: '',
                ErrorDetails: ''
            }],
            OCRExitCode: 1,
            IsErroredOnProcessing: false,
            ProcessingTimeInMilliseconds: '0',
            __engine: 'google'
        };
    }

    // =====================================================================
    //  📊 สถิติ OCR รายวัน (แสดงในหน้าแอดมิน) — เก็บใน memory และเซฟลง Supabase settings.ocr_stats
    // =====================================================================
    function thaiDayKey() {
        const n = new Date(Date.now() + 7 * 3600 * 1000); // UTC+7
        return n.getUTCFullYear() + '-' + String(n.getUTCMonth() + 1).padStart(2, '0') + '-' + String(n.getUTCDate()).padStart(2, '0');
    }
    let ocrStats = { day: thaiDayKey(), google_ok: 0, google_fail: 0, fallback_ok: 0, fallback_fail: 0, last_engine: null, last_error: null, last_ms: null, last_at: null };
    (async () => { try {
        const d = await sbGet('settings?key=eq.ocr_stats&select=value');
        if (d && d[0] && d[0].value) { const s = JSON.parse(d[0].value); if (s && s.day === thaiDayKey()) ocrStats = Object.assign(ocrStats, s); }
    } catch (e) {} })();
    let statsSaveTimer = null;
    function bumpStats(field, extra) {
        if (ocrStats.day !== thaiDayKey()) ocrStats = { day: thaiDayKey(), google_ok: 0, google_fail: 0, fallback_ok: 0, fallback_fail: 0, last_engine: null, last_error: null, last_ms: null, last_at: null };
        ocrStats[field] = (ocrStats[field] || 0) + 1;
        Object.assign(ocrStats, extra || {}, { last_at: Date.now() });
        clearTimeout(statsSaveTimer);
        statsSaveTimer = setTimeout(() => sbUpsertSetting('ocr_stats', ocrStats).catch(() => {}), 3000);
    }

    // ---------- GET /api/bots : รายชื่อบอท ----------
    app.get('/api/bots', cors, auth, async (req, res) => {
        try {
            const bots = new Set();
            try { (await sbGet('kbiz_bots_data?select=machine_id')).forEach(b => b.machine_id && bots.add(b.machine_id)); } catch (e) {}
            try {
                const d = await sbGet('settings?key=eq.kbiz_bots_data&select=value');
                if (d && d[0] && d[0].value) JSON.parse(d[0].value).forEach(b => b.machine_id && bots.add(b.machine_id));
            } catch (e) {}
            res.json({ ok: true, bots: [...bots] });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });
    app.options('/api/bots', cors);

    // ---------- POST /api/ocr/parse : OCR รูป (Google Vision หลัก → OCR.space สำรอง) ----------
    // body: { base64Image, language: 'eng'|'tha'|'auto', engine: '1'|'2'|'3', overlay: bool }
    app.options('/api/ocr/parse', cors);
    app.post('/api/ocr/parse', cors, auth, json, async (req, res) => {
        const { base64Image, language = 'eng', engine = '2', overlay = false } = req.body || {};
        if (!base64Image || typeof base64Image !== 'string') return res.status(400).json({ ok: false, error: 'no image' });

        // ── 1) ลอง Google Cloud Vision ก่อน ──
        const overCap = GV_DAILY_LIMIT > 0 && ocrStats.day === thaiDayKey() && (ocrStats.google_ok || 0) >= GV_DAILY_LIMIT;
        if (overCap) console.warn(`[kbiz-api] Google ถึงเพดานวันนี้ (${GV_DAILY_LIMIT}) → ใช้ OCR.space`);
        if (GOOGLE_VISION_API_KEY && !overCap) {
            const t0 = Date.now();
            try {
                const data = await googleVisionOCR(base64Image, language);
                bumpStats('google_ok', { last_engine: 'google', last_ms: Date.now() - t0, last_error: null });
                return res.json({ ok: true, data, keyName: 'google-vision' });
            } catch (e) {
                bumpStats('google_fail', { last_error: e.message });
                console.warn('[kbiz-api] Google Vision พลาด → สลับไป OCR.space:', e.message);
                // ตกลงไปใช้ OCR.space ต่อด้านล่าง
            }
        }

        // ── 2) สำรอง: OCR.space (ตรรกะเดิมทั้งหมด) ──
        let keys;
        try { keys = await loadKeys(); } catch (e) { return res.status(502).json({ ok: false, error: 'โหลด API keys ไม่สำเร็จ' }); }

        const today = todayKey();
        const usable = keys.filter(k => k.is_active && k.api_key && ((k.last_used_date === today ? (k.used_count || 0) : 0) < DAILY_LIMIT));
        if (!usable.length) return res.status(503).json({ ok: false, error: 'ไม่มี API key ที่พร้อมใช้ — ตรวจสอบในหน้า admin' });

        // สุ่มลำดับ แล้วลองทีละ key สูงสุด 3 อัน
        usable.sort(() => Math.random() - 0.5);
        let lastErr = 'unknown';
        for (const k of usable.slice(0, 3)) {
            try {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 20000);
                const r = await fetch('https://api.ocr.space/parse/image', {
                    method: 'POST',
                    headers: { apikey: k.api_key },
                    body: new URLSearchParams({
                        base64Image, language, scale: 'true', detectOrientation: 'true',
                        isTable: 'false', isOverlayRequired: overlay ? 'true' : 'false', OCREngine: String(engine)
                    }),
                    signal: controller.signal
                });
                clearTimeout(timer);

                if (r.status === 401 || r.status === 403 || r.status === 429) { lastErr = `key ${k.key_name} ใช้ไม่ได้ (${r.status})`; continue; }
                const d = await r.json();
                if (d.IsErroredOnProcessing) {
                    const m = Array.isArray(d.ErrorMessage) ? d.ErrorMessage.join(' / ') : (d.ErrorMessage || 'error');
                    if (isKeyProblem(m)) { lastErr = m; continue; }       // key มีปัญหา → ลองอันถัดไป
                    return res.json({ ok: true, data: d, keyName: k.key_name }); // error อื่น (เช่น อ่านไม่เจอ) → ส่งกลับให้ client ตัดสินใจ
                }
                incrementUsage(k.id); // ไม่ต้อง await
                bumpStats('fallback_ok', { last_engine: 'ocr.space' });
                return res.json({ ok: true, data: d, keyName: k.key_name });
            } catch (e) {
                lastErr = e.name === 'AbortError' ? 'OCR.space ตอบช้าเกินไป' : e.message;
            }
        }
        bumpStats('fallback_fail', { last_error: lastErr });
        res.status(502).json({ ok: false, error: lastErr });
    });

    // ---------- GET /api/ocr/key : ยืม key ไปยิง OCR.space ตรงๆ (ทางเร็วสำรอง) ----------
    app.options('/api/ocr/key', cors);
    app.get('/api/ocr/key', cors, auth, async (req, res) => {
        try {
            const keys = await loadKeys();
            const today = todayKey();
            const usable = keys.filter(k => k.is_active && k.api_key && ((k.last_used_date === today ? (k.used_count || 0) : 0) < DAILY_LIMIT));
            if (!usable.length) return res.status(503).json({ ok: false, error: 'ไม่มี API key ที่พร้อมใช้' });
            usable.sort(() => Math.random() - 0.5);
            const k = usable[0];
            res.json({ ok: true, key: k.api_key, id: k.id, name: k.key_name, ttl: 600 });
        } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
    });

    // ---------- POST /api/ocr/used : แจ้งว่าใช้ key ไปแล้ว 1 ครั้ง ----------
    app.options('/api/ocr/used', cors);
    app.post('/api/ocr/used', cors, auth, json, (req, res) => {
        if (req.body && req.body.id !== undefined) incrementUsage(req.body.id);
        res.json({ ok: true });
    });

    // ---------- GET /api/ocr/health : เช็คว่า Google Vision พร้อมไหม ----------
    app.get('/api/ocr/health', cors, (req, res) => {
        if (ocrStats.day !== thaiDayKey()) bumpStats('__touch');
        res.json({ ok: true, google: !!GOOGLE_VISION_API_KEY, primary: GOOGLE_VISION_API_KEY ? 'google-vision' : 'ocr.space', dailyLimit: GV_DAILY_LIMIT, stats: ocrStats });
    });

    // ---------- GET /api/ping : ปลุกเซิร์ฟเวอร์ ----------
    app.get('/api/ping', cors, (req, res) => res.json({ ok: true, t: Date.now() }));

    // ---------- POST /api/slip/verify : ตรวจสลิปผ่าน Thunder Solution ----------
    // body: { payload?: string (ข้อมูลจาก QR บนสลิป), image?: base64 (dataURL หรือ base64 ล้วน) }
    // ต้องตั้ง THUNDER_TOKEN ใน Railway Variables
    const THUNDER_TOKEN = process.env.THUNDER_TOKEN || '';
    app.options('/api/slip/verify', cors);
    app.post('/api/slip/verify', cors, auth, json, async (req, res) => {
        if (!THUNDER_TOKEN) return res.status(503).json({ ok: false, error: 'ยังไม่ได้ตั้ง THUNDER_TOKEN บนเซิร์ฟเวอร์' });
        const { payload, image } = req.body || {};
        if (!payload && !image) return res.status(400).json({ ok: false, error: 'ต้องส่ง payload หรือ image' });
        const H = { Authorization: `Bearer ${THUNDER_TOKEN}` };
        const call = async (url, init) => {
            const controller = new AbortController(); const t = setTimeout(() => controller.abort(), 20000);
            try {
                const r = await fetch(url, Object.assign({ signal: controller.signal }, init));
                let d = null; try { d = await r.json(); } catch (e) { d = { raw: await r.text().catch(() => '') }; }
                return { status: r.status, d };
            } catch (e) { return { status: 0, d: { message: e.name === 'AbortError' ? 'timeout' : e.message } }; }
            finally { clearTimeout(t); }
        };
        let out;
        if (payload) {
            out = await call('https://api.thunder.in.th/v2/verify/bank', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, H), body: JSON.stringify({ payload }) });
        } else {
            // รูป: ส่งเป็น multipart (field: file) ไป v2 ก่อน ถ้าไม่รับค่อยลอง v1
            const b64 = String(image).replace(/^data:image\/\w+;base64,/, '');
            const buf = Buffer.from(b64, 'base64');
            const mk = () => { const fd = new FormData(); fd.append('file', new Blob([buf], { type: 'image/png' }), 'slip.png'); return fd; };
            out = await call('https://api.thunder.in.th/v2/verify/bank', { method: 'POST', headers: H, body: mk() });
            if (out.status === 0 || out.status === 404 || out.status === 415 || out.status === 400) {
                const v1 = await call('https://api.thunder.in.th/v1/verify', { method: 'POST', headers: H, body: mk() });
                if (v1.status === 200) out = v1;
            }
        }
        const d = out.d || {};
        const okFlag = (d.success === true) || (d.status === 200) || (out.status === 200 && d.data);
        if (!okFlag) {
            const msg = d.message || d.error || (d.data && d.data.message) || `thunder ${out.status}`;
            return res.status(200).json({ ok: false, error: String(msg), code: d.code || d.status || out.status, raw: d });
        }
        res.json({ ok: true, data: d.data || d, raw: d });
    });

    // ---------- GET /api/slip/me : เช็กโควต้า/ข้อมูลแอปของ Thunder ----------
    app.get('/api/slip/me', cors, auth, async (req, res) => {
        if (!THUNDER_TOKEN) return res.status(503).json({ ok: false, error: 'ยังไม่ได้ตั้ง THUNDER_TOKEN' });
        try {
            const r = await fetch('https://api.thunder.in.th/v1/me', { headers: { Authorization: `Bearer ${THUNDER_TOKEN}` } });
            const d = await r.json().catch(() => ({}));
            res.json({ ok: r.ok, data: d.data || d });
        } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
    });

    console.log('[kbiz-api] ✅ routes ready: /api/bots, /api/ocr/parse (' +
        (GOOGLE_VISION_API_KEY ? 'Google Vision → OCR.space' : 'OCR.space เท่านั้น') +
        '), /api/slip/verify' + (THUNDER_TOKEN ? '' : ' (THUNDER_TOKEN ยังไม่ตั้ง)'));
};
