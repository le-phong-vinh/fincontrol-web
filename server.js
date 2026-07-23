const express = require('express');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const fsSync = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
const DEFAULT_PORT = 3000;
const PORT = Number(process.env.PORT) || DEFAULT_PORT;

// 1. KẾT NỐI GOOGLE CLOUD FIRESTORE
const SERVICE_ACCOUNT_PATH = path.join(__dirname, 'serviceAccountKey.json');

if (!fsSync.existsSync(SERVICE_ACCOUNT_PATH)) {
  console.error('❌ KHÔNG TÌM THẤY FILE serviceAccountKey.json!');
  process.exit(1);
}

const serviceAccount = require(SERVICE_ACCOUNT_PATH);

// Khởi tạo Firebase Admin đúng cú pháp v12+
initializeApp({
  credential: cert(serviceAccount)
});

const db = getFirestore();
console.log('✅ Đã kết nối thành công tới Google Cloud Firestore!');

// Thư mục uploads ảnh Bill
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
if (!fsSync.existsSync(UPLOADS_DIR)) fsSync.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, `bill_${Date.now()}${path.extname(file.originalname)}`)
});
const upload = multer({ storage });

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const requireAdmin = (req, res, next) => {
  next(); // Bypass phân quyền để thao tác mượt mà
};

// ==========================================
// 2. MIGRATION DATA TỰ ĐỘNG TỪ JSON LÊN GOOGLE
// ==========================================
const migrateJsonToFirestore = async () => {
  try {
    const loansFile = path.join(__dirname, 'data', 'loans.json');
    const usersFile = path.join(__dirname, 'data', 'users.json');
    const paymentsFile = path.join(__dirname, 'data', 'payments.json');

    // Kiểm tra xem trên Google Firestore đã có data chưa
    const loansCheck = await db.collection('loans').limit(1).get();
    if (loansCheck.empty && fsSync.existsSync(loansFile)) {
      console.log('🔄 Đang đồng bộ dữ liệu ban đầu từ loans.json lên Google Cloud...');
      const loansData = JSON.parse(fsSync.readFileSync(loansFile, 'utf8'));
      for (const [monthKey, loansList] of Object.entries(loansData)) {
        await db.collection('loans').doc(monthKey).set({ list: loansList });
      }
      console.log('✅ Đồng bộ loans.json lên Google thành công!');
    }

    const usersCheck = await db.collection('users').limit(1).get();
    if (usersCheck.empty && fsSync.existsSync(usersFile)) {
      console.log('🔄 Đang đồng bộ danh sách Users lên Google Cloud...');
      const usersData = JSON.parse(fsSync.readFileSync(usersFile, 'utf8'));
      for (const user of usersData) {
        await db.collection('users').doc(String(user.id)).set(user);
      }
      console.log('✅ Đồng bộ users.json lên Google thành công!');
    }

    const paymentsCheck = await db.collection('payments').limit(1).get();
    if (paymentsCheck.empty && fsSync.existsSync(paymentsFile)) {
      console.log('🔄 Đang đồng bộ Payments lên Google Cloud...');
      const paymentsData = JSON.parse(fsSync.readFileSync(paymentsFile, 'utf8'));
      for (const [pKey, pVal] of Object.entries(paymentsData)) {
        await db.collection('payments').doc(pKey).set(pVal);
      }
      console.log('✅ Đồng bộ payments.json lên Google thành công!');
    }
  } catch (err) {
    console.error('⚠️ Lỗi khi Migrate dữ liệu:', err.message);
  }
};

// ==========================================
// 3. API USER & SYSTEM
// ==========================================
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  try {
    const snapshot = await db.collection('users').where('username', '==', username).where('password', '==', password).get();
    if (snapshot.empty) {
      return res.status(401).json({ message: 'Tên đăng nhập hoặc mật khẩu không đúng.' });
    }
    const user = snapshot.docs[0].data();
    return res.json({
      id: user.id,
      username: user.username,
      name: user.name,
      role: user.role,
      permissions: user.permissions || { seeAllLoans: false, showRealInterest: false },
      initials: user.name.slice(0, 2).toUpperCase()
    });
  } catch (err) {
    res.status(500).json({ message: 'Lỗi hệ thống đăng nhập Google Cloud' });
  }
});

app.get('/api/users', async (req, res) => {
  try {
    const snapshot = await db.collection('users').get();
    const users = snapshot.docs.map(doc => doc.data());
    res.json(users);
  } catch (err) {
    res.status(500).json({ message: 'Không thể đọc danh sách thành viên' });
  }
});

