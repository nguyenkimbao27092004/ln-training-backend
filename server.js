// Tệp: backend/server.js
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { Trainer, Client, DailySession } = require('./models');

const app = express();
app.use(cors());
app.use(express.json());

const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://lntraining:Lntraining2026@cluster0.sla3zqa.mongodb.net/pt_schedule_db?retryWrites=true&w=majority';

mongoose.connect(MONGO_URI)
  .then(() => console.log('Đã kết nối MongoDB Atlas thành công!'))
  .catch(err => console.error('Lỗi kết nối MongoDB:', err));

// ==================== TỰ ĐỘNG BỔ SUNG TRƯỜNG SĐT & BÀI TẬP VÀO SCHEMA ====================
if (!Client.schema.path('phone')) {
  Client.schema.add({ phone: { type: String, default: '' } });
}
const weeklySubSchema = Client.schema.path('weeklySchedule')?.schema;
if (weeklySubSchema) {
  if (!weeklySubSchema.path('workoutType')) {
    weeklySubSchema.add({
      workoutType: { type: String, default: '' }, // VD: Thân trên, Thân dưới...
      workoutNote: { type: String, default: '' }  // Chi tiết bài tập
    });
  }
}
if (!DailySession.schema.path('workoutType')) {
  DailySession.schema.add({
    workoutType: { type: String, default: '' },
    workoutNote: { type: String, default: '' }
  });
}

// Schema Tài Khoản Người Dùng (Phân quyền Admin & PT)
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  name: { type: String, required: true },
  role: { type: String, enum: ['ADMIN', 'PT'], default: 'PT' },
  trainerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Trainer', default: null }
}, { timestamps: true });

const User = mongoose.models.User || mongoose.model('User', userSchema);

function getDayOfWeekNumber(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const jsDay = new Date(year, month - 1, day).getDay();
  return jsDay === 0 ? 8 : jsDay + 1;
}

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
        status: 'SCHEDULED',
        workoutType: slot.workoutType || '',
        workoutNote: slot.workoutNote || ''
      });
    }
  });

  return newSessions.length > 0 ? await DailySession.insertMany(newSessions) : [];
}

