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
        
        const currentTab = ref('home'); 
        const showAddModal = ref(false);
        const isEditing = ref(false);
        const sessionUser = ref(null);
        
        const loginForm = ref({ username: '', password: '' }); 
        const loginError = ref('');

        const newUserForm = ref({ name: '', username: '', password: '', role: 'MEMBER' });

        const isDarkMode = ref(true);

        // State quản lý Logs
        const showLogsModal = ref(false);
        const logsList = ref([]);

        // State & Helper Toast Notification
        const toast = ref({ show: false, message: '', type: 'success' });
        let toastTimeout = null;

        const showToast = (message, type = 'success') => {
            toast.value = { show: true, message, type };
            if (toastTimeout) clearTimeout(toastTimeout);
            toastTimeout = setTimeout(() => {
                toast.value.show = false;
            }, 3000);
        };

        // State & Helper Confirm Modal Custom
        const confirmModal = ref({
            show: false,
            title: 'Xác nhận hành động',
            message: '',
            type: 'info',
            requirePassword: false,
            inputPassword: '',
            resolve: null
        });

        const showConfirm = (message, title = 'Xác nhận hành động', type = 'info', requirePassword = false) => {
            return new Promise((resolve) => {
                confirmModal.value = {
                    show: true,
                    title,
                    message,
                    type,
                    requirePassword,
                    inputPassword: '',
                    resolve
                };
            });
        };

        const closeConfirm = (result) => {
            if (confirmModal.value.resolve) {
                confirmModal.value.resolve(
                    result 
                        ? { confirmed: true, password: confirmModal.value.inputPassword } 
                        : { confirmed: false, password: '' }
                );
            }
            confirmModal.value.show = false;
        };

        const applyTheme = (dark) => {
            isDarkMode.value = dark;
            if (dark) {
                document.documentElement.classList.add('dark');
                localStorage.setItem('fincontrol_theme', 'dark');
            } else {
                document.documentElement.classList.remove('dark');
                localStorage.setItem('fincontrol_theme', 'light');
            }
        };

        const toggleTheme = () => {
            applyTheme(!isDarkMode.value);
        };

        const initTheme = () => {
            const savedTheme = localStorage.getItem('fincontrol_theme');
            if (savedTheme) {
                applyTheme(savedTheme === 'dark');
            } else {
                const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
                applyTheme(systemPrefersDark);
            }
        };

        const formLoan = ref({
            id: Date.now(), bank: '', totalAmount: 0,
            withdrawDate: new Date().toISOString().split('T')[0],
            monthlyPayment: 0, monthlyInterest: 0, memberInterest: null,
            interestDays: '~ngày 5', dueDateRule: 'Trước ngày 5', tenure: '', assignee: 'Vinh', note: ''
        });

        const monthList = computed(() => Object.keys(loansData.value).sort((a, b) => a.localeCompare(b)));
        const currentMonthLoans = computed(() => loansData.value[selectedMonth.value] || []);
        const isLoggedIn = computed(() => Boolean(sessionUser.value));
        const currentUserName = computed(() => sessionUser.value?.name || 'Chưa đăng nhập');
        const currentUserInitials = computed(() => sessionUser.value?.initials || '??');
        
        const currentRoleText = computed(() => {
            if (currentRole.value === 'ADMIN') return 'Super Admin';
            if (currentRole.value === 'VIEWER') return 'Chỉ Xem (Viewer)';
            return 'Member';
        });

        const canEdit = computed(() => currentRole.value === 'ADMIN');
        const canToggleStatus = computed(() => currentRole.value === 'ADMIN' || currentRole.value === 'MEMBER');

        watch(currentTab, (newTab) => {
            window.location.hash = newTab;
        });

        const syncTabFromHash = () => {
            const hash = window.location.hash.replace('#', '');
            if (hash === 'member' || hash === 'home') {
                currentTab.value = hash;
            }
        };

        // Mã hóa encodeURIComponent cho tên tiếng Việt trong Header
        const getAuthHeaders = () => {
            let role = 'MEMBER';
            let name = 'Thành viên';
            try {
                const saved = localStorage.getItem('fincontrol_session');
                if (saved) {
                    const parsed = JSON.parse(saved);
                    role = parsed.role || 'MEMBER';
                    name = parsed.name || 'Thành viên';
                }
            } catch (e) {}

            return {
                'Content-Type': 'application/json',
                'X-User-Role': role,
                'X-User-Name': encodeURIComponent(name),
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
                showToast(`Chào mừng ${result.name} quay trở lại!`, 'success');
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

        const loadLogs = async () => {
            try {
                const res = await fetch('/api/logs', { headers: getAuthHeaders() });
                if (res.ok) {
                    logsList.value = await res.json();
                }
            } catch (err) {
                showToast('Lỗi tải nhật ký thao tác', 'error');
            }
        };

        const openLogsModal = async () => {
            await loadLogs();
            showLogsModal.value = true;
        };

        const formatLogTime = (timeStr) => {
            if (!timeStr) return '';
            const d = new Date(timeStr);
            return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')} - ${d.getDate()}/${d.getMonth()+1}/${d.getFullYear()}`;
        };

        const clearAllLogs = async () => {
            const res = await showConfirm(
                'Bạn có chắc chắn muốn XÓA SẠCH toàn bộ nhật ký lịch sử thao tác? Hành động này không thể khôi phục!',
                'Xóa Nhật Ký Log',
                'danger'
            );
            if (!res.confirmed) return;

            try {
                const response = await fetch('/api/logs', {
                    method: 'DELETE',
                    headers: getAuthHeaders()
                });
                const resData = await response.json();
                if (!response.ok) throw new Error(resData.message || 'Không thể xóa log');

                showToast('Đã xóa toàn bộ nhật ký thao tác!', 'success');
                await loadLogs();
            } catch (err) {
                showToast(err.message, 'error');
            }
        };

        const deleteSingleLog = async (logId) => {
            try {
                const response = await fetch(`/api/logs/${logId}`, {
                    method: 'DELETE',
                    headers: getAuthHeaders()
                });
                const resData = await response.json();
                if (!response.ok) throw new Error(resData.message || 'Không thể xóa log');

                showToast('Đã xóa dòng log!', 'success');
                await loadLogs();
            } catch (err) {
                showToast(err.message, 'error');
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
                showToast('Khởi tạo tài khoản thành công!', 'success');
                newUserForm.value = { name: '', username: '', password: '', role: 'MEMBER' };
                await loadUsers();
            } catch (err) {
                showToast(err.message, 'error');
            }
        };

        const deleteUser = async (user) => {
            if (sessionUser.value && sessionUser.value.id === user.id) {
                showToast('Bạn không thể tự xóa tài khoản đang đăng nhập!', 'error');
                return;
            }

            const res = await showConfirm(
                `Bạn có chắc chắn muốn XÓA TÀI KHOẢN "${user.name}" (${user.username})? Hành động này không thể khôi phục.`,
                'Xóa Tài Khoản',
                'danger'
            );
            if (!res.confirmed) return;

            try {
                const response = await fetch(`/api/users/${user.id}`, { method: 'DELETE', headers: getAuthHeaders() });
                if (!response.ok) throw new Error('Không thể xóa tài khoản');
                showToast('Xóa tài khoản thành công!', 'success');
                await loadUsers();
            } catch (err) {
                showToast(err.message, 'error');
            }
        };

        const updateUserRole = async (user) => {
            try {
                const response = await fetch(`/api/users/${user.id}/role`, {
                    method: 'PUT',
                    headers: getAuthHeaders(),
                    body: JSON.stringify({ role: user.role })
                });
                const resData = await response.json();
                if (!response.ok) throw new Error(resData.message || 'Không thể đổi vai trò');

                if (sessionUser.value && sessionUser.value.id === user.id) {
                    sessionUser.value.role = user.role;
                    currentRole.value = user.role;
                    saveSession(sessionUser.value);
                }

                showToast(`Đã đổi vai trò của "${user.name}" thành ${user.role}!`, 'success');
                await loadUsers();
            } catch (err) {
                showToast(err.message, 'error');
                await loadUsers();
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
                showToast(error.message, 'error');
            }
        };

        const updateUserPermissions = async (user) => {
            try {
                await fetch(`/api/users/${user.id}/permissions`, {
                    method: 'PUT',
                    headers: getAuthHeaders(),
                    body: JSON.stringify({ permissions: user.permissions })
                });
                showToast('Cập nhật quyền xem thành công!', 'info');
            } catch (err) {
                showToast('Lỗi cập nhật quyền', 'error');
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
                if ((currentRole.value === 'MEMBER' || currentRole.value === 'VIEWER') && !userPermissions.value.seeAllLoans) {
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

        const totalPrincipal = computed(() => filteredLoans.value.reduce((acc, curr) => acc + (Number(curr.totalAmount) || 0), 0));
        const totalMonthlyPayment = computed(() => filteredLoans.value.reduce((acc, curr) => acc + (Number(curr.monthlyPayment) || 0), 0));
        const totalMonthlyInterest = computed(() => filteredLoans.value.reduce((acc, curr) => acc + (Number(curr.monthlyInterest) || 0), 0));
        const totalMonthlyNet = computed(() => Math.round(totalMonthlyPayment.value + totalMonthlyInterest.value));
        const paidMonthlyCount = computed(() => filteredLoans.value.filter(item => getPaymentStatus(item.id).isMonthlyPaid).length);
        const interestReceivedCount = computed(() => filteredLoans.value.filter(item => getPaymentStatus(item.id).isInterestReceived).length);

        const isDueDateNearOrOverdue = (dueDateRule, loanId) => checkDueDateNearOrOverdue(dueDateRule, loanId, getPaymentStatus, selectedMonth.value);

        const getDueDateClass = (rule, loanId) => {
            if (!rule) return 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/30';
            return getPaymentStatus(loanId).isMonthlyPaid
                ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30'
                : 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/30';
        };

        const getAssigneeBadgeClass = (name) => {
            switch (name) {
                case 'Vinh': return 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-300 border-cyan-500/30';
                case 'Khang': return 'bg-amber-500/10 text-amber-600 dark:text-amber-300 border-amber-500/30';
                case 'Linh': return 'bg-sky-500/10 text-sky-600 dark:text-sky-300 border-sky-500/30';
                default: return 'bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-300 dark:border-slate-700';
            }
        };

        const getBankIndicatorColor = (note) => (note && (note.includes('LÃI MỚI') || note.includes('new'))) ? 'bg-rose-500 animate-pulse' : 'bg-cyan-500';

        const toggleStatus = async (item, field) => {
            if (!canToggleStatus.value) {
                showToast('Tài khoản VIEWER chỉ có quyền xem, không thể thay đổi trạng thái!', 'error');
                return;
            }

            const current = getPaymentStatus(item.id);
            const newValue = !current[field];
            const actionName = field === 'isMonthlyPaid' ? (newValue ? 'ĐÃ TRẢ GỐC' : 'CHƯA TRẢ GỐC') : (newValue ? 'ĐÃ NHẬN LÃI' : 'CHƯA NHẬN LÃI');

            const res = await showConfirm(
                `Bạn có chắc chắn muốn đổi trạng thái của "${item.bank}" thành "${actionName}" trong Tháng ${selectedMonth.value}?`,
                'Cập nhật trạng thái',
                'info'
            );
            if (!res.confirmed) return;

            const formData = new FormData();
            formData.append('monthKey', selectedMonth.value);
            formData.append('field', field);
            formData.append('value', String(newValue));
            formData.append('bankName', item.bank);

            try {
                const response = await fetch(`/api/loans/${item.id}/status-toggle`, { 
                    method: 'POST', 
                    headers: {
                        'X-User-Role': currentRole.value,
                        'X-User-Name': encodeURIComponent(currentUserName.value)
                    },
                    body: formData 
                });
                if (!response.ok) throw new Error('Cập nhật thất bại');
                const data = await response.json();
                payments.value = data.payments;
                showToast(`Đã đổi "${item.bank}" thành "${actionName}"!`, 'success');
            } catch (error) {
                showToast(error.message, 'error');
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
                showToast(`Khởi tạo Sheet Tháng ${nextKey} thành công!`, 'success');
            } catch (err) {
                showToast(err.message, 'error');
            }
        };

        const deleteCurrentMonthSheet = async () => {
            const res = await showConfirm(
                `Vui lòng nhập MẬT KHẨU ADMIN để xác nhận xóa toàn bộ Sheet Tháng ${selectedMonth.value}. Dữ liệu tháng này sẽ bị xóa vĩnh viễn!`,
                'Xác Nhận Xóa Sheet Tháng',
                'danger',
                true
            );

            if (!res.confirmed) return;

            if (!res.password) {
                showToast('Vui lòng nhập mật khẩu Admin!', 'error');
                return;
            }

            try {
                const response = await fetch(`/api/loans/delete-month-sheet/${selectedMonth.value}`, { 
                    method: 'DELETE', 
                    headers: {
                        ...getAuthHeaders(),
                        'X-Admin-Password': res.password
                    },
                    body: JSON.stringify({ adminPassword: res.password })
                });
                
                if (!response.ok) {
                    const errData = await response.json().catch(() => ({}));
                    throw new Error(errData.message || 'Mật khẩu Admin không chính xác hoặc không thể xóa Sheet tháng này');
                }

                const result = await response.json();
                loansData.value = result.loans;
                if (monthList.value.length > 0) selectedMonth.value = monthList.value[0];
                showToast(`Đã xóa thành công Sheet Tháng ${selectedMonth.value}!`, 'success');
            } catch (err) {
                showToast(err.message, 'error');
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
            const payment = Number(formLoan.value.monthlyPayment) || 0;
            const interest = Number(formLoan.value.monthlyInterest) || 0;

            const payload = {
                ...formLoan.value,
                totalAmount: Number(formLoan.value.totalAmount) || 0,
                monthlyPayment: payment,
                monthlyInterest: interest,
                monthKey: selectedMonth.value,
                netMonthly: Math.round(payment + interest)
            };
            try {
                const url = isEditing.value ? `/api/loans/${payload.id}` : '/api/loans';
                const method = isEditing.value ? 'PUT' : 'POST';
                const response = await fetch(url, { method, headers: getAuthHeaders(), body: JSON.stringify(payload) });
                if (!response.ok) throw new Error('Không thể lưu khoản vay');
                loansData.value = await response.json();
                showAddModal.value = false;
                showToast(isEditing.value ? 'Cập nhật khoản vay thành công!' : 'Thêm khoản vay mới thành công!', 'success');
            } catch (error) {
                showToast(error.message, 'error');
            }
        };

        const deleteLoan = async (id) => {
            const res = await showConfirm(
                `Bạn có chắc muốn xóa khoản vay này khỏi Sheet Tháng ${selectedMonth.value}?`,
                'Xóa Khoản Vay',
                'danger'
            );
            if (!res.confirmed) return;

            try {
                const response = await fetch(`/api/loans/${id}?monthKey=${selectedMonth.value}`, { method: 'DELETE', headers: getAuthHeaders() });
                if (!response.ok) throw new Error('Không thể xóa khoản vay');
                loansData.value = await response.json();
                showToast('Đã xóa khoản vay!', 'success');
            } catch (error) {
                showToast(error.message, 'error');
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
            initTheme();
            syncTabFromHash();
            window.addEventListener('hashchange', syncTabFromHash);
            loginForm.value = { username: '', password: '' };
            loadSession(); 
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

                showToast(`Đã đổi mật khẩu thành công cho tài khoản "${selectedUserForReset.value.name}"!`, 'success');
                showResetPasswordModal.value = false;
                await loadUsers();
            } catch (err) {
                showToast(err.message || 'Lỗi khi đổi mật khẩu', 'error');
            }
        };

        return {
            currentTab, loansData, payments, allUsers, memberList, currentRole, userPermissions, searchQuery, filterAssignee, selectedMonth, monthList,
            currentMonthLoans, filteredLoans, totalPrincipal, totalMonthlyNet, totalMonthlyPayment, totalMonthlyInterest, paidMonthlyCount, interestReceivedCount,
            showAddModal, isEditing, formLoan, newUserForm, currentUserName, currentUserInitials,
            currentRoleText, canEdit, canToggleStatus, isLoggedIn, loginForm, loginError, isDarkMode, toggleTheme,
            confirmModal, showConfirm, closeConfirm, toast, showToast, showLogsModal, logsList, openLogsModal, clearAllLogs, deleteSingleLog, formatLogTime,
            formatCurrency, isDueDateNearOrOverdue, formatDate, formatMonthLabel, getDueDateClass, getAssigneeBadgeClass, getBankIndicatorColor, getPaymentStatus, toggleStatus,
            getDealCountdown, updateUserPermissions, updateUserRole, createNewUser, deleteUser, createNewMonthSheet, deleteCurrentMonthSheet, openAddLoanModal, editLoan, saveLoan, deleteLoan, login, logout, exportPDF, exportCSV, 
            showResetPasswordModal, selectedUserForReset, newPasswordInput,
            openResetPasswordModal, submitChangePassword
        };
    }
}).mount('#app');