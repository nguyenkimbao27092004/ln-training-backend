// Tệp: backend/server.js
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
// Đã bổ sung đầy đủ cả 3 bảng: Trainer, Client, DailySession
const { Trainer, Client, DailySession } = require('./models');

const app = express();
app.use(cors());
app.use(express.json());

// Tự động lấy MONGO_URI trên Render hoặc dùng link Atlas của bạn
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://lntraining:Lntraining2026@cluster0.sla3zqa.mongodb.net/pt_schedule_db?retryWrites=true&w=majority';

// Mở kết nối tới MongoDB Atlas
mongoose.connect(MONGO_URI)
  .then(() => console.log('Đã kết nối MongoDB Atlas thành công!'))
  .catch(err => console.error('Lỗi kết nối MongoDB:', err));

// Hàm quy đổi ngày YYYY-MM-DD sang Thứ trong tuần (2 = Thứ 2 ... 8 = Chủ Nhật)
function getDayOfWeekNumber(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const jsDay = new Date(year, month - 1, day).getDay();
  return jsDay === 0 ? 8 : jsDay + 1;
}

// Hàm tạo danh sách ca tập trong ngày từ lịch cố định theo tuần
async function buildSessionsFromWeekly(date, dayOfWeek) {
  const activeClients = await Client.find({
    status: 'ACTIVE',
    'weeklySchedule.dayOfWeek': dayOfWeek
  });

  const newSessions = [];
  activeClients.forEach(client => {
    const slot = client.weeklySchedule.find(s => s.dayOfWeek === dayOfWeek);
    if (slot) {
      newSessions.push({
        date,
        dayOfWeek,
        trainerId: slot.assignedTrainerId || client.primaryTrainerId,
        clientId: client._id,
        clientName: client.name,
        time: slot.time,
        status: 'SCHEDULED'
      });
    }
  });

  return newSessions.length > 0 ? await DailySession.insertMany(newSessions) : [];
}

