// Tệp: backend/models.js
const mongoose = require('mongoose');

// 1. Bảng PT (Huấn luyện viên)
const TrainerSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  isOffToday: { type: Boolean, default: false } // Đánh dấu PT nghỉ phép (OFF)
});

// 2. Bảng Khách hàng & Lịch cố định theo tuần (Chuyển từ file Word)
const ClientSchema = new mongoose.Schema({
  name: { type: String, required: true },
  primaryTrainerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Trainer' },
  status: { type: String, enum: ['ACTIVE', 'PAUSED'], default: 'ACTIVE' }, // PAUSED cho khách off 1 tuần
  packageNote: { type: String, default: '' }, // Lưu ghi chú gói tập (VD: gói 120b)
  weeklySchedule: [{
    dayOfWeek: { type: Number, required: true }, // 2 = Thứ 2 ... 7 = Thứ 7, 8 = CN
    time: { type: String, default: '' },         // Giờ tập: "15h", "8h30"...
    assignedTrainerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Trainer' }, // PT dạy thay cố định nếu có
    isFlexible: { type: Boolean, default: false } // Khách báo từng ngày / báo sau
  }]
}, { timestamps: true });

// 3. Bảng Lịch xếp mỗi ngày & Chốt ca
const DailySessionSchema = new mongoose.Schema({
  date: { type: String, required: true, index: true }, // Định dạng "YYYY-MM-DD"
  dayOfWeek: { type: Number, required: true },
  trainerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Trainer', required: true },
  clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Client' },
  clientName: { type: String, required: true },
  time: { type: String, default: '' },
  // SCHEDULED: Đang xếp lịch, COMPLETED: Đã chốt ca, CANCELLED: Gạch ngang hủy ca
  status: { type: String, enum: ['SCHEDULED', 'COMPLETED', 'CANCELLED'], default: 'SCHEDULED' },
  isLocked: { type: Boolean, default: false } // Khóa sổ cuối ngày
}, { timestamps: true });

module.exports = {
  Trainer: mongoose.model('Trainer', TrainerSchema),
  Client: mongoose.model('Client', ClientSchema),
  DailySession: mongoose.model('DailySession', DailySessionSchema)
};