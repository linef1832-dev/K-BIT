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
    // 🆕 Gemini Flash-Lite (OCR ทางเลือก ถูกกว่า Vision ~30 เท่า) — คีย์จาก aistudio.google.com
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
    const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
    const GEMINI_TIMEOUT_MS = parseInt(process.env.GEMINI_TIMEOUT_MS || '10000', 10);
    // เครื่องยนต์หลัก: 'vision' | 'gemini' | 'ocrspace' — อ่านจาก Supabase settings.ocr_engine (สลับได้จากหน้าแอดมิน) ถ้าไม่มีใช้ env OCR_PRIMARY
    const OCR_PRIMARY_ENV = (process.env.OCR_PRIMARY || 'vision').toLowerCase();

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
        // ต่อคำในบรรทัดโดยดู "ระยะห่างจริงในภาพ" — Google ตัดคำไทยเป็นชิ้นๆ (คม|กริช) ถ้ากล่องชิดกันคือคำเดียวกัน ห้ามเว้นวรรค
        const joinWords = (ws) => {
            let out = '';
            for (let i = 0; i < ws.length; i++) {
                const w = ws[i];
                if (i > 0) {
                    const p = ws[i - 1];
                    const gap = w.Left - (p.Left + p.Width);
                    const h = Math.max(p.Height, w.Height, 1);
                    const visibleGap = gap > h * 0.22;                       // ช่องว่างที่ตามองเห็น
                    const bothThai = /[\u0E00-\u0E7F]$/.test(p.WordText) && /^[\u0E00-\u0E7F]/.test(w.WordText);
                    const saidSpace = p.brk === 'SPACE' || p.brk === 'SURE_SPACE';
                    // ไทย: เว้นเฉพาะเมื่อมีช่องว่างจริง / อังกฤษ-ตัวเลข: เชื่อ Google แต่ถ้าชิดกันมากก็ไม่เว้น
                    const space = bothThai ? visibleGap : (saidSpace ? gap > h * 0.08 : visibleGap);
                    if (space) out += ' ';
                }
                out += w.WordText;
            }
            return out.replace(/[ \t]+/g, ' ').trim();
        };
        const flush = () => {
            if (!cur.length) return;
            const line = {
                LineText: joinWords(cur),
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
                        const lastBreak = symbols.length ? (symbols[symbols.length - 1].property && symbols[symbols.length - 1].property.detectedBreak) : null;
                        const bt = lastBreak && lastBreak.type;
                        if (wordText) cur.push({ WordText: wordText, brk: bt || '', ...box });
                        // ตัดบรรทัดถ้าตัวอักษรสุดท้ายของคำนี้เป็นจุดจบบรรทัด
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
        const joinedText = overlay.length ? overlay.map(l => l.LineText).join('\n') : parsedText;
        return {
            ParsedResults: [{
                ParsedText: joinedText,
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
    //  🆕 GEMINI FLASH-LITE — OCR ทางเลือก (คืนรูปแบบเดียวกับ OCR.space, ไม่มี overlay)
    // =====================================================================
    async function geminiOCR(base64Image, language) {
        if (!GEMINI_API_KEY) throw new Error('no gemini key');
        const m = String(base64Image).match(/^data:(image\/\w+);base64,(.+)$/s);
        const mime = m ? m[1] : 'image/png';
        const b64 = m ? m[2] : String(base64Image);
        const l = String(language || '').toLowerCase();
        const hint = (l === 'eng' || l === 'code' || l === 'en') ? 'ข้อความส่วนใหญ่เป็นตัวเลข/ภาษาอังกฤษ/รหัส' : 'ข้อความอาจเป็นภาษาไทยปนอังกฤษและตัวเลข';
        const prompt = `ถอดข้อความทั้งหมดที่เห็นในรูปนี้แบบตรงตัว (OCR) ${hint}
กฎ: รักษาบรรทัดตามรูป, ไม่แปล, ไม่อธิบาย, ไม่ใส่เครื่องหมายคำพูดหรือ markdown, ภาษาไทยเขียนติดกันตามปกติ (เว้นวรรคเฉพาะที่รูปเว้น), ตัวเลขและเครื่องหมาย - ให้ตรงตามรูปทุกตัว
ถ้าไม่มีข้อความให้ตอบว่างเปล่า`;
        const call = async (body) => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
            try {
                return await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL.trim()}:generateContent`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY.trim() },
                    body: JSON.stringify(body), signal: controller.signal
                });
            } finally { clearTimeout(timer); }
        };
        const contents = [{ role: 'user', parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: b64 } }] }];
        let r = await call({ contents, generationConfig: { temperature: 0, maxOutputTokens: 2048 } });
        if (r.status === 400) {
            const t1 = await r.text().catch(() => '');
            console.warn('[kbiz-api] gemini 400 (รอบแรก) mime=' + mime + ' b64len=' + b64.length + ' model=' + GEMINI_MODEL + ' → ' + t1.replace(/\s+/g, ' ').slice(0, 400));
            r = await call({ contents }); // ลองแบบไม่มี generationConfig
        }
        if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(`gemini ${r.status}${t ? ': ' + t.replace(/\s+/g, ' ').slice(0, 400) : ''}`); }
        const j = await r.json();
        const parts = j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts || [];
        let text = parts.map(p => p.text || '').join('').replace(/^```[a-z]*\n?|```$/g, '').trim();
        return {
            ParsedResults: [{ ParsedText: text, TextOverlay: { Lines: [], HasOverlay: false, Message: '' }, FileParseExitCode: 1, ErrorMessage: '', ErrorDetails: '' }],
            OCRExitCode: 1, IsErroredOnProcessing: false, ProcessingTimeInMilliseconds: '0', __engine: 'gemini', __empty: !text
        };
    }

    // อ่านค่าเครื่องยนต์หลักจาก Supabase (cache 15 วิ) — หน้าแอดมินเขียนค่านี้
    let engineCache = { at: 0, val: null };
    async function currentEngine() {
        if (Date.now() - engineCache.at < 15000 && engineCache.val) return engineCache.val;
        let val = OCR_PRIMARY_ENV;
        try {
            const d = await sbGet('settings?key=eq.ocr_engine&select=value');
            if (d && d[0] && d[0].value) { const v = String(JSON.parse(d[0].value) || '').toLowerCase().replace(/"/g, ''); if (['vision', 'gemini', 'ocrspace'].includes(v)) val = v; }
        } catch (e) {}
        if (val === 'gemini' && !GEMINI_API_KEY) val = GOOGLE_VISION_API_KEY ? 'vision' : 'ocrspace';
        if (val === 'vision' && !GOOGLE_VISION_API_KEY) val = GEMINI_API_KEY ? 'gemini' : 'ocrspace';
        engineCache = { at: Date.now(), val };
        return val;
    }

    // =====================================================================
    //  📊 สถิติ OCR รายวัน (แสดงในหน้าแอดมิน) — เก็บใน memory และเซฟลง Supabase settings.ocr_stats
    // =====================================================================
    function thaiDayKey() {
        const n = new Date(Date.now() + 7 * 3600 * 1000); // UTC+7
        return n.getUTCFullYear() + '-' + String(n.getUTCMonth() + 1).padStart(2, '0') + '-' + String(n.getUTCDate()).padStart(2, '0');
    }
    let ocrStats = { day: thaiDayKey(), google_ok: 0, google_fail: 0, gemini_ok: 0, gemini_fail: 0, fallback_ok: 0, fallback_fail: 0, last_engine: null, last_error: null, last_ms: null, last_at: null };
    (async () => { try {
        const d = await sbGet('settings?key=eq.ocr_stats&select=value');
        if (d && d[0] && d[0].value) { const s = JSON.parse(d[0].value); if (s && s.day === thaiDayKey()) ocrStats = Object.assign(ocrStats, s); }
    } catch (e) {} })();
    // 💰 ยอดเงินคงเหลือ (ประมาณการ): แอดมินกรอกยอดตั้งต้น ระบบหักตามราคาต่อรูป — settings.ocr_budget
    const VISION_COST = parseFloat(process.env.VISION_COST_THB || '0.05');    // ~$1.50/1000
    const GEMINI_COST = parseFloat(process.env.GEMINI_COST_THB || '0.0015'); // flash-lite รูปเล็ก ~260 โทเค็น
    let budget = { vision_start: 0, vision_used: 0, gemini_start: 0, gemini_used: 0, vision_calls: 0, gemini_calls: 0, updated: 0 };
    let budgetLoadedAt = 0, budgetSaveTimer = null;
    async function loadBudget(force) {
        if (!force && Date.now() - budgetLoadedAt < 20000) return budget;
        try { const d = await sbGet('settings?key=eq.ocr_budget&select=value'); if (d && d[0] && d[0].value) { const b = JSON.parse(d[0].value); if (b && typeof b === 'object') {
            if (budgetSaveTimer) { budget.vision_start = b.vision_start ?? budget.vision_start; budget.gemini_start = b.gemini_start ?? budget.gemini_start; } // มีการใช้ที่ยังไม่เซฟ → อย่าทับตัวนับ
            else budget = Object.assign(budget, b);
        } } } catch (e) {}
        budgetLoadedAt = Date.now(); return budget;
    }
    loadBudget(true);
    function spend(engine) {
        if (engine === 'vision') { budget.vision_used = +(budget.vision_used + VISION_COST).toFixed(4); budget.vision_calls = (budget.vision_calls || 0) + 1; }
        else if (engine === 'gemini') { budget.gemini_used = +(budget.gemini_used + GEMINI_COST).toFixed(4); budget.gemini_calls = (budget.gemini_calls || 0) + 1; }
        budget.updated = Date.now();
        clearTimeout(budgetSaveTimer);
        budgetSaveTimer = setTimeout(async () => {
            // รวมกับค่าที่แอดมินอาจแก้ยอดตั้งต้นไว้ระหว่างนี้
            try { const d = await sbGet('settings?key=eq.ocr_budget&select=value'); if (d && d[0] && d[0].value) { const b = JSON.parse(d[0].value); budget.vision_start = b.vision_start ?? budget.vision_start; budget.gemini_start = b.gemini_start ?? budget.gemini_start; if (b.reset_at && b.reset_at > (budget.reset_at || 0)) { budget.vision_used = 0; budget.gemini_used = 0; budget.vision_calls = 0; budget.gemini_calls = 0; budget.reset_at = b.reset_at; } } } catch (e) {}
            sbUpsertSetting('ocr_budget', budget).catch(() => {});
        }, 3000);
    }
    let statsSaveTimer = null;
    function bumpStats(field, extra) {
        if (ocrStats.day !== thaiDayKey()) ocrStats = { day: thaiDayKey(), google_ok: 0, google_fail: 0, gemini_ok: 0, gemini_fail: 0, fallback_ok: 0, fallback_fail: 0, last_engine: null, last_error: null, last_ms: null, last_at: null };
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
        if (overCap) console.warn(`[kbiz-api] Google ถึงเพดานวันนี้ (${GV_DAILY_LIMIT}) → ใช้ตัวถัดไป`);
        const primary = await currentEngine();
        // ลำดับ: เครื่องยนต์หลัก → อีกตัวของ Google (ถ้ามีคีย์) → OCR.space
        const order = primary === 'gemini' ? ['gemini', 'vision'] : primary === 'vision' ? ['vision', 'gemini'] : [];
        for (const eng of order) {
            if (eng === 'vision' && (!GOOGLE_VISION_API_KEY || overCap)) continue;
            if (eng === 'gemini' && !GEMINI_API_KEY) continue;
            const t0 = Date.now();
            try {
                const data = eng === 'vision' ? await googleVisionOCR(base64Image, language) : await geminiOCR(base64Image, language);
                bumpStats(eng === 'vision' ? 'google_ok' : 'gemini_ok', { last_engine: eng === 'vision' ? 'google' : 'gemini', last_ms: Date.now() - t0, last_error: null });
                spend(eng);
                return res.json({ ok: true, data, keyName: eng === 'vision' ? 'google-vision' : 'gemini' });
            } catch (e) {
                bumpStats(eng === 'vision' ? 'google_fail' : 'gemini_fail', { last_error: e.message });
                console.warn(`[kbiz-api] ${eng} พลาด → ลองตัวถัดไป:`, e.message);
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
    app.get('/api/ocr/health', cors, async (req, res) => {
        if (ocrStats.day !== thaiDayKey()) bumpStats('__touch');
        engineCache.at = 0; // หน้าแอดมินกดรีเฟรช → อ่านค่าล่าสุดทันที
        const engine = await currentEngine();
        res.json({ ok: true, google: !!GOOGLE_VISION_API_KEY, gemini: !!GEMINI_API_KEY, engine, geminiModel: GEMINI_MODEL,
                   primary: engine === 'vision' ? 'google-vision' : engine === 'gemini' ? 'gemini' : 'ocr.space', dailyLimit: GV_DAILY_LIMIT, stats: ocrStats, budget: await loadBudget(true), rates: { vision: VISION_COST, gemini: GEMINI_COST } });
    });

    // ---------- GET /api/ocr/test-gemini : ทดสอบ Gemini ตรงๆ (เปิดในเบราว์เซอร์ได้) ----------
    app.get('/api/ocr/test-gemini', cors, async (req, res) => {
        const png = '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';
        try {
            const data = await geminiOCR('data:image/png;base64,' + png, 'eng');
            res.json({ ok: true, model: GEMINI_MODEL, text: data.ParsedResults[0].ParsedText, note: 'ถ้าเห็น ok:true แสดงว่า Gemini ใช้ได้แล้ว' });
        } catch (e) { res.json({ ok: false, model: GEMINI_MODEL, keyPrefix: GEMINI_API_KEY.slice(0, 6), error: e.message }); }
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