// 1. Lấy danh sách PT và Khách hàng
app.get('/api/init', async (req, res) => {
  try {
    const trainers = await Trainer.find();
    const clients = await Client.find().populate('primaryTrainerId');
    res.json({ trainers, clients });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Lấy lịch theo ngày (Nếu chưa có thì tự động lấy từ lịch tuần sang)
app.post('/api/daily-schedule', async (req, res) => {
  try {
    const { date } = req.body;
    const dayOfWeek = getDayOfWeekNumber(date);
    let sessions = await DailySession.find({ date });

    if (sessions.length === 0) {
      sessions = await buildSessionsFromWeekly(date, dayOfWeek);
    }
    res.json(sessions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Xếp lại toàn bộ lịch ngày từ Lịch Tuần (Reset & Đồng bộ lại)
app.post('/api/daily-schedule/resync', async (req, res) => {
  const { date } = req.body;
  const dayOfWeek = getDayOfWeekNumber(date);
  await DailySession.deleteMany({ date });
  const sessions = await buildSessionsFromWeekly(date, dayOfWeek);
  res.json(sessions);
});

// 4. Thêm nhanh 1 ca tập trong ngày (Và tùy chọn lưu luôn vào lịch tuần)
app.post('/api/daily-session/add', async (req, res) => {
  const { date, trainerId, clientId, clientName, time, saveToWeekly } = req.body;
  const dayOfWeek = getDayOfWeekNumber(date);

  const session = await DailySession.create({
    date,
    dayOfWeek,
    trainerId,
    clientId: clientId || null,
    clientName,
    time,
    status: 'SCHEDULED'
  });

  if (saveToWeekly && clientId) {
    const client = await Client.findById(clientId);
    if (client) {
      const existingIdx = client.weeklySchedule.findIndex(s => s.dayOfWeek === dayOfWeek);
      if (existingIdx >= 0) {
        client.weeklySchedule[existingIdx].time = time;
        client.weeklySchedule[existingIdx].assignedTrainerId = trainerId;
      } else {
        client.weeklySchedule.push({ dayOfWeek, time, assignedTrainerId: trainerId });
      }
      await client.save();
    }
  }

  res.json(session);
});

// 5. Xếp lại 1 ca tập (Cập nhật theo Ngày hoặc cập nhật cả Lịch Tuần)
app.put('/api/daily-session/:id/reschedule', async (req, res) => {
  const { trainerId, time, clientName, status, updateScope } = req.body;
  const session = await DailySession.findById(req.params.id);
  if (!session) return res.status(404).json({ message: 'Không tìm thấy ca tập' });

  if (trainerId) session.trainerId = trainerId;
  if (time !== undefined) session.time = time;
  if (clientName) session.clientName = clientName;
  if (status) session.status = status;
  await session.save();

  if (updateScope === 'WEEKLY' && session.clientId) {
    const client = await Client.findById(session.clientId);
    if (client) {
      const slot = client.weeklySchedule.find(s => s.dayOfWeek === session.dayOfWeek);
      if (slot) {
        slot.time = session.time;
        slot.assignedTrainerId = session.trainerId;
      } else {
        client.weeklySchedule.push({
          dayOfWeek: session.dayOfWeek,
          time: session.time,
          assignedTrainerId: session.trainerId
        });
      }
      await client.save();
    }
  }

  res.json(session);
});

// 6. Xóa 1 ca tập khỏi bảng lịch ngày
app.delete('/api/daily-session/:id', async (req, res) => {
  await DailySession.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

// 7. Đánh dấu PT nghỉ phép (OFF) trong ngày
app.post('/api/daily-schedule/toggle-off', async (req, res) => {
  const { date, trainerId } = req.body;
  const dayOfWeek = getDayOfWeekNumber(date);

  const existingOff = await DailySession.findOne({ date, trainerId, clientName: 'OFF' });
  if (existingOff) {
    await DailySession.deleteOne({ _id: existingOff._id });
  } else {
    await DailySession.deleteMany({ date, trainerId });
    await DailySession.create({
      date,
      dayOfWeek,
      trainerId,
      clientName: 'OFF',
      time: '',
      status: 'CANCELLED'
    });
  }

  const sessions = await DailySession.find({ date });
  res.json(sessions);
});

// 8. Quản lý Khách hàng & Lịch cố định theo tuần
app.post('/api/clients', async (req, res) => {
  const newClient = await Client.create(req.body);
  const populated = await Client.findById(newClient._id).populate('primaryTrainerId');
  res.json(populated);
});

app.put('/api/clients/:id', async (req, res) => {
  const updated = await Client.findByIdAndUpdate(req.params.id, req.body, { new: true }).populate('primaryTrainerId');
  res.json(updated);
});

// 9. Chốt ca cuối ngày
app.post('/api/daily-schedule/close', async (req, res) => {
  const { date } = req.body;
  await DailySession.updateMany(
    { date, status: 'SCHEDULED' },
    { $set: { status: 'COMPLETED', isLocked: true } }
  );
  await DailySession.updateMany(
    { date, status: 'CANCELLED' },
    { $set: { isLocked: true } }
  );
  const sessions = await DailySession.find({ date });
  res.json(sessions);
});

// 10. Mở khóa lại ngày đã chốt
app.post('/api/daily-schedule/reopen', async (req, res) => {
  const { date } = req.body;
  await DailySession.updateMany(
    { date, status: 'COMPLETED' },
    { $set: { status: 'SCHEDULED', isLocked: false } }
  );
  await DailySession.updateMany(
    { date, status: 'CANCELLED' },
    { $set: { isLocked: false } }
  );
  const sessions = await DailySession.find({ date });
  res.json(sessions);
});

// 11. Tổng hợp ca làm việc của PT cuối tuần
app.get('/api/weekly-summary', async (req, res) => {
  const { startDate, endDate } = req.query;
  const summary = await DailySession.aggregate([
    {
      $match: {
        date: { $gte: startDate, $lte: endDate },
        status: 'COMPLETED'
      }
    },
    {
      $group: {
        _id: { trainerId: '$trainerId', date: '$date' },
        dailyCount: { $sum: 1 }
      }
    },
    {
      $group: {
        _id: '$_id.trainerId',
        totalShifts: { $sum: '$dailyCount' },
        dailyBreakdown: { $push: { date: '$_id.date', count: '$dailyCount' } }
      }
    }
  ]);
  res.json(summary);
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server đang chạy tại cổng ${PORT}`));