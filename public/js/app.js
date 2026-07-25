import { 
    formatCurrency, formatDate, formatMonthLabel, getDealCountdown, 
    checkDueDateNearOrOverdue, exportToExcel, exportToPDF 
} from './utils.js';

const { createApp, ref, computed, onMounted, watch } = Vue;

createApp({
    setup() {
        const loansData = ref({});
        const payments = ref({});
        const allUsers = ref([]);
        const memberList = ref([]);
        const currentRole = ref('ADMIN');
        const userPermissions = ref({ seeAllLoans: false, showRealInterest: false });
        const searchQuery = ref('');
        const filterAssignee = ref('ALL');
        const selectedMonth = ref('2026-07');
        
        // BIẾN QUẢN LÝ TAB TRANG CHÍNH (/HOME HOẶC /MEMBER)
        const currentTab = ref('home'); 
        
        const showAddModal = ref(false);
        const isEditing = ref(false);
        const sessionUser = ref(null);
        
        const loginForm = ref({ username: '', password: '' }); 
        const loginError = ref('');

        const newUserForm = ref({ name: '', username: '', password: '', role: 'MEMBER' });

        const formLoan = ref({
            id: Date.now(), bank: '', totalAmount: 0,
            withdrawDate: new Date().toISOString().split('T')[0],
            monthlyPayment: 0, monthlyInterest: 0, memberInterest: null,
            interestDays: '~ngày 5', dueDateRule: 'Trước ngày 5', tenure: '', assignee: 'Vinh', note: ''
        });

        // Computed Properties
        const monthList = computed(() => Object.keys(loansData.value).sort((a, b) => a.localeCompare(b)));
        const currentMonthLoans = computed(() => loansData.value[selectedMonth.value] || []);
        const isLoggedIn = computed(() => Boolean(sessionUser.value));
        const currentUserName = computed(() => sessionUser.value?.name || 'Chưa đăng nhập');
        const currentUserInitials = computed(() => sessionUser.value?.initials || '??');
        const currentRoleText = computed(() => currentRole.value === 'ADMIN' ? 'Super Admin' : 'Member');
        const canEdit = computed(() => currentRole.value === 'ADMIN');

        // Đồng bộ URL Hash (#home, #member)
        watch(currentTab, (newTab) => {
            window.location.hash = newTab;
        });

        const syncTabFromHash = () => {
            const hash = window.location.hash.replace('#', '');
            if (hash === 'member' || hash === 'home') {
                currentTab.value = hash;
            }
        };

        const getAuthHeaders = () => {
    // Đọc trực tiếp session từ localStorage để luôn chính xác role ADMIN
    let role = 'MEMBER';
    try {
        const saved = localStorage.getItem('fincontrol_session');
        if (saved) {
            const parsed = JSON.parse(saved);
            role = parsed.role || 'MEMBER';
        }
    } catch (e) {}

    return {
        'Content-Type': 'application/json',
        'X-User-Role': role,
        'X-Show-Real-Interest': String(userPermissions.value.showRealInterest)
    };
};

        const loadSession = () => {
            const saved = localStorage.getItem('fincontrol_session');
            if (!saved) return;
            try {
                const parsed = JSON.parse(saved);
                sessionUser.value = parsed;
                currentRole.value = parsed.role;
                userPermissions.value = parsed.permissions || { seeAllLoans: false, showRealInterest: false };
            } catch (error) {
                localStorage.removeItem('fincontrol_session');
            }
        };

        const saveSession = (user) => {
            localStorage.setItem('fincontrol_session', JSON.stringify(user));
            sessionUser.value = user;
            currentRole.value = user.role;
            userPermissions.value = user.permissions || { seeAllLoans: false, showRealInterest: false };
        };

        const login = async () => {
            loginError.value = '';
            try {
                const response = await fetch('/api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(loginForm.value)
                });
                const result = await response.json();
                if (!response.ok) throw new Error(result.message || 'Đăng nhập thất bại');
                saveSession(result);
                await loadUsers();
                await loadLoans();
            } catch (error) {
                loginError.value = error.message;
            }
        };

        const logout = () => {
            sessionUser.value = null;
            currentRole.value = 'MEMBER';
            loginForm.value = { username: '', password: '' };
            localStorage.removeItem('fincontrol_session');
            currentTab.value = 'home';
        };

        const loadUsers = async () => {
         try {
        const res = await fetch('/api/users', { headers: getAuthHeaders() });
        if (res.ok) {
            const users = await res.json();
            
            // Map danh sách mới nhưng giữ nguyên trạng thái showPassword cũ nếu user đã bấm xem trước đó
            allUsers.value = users.map(u => {
                const existingUser = memberList.value.find(m => m.id === u.id);
                return {
                    ...u,
                    showPassword: existingUser ? existingUser.showPassword : false
                };
            });
            
            memberList.value = allUsers.value;
        }
    } catch (err) {
        console.error('Lỗi tải danh sách thành viên:', err);
    }
};

        const createNewUser = async () => {
            try {
                const response = await fetch('/api/users', {
                    method: 'POST',
                    headers: getAuthHeaders(),
                    body: JSON.stringify(newUserForm.value)
                });
                const res = await response.json();
                if (!response.ok) throw new Error(res.message);
                alert('Khởi tạo tài khoản thành công!');
                newUserForm.value = { name: '', username: '', password: '', role: 'MEMBER' };
                await loadUsers();
            } catch (err) {
                alert(err.message);
            }
        };

        const deleteUser = async (user) => {
            if (sessionUser.value && sessionUser.value.id === user.id) {
                alert('Bạn không thể tự xóa tài khoản đang đăng nhập!');
                return;
            }
            if (!confirm(`XÁC NHẬN: Bạn có chắc chắn muốn XÓA TÀI KHOẢN "${user.name}" (${user.username})?`)) return;

            try {
                const response = await fetch(`/api/users/${user.id}`, { method: 'DELETE', headers: getAuthHeaders() });
                if (!response.ok) throw new Error('Không thể xóa tài khoản');
                alert('Xóa tài khoản thành công!');
                await loadUsers();
            } catch (err) {
                alert(err.message);
            }
        };

        const loadLoans = async () => {
            try {
                const response = await fetch('/api/loans', { headers: getAuthHeaders() });
                if (!response.ok) throw new Error('Không thể tải dữ liệu');
                const data = await response.json();
                loansData.value = data.loans || {};
                payments.value = data.payments || {};

                if (monthList.value.length > 0 && !monthList.value.includes(selectedMonth.value)) {
                    selectedMonth.value = monthList.value[0];
                }
            } catch (error) {
                alert(error.message);
            }
        };

        const updateUserPermissions = async (user) => {
            try {
                await fetch(`/api/users/${user.id}/permissions`, {
                    method: 'PUT',
                    headers: getAuthHeaders(),
                    body: JSON.stringify({ permissions: user.permissions })
                });
            } catch (err) {
                alert('Lỗi cập nhật quyền');
            }
        };

        const getPaymentStatus = (loanId) => {
            const key = `${selectedMonth.value}_${loanId}`;
            return payments.value[key] || { isInterestReceived: false, isMonthlyPaid: false };
        };

        const parseInterestDayNumber = (dayStr) => {
            if (!dayStr) return 999;
            const match = dayStr.match(/\d+/);
            return match ? parseInt(match[0], 10) : 999;
        };

        const filteredLoans = computed(() => {
            const list = currentMonthLoans.value.filter(item => {
                if (currentRole.value === 'MEMBER' && !userPermissions.value.seeAllLoans) {
                    const currentAssignee = (sessionUser.value?.name || '').trim().toLowerCase();
                    const itemAssignee = (item.assignee || '').trim().toLowerCase();
                    if (!currentAssignee || currentAssignee !== itemAssignee) return false;
                }

                if (searchQuery.value) {
                    const q = searchQuery.value.toLowerCase();
                    const matchBank = item.bank.toLowerCase().includes(q);
                    const matchNote = item.note ? item.note.toLowerCase().includes(q) : false;
                    if (!matchBank && !matchNote) return false;
                }

                if (filterAssignee.value !== 'ALL' && item.assignee !== filterAssignee.value) return false;
                return true;
            });

            return list.sort((a, b) => parseInterestDayNumber(a.interestDays) - parseInterestDayNumber(b.interestDays));
        });

        const totalPrincipal = computed(() => filteredLoans.value.reduce((acc, curr) => acc + (curr.totalAmount || 0), 0));
        const totalMonthlyNet = computed(() => filteredLoans.value.reduce((acc, curr) => acc + (curr.netMonthly || 0), 0));
        const totalMonthlyPayment = computed(() => filteredLoans.value.reduce((acc, curr) => acc + (curr.monthlyPayment || 0), 0));
        const totalMonthlyInterest = computed(() => filteredLoans.value.reduce((acc, curr) => acc + (curr.monthlyInterest || 0), 0));
        const paidMonthlyCount = computed(() => filteredLoans.value.filter(item => getPaymentStatus(item.id).isMonthlyPaid).length);
        const interestReceivedCount = computed(() => filteredLoans.value.filter(item => getPaymentStatus(item.id).isInterestReceived).length);

        const isDueDateNearOrOverdue = (dueDateRule, loanId) => checkDueDateNearOrOverdue(dueDateRule, loanId, getPaymentStatus, selectedMonth.value);

        const getDueDateClass = (rule, loanId) => {
            if (!rule) return 'bg-rose-500/10 text-rose-400 border-rose-500/30';
            return getPaymentStatus(loanId).isMonthlyPaid
                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                : 'bg-rose-500/10 text-rose-400 border-rose-500/30';
        };

        const getAssigneeBadgeClass = (name) => {
            switch (name) {
                case 'Vinh': return 'bg-indigo-500/10 text-indigo-400 border-indigo-500/30';
                case 'Khang': return 'bg-amber-500/10 text-amber-400 border-amber-500/30';
                case 'Linh': return 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30';
                default: return 'bg-slate-800 text-slate-300 border-slate-700';
            }
        };

        const getBankIndicatorColor = (note) => (note && (note.includes('LÃI MỚI') || note.includes('new'))) ? 'bg-rose-500 animate-pulse' : 'bg-indigo-500';

        const toggleStatus = async (item, field) => {
            const current = getPaymentStatus(item.id);
            const newValue = !current[field];
            const actionName = field === 'isMonthlyPaid' ? (newValue ? 'ĐÃ TRẢ' : 'CHƯA TRẢ') : (newValue ? 'ĐÃ NHẬN LÃI' : 'CHƯA NHẬN LÃI');

            if (!confirm(`XÁC NHẬN: Bạn có chắc chắn muốn đổi trạng thái của "${item.bank}" thành "${actionName}" trong Tháng ${selectedMonth.value}?`)) return;

            const formData = new FormData();
            formData.append('monthKey', selectedMonth.value);
            formData.append('field', field);
            formData.append('value', String(newValue));

            try {
                const response = await fetch(`/api/loans/${item.id}/status-toggle`, { method: 'POST', body: formData });
                if (!response.ok) throw new Error('Cập nhật thất bại');
                const data = await response.json();
                payments.value = data.payments;
            } catch (error) {
                alert(error.message);
            }
        };

        const createNewMonthSheet = async () => {
            const lastM = monthList.value[monthList.value.length - 1] || '2026-07';
            const [y, m] = lastM.split('-').map(Number);
            const nextD = new Date(y, m, 1);
            const nextKey = `${nextD.getFullYear()}-${String(nextD.getMonth() + 1).padStart(2, '0')}`;

            try {
                const response = await fetch('/api/loans/create-next-month', {
                    method: 'POST',
                    headers: getAuthHeaders(),
                    body: JSON.stringify({ currentMonth: lastM, newMonth: nextKey })
                });
                if (!response.ok) throw new Error('Không thể tạo tháng mới');
                const result = await response.json();
                loansData.value = result.loans;
                selectedMonth.value = nextKey;
            } catch (err) {
                alert(err.message);
            }
        };

        const deleteCurrentMonthSheet = async () => {
            if (!confirm(`CẢNH BÁO: Bạn có chắc chắn muốn XÓA TOÀN BỘ Sheet Tháng ${selectedMonth.value}?`)) return;

            try {
                const response = await fetch(`/api/loans/delete-month-sheet/${selectedMonth.value}`, { method: 'DELETE', headers: getAuthHeaders() });
                if (!response.ok) throw new Error('Không thể xóa Sheet tháng này');
                const result = await response.json();
                loansData.value = result.loans;
                if (monthList.value.length > 0) selectedMonth.value = monthList.value[0];
            } catch (err) {
                alert(err.message);
            }
        };

        const openAddLoanModal = () => {
            isEditing.value = false;
            formLoan.value = {
                id: Date.now(), bank: '', totalAmount: 0,
                withdrawDate: new Date().toISOString().split('T')[0],
                monthlyPayment: 0, monthlyInterest: 0, memberInterest: null,
                interestDays: '~ngày 5', dueDateRule: 'Trước ngày 5', tenure: '',
                assignee: allUsers.value.length > 0 ? allUsers.value[0].name : 'Vinh', note: ''
            };
            showAddModal.value = true;
        };

        const editLoan = (item) => {
            isEditing.value = true;
            formLoan.value = { ...item, monthKey: selectedMonth.value };
            showAddModal.value = true;
        };

        const saveLoan = async () => {
            const payload = {
                ...formLoan.value,
                monthKey: selectedMonth.value,
                netMonthly: (formLoan.value.monthlyPayment || 0) + (formLoan.value.monthlyInterest || 0)
            };
            try {
                const url = isEditing.value ? `/api/loans/${payload.id}` : '/api/loans';
                const method = isEditing.value ? 'PUT' : 'POST';
                const response = await fetch(url, { method, headers: getAuthHeaders(), body: JSON.stringify(payload) });
                if (!response.ok) throw new Error('Không thể lưu khoản vay');
                loansData.value = await response.json();
                showAddModal.value = false;
            } catch (error) {
                alert(error.message);
            }
        };

        const deleteLoan = async (id) => {
            if (!confirm(`Bạn có chắc muốn xóa khoản vay này khỏi Sheet Tháng ${selectedMonth.value}?`)) return;
            try {
                const response = await fetch(`/api/loans/${id}?monthKey=${selectedMonth.value}`, { method: 'DELETE', headers: getAuthHeaders() });
                if (!response.ok) throw new Error('Không thể xóa khoản vay');
                loansData.value = await response.json();
            } catch (error) {
                alert(error.message);
            }
        };

        const exportCSV = () => exportToExcel(filteredLoans.value, getPaymentStatus, getDealCountdown, selectedMonth.value);

        const exportPDF = () => exportToPDF(filteredLoans.value, getPaymentStatus, getDealCountdown, selectedMonth.value, {
            principal: totalPrincipal.value,
            monthlyPayment: totalMonthlyPayment.value,
            monthlyInterest: totalMonthlyInterest.value,
            monthlyNet: totalMonthlyNet.value
        });

                        onMounted(async () => {
                    syncTabFromHash();
                    window.addEventListener('hashchange', syncTabFromHash);

                    loginForm.value = { username: '', password: '' };
                    
                    // 1. Tải Session trước
                    loadSession(); 
                    
                    // 2. Sau khi đã có Session mới gọi API lấy Users & Loans
                    await loadUsers();
                    await loadLoans();
                });

                    const showResetPasswordModal = ref(false);
                    const selectedUserForReset = ref(null);
                    const newPasswordInput = ref('');

                    const openResetPasswordModal = (user) => {
                        selectedUserForReset.value = user;
                        newPasswordInput.value = '';
                        showResetPasswordModal.value = true;
                    };

                    const submitChangePassword = async () => {
                        if (!selectedUserForReset.value || !newPasswordInput.value) return;

                        try {
                            const response = await fetch(`/api/users/${selectedUserForReset.value.id}/password`, {
                                method: 'PUT',
                                headers: getAuthHeaders(),
                                body: JSON.stringify({ password: newPasswordInput.value })
                            });
                            const result = await response.json();
                            if (!response.ok) throw new Error(result.message);

                            alert(`Đã đổi mật khẩu thành công cho tài khoản "${selectedUserForReset.value.name}"!`);
                            showResetPasswordModal.value = false;
                            await loadUsers();
                        } catch (err) {
                            alert(err.message || 'Lỗi khi đổi mật khẩu');
                        }
                    };


        return {
            currentTab, loansData, payments, allUsers, memberList, currentRole, userPermissions, searchQuery, filterAssignee, selectedMonth, monthList,
            currentMonthLoans, filteredLoans, totalPrincipal, totalMonthlyNet, totalMonthlyPayment, totalMonthlyInterest, paidMonthlyCount, interestReceivedCount,
            showAddModal, isEditing, formLoan, newUserForm, currentUserName, currentUserInitials,
            currentRoleText, canEdit, isLoggedIn, loginForm, loginError,
            formatCurrency, isDueDateNearOrOverdue, formatDate, formatMonthLabel, getDueDateClass, getAssigneeBadgeClass, getBankIndicatorColor, getPaymentStatus, toggleStatus,
            getDealCountdown, updateUserPermissions, createNewUser, deleteUser, createNewMonthSheet, deleteCurrentMonthSheet, openAddLoanModal, editLoan, saveLoan, deleteLoan, login, logout, exportPDF, exportCSV, 
            showResetPasswordModal, selectedUserForReset, newPasswordInput,
            openResetPasswordModal, submitChangePassword
        };
    }
}).mount('#app');