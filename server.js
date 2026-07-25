const express = require('express');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const fsSync = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
const DEFAULT_PORT = 3000;
const PORT = Number(process.env.PORT) || DEFAULT_PORT;

// ==========================================
// 1. KẾT NỐI GOOGLE CLOUD FIRESTORE
// ==========================================
let serviceAccount;
const renderSecretPath = '/etc/secrets/serviceAccountKey.json';
const localSecretPath = path.join(__dirname, 'serviceAccountKey.json');

try {
  if (fsSync.existsSync(renderSecretPath)) {
    serviceAccount = JSON.parse(fsSync.readFileSync(renderSecretPath, 'utf8'));
    console.log('🔑 Đã tải Service Account Key từ Render Secret File');
  } else if (fsSync.existsSync(localSecretPath)) {
    serviceAccount = JSON.parse(fsSync.readFileSync(localSecretPath, 'utf8'));
    console.log('🔑 Đã tải Service Account Key từ Local File');
  } else {
    console.error('❌ KHÔNG TÌM THẤY FILE serviceAccountKey.json!');
  }
} catch (e) {
  console.error('❌ Lỗi đọc file JSON Key:', e.message);
}

if (serviceAccount) {
  initializeApp({
    credential: cert(serviceAccount)
  });
}

const db = getFirestore();
db.settings({ preferRest: true });
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

// Helper đọc tên người dùng an toàn từ Header (Decode Unicode tiếng Việt)
const getActorName = (req, defaultName = 'Thành viên') => {
  const rawName = req.headers['x-user-name'];
  if (!rawName) return defaultName;
  try {
    return decodeURIComponent(rawName);
  } catch (e) {
    return rawName;
  }
};

// Helper ghi Log Thao Tác
const createLog = async (userName, action, details) => {
  try {
    const logDoc = {
      id: Date.now(),
      userName: userName || 'Hệ thống',
      action,
      details,
      timestamp: new Date().toISOString()
    };
    await db.collection('logs').doc(String(logDoc.id)).set(logDoc);
  } catch (err) {
    console.error('Lỗi lưu log:', err.message);
  }
};

// Middleware kiểm tra quyền ADMIN
const requireAdmin = (req, res, next) => {
  const userRole = req.headers['x-user-role'];
  if (userRole !== 'ADMIN') {
    return res.status(403).json({ message: 'Quyền truy cập bị từ chối. Yêu cầu tài khoản ADMIN!' });
  }
  next();
};

