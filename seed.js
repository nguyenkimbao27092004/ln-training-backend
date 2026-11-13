// Tệp: backend/seed.js
require('dotenv').config();
const mongoose = require('mongoose');
const { Trainer, Client } = require('./models');

const MONGO_URI = process.env.MONGO_URI;
// Danh sách PT từ bảng lịch ngày và file Word
const trainerNames = [
  'Anh Nguyễn', 'Chị Hương', 'Anh Bảo', 'Anh Biên', 
  'Anh Đạt', 'Anh Tú', 'Tuấn Anh', 'Chị Hương (thứ 2)'
];

// Nội dung copy trực tiếp từ file Word của bạn
const rawWordData = [
  {
    trainer: 'Anh Nguyễn',
    clients: [
      'nhi 1993: t3-4-6( báo sau )',
      'a Cường: t3-5-7 (5h)',
      'Khánh trinh: 3-5-7(5h)',
      'nhóm 3 ban :t3-5-6(6h)',
      'A (phúc):t2-3-5-6(6h)off 1 tuần',
      'a dự new: t4(16h) | t5-6-7(7h)',
      'Quyên nguyễn :3-5-7(9h)',
      'c Ny phạm :full tuần (7h15)',
      'C Tú: t2-3-5-6 (9h) | t4 (8h30)',
      'C chả lụi: full tuần a nguyên dạy 3-5',
      'Mẹ của nhi mập:t3-4-5-6 (8h)',
      'c oanh online :3(9h)',
      'a hiệp new:t2-4-5-(15h)',
      'Hammy nguyên : t5:9h',
      'a thành:t3-4-6(14h)',
      'Nhy xkld:t3-4-5-6(15h)',
      'Nga new:t6-7 (16h)',
      'quỳnh giang: t2 (17h) | t4-5 (16h)',
      'Liễu nguyễn :t3-4(17h) | t7 (16h)',
      'c duyên ngân hàng :t3-5-7(19h)',
      'c Minh Anh: t3-4-5(18h45)',
      'c Thuý vy: t2-4-6 (9h)',
      'Ngân mập :t3-t5(18h)-t7(7h)',
      'a tín (new): t2-4-6(19h)',
      'Uyên lê: t4-7(17h)',
      'Toàn pccc:t2.17h',
      'c Kiều oanh new :t5-7 (8h30)',
      'c Linh phương: t2-3-4-5-6-7 (9h30) (báo từng ngày )',
      'c My sa : t3-5-6 (h)',
      'A Tư :t3-5-6-7 (15h)',
      'A tiến đạt : t4-6 (18h)',
      'A Phúc new: t2-3-5-7 (16h) TA',
      'Thuy ngọc new: t3-6 (15h)',
      'c Thảo Nguyên: t2-4-6 (7h30)',
      'c Thảo Phương: t2-3-6 (18h)'
    ]
  },
  {
    trainer: 'Chị Hương',
    clients: [
      'hoa nguyễn: t3-4-5-6 (18h)',
      'c Hương Phạm: t3-4-6(9h)',
      'c Hải Nguyễn: t3-5-6(7h15)',
      'c Oanh: t4(10h)',
      'c Hoài Linh: t2-3 (18h) | t7 (17h)',
      'c Giang linh: t2-4(18h) | t3-5(19h)',
      'c thanh huynh: t2-4-6(19h)'
    ]
  },
  {
    trainer: 'Anh Bảo',
    clients: [
      'c Trinh Vy: t2-4-6 (8h)',
      'c Tường Vy: t5-6 (18h)'
    ]
  },
  {
    trainer: 'Anh Biên',
    clients: [
      'linh chi:3-4-5-6(5h)',
      'c Nhi mập:full(9h)',
      'c Kim Anh:t2-(10h) | t4 (10h) | t5:(13h30)',
      'c Ngọc 1997: t5-6-7 (16h)'
    ]
  }
];

// Hàm bóc tách chuỗi lịch tập thành mảng weeklySchedule
function parseSchedule(scheduleStr, primaryTrainerId, tuanAnhId) {
  const result = [];
  const isFlexible = /báo sau|báo từng ngày|\(h\)/i.test(scheduleStr);
  const assignedTrainer = /TA\b/.test(scheduleStr) ? tuanAnhId : primaryTrainerId;

  const segments = scheduleStr.split('|');
  segments.forEach(seg => {
    const timeMatch = seg.match(/\(([\dh:]+)\)/i) || seg.match(/[:.](\d{1,2}h\d*)/i);
    const time = timeMatch ? timeMatch[1] : '';

    if (/full/i.test(seg)) {
      for (let d = 2; d <= 7; d++) {
        result.push({ dayOfWeek: d, time, assignedTrainerId: assignedTrainer, isFlexible });
      }
      return;
    }

    const dayPart = seg.split('(')[0];
    const days = dayPart.match(/[2-8]/g);
    if (days) {
      days.forEach(d => {
        result.push({
          dayOfWeek: Number(d),
          time,
          assignedTrainerId: assignedTrainer,
          isFlexible
        });
      });
    }
  });
  return result;
}

async function seedDatabase() {
  await mongoose.connect(MONGO_URI);
  await Trainer.deleteMany({});
  await Client.deleteMany({});

  const trainerMap = {};
  for (const name of trainerNames) {
    const t = await Trainer.create({ name });
    trainerMap[name] = t._id;
  }

  for (const group of rawWordData) {
    const trainerId = trainerMap[group.trainer];
    for (const line of group.clients) {
      const [rawName, ...rest] = line.split(':');
      const scheduleStr = rest.join(':');
      const isPaused = /off 1 tuần/i.test(scheduleStr);
      const isGroup3 = /nhóm 3/i.test(rawName);

      await Client.create({
        name: rawName.trim(),
        primaryTrainerId: trainerId,
        status: isPaused ? 'PAUSED' : 'ACTIVE',
        packageNote: isGroup3 ? 'Up lên gói 120b ngày 15/9, đóng thêm mỗi người 6tr' : '',
        weeklySchedule: parseSchedule(scheduleStr, trainerId, trainerMap['Tuấn Anh'])
      });
    }
  }

  console.log('Đã chuyển toàn bộ dữ liệu từ file Word vào MongoDB thành công!');
  process.exit();
}

seedDatabase();