// ==================== AUTHENTICATION (ĐĂNG NHẬP ADMIN, PT & KHÁCH HÀNG) ====================
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Vui lòng nhập đầy đủ tài khoản và mật khẩu' });
    }

    if (username.trim().toLowerCase() === 'dinhle' && password === 'dinhle123') {
      return res.json({
        user: {
          username: 'dinhle',
          name: 'Admin Định Lê',
          role: 'ADMIN'
        }
      });
    }

    const user = await User.findOne({ username: username.trim().toLowerCase() });
    if (!user || user.password !== password) {
      return res.status(401).json({ error: 'Tài khoản hoặc mật khẩu không chính xác' });
    }

    res.json({
      user: {
        _id: user._id,
        username: user.username,
        name: user.name,
        role: user.role,
        trainerId: user.trainerId
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password, name, trainerId } = req.body;
    if (!username || !password || !name) {
      return res.status(400).json({ error: 'Vui lòng điền đầy đủ thông tin' });
    }

    const cleanUsername = username.trim().toLowerCase();
    if (cleanUsername === 'dinhle') {
      return res.status(400).json({ error: 'Tên tài khoản này đã được bảo lưu cho Admin' });
    }

    const existing = await User.findOne({ username: cleanUsername });
    if (existing) {
      return res.status(400).json({ error: 'Tên tài khoản đã tồn tại, vui lòng chọn tên khác' });
    }

    const newUser = await User.create({
      username: cleanUsername,
      password,
      name: name.trim(),
      role: 'PT',
      trainerId: trainerId || null
    });

    res.json({
      message: 'Đăng ký tài khoản PT thành công',
      user: {
        _id: newUser._id,
        username: newUser.username,
        name: newUser.name,
        role: newUser.role,
        trainerId: newUser.trainerId
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ĐĂNG NHẬP DÀNH RIÊNG CHO KHÁCH HÀNG BẰNG SỐ ĐIỆN THOẠI
app.post('/api/auth/client-login', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone || !phone.trim()) {
      return res.status(400).json({ error: 'Vui lòng nhập số điện thoại của bạn' });
    }

    const cleanPhone = phone.replace(/\D/g, '');
    if (!cleanPhone) {
      return res.status(400).json({ error: 'Số điện thoại không hợp lệ' });
    }

    const allClients = await Client.find().populate('primaryTrainerId');
    const matchedClient = allClients.find(
      c => c.phone && c.phone.replace(/\D/g, '') === cleanPhone
    );

    if (!matchedClient) {
      return res.status(404).json({
        error: 'Không tìm thấy thông tin học viên với số điện thoại này. Vui lòng liên hệ Admin hoặc PT để cập nhật SĐT!'
      });
    }

    const trainers = await Trainer.find();
    const recentSessions = await DailySession.find({
      $or: [
        { clientId: matchedClient._id },
        { clientName: { $regex: matchedClient.name.trim(), $options: 'i' } }
      ]
    }).sort({ date: -1 }).limit(30);

    res.json({
      client: matchedClient,
      trainers,
      recentSessions
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== CÁC API QUẢN LÝ LỊCH & KHÁCH HÀNG ====================
app.get('/api/init', async (req, res) => {
  try {
    const trainers = await Trainer.find();
    const clients = await Client.find().populate('primaryTrainerId');
    res.json({ trainers, clients });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

app.post('/api/daily-schedule/resync', async (req, res) => {
  const { date } = req.body;
  const dayOfWeek = getDayOfWeekNumber(date);
  await DailySession.deleteMany({ date });
  const sessions = await buildSessionsFromWeekly(date, dayOfWeek);
  res.json(sessions);
});

app.post('/api/daily-session/add', async (req, res) => {
  const { date, trainerId, clientId, clientName, time, saveToWeekly, workoutType, workoutNote } = req.body;
  const dayOfWeek = getDayOfWeekNumber(date);

  const session = await DailySession.create({
    date,
    dayOfWeek,
    trainerId,
    clientId: clientId || null,
    clientName,
    time,
    status: 'SCHEDULED',
    workoutType: workoutType || '',
    workoutNote: workoutNote || ''
  });

  if (saveToWeekly && clientId) {
    const client = await Client.findById(clientId);
    if (client) {
      const existingIdx = client.weeklySchedule.findIndex(s => s.dayOfWeek === dayOfWeek);
      if (existingIdx >= 0) {
        client.weeklySchedule[existingIdx].time = time;
        client.weeklySchedule[existingIdx].assignedTrainerId = trainerId;
        if (workoutType !== undefined) client.weeklySchedule[existingIdx].workoutType = workoutType;
        if (workoutNote !== undefined) client.weeklySchedule[existingIdx].workoutNote = workoutNote;
      } else {
        client.weeklySchedule.push({
          dayOfWeek,
          time,
          assignedTrainerId: trainerId,
          workoutType: workoutType || '',
          workoutNote: workoutNote || ''
        });
      }
      await client.save();
    }
  }

  res.json(session);
});

app.put('/api/daily-session/:id/reschedule', async (req, res) => {
  const { trainerId, time, clientName, status, updateScope, workoutType, workoutNote } = req.body;
  const session = await DailySession.findById(req.params.id);
  if (!session) return res.status(404).json({ message: 'Không tìm thấy ca tập' });

  if (trainerId) session.trainerId = trainerId;
  if (time !== undefined) session.time = time;
  if (clientName) session.clientName = clientName;
  if (status) session.status = status;
  if (workoutType !== undefined) session.workoutType = workoutType;
  if (workoutNote !== undefined) session.workoutNote = workoutNote;
  await session.save();

  if (updateScope === 'WEEKLY' && session.clientId) {
    const client = await Client.findById(session.clientId);
    if (client) {
      const slot = client.weeklySchedule.find(s => s.dayOfWeek === session.dayOfWeek);
      if (slot) {
        slot.time = session.time;
        slot.assignedTrainerId = session.trainerId;
        if (workoutType !== undefined) slot.workoutType = workoutType;
        if (workoutNote !== undefined) slot.workoutNote = workoutNote;
      } else {
        client.weeklySchedule.push({
          dayOfWeek: session.dayOfWeek,
          time: session.time,
          assignedTrainerId: session.trainerId,
          workoutType: workoutType || '',
          workoutNote: workoutNote || ''
        });
      }
      await client.save();
    }
  }

  res.json(session);
});

// API CHO ADMIN & PT CẬP NHẬT BÀI TẬP TRONG CA TẬP NGÀY
app.put('/api/daily-session/:id/workout', async (req, res) => {
  try {
    const { workoutType, workoutNote, saveToWeekly } = req.body;
    const session = await DailySession.findById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Không tìm thấy ca tập' });

    session.workoutType = workoutType || '';
    session.workoutNote = workoutNote || '';
    await session.save();

    if (saveToWeekly && session.clientId) {
      const client = await Client.findById(session.clientId);
      if (client) {
        const slot = client.weeklySchedule.find(s => s.dayOfWeek === session.dayOfWeek);
        if (slot) {
          slot.workoutType = workoutType || '';
          slot.workoutNote = workoutNote || '';
          await client.save();
        }
      }
    }

    res.json(session);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/daily-session/:id', async (req, res) => {
  await DailySession.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

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

app.post('/api/clients', async (req, res) => {
  const newClient = await Client.create(req.body);
  const populated = await Client.findById(newClient._id).populate('primaryTrainerId');
  res.json(populated);
});

app.put('/api/clients/:id', async (req, res) => {
  const updated = await Client.findByIdAndUpdate(req.params.id, req.body, { new: true }).populate('primaryTrainerId');
  res.json(updated);
});

// Chuyển toàn bộ khách hàng sang trạng thái Tạm nghỉ (PAUSED / OFF)
app.post('/api/clients/pause-all', async (req, res) => {
  try {
    const result = await Client.updateMany(
      {},
      { $set: { status: 'PAUSED' } }
    );
    const clients = await Client.find().populate('primaryTrainerId');
    res.json({
      success: true,
      message: `Đã chuyển toàn bộ ${result.modifiedCount} khách hàng sang trạng thái Tạm nghỉ (OFF)!`,
      clients
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Xóa vĩnh viễn 1 khách hàng
app.delete('/api/clients/:id', async (req, res) => {
  try {
    await Client.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Đã xóa khách hàng thành công' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
        dailyCount: { $sum: 1 },
        doubleCount: {
          $sum: {
            $cond: [
              { $regexMatch: { input: { $ifNull: ['$clientName', ''] }, regex: /\[CA ĐÔI\]/i } },
              1,
              0
            ]
          }
        }
      }
    },
    {
      $group: {
        _id: '$_id.trainerId',
        totalShifts: { $sum: '$dailyCount' },
        totalDoubleShifts: { $sum: '$doubleCount' },
        dailyBreakdown: {
          $push: {
            date: '$_id.date',
            count: '$dailyCount',
            doubleCount: '$doubleCount'
          }
        }
      }
    }
  ]);
  res.json(summary);
});

app.post('/api/daily-schedule/clear-range', async (req, res) => {
  try {
    const { startDate, endDate } = req.body;
    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'Thiếu ngày bắt đầu hoặc ngày kết thúc' });
    }
    const result = await DailySession.deleteMany({
      date: { $gte: startDate, $lte: endDate }
    });
    res.json({
      success: true,
      deletedCount: result.deletedCount
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server đang chạy tại cổng ${PORT}`));