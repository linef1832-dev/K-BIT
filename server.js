const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
require('./kbiz-api')(app); // 🔐 API สำหรับส่วนขยาย (key อยู่ใน Environment Variables)

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

/* ═══════════════ STATE ═══════════════
   activeBots   : socket.id → { id, isProcessing }
   botSocketIds : machineId → socket.id
   jobs         : workerId  → { socketId, clientId, bankName, accNo, system, ts, inFlight, dispatchedAt }
   หลักการ: ทุกงานเข้าคิวกลางต่อเครื่อง → ส่งให้เครื่องทีละงาน → เสร็จค่อยส่งงานถัดไป
            เครื่อง reconnect → งานที่ค้าง "ยิงต่อ" ให้เอง ไม่ยกเลิก
*/
const activeBots = new Map();
const botSocketIds = new Map();
const jobs = new Map();

const JOB_MAX_AGE_MS = 4 * 60 * 1000;   // งานรอได้สูงสุด 4 นาที (เผื่อเครื่องหลุด/refresh/login ใหม่) → ค่อยแจ้งล้มเหลว
const INFLIGHT_STALL_MS = 100 * 1000;   // ส่งไปแล้วเครื่องไม่ตอบเกิน 100 วิ → ถือว่าค้าง ส่งใหม่/ล้มเหลว

function jobsOf(machineId) {
    return [...jobs.entries()].filter(([, j]) => j.system === machineId).sort((a, b) => a[1].ts - b[1].ts);
}
function replyJob(workerId, job, result) {
    const payload = Object.assign({}, result, { workerId, reqBank: job.bankName, reqAcc: job.accNo, system: job.system });
    if (job.clientId) io.to('client:' + job.clientId).emit('check_result', payload);
    else io.to(job.socketId).emit('check_result', payload);
}
function failJob(workerId, job, reason) {
    replyJob(workerId, job, { status: 'error', message: reason });
    jobs.delete(workerId);
}
function botOf(machineId) {
    const sid = botSocketIds.get(machineId);
    return sid ? { sid, bot: activeBots.get(sid) } : { sid: null, bot: null };
}

/** ส่งงานถัดไปให้เครื่อง (ถ้าเครื่องว่างและมีงานรอ) */
function dispatchNext(machineId) {
    const { sid, bot } = botOf(machineId);
    if (!sid || !bot) return;
    const list = jobsOf(machineId);
    if (list.some(([, j]) => j.inFlight)) return;            // มีงานกำลังทำอยู่ → รอ
    const next = list.find(([, j]) => !j.inFlight);
    if (!next) { bot.isProcessing = false; return; }
    const [workerId, job] = next;
    job.inFlight = true; job.dispatchedAt = Date.now(); job.attempts = (job.attempts || 0) + 1;
    bot.isProcessing = true;
    io.to(sid).emit('do_check', { workerId, bankName: job.bankName, accNo: job.accNo });
    console.log(`▶ ${machineId} ← ${job.accNo} (${job.bankName}) [คิวเหลือ ${list.length - 1}]`);
}

function broadcastStatus() {
    const liveStatusData = {};
    for (const [machineId, socketId] of botSocketIds.entries()) {
        const bot = activeBots.get(socketId);
        if (!bot) continue;
        const queue = jobsOf(machineId).map(([, j]) => j.clientId || null);
        liveStatusData[machineId] = { isOnline: true, count: queue.length, isProcessing: bot.isProcessing, queue };
    }
    io.emit('live_queue_status', liveStatusData);
}