app.post('/api/users', requireAdmin, async (req, res) => {
  try {
    const { name, username, password, role } = req.body;
    if (!name || !username || !password) return res.status(400).json({ message: 'Thiếu thông tin' });

    const checkSnap = await db.collection('users').where('username', '==', username).get();
    if (!checkSnap.empty) return res.status(400).json({ message: 'Tên đăng nhập đã tồn tại' });

    const newUser = {
      id: Date.now(),
      name,
      username,
      password,
      role: role || 'MEMBER',
      permissions: { seeAllLoans: false, showRealInterest: false }
    };

    await db.collection('users').doc(String(newUser.id)).set(newUser);
    const allUsersSnap = await db.collection('users').get();
    res.status(201).json(allUsersSnap.docs.map(doc => doc.data()));
  } catch (err) {
    res.status(500).json({ message: 'Lỗi tạo thành viên' });
  }
});

app.delete('/api/users/:id', requireAdmin, async (req, res) => {
  try {
    const userId = String(req.params.id);
    await db.collection('users').doc(userId).delete();
    const allUsersSnap = await db.collection('users').get();
    res.json(allUsersSnap.docs.map(doc => doc.data()));
  } catch (err) {
    res.status(500).json({ message: 'Lỗi khi xóa tài khoản' });
  }
});

app.put('/api/users/:id/permissions', requireAdmin, async (req, res) => {
  try {
    const userId = String(req.params.id);
    const { permissions } = req.body;
    await db.collection('users').doc(userId).update({ permissions });
    res.json({ message: 'Cập nhật phân quyền thành công' });
  } catch (err) {
    res.status(500).json({ message: 'Lỗi cập nhật quyền' });
  }
});

// ==========================================
// 4. API LOANS (KHOẢN VAY GOOGLE CLOUD FIRESTORE)
// ==========================================
const getAllLoansObject = async () => {
  const snapshot = await db.collection('loans').get();
  let loansObj = {};
  snapshot.forEach(doc => {
    loansObj[doc.id] = doc.data().list || [];
  });
  return loansObj;
};

app.get('/api/loans', async (req, res) => {
  try {
    const loansObj = await getAllLoansObject();

    const paymentsSnap = await db.collection('payments').get();
    let paymentsObj = {};
    paymentsSnap.forEach(doc => {
      paymentsObj[doc.id] = doc.data();
    });

    const userRole = req.headers['x-user-role'];
    const showRealInterest = req.headers['x-show-real-interest'] === 'true';

    const responseLoans = JSON.parse(JSON.stringify(loansObj));

    if (userRole !== 'ADMIN' && !showRealInterest) {
      Object.keys(responseLoans).forEach(m => {
        responseLoans[m] = responseLoans[m].map(loan => ({
          ...loan,
          monthlyInterest: loan.memberInterest !== undefined ? loan.memberInterest : 0,
          netMonthly: (loan.monthlyPayment || 0) + (loan.memberInterest !== undefined ? loan.memberInterest : 0)
        }));
      });
    }

    res.json({ loans: responseLoans, payments: paymentsObj });
  } catch (error) {
    res.status(500).json({ message: 'Không thể đọc dữ liệu', error: error.message });
  }
});

// THÊM KHOẢN VAY
app.post('/api/loans', requireAdmin, async (req, res) => {
  try {
    const { monthKey, ...loanData } = req.body;
    const targetMonth = monthKey || '2026-07';

    const docRef = db.collection('loans').doc(targetMonth);
    const docSnap = await docRef.get();
    let currentList = docSnap.exists ? (docSnap.data().list || []) : [];

    const newLoan = {
      ...loanData,
      id: Date.now(),
      netMonthly: Number(loanData.netMonthly ?? ((Number(loanData.monthlyPayment) || 0) + (Number(loanData.monthlyInterest) || 0)))
    };

    currentList.unshift(newLoan);
    await docRef.set({ list: currentList });

    console.log(`☁️ [GOOGLE CLOUD]: Đã thêm khoản vay "${newLoan.bank}" vào Tháng ${targetMonth}`);
    const updatedLoans = await getAllLoansObject();
    res.status(201).json(updatedLoans);
  } catch (error) {
    res.status(500).json({ message: 'Không thể thêm khoản vay', error: error.message });
  }
});

// SỬA KHOẢN VAY
app.put('/api/loans/:id', requireAdmin, async (req, res) => {
  try {
    const loanId = String(req.params.id);
    const { monthKey, ...payload } = req.body;

    let loansObj = await getAllLoansObject();
    let targetMonth = monthKey;

    if (!targetMonth || !loansObj[targetMonth]) {
      targetMonth = Object.keys(loansObj).find(m => loansObj[m].some(l => String(l.id) === loanId));
    }

    if (targetMonth && loansObj[targetMonth]) {
      const updatedList = loansObj[targetMonth].map(loan => {
        if (String(loan.id) === loanId) {
          return {
            ...loan,
            ...payload,
            id: Number(loanId),
            netMonthly: Number(payload.netMonthly ?? ((Number(payload.monthlyPayment) || 0) + (Number(payload.monthlyInterest) || 0)))
          };
        }
        return loan;
      });

      await db.collection('loans').doc(targetMonth).set({ list: updatedList });
      console.log(`☁️ [GOOGLE CLOUD]: Đã cập nhật ID "${loanId}" trong Tháng ${targetMonth}`);

      const updatedLoans = await getAllLoansObject();
      return res.json(updatedLoans);
    }

    return res.status(404).json({ message: 'Không tìm thấy khoản vay để sửa' });
  } catch (error) {
    res.status(500).json({ message: 'Không thể cập nhật khoản vay', error: error.message });
  }
});

