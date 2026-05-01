const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// เก็บข้อมูล Bot ที่ออนไลน์
const activeBots = new Map();
// แมปเพื่อหา socket.id ของ bot จากชื่อ MACHINE_ID
const botSocketIds = new Map();
// เก็บงานที่ Popup สั่งมา (ใครเป็นคนสั่ง จะได้ตอบกลับถูกคน)
const pendingRequests = new Map();

// ฟังก์ชันส่งอัปเดตสถานะให้ Popup ทุกหน้าต่างที่เปิดอยู่
function broadcastStatus() {
    const liveStatusData = {};
    for (let [machineId, socketId] of botSocketIds.entries()) {
        const botData = activeBots.get(socketId);
        if (botData) {
            liveStatusData[machineId] = {
                isOnline: true,
                count: botData.count,
                isProcessing: botData.isProcessing
            };
        }
    }
    // ส่งข้อมูลให้ Popup อัปเดต Dropdown ให้เป็นสีเขียว
    io.emit('live_queue_status', liveStatusData);
}

io.on('connection', (socket) => {
    console.log(`⚡ มีการเชื่อมต่อ: ${socket.id}`);

    // 1. ฝั่งบอทมารายงานตัวว่าออนไลน์
    socket.on('register', (data) => {
        if (data.role === 'host' && data.hostId) {
            activeBots.set(socket.id, { id: data.hostId, count: 0, isProcessing: false, isOnline: true });
            botSocketIds.set(data.hostId, socket.id);
            console.log(`🤖 บอทออนไลน์: ${data.hostId}`);
            broadcastStatus(); // สั่งอัปเดตหน้า Popup ทันที
        }
    });

    // 2. ฝั่ง Popup กดปุ่ม "ค้นหาชื่อบัญชี"
    socket.on('request_check', (data) => {
        const targetMachine = data.system;
        const targetSocketId = botSocketIds.get(targetMachine);

        // ถ้าบอทไม่ออนไลน์ ให้เด้งบอก Popup
        if (!targetSocketId || !activeBots.has(targetSocketId)) {
            return socket.emit('check_result', { status: 'error', message: `บอท ${targetMachine} ออฟไลน์อยู่` });
        }

        const workerId = "job_" + Date.now() + "_" + Math.floor(Math.random() * 1000);
        pendingRequests.set(workerId, socket.id); // จำไว้ว่า Popup หน้าต่างไหนเป็นคนกดสั่ง

        const botData = activeBots.get(targetSocketId);
        botData.count += 1; // เพิ่มคิว
        
        // แจ้ง Popup ว่ากำลังเข้าคิว
        socket.emit('queue_status', { position: botData.count });

        // สั่งงานไปที่บอทให้เริ่มดึงข้อมูล
        io.to(targetSocketId).emit('do_check', {
            workerId: workerId,
            bankName: data.bankName,
            accNo: data.accNo
        });

        broadcastStatus();
    });

    // 3. ฝั่งบอททำงานเสร็จ ส่งข้อมูลชื่อกลับมา
    socket.on('send_result', (data) => {
        const popupSocketId = pendingRequests.get(data.workerId);
        if (popupSocketId) {
            // ส่งชื่อบัญชีกลับไปแสดงที่หน้า Popup
            io.to(popupSocketId).emit('check_result', data.result);
            pendingRequests.delete(data.workerId);
        }

        // ลดคิวบอทลง
        const botData = activeBots.get(socket.id);
        if (botData && botData.count > 0) {
            botData.count -= 1;
        }
        broadcastStatus();
    });

    // 4. กรณีมีคนปิดโปรแกรม หรือเน็ตหลุด
    socket.on('disconnect', () => {
        const botData = activeBots.get(socket.id);
        if (botData) {
            console.log(`🔴 ขาดการเชื่อมต่อ: ${botData.id}`);
            botSocketIds.delete(botData.id);
            activeBots.delete(socket.id);
            broadcastStatus(); // อัปเดตให้ Popup รู้ว่าบอทออฟไลน์ไปแล้ว
        }
    });
});

// อัปเดตสถานะให้ Popup ทุกๆ 3 วินาที (เผื่อมีคนเพิ่งกดเปิด Popup ขึ้นมาใหม่)
setInterval(broadcastStatus, 3000);

app.get('/', (req, res) => {
    res.send(`✅ Server is Running! Active Bots: ${activeBots.size}`);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server started on port ${PORT}`);
});
