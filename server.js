const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

// สร้าง Server สำหรับเว็บและ WebSockets
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" } // อนุญาตให้ Extension ทุกเครื่องเชื่อมต่อเข้ามาได้
});

// ตัวแปรจำว่าคอมของคุณ (Host) คือสายไหน จะได้โยนงานไปให้ถูก
let hostSocketId = null;

io.on('connection', (socket) => {
    console.log('⚡ มีคนเชื่อมต่อเข้ามา:', socket.id);

    // 1. แยกแยะว่าคนที่ต่อเข้ามาคือ "คอมของคุณ (Host)" หรือ "พนักงาน (Worker)"
    socket.on('register', (role) => {
        if (role === 'host') {
            hostSocketId = socket.id;
            console.log('👑 บอส (Host) ออนไลน์แล้ว! ID:', socket.id);
        } else {
            console.log('👤 พนักงาน (Worker) ออนไลน์: ID:', socket.id);
        }
    });

    // 2. เมื่อพนักงานส่งเลขบัญชีมาให้เช็ค
    socket.on('request_check', (data) => {
        console.log(`📩 พนักงาน ${socket.id} สั่งเช็คบัญชี:`, data);
        
        if (hostSocketId) {
            // โยนงานไปให้คอมของคุณ (Host) ทำ พร้อมแนบ ID พนักงานไปด้วย
            io.to(hostSocketId).emit('do_check', { 
                workerId: socket.id, 
                bankName: data.bankName, 
                accNo: data.accNo 
            });
        } else {
            // ถ้าคอมของคุณปิดอยู่ หรือไม่ได้เปิด Extension ค้างไว้
            socket.emit('check_result', { 
                status: 'error', 
                message: '❌ เครื่องแม่ข่าย (Host) ออฟไลน์อยู่ กรุณาแจ้งแอดมิน' 
            });
        }
    });

    // 3. เมื่อคอมของคุณ (Host) เช็คเสร็จแล้วส่งชื่อกลับมา
    socket.on('send_result', (data) => {
        console.log('✅ บอสส่งผลลัพธ์กลับมาให้พนักงาน:', data.workerId);
        // ส่งชื่อบัญชีกลับไปเด้งโชว์ที่หน้าจอพนักงานคนที่ขอมา
        io.to(data.workerId).emit('check_result', data.result);
    });

    // กรณีมีคนปิดเบราว์เซอร์หนี
    socket.on('disconnect', () => {
        console.log('❌ มีคนออกจากการเชื่อมต่อ:', socket.id);
        if (socket.id === hostSocketId) {
            console.log('⚠️ อ้าว! บอส (Host) ออฟไลน์ไปแล้ว!');
            hostSocketId = null;
        }
    });
});

// ให้ Server รันบน Port ที่ Railway กำหนดให้
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 ระบบพร้อมทำงานแล้วที่พอร์ต ${PORT}`);
});