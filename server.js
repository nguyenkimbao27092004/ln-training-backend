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

// ==================== BỔ SUNG TRƯỜNG SĐT & BÀI TẬP VÀO SCHEMA & PROTOTYPE ====================
Client.schema.set('strict', false);
DailySession.schema.set('strict', false);

if (!Client.schema.path('phone')) {
  Client.schema.add({ phone: { type: String, default: '' } });
}
const weeklySubSchema = Client.schema.path('weeklySchedule')?.schema;
if (weeklySubSchema) {
  weeklySubSchema.set('strict', false);
  if (!weeklySubSchema.path('workoutType')) {
    weeklySubSchema.add({
      workoutType: { type: String, default: '' },
      workoutNote: { type: String, default: '' }
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
  // Dùng .lean() để lấy đầy đủ workoutType và workoutNote trực tiếp từ MongoDB
  const activeClients = await Client.find({
    status: 'ACTIVE',
    'weeklySchedule.dayOfWeek': dayOfWeek
  }).lean();

  const newSessions = [];
  activeClients.forEach(client => {
    const slot = (client.weeklySchedule || []).find(s => s.dayOfWeek === dayOfWeek);
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
    const { username, password, name, trainerId, registerCode } = req.body;
    if (!username || !password || !name || !registerCode) {
      return res.status(400).json({ error: 'Vui lòng điền đầy đủ thông tin và mã xác nhận đăng ký PT' });
    }

    if (String(registerCode).trim().toLowerCase() !== 'dinhle') {
      return res.status(403).json({ error: 'Mã xác nhận đăng ký PT không chính xác!' });
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

// ĐĂNG NHẬP DÀNH RIÊNG CHO KHÁCH HÀNG BẰNG SỐ ĐIỆN THOẠI HOẶC 4 SỐ CUỐI (DÙNG .lean() ĐỂ ĐỌC TRỰC TIẾP TỪ MONGODB)
app.post('/api/auth/client-login', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone || !String(phone).trim()) {
      return res.status(400).json({ error: 'Vui lòng nhập số điện thoại của bạn' });
    }

    const cleanInput = String(phone).trim();
    const digitsInput = cleanInput.replace(/\D/g, '');

    // .lean() giúp lấy nguyên vẹn trường phone và weeklySchedule từ MongoDB
    const allClients = await Client.find().populate('primaryTrainerId').lean();

    let matchedClient = allClients.find(c => {
      const dbPhone = String(c.phone || '').trim();
      if (!dbPhone) return false;
      const dbDigits = dbPhone.replace(/\D/g, '');
      if (digitsInput && dbDigits) {
        return dbDigits === digitsInput;
      }
      return dbPhone.toLowerCase() === cleanInput.toLowerCase();
    });

    // Hỗ trợ đăng nhập bằng 4 số cuối của số điện thoại
    if (!matchedClient && digitsInput.length >= 4) {
      const suffixMatches = allClients.filter(c => {
        const dbPhone = String(c.phone || '').trim();
        if (!dbPhone) return false;
        const dbDigits = dbPhone.replace(/\D/g, '');
        return dbDigits && dbDigits.endsWith(digitsInput);
      });

      if (suffixMatches.length === 1) {
        matchedClient = suffixMatches[0];
      } else if (suffixMatches.length > 1) {
        return res.status(400).json({
          error: 'Có nhiều học viên có 4 số cuối giống nhau, vui lòng nhập đầy đủ số điện thoại của bạn!'
        });
      }
    }

    if (!matchedClient) {
      return res.status(404).json({
        error: 'Không tìm thấy thông tin học viên với số điện thoại này. Vui lòng liên hệ Admin hoặc PT để cập nhật SĐT!'
      });
    }

    const trainers = await Trainer.find().lean();
    const escapedName = matchedClient.name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rawSessions = await DailySession.find({
      clientName: { $ne: 'OFF' },
      $or: [
        { clientId: matchedClient._id },
        { clientName: { $regex: escapedName, $options: 'i' } }
      ]
    })
      .sort({ date: -1 })
      .limit(100)
      .lean();

    // Ưu tiên thông tin buổi tập đã xếp/chốt ca trong ngày đó; nếu trống mới lấy dự phòng từ lịch tuần
    const recentSessions = rawSessions.map(s => {
      const dow = s.dayOfWeek || getDayOfWeekNumber(s.date);
      const weeklySlot = (matchedClient.weeklySchedule || []).find(w => w.dayOfWeek === dow);
      const hasCustomWorkout = Boolean(s.workoutType || s.workoutNote);

      return {
        ...s,
        dayOfWeek: dow,
        workoutType: hasCustomWorkout ? (s.workoutType || '') : (weeklySlot?.workoutType || ''),
        workoutNote: hasCustomWorkout ? (s.workoutNote || '') : (weeklySlot?.workoutNote || '')
      };
    });

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
    const trainers = await Trainer.find().lean();
    const clients = await Client.find().populate('primaryTrainerId').lean();
    res.json({ trainers, clients });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/daily-schedule', async (req, res) => {
  try {
    const { date } = req.body;
    const dayOfWeek = getDayOfWeekNumber(date);
    let sessions = await DailySession.find({ date }).lean();

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

  let finalWorkoutType = workoutType || '';
  let finalWorkoutNote = workoutNote || '';

  const clientDoc = clientId ? await Client.findById(clientId).lean() : null;
  if (!finalWorkoutType && !finalWorkoutNote && clientDoc) {
    const weeklySlot = (clientDoc.weeklySchedule || []).find(s => s.dayOfWeek === dayOfWeek);
    if (weeklySlot) {
      finalWorkoutType = weeklySlot.workoutType || '';
      finalWorkoutNote = weeklySlot.workoutNote || '';
    }
  }

  const session = await DailySession.create({
    date,
    dayOfWeek,
    trainerId,
    clientId: clientId || null,
    clientName,
    time,
    status: 'SCHEDULED',
    workoutType: finalWorkoutType,
    workoutNote: finalWorkoutNote
  });

  if (saveToWeekly && clientId && clientDoc) {
    const schedule = Array.isArray(clientDoc.weeklySchedule) ? [...clientDoc.weeklySchedule] : [];
    const existingIdx = schedule.findIndex(s => s.dayOfWeek === dayOfWeek);
    if (existingIdx >= 0) {
      schedule[existingIdx] = {
        ...schedule[existingIdx],
        time,
        assignedTrainerId: trainerId,
        workoutType: finalWorkoutType || schedule[existingIdx].workoutType || '',
        workoutNote: finalWorkoutNote || schedule[existingIdx].workoutNote || ''
      };
    } else {
      schedule.push({
        dayOfWeek,
        time,
        assignedTrainerId: trainerId,
        workoutType: finalWorkoutType,
        workoutNote: finalWorkoutNote
      });
    }
    await Client.findByIdAndUpdate(clientId, { $set: { weeklySchedule: schedule } });
  }

  res.json(session);
});

app.put('/api/daily-session/:id/reschedule', async (req, res) => {
  const { trainerId, time, clientName, status, updateScope, workoutType, workoutNote } = req.body;
  const updateFields = {};
  if (trainerId) updateFields.trainerId = trainerId;
  if (time !== undefined) updateFields.time = time;
  if (clientName) updateFields.clientName = clientName;
  if (status) updateFields.status = status;
  if (workoutType !== undefined) updateFields.workoutType = workoutType;
  if (workoutNote !== undefined) updateFields.workoutNote = workoutNote;

  const session = await DailySession.findByIdAndUpdate(
    req.params.id,
    { $set: updateFields },
    { new: true }
  ).lean();

  if (!session) return res.status(404).json({ message: 'Không tìm thấy ca tập' });

  if (updateScope === 'WEEKLY' && session.clientId) {
    const client = await Client.findById(session.clientId).lean();
    if (client) {
      const schedule = Array.isArray(client.weeklySchedule) ? [...client.weeklySchedule] : [];
      const idx = schedule.findIndex(s => s.dayOfWeek === session.dayOfWeek);
      if (idx >= 0) {
        schedule[idx] = {
          ...schedule[idx],
          time: session.time,
          assignedTrainerId: session.trainerId,
          workoutType: workoutType !== undefined ? workoutType : (schedule[idx].workoutType || ''),
          workoutNote: workoutNote !== undefined ? workoutNote : (schedule[idx].workoutNote || '')
        };
      } else {
        schedule.push({
          dayOfWeek: session.dayOfWeek,
          time: session.time,
          assignedTrainerId: session.trainerId,
          workoutType: workoutType || '',
          workoutNote: workoutNote || ''
        });
      }
      await Client.findByIdAndUpdate(session.clientId, { $set: { weeklySchedule: schedule } });
    }
  }

  res.json(session);
});

// API CHO ADMIN & PT CẬP NHẬT BÀI TẬP TRONG CA TẬP NGÀY
app.put('/api/daily-session/:id/workout', async (req, res) => {
  try {
    const { workoutType, workoutNote, saveToWeekly } = req.body;
    const session = await DailySession.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          workoutType: workoutType || '',
          workoutNote: workoutNote || ''
        }
      },
      { new: true }
    ).lean();

    if (!session) return res.status(404).json({ error: 'Không tìm thấy ca tập' });

    if (saveToWeekly && session.clientId) {
      const client = await Client.findById(session.clientId).lean();
      if (client) {
        const schedule = Array.isArray(client.weeklySchedule) ? [...client.weeklySchedule] : [];
        const idx = schedule.findIndex(s => s.dayOfWeek === session.dayOfWeek);
        if (idx >= 0) {
          schedule[idx] = {
            ...schedule[idx],
            workoutType: workoutType || '',
            workoutNote: workoutNote || ''
          };
          await Client.findByIdAndUpdate(session.clientId, { $set: { weeklySchedule: schedule } });
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

  const sessions = await DailySession.find({ date }).lean();
  res.json(sessions);
});

app.post('/api/clients', async (req, res) => {
  const newClient = await Client.create(req.body);
  const populated = await Client.findById(newClient._id).populate('primaryTrainerId').lean();
  res.json(populated);
});

app.put('/api/clients/:id', async (req, res) => {
  const updated = await Client.findByIdAndUpdate(
    req.params.id,
    { $set: req.body },
    { new: true }
  ).populate('primaryTrainerId').lean();
  res.json(updated);
});

app.post('/api/clients/pause-all', async (req, res) => {
  try {
    const result = await Client.updateMany(
      {},
      { $set: { status: 'PAUSED' } }
    );
    const clients = await Client.find().populate('primaryTrainerId').lean();
    res.json({
      success: true,
      message: `Đã chuyển toàn bộ ${result.modifiedCount} khách hàng sang trạng thái Tạm nghỉ (OFF)!`,
      clients
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/clients/:id', async (req, res) => {
  try {
    await Client.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Đã xóa khách hàng thành công' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CHỐT CA: Lưu cứng trạng thái COMPLETED + tự động lưu kèm nhóm cơ/bài tập nếu ca chưa ghi riêng
app.post('/api/daily-schedule/close', async (req, res) => {
  try {
    const { date } = req.body;
    const dayOfWeek = getDayOfWeekNumber(date);

    const scheduledSessions = await DailySession.find({ date, status: 'SCHEDULED' }).lean();
    const clientIds = scheduledSessions.map(s => s.clientId).filter(Boolean);
    const clientsList = clientIds.length > 0
      ? await Client.find({ _id: { $in: clientIds } }).lean()
      : [];
    const clientMap = new Map(clientsList.map(c => [String(c._id), c]));

    const bulkOps = scheduledSessions.map(s => {
      const updateSet = { status: 'COMPLETED', isLocked: true };
      const isDouble = /\[CA ĐÔI\]/i.test(s.clientName || '');
      const hasCustomWorkout = Boolean(s.workoutType || s.workoutNote);

      if (!hasCustomWorkout && !isDouble && s.clientId) {
        const client = clientMap.get(String(s.clientId));
        const slot = (client?.weeklySchedule || []).find(w => w.dayOfWeek === dayOfWeek);
        if (slot && (slot.workoutType || slot.workoutNote)) {
          updateSet.workoutType = slot.workoutType || '';
          updateSet.workoutNote = slot.workoutNote || '';
        }
      }

      return {
        updateOne: {
          filter: { _id: s._id },
          update: { $set: updateSet }
        }
      };
    });

    if (bulkOps.length > 0) {
      await DailySession.bulkWrite(bulkOps);
    }

    await DailySession.updateMany(
      { date, status: 'CANCELLED' },
      { $set: { isLocked: true } }
    );

    const sessions = await DailySession.find({ date }).lean();
    res.json(sessions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
  const sessions = await DailySession.find({ date }).lean();
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
      $sort: { '_id.date': 1 }
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