io.on('connection', (socket) => {
    console.log(`⚡ มีการเชื่อมต่อ: ${socket.id}`);

    socket.on('join', (data) => {
        if (data && data.clientId) socket.join('client:' + data.clientId);
        broadcastStatus();
    });

    // 1. เครื่อง (extension) รายงานตัว — เรียกซ้ำได้ (heartbeat) ไม่ทำงานหาย
    socket.on('register', (data) => {
        if (!(data && data.role === 'host' && data.hostId)) return;
        const prevSid = botSocketIds.get(data.hostId);
        const isNewSocket = prevSid !== socket.id;
        if (!activeBots.has(socket.id)) activeBots.set(socket.id, { id: data.hostId, isProcessing: false, isOnline: true });
        botSocketIds.set(data.hostId, socket.id);
        if (isNewSocket) {
            if (prevSid && prevSid !== socket.id) activeBots.delete(prevSid);
            console.log(`🤖 บอทออนไลน์: ${data.hostId}${prevSid ? ' (reconnect — ส่งงานค้างต่อ)' : ''}`);
            // เครื่องต่อใหม่ → งานที่ส่งไปแล้วถือว่าหลุด ให้ส่งใหม่ (ไม่ยกเลิก)
            for (const [, j] of jobsOf(data.hostId)) j.inFlight = false;
            activeBots.get(socket.id).isProcessing = false;
        }
        dispatchNext(data.hostId);
        broadcastStatus();
    });

    // 2. รับงาน (จาก Telegram bot หรือ popup) → เข้าคิวกลาง
    socket.on('request_check', (data) => {
        const targetMachine = data.system;
        const { sid, bot } = botOf(targetMachine);
        // เครื่องหลุดอยู่ → ไม่ตอบออฟไลน์ รับเข้าคิวไว้ พอเครื่องกลับมาจะเช็คให้เอง (รอได้สูงสุด JOB_MAX_AGE_MS)
        if (!sid || !bot) console.log(`⏳ ${targetMachine} ออฟไลน์ชั่วคราว — เก็บงาน ${data.accNo} ไว้รอ`);

        const workerId = "job_" + Date.now() + "_" + Math.floor(Math.random() * 1000);
        jobs.set(workerId, { socketId: socket.id, clientId: data.clientId || null, bankName: data.bankName, accNo: data.accNo, system: targetMachine, ts: Date.now(), inFlight: false });
        socket.emit('job_accepted', { workerId, bankName: data.bankName, accNo: data.accNo, system: targetMachine });
        const position = jobsOf(targetMachine).length;
        socket.emit('queue_status', { position, ahead: position - 1 });
        dispatchNext(targetMachine);
        broadcastStatus();
    });

    // 3. เครื่องส่งผลกลับ → ตอบคนสั่ง → ส่งงานถัดไป
    socket.on('send_result', (data) => {
        const job = jobs.get(data.workerId);
        const bot = activeBots.get(socket.id);
        if (job) { replyJob(data.workerId, job, data.result || {}); jobs.delete(data.workerId); }
        if (bot) { bot.isProcessing = false; dispatchNext(bot.id); }
        broadcastStatus();
    });

    // 4. เครื่องหลุด — ไม่ยกเลิกงาน แค่ปลด inFlight รอเครื่องกลับมาแล้วส่งต่อ (sweeper จะล้มเหลวให้ถ้าเกิน 3 นาที)
    socket.on('disconnect', () => {
        const bot = activeBots.get(socket.id);
        if (bot) {
            console.log(`🔴 ขาดการเชื่อมต่อ: ${bot.id}`);
            if (botSocketIds.get(bot.id) === socket.id) {
                botSocketIds.delete(bot.id);
                for (const [, j] of jobsOf(bot.id)) j.inFlight = false;
            }
            activeBots.delete(socket.id);
            broadcastStatus();
        }
    });
});

// เก็บกวาด: งานเก่าเกิน 3 นาที → ล้มเหลว; งาน inFlight ที่เครื่องไม่ตอบเกิน 100 วิ → ส่งใหม่ 1 ครั้ง แล้วค่อยล้มเหลว
setInterval(() => {
    const now = Date.now();
    const touched = new Set();
    for (const [workerId, job] of jobs.entries()) {
        if (now - job.ts > JOB_MAX_AGE_MS) { failJob(workerId, job, `บอท ${job.system} ไม่กลับมาภายใน 4 นาที กรุณาลองใหม่`); touched.add(job.system); continue; }
        if (job.inFlight && now - (job.dispatchedAt || 0) > INFLIGHT_STALL_MS) {
            if ((job.attempts || 0) >= 2) { failJob(workerId, job, `บอท ${job.system} ค้างระหว่างทำงาน กรุณาลองใหม่`); }
            else { job.inFlight = false; }
            touched.add(job.system);
        }
    }
    for (const m of touched) { const { bot } = botOf(m); if (bot) bot.isProcessing = false; dispatchNext(m); }
    if (touched.size) broadcastStatus();
}, 15000);

setInterval(broadcastStatus, 3000);

app.get('/', (req, res) => res.send(`✅ Server is Running! Active Bots: ${activeBots.size} | Queue: ${jobs.size}`));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server started on port ${PORT} (queue v2)`));