// ==========================================
// 2. MIGRATION DATA TỰ ĐỘNG TỪ JSON LÊN GOOGLE
// ==========================================
const migrateJsonToFirestore = async () => {
  try {
    const loansFile = path.join(__dirname, 'data', 'loans.json');
    const usersFile = path.join(__dirname, 'data', 'users.json');
    const paymentsFile = path.join(__dirname, 'data', 'payments.json');

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
// 3. API USER, SYSTEM & LOGS
// ==========================================
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  try {
    const snapshot = await db.collection('users').where('username', '==', username).where('password', '==', password).get();
    if (snapshot.empty) {
      return res.status(401).json({ message: 'Tên đăng nhập hoặc mật khẩu không đúng.' });
    }
    const user = snapshot.docs[0].data();

    await createLog(user.name, 'Đăng nhập', `Đã đăng nhập vào hệ thống`);

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

// GET /api/users
app.get('/api/users', async (req, res) => {
  try {
    const userRole = req.headers['x-user-role'];
    const snapshot = await db.collection('users').get();
    
    const users = snapshot.docs.map(doc => {
      const userData = doc.data();
      if (userRole !== 'ADMIN') {
        const { password, ...safeUser } = userData;
        return safeUser;
      }
      return userData;
    });

    res.json(users);
  } catch (err) {
    res.status(500).json({ message: 'Không thể đọc danh sách thành viên' });
  }
});

app.post('/api/users', requireAdmin, async (req, res) => {
  try {
    const { name, username, password, role } = req.body;
    const actorName = getActorName(req, 'Admin');

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
    await createLog(actorName, 'Tạo người dùng', `Đã tạo tài khoản mới: ${name} (${role})`);
    
    const allUsersSnap = await db.collection('users').get();
    res.status(201).json(allUsersSnap.docs.map(doc => doc.data()));
  } catch (err) {
    res.status(500).json({ message: 'Lỗi tạo thành viên' });
  }
});

app.delete('/api/users/:id', requireAdmin, async (req, res) => {
  try {
    const userId = String(req.params.id);
    const actorName = getActorName(req, 'Admin');

    const userDoc = await db.collection('users').doc(userId).get();
    const deletedName = userDoc.exists ? userDoc.data().name : userId;

    await db.collection('users').doc(userId).delete();
    await createLog(actorName, 'Xóa người dùng', `Đã xóa tài khoản ID ${userId} (${deletedName})`);

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
    const actorName = getActorName(req, 'Admin');

    await db.collection('users').doc(userId).update({ permissions });
    await createLog(actorName, 'Chỉnh quyền', `Đã cập nhật quyền cho User ID ${userId}`);

    res.json({ message: 'Cập nhật phân quyền thành công' });
  } catch (err) {
    res.status(500).json({ message: 'Lỗi cập nhật quyền' });
  }
});

app.put('/api/users/:id/password', requireAdmin, async (req, res) => {
  try {
    const userId = String(req.params.id);
    const { password } = req.body;
    const actorName = getActorName(req, 'Admin');

    if (!password) {
      return res.status(400).json({ message: 'Mật khẩu mới không được để trống' });
    }

    const userRef = db.collection('users').doc(userId);
    const docSnap = await userRef.get();

    if (!docSnap.exists) {
      return res.status(404).json({ message: 'Không tìm thấy tài khoản' });
    }

    await userRef.update({ password });
    await createLog(actorName, 'Đổi mật khẩu', `Đã đổi mật khẩu cho tài khoản "${docSnap.data().name}"`);

    res.json({ message: 'Đổi mật khẩu thành công' });
  } catch (err) {
    res.status(500).json({ message: 'Lỗi khi cập nhật mật khẩu', error: err.message });
  }
});

app.put('/api/users/:id/role', requireAdmin, async (req, res) => {
  try {
    const userId = String(req.params.id);
    const { role } = req.body;
    const actorName = getActorName(req, 'Admin');

    if (!['ADMIN', 'MEMBER', 'VIEWER'].includes(role)) {
      return res.status(400).json({ message: 'Vai trò không hợp lệ' });
    }

    const userRef = db.collection('users').doc(userId);
    const docSnap = await userRef.get();

    if (!docSnap.exists) {
      return res.status(404).json({ message: 'Không tìm thấy tài khoản' });
    }

    const oldRole = docSnap.data().role;
    await userRef.update({ role });
    await createLog(actorName, 'Đổi Role', `Đã đổi vai trò của "${docSnap.data().name}" từ ${oldRole} -> ${role}`);

    res.json({ message: 'Cập nhật vai trò thành công' });
  } catch (err) {
    res.status(500).json({ message: 'Lỗi khi cập nhật vai trò', error: err.message });
  }
});

// GET /api/logs: Lấy danh sách Log
app.get('/api/logs', async (req, res) => {
  try {
    const userRole = req.headers['x-user-role'];
    const snapshot = await db.collection('logs').get();
    let logs = [];
    
    snapshot.forEach(doc => logs.push(doc.data()));
    logs.sort((a, b) => b.id - a.id);

    if (userRole !== 'ADMIN') {
      const allowedActions = ['Đổi trạng thái Lãi', 'Đổi trạng thái Gốc', 'Đăng nhập'];
      logs = logs.filter(log => allowedActions.includes(log.action));
    }

    res.json(logs.slice(0, 100));
  } catch (err) {
    res.status(500).json({ message: 'Lỗi tải nhật ký log' });
  }
});

// DELETE /api/logs: Admin xóa sạch toàn bộ log
app.delete('/api/logs', requireAdmin, async (req, res) => {
  try {
    const actorName = getActorName(req, 'Admin');
    const snapshot = await db.collection('logs').get();

    if (snapshot.empty) {
      return res.json({ message: 'Không có log nào để xóa' });
    }

    const batch = db.batch();
    snapshot.docs.forEach(doc => {
      batch.delete(doc.ref);
    });
    await batch.commit();

    await createLog(actorName, 'Xóa Nhật Ký', 'Đã xóa toàn bộ nhật ký lịch sử thao tác');

    res.json({ message: 'Đã xóa toàn bộ nhật ký log thành công' });
  } catch (err) {
    res.status(500).json({ message: 'Lỗi khi xóa log', error: err.message });
  }
});

// DELETE /api/logs/:id: Admin xóa 1 dòng log lẻ
app.delete('/api/logs/:id', requireAdmin, async (req, res) => {
  try {
    const logId = String(req.params.id);
    const logRef = db.collection('logs').doc(logId);
    const docSnap = await logRef.get();

    if (!docSnap.exists) {
      return res.status(404).json({ message: 'Không tìm thấy dòng log này' });
    }

    await logRef.delete();
    res.json({ message: 'Đã xóa dòng log thành công' });
  } catch (err) {
    res.status(500).json({ message: 'Lỗi khi xóa log', error: err.message });
  }
});

// ==========================================
// 4. API LOANS
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

app.post('/api/loans', requireAdmin, async (req, res) => {
  try {
    const { monthKey, ...loanData } = req.body;
    const targetMonth = monthKey || '2026-07';
    const actorName = getActorName(req, 'Admin');

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

    await createLog(actorName, 'Thêm khoản vay', `Đã thêm khoản vay "${newLoan.bank}" (${targetMonth})`);

    const updatedLoans = await getAllLoansObject();
    res.status(201).json(updatedLoans);
  } catch (error) {
    res.status(500).json({ message: 'Không thể thêm khoản vay', error: error.message });
  }
});

app.put('/api/loans/:id', requireAdmin, async (req, res) => {
  try {
    const loanId = String(req.params.id);
    const { monthKey, ...payload } = req.body;
    const actorName = getActorName(req, 'Admin');

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
      await createLog(actorName, 'Sửa khoản vay', `Đã cập nhật khoản vay "${payload.bank}" (${targetMonth})`);

      const updatedLoans = await getAllLoansObject();
      return res.json(updatedLoans);
    }

    return res.status(404).json({ message: 'Không tìm thấy khoản vay để sửa' });
  } catch (error) {
    res.status(500).json({ message: 'Không thể cập nhật khoản vay', error: error.message });
  }
});

app.delete('/api/loans/:id', requireAdmin, async (req, res) => {
  try {
    const loanId = String(req.params.id);
    let monthKey = req.query.monthKey;
    const actorName = getActorName(req, 'Admin');

    let loansObj = await getAllLoansObject();

    if (!monthKey || !loansObj[monthKey]) {
      monthKey = Object.keys(loansObj).find(m => loansObj[m].some(l => String(l.id) === loanId));
    }

    if (monthKey && loansObj[monthKey]) {
      const deletedLoan = loansObj[monthKey].find(loan => String(loan.id) === loanId);
      const updatedList = loansObj[monthKey].filter(loan => String(loan.id) !== loanId);
      await db.collection('loans').doc(monthKey).set({ list: updatedList });
      
      await createLog(actorName, 'Xóa khoản vay', `Đã xóa khoản vay "${deletedLoan ? deletedLoan.bank : loanId}" khỏi Tháng ${monthKey}`);
    }

    const updatedLoans = await getAllLoansObject();
    res.json(updatedLoans);
  } catch (error) {
    res.status(500).json({ message: 'Không thể xóa khoản vay', error: error.message });
  }
});

app.post('/api/loans/create-next-month', requireAdmin, async (req, res) => {
  try {
    const { currentMonth, newMonth } = req.body;
    const actorName = getActorName(req, 'Admin');
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
    await createLog(actorName, 'Tạo Sheet Tháng', `Đã tạo Sheet tháng mới: ${newMonth} từ ${currentMonth}`);

    const updatedLoans = await getAllLoansObject();
    res.json({ message: `Khởi tạo ${newMonth} thành công`, loans: updatedLoans });
  } catch (error) {
    res.status(500).json({ message: 'Lỗi tạo tháng mới', error: error.message });
  }
});

app.delete('/api/loans/delete-month-sheet/:monthKey', requireAdmin, async (req, res) => {
  try {
    const { monthKey } = req.params;
    const adminPassword = req.headers['x-admin-password'] || req.body.adminPassword;
    const actorName = getActorName(req, 'Admin');

    if (!adminPassword) {
      return res.status(400).json({ message: 'Yêu cầu nhập mật khẩu Admin để xác nhận!' });
    }

    const adminCheck = await db.collection('users')
      .where('role', '==', 'ADMIN')
      .where('password', '==', adminPassword)
      .get();

    if (adminCheck.empty) {
      return res.status(401).json({ message: 'Mật khẩu Admin không chính xác!' });
    }

    await db.collection('loans').doc(monthKey).delete();
    await createLog(actorName, 'Xóa Sheet Tháng', `Đã xóa vĩnh viễn Sheet Tháng ${monthKey}`);

    const updatedLoans = await getAllLoansObject();
    res.json({ message: `Đã xóa Sheet Tháng ${monthKey}`, loans: updatedLoans });
  } catch (error) {
    res.status(500).json({ message: 'Không thể xóa Sheet Tháng', error: error.message });
  }
});

app.post('/api/loans/:id/status-toggle', upload.single('billImage'), async (req, res) => {
  try {
    const userRole = req.headers['x-user-role'];
    const actorName = getActorName(req, 'Thành viên');

    if (userRole === 'VIEWER') {
      return res.status(403).json({ message: 'Tài khoản VIEWER chỉ có quyền xem, không thể thay đổi trạng thái!' });
    }

    const loanId = String(req.params.id);
    const { monthKey, field, value, bankName } = req.body;

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

    const isTrue = value === 'true';

    if (field === 'isInterestReceived') {
      current.isInterestReceived = isTrue;
      const statusText = isTrue ? 'ĐÃ NHẬN LÃI' : 'CHƯA NHẬN LÃI';
      await createLog(actorName, 'Đổi trạng thái Lãi', `Đánh dấu "${bankName || loanId}" là [${statusText}] (Tháng ${monthKey})`);
    }

    if (field === 'isMonthlyPaid') {
      current.isMonthlyPaid = isTrue;
      const statusText = isTrue ? 'ĐÃ TRẢ GỐC' : 'CHƯA TRẢ GỐC';
      await createLog(actorName, 'Đổi trạng thái Gốc', `Đánh dấu "${bankName || loanId}" là [${statusText}] (Tháng ${monthKey})`);
    }

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

const startServer = async (port) => {
  await migrateJsonToFirestore();

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