// XÓA KHOẢN VAY
app.delete('/api/loans/:id', requireAdmin, async (req, res) => {
  try {
    const loanId = String(req.params.id);
    let monthKey = req.query.monthKey;

    let loansObj = await getAllLoansObject();

    if (!monthKey || !loansObj[monthKey]) {
      monthKey = Object.keys(loansObj).find(m => loansObj[m].some(l => String(l.id) === loanId));
    }

    if (monthKey && loansObj[monthKey]) {
      const updatedList = loansObj[monthKey].filter(loan => String(loan.id) !== loanId);
      await db.collection('loans').doc(monthKey).set({ list: updatedList });
      console.log(`☁️ [GOOGLE CLOUD]: Đã xóa ID "${loanId}" khỏi Tháng ${monthKey}`);
    }

    const updatedLoans = await getAllLoansObject();
    res.json(updatedLoans);
  } catch (error) {
    res.status(500).json({ message: 'Không thể xóa khoản vay', error: error.message });
  }
});

// TẠO THÁNG MỚI
app.post('/api/loans/create-next-month', requireAdmin, async (req, res) => {
  try {
    const { currentMonth, newMonth } = req.body;
    const docSnap = await db.collection('loans').doc(currentMonth).get();

    if (!docSnap.exists) {
      return res.status(400).json({ message: 'Tháng nguồn không có dữ liệu' });
    }

    const currentList = docSnap.data().list || [];
    const newList = currentList.map((loan, idx) => ({
      ...loan,
      id: Date.now() + idx
    }));

    await db.collection('loans').doc(newMonth).set({ list: newList });
    const updatedLoans = await getAllLoansObject();
    res.json({ message: `Khởi tạo ${newMonth} thành công`, loans: updatedLoans });
  } catch (error) {
    res.status(500).json({ message: 'Lỗi tạo tháng mới', error: error.message });
  }
});

// XÓA SHEET THÁNG
app.delete('/api/loans/delete-month-sheet/:monthKey', requireAdmin, async (req, res) => {
  try {
    const { monthKey } = req.params;
    await db.collection('loans').doc(monthKey).delete();

    const updatedLoans = await getAllLoansObject();
    res.json({ message: `Đã xóa Sheet Tháng ${monthKey}`, loans: updatedLoans });
  } catch (error) {
    res.status(500).json({ message: 'Không thể xóa Sheet Tháng', error: error.message });
  }
});

// CẬP NHẬT TRẠNG THÁI / BILL
app.post('/api/loans/:id/status-toggle', upload.single('billImage'), async (req, res) => {
  try {
    const loanId = String(req.params.id);
    const { monthKey, field, value, note } = req.body;

    const pKey = `${monthKey}_${loanId}`;
    const pRef = db.collection('payments').doc(pKey);
    const pSnap = await pRef.get();

    const current = pSnap.exists ? pSnap.data() : {
      loanId: Number(loanId),
      monthKey,
      isInterestReceived: false,
      isMonthlyPaid: false,
      paymentNote: '',
      billImage: null
    };

    if (field === 'isInterestReceived') current.isInterestReceived = value === 'true';
    if (field === 'isMonthlyPaid') current.isMonthlyPaid = value === 'true';
    if (note !== undefined) current.paymentNote = note;
    if (req.file) current.billImage = `/uploads/${req.file.filename}`;

    await pRef.set(current);

    const paymentsSnap = await db.collection('payments').get();
    let paymentsObj = {};
    paymentsSnap.forEach(doc => {
      paymentsObj[doc.id] = doc.data();
    });

    res.json({ message: 'Cập nhật thành công', payments: paymentsObj });
  } catch (error) {
    res.status(500).json({ message: 'Lỗi cập nhật trạng thái', error: error.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// KÍCH HOẠT SERVER
const startServer = async (port) => {
  await migrateJsonToFirestore(); // Chạy đồng bộ dữ liệu nếu mới khởi tạo

  const server = app.listen(port, () => {
    console.log(`====================================================`);
    console.log(`🚀 SERVER FINCONTROL PRO ĐANG CHẠY TẠI: http://localhost:${port}`);
    console.log(`☁️ DỮ LIỆU ĐÃ ĐƯỢC LƯU TRỰC TIẾP TRÊN GOOGLE CLOUD FIRESTORE`);
    console.log(`====================================================`);
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      startServer(port + 1);
      return;
    }
    console.error(error);
    process.exit(1);
  });
};

startServer(PORT);