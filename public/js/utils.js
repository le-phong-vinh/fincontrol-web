// Format tiền & ngày
export const formatCurrency = (val) => new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(val || 0);
export const formatDate = (dateStr) => dateStr ? new Date(dateStr).toLocaleDateString('vi-VN') : '-';
export const formatMonthLabel = (month) => month ? `T${month.split('-')[1]}/${month.split('-')[0].slice(2)}` : '-';

// Tính đếm ngược hạn deal
export const getDealCountdown = (withdrawDate, dealTerm, currentSelectedMonth) => {
    if (!dealTerm || !withdrawDate) return null;
    const totalMonths = parseInt(dealTerm.match(/\d+/)?.[0] || '0', 10);
    if (!totalMonths) return null;

    const withdraw = new Date(withdrawDate);
    const [selectedYear, selectedMonthNum] = currentSelectedMonth.split('-').map(Number);
    const elapsedMonths = (selectedYear - withdraw.getFullYear()) * 12 + (selectedMonthNum - (withdraw.getMonth() + 1));
    const remaining = totalMonths - elapsedMonths;

    return {
        total: totalMonths,
        remaining: remaining > 0 ? remaining : 0,
        isExpired: remaining <= 0,
        isNearEnd: remaining > 0 && remaining <= 2
    };
};

// Kiểm tra cảnh báo hạn trả
export const checkDueDateNearOrOverdue = (dueDateRule, loanId, getPaymentStatus, selectedMonth) => {
    if (getPaymentStatus(loanId).isMonthlyPaid) return false;
    if (!dueDateRule) return false;

    const today = new Date();
    const currentYear = today.getFullYear();
    const currentMonthNum = today.getMonth() + 1;
    const currentDay = today.getDate();

    const [sheetYear, sheetMonth] = selectedMonth.split('-').map(Number);

    if (sheetYear > currentYear || (sheetYear === currentYear && sheetMonth > currentMonthNum)) {
        return false;
    }

    const dueDay = parseInt(dueDateRule.match(/\d+/)?.[0] || '0', 10);
    if (!dueDay) return false;

    if (sheetYear === currentYear && sheetMonth === currentMonthNum) {
        return (dueDay - currentDay) <= 3;
    }

    if (sheetYear < currentYear || (sheetYear === currentYear && sheetMonth < currentMonthNum)) {
        return true;
    }

    return false;
};

// Xuất file Excel (SheetJS)
export const exportToExcel = (filteredLoans, getPaymentStatus, getDealCountdown, selectedMonth) => {
    try {
        if (typeof XLSX === 'undefined') {
            alert('Thư viện Excel đang được tải, vui lòng thử lại sau vài giây!');
            return;
        }

        const headers = [
            'Ngân hàng / Đơn vị', 'Tổng tiền (VNĐ)', 'Ngày rút', 'Trả / Tháng', 'Lãi nhận',
            'Tổng Thu/Chi', 'Ngày nhận lãi', 'Hạn thanh toán', 'Hạn Deal', 'Người gửi',
            'Ghi chú', 'Trạng thái Trả/Tháng', 'Trạng thái Nhận lãi'
        ];

        const dataRows = filteredLoans.map(item => {
            const st = getPaymentStatus(item.id);
            const countdown = getDealCountdown(item.withdrawDate, item.tenure, selectedMonth);
            
            let dealText = '-';
            if (countdown) {
                dealText = countdown.isExpired ? `Hết hạn (0/${countdown.total}T)` : `Còn ${countdown.remaining}/${countdown.total}T`;
            } else if (item.tenure) {
                dealText = item.tenure;
            }

            return [
                item.bank || '', item.totalAmount || 0, formatDate(item.withdrawDate),
                item.monthlyPayment || 0, item.monthlyInterest || 0, item.netMonthly || 0,
                item.interestDays || '-', item.dueDateRule || '-', dealText, item.assignee || '-',
                item.note || '-', st.isMonthlyPaid ? 'ĐÃ TRẢ' : 'CHƯA TRẢ',
                st.isInterestReceived ? 'ĐÃ NHẬN LÃI' : 'CHƯA NHẬN LÃI'
            ];
        });

        const worksheet = XLSX.utils.aoa_to_sheet([headers, ...dataRows]);
        worksheet['!cols'] = [
            { wch: 20 }, { wch: 10 }, { wch: 11 }, { wch: 9 }, { wch: 9 }, { wch: 10 },
            { wch: 15 }, { wch: 15 }, { wch: 10 }, { wch: 10 }, { wch: 15 }, { wch: 18 }, { wch: 18 }
        ];

        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, `Tháng ${selectedMonth}`);
        XLSX.writeFile(workbook, `FinControl_Thang_${selectedMonth}.xlsx`);
    } catch (err) {
        alert('Lỗi xuất file Excel: ' + err.message);
    }
};

// Xuất file PDF (html2pdf)
export const exportToPDF = (filteredLoans, getPaymentStatus, getDealCountdown, selectedMonth, totals) => {
    try {
        if (typeof html2pdf === 'undefined') {
            alert('Thư viện PDF đang được tải, vui lòng thử lại sau vài giây!');
            return;
        }

        const printElement = document.createElement('div');
        printElement.style.padding = '8px';
        printElement.style.fontFamily = 'Roboto, Arial, sans-serif';
        printElement.style.color = '#1e293b';

        let htmlContent = `
            <style>
                .pdf-table { width: 100%; border-collapse: collapse; font-size: 7.5pt; table-layout: fixed; }
                .pdf-table th, .pdf-table td { border: 1px solid #cbd5e1; padding: 3px 2px; text-align: center; word-wrap: break-word; }
                .pdf-table tr { page-break-inside: avoid; }
                .pdf-header { text-align: center; margin-bottom: 6px; }
                .pdf-cards { display: flex; gap: 6px; margin-bottom: 8px; }
                .pdf-card { flex: 1; background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 4px; padding: 4px 6px; }
            </style>

            <div class="pdf-header">
                <h2 style="margin: 0; color: #4f46e5; font-size: 13pt; font-weight: 800;">BÁO CÁO DÒNG TIỀN & KHOẢN VAY TÍN DỤNG</h2>
                <p style="margin: 2px 0 0 0; font-size: 7.5pt; color: #64748b;">
                    Sheet Tháng: <b>${selectedMonth}</b> | Ngày xuất: ${new Date().toLocaleDateString('vi-VN')}
                </p>
            </div>

            <div class="pdf-cards">
                <div class="pdf-card">
                    <div style="font-size: 6.5pt; font-weight: 700; color: #64748b;">TỔNG DƯ NỢ</div>
                    <div style="font-size: 9.5pt; font-weight: 800; color: #0f172a; margin-top: 1px;">${formatCurrency(totals.principal)}</div>
                </div>
                <div class="pdf-card">
                    <div style="font-size: 6.5pt; font-weight: 700; color: #64748b;">TỔNG TRẢ GỐC</div>
                    <div style="font-size: 9.5pt; font-weight: 800; color: #d97706; margin-top: 1px;">${formatCurrency(totals.monthlyPayment)}</div>
                </div>
                <div class="pdf-card">
                    <div style="font-size: 6.5pt; font-weight: 700; color: #64748b;">TỔNG LÃI NHẬN</div>
                    <div style="font-size: 9.5pt; font-weight: 800; color: #16a34a; margin-top: 1px;">${formatCurrency(totals.monthlyInterest)}</div>
                </div>
                <div class="pdf-card">
                    <div style="font-size: 6.5pt; font-weight: 700; color: #4f46e5;">TỔNG THU/CHI</div>
                    <div style="font-size: 9.5pt; font-weight: 800; color: #4338ca; margin-top: 1px;">${formatCurrency(totals.monthlyNet)}</div>
                </div>
            </div>

            <table class="pdf-table">
                <thead>
                    <tr style="background-color: #f1f5f9; color: #334155; font-weight: 700;">
                        <th style="width: 13%; text-align: left; padding-left: 4px;">Ngân hàng</th>
                        <th style="width: 9%;">Tổng tiền</th>
                        <th style="width: 7.5%;">Ngày rút</th>
                        <th style="width: 8.5%;">Trả/Tháng</th>
                        <th style="width: 8%;">Lãi nhận</th>
                        <th style="width: 8.5%;">Thu/Chi</th>
                        <th style="width: 8.5%;">Hạn trả</th>
                        <th style="width: 8.5%;">Hạn Deal</th>
                        <th style="width: 6.5%;">Gửi</th>
                        <th style="width: 7.5%;">Ghi chú</th>
                        <th style="width: 7.5%;">Trả/Tháng</th>
                        <th style="width: 7%;">Nhận Lãi</th>
                    </tr>
                </thead>
                <tbody>
        `;

        filteredLoans.forEach(item => {
            const st = getPaymentStatus(item.id);
            const countdown = getDealCountdown(item.withdrawDate, item.tenure, selectedMonth);
            
            let dealText = '-';
            if (countdown) {
                dealText = countdown.isExpired ? `Hết (${countdown.total}T)` : `Còn ${countdown.remaining}/${countdown.total}T`;
            } else if (item.tenure) {
                dealText = item.tenure;
            }

            htmlContent += `
                <tr>
                    <td style="text-align: left; font-weight: bold; padding-left: 4px;">${item.bank || ''}</td>
                    <td>${formatCurrency(item.totalAmount)}</td>
                    <td>${formatDate(item.withdrawDate)}</td>
                    <td>${item.monthlyPayment ? formatCurrency(item.monthlyPayment) : '-'}</td>
                    <td style="color: #16a34a; font-weight: bold;">${item.monthlyInterest ? formatCurrency(item.monthlyInterest) : '-'}</td>
                    <td style="font-weight: bold; color: #4f46e5;">${formatCurrency(item.netMonthly)}</td>
                    <td>${item.dueDateRule || '-'}</td>
                    <td>${dealText}</td>
                    <td>${item.assignee || '-'}</td>
                    <td style="color: #d97706; font-weight: bold;">${item.note || '-'}</td>
                    <td style="font-weight: bold; color: ${st.isMonthlyPaid ? '#16a34a' : '#dc2626'};">${st.isMonthlyPaid ? 'ĐÃ TRẢ' : 'CHƯA TRẢ'}</td>
                    <td style="font-weight: bold; color: ${st.isInterestReceived ? '#9333ea' : '#dc2626'};">${st.isInterestReceived ? 'ĐÃ NHẬN' : 'CHƯA NHẬN'}</td>
                </tr>
            `;
        });

        htmlContent += `</tbody></table>`;
        printElement.innerHTML = htmlContent;

        const opt = {
            margin:       [4, 4, 4, 4],
            filename:     `FinControl_Thang_${selectedMonth}.pdf`,
            image:        { type: 'jpeg', quality: 1.0 },
            html2canvas:  { scale: 2.5, useCORS: true, letterRendering: true },
            jsPDF:        { unit: 'mm', format: 'a4', orientation: 'landscape' },
            pagebreak:    { mode: ['avoid-all', 'css', 'legacy'] }
        };

        html2pdf().set(opt).from(printElement).save();
    } catch (err) {
        alert('Lỗi xuất file PDF: ' + err.message);
    }
};