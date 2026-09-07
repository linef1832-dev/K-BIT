// =====================================================================
//  kbiz-api.js — API สำหรับส่วนขยาย K BIZ Checker (วางบน Railway)
//  key ทั้งหมดอยู่ที่นี่ผ่าน Environment Variables ไม่ต้องฝังในส่วนขยายอีก
//
//  วิธีใช้ในไฟล์ server หลัก (ที่มี express + socket.io อยู่แล้ว):
//      const kbizApi = require('./kbiz-api');
//      kbizApi(app);            // app = express()
//
//  Environment Variables ที่ต้องตั้งใน Railway → Variables:
//      SUPABASE_URL   = https://xxxx.supabase.co
//      SUPABASE_KEY   = (service_role key แนะนำ  หรือ anon key ก็ได้)
//      EXT_TOKEN      = (ไม่บังคับ) ถ้าตั้ง ส่วนขยายต้องส่ง header X-KBIZ-TOKEN ให้ตรง
// =====================================================================

module.exports = function attachKbizApi(app) {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_KEY;
    const EXT_TOKEN = process.env.EXT_TOKEN || '';
    const DAILY_LIMIT = parseInt(process.env.OCR_DAILY_LIMIT || '500', 10);

    if (!SUPABASE_URL || !SUPABASE_KEY) {
        console.warn('[kbiz-api] ⚠️ ยังไม่ได้ตั้ง SUPABASE_URL / SUPABASE_KEY ใน Environment Variables');
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

    // ---------- POST /api/ocr/parse : OCR รูป ----------
    // body: { base64Image, language: 'eng'|'tha', engine: '1'|'2'|'3', overlay: bool }
    app.options('/api/ocr/parse', cors);
    app.post('/api/ocr/parse', cors, auth, json, async (req, res) => {
        const { base64Image, language = 'eng', engine = '2', overlay = false } = req.body || {};
        if (!base64Image || typeof base64Image !== 'string') return res.status(400).json({ ok: false, error: 'no image' });

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
                return res.json({ ok: true, data: d, keyName: k.key_name });
            } catch (e) {
                lastErr = e.name === 'AbortError' ? 'OCR.space ตอบช้าเกินไป' : e.message;
            }
        }
        res.status(502).json({ ok: false, error: lastErr });
    });

    console.log('[kbiz-api] ✅ routes ready: GET /api/bots, POST /api/ocr/parse');
};
