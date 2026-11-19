'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ActionButton, ErrorBox, Field } from '@/components/ui';
import { api, describeError } from '@/lib/api';
import type { ClassView, FeeType } from '@/lib/types';

export default function NewClassPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [subject, setSubject] = useState('');
  const [type, setType] = useState<'ONE_ON_ONE' | 'GROUP'>('ONE_ON_ONE');
  const [maxStudents, setMaxStudents] = useState('4');
  const [feeType, setFeeType] = useState<FeeType>('PER_SESSION');
  const [feeAmount, setFeeAmount] = useState('');
  const [chargeAbsent, setChargeAbsent] = useState(true);
  const [error, setError] = useState('');

  async function submit() {
    setError('');
    const fee = Number(feeAmount);
    if (!name.trim() || !subject.trim()) return setError('Cần nhập tên lớp và môn học.');
    if (!Number.isInteger(fee) || fee <= 0)
      return setError('Học phí phải là số nguyên VND lớn hơn 0.');
    try {
      const res = await api.post<ClassView>('/classes', {
        name: name.trim(),
        subject: subject.trim(),
        type,
        ...(type === 'GROUP' && { maxStudents: Number(maxStudents) }),
        feeType,
        feeAmount: fee,
        chargeAbsent,
      });
      router.push(`/tutor/classes/${res.data.id}`);
    } catch (err) {
      setError(describeError(err));
    }
  }

  return (
    <>
      <h1>Tạo lớp</h1>
      <form className="card stack" onSubmit={(e) => e.preventDefault()}>
        <div className="grid">
          <Field label="Tên lớp">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Toán 9 – nhóm tối thứ 2"
            />
          </Field>
          <Field label="Môn học">
            <input value={subject} onChange={(e) => setSubject(e.target.value)} />
          </Field>
          <Field label="Loại lớp">
            <select
              value={type}
              onChange={(e) => setType(e.target.value as 'ONE_ON_ONE' | 'GROUP')}
            >
              <option value="ONE_ON_ONE">1-1 (một học sinh)</option>
              <option value="GROUP">Nhóm</option>
            </select>
          </Field>
          {type === 'GROUP' && (
            <Field label="Sĩ số tối đa" hint="Lớp nhóm từ 2 đến 8 học sinh">
              <input
                type="number"
                min={2}
                max={8}
                value={maxStudents}
                onChange={(e) => setMaxStudents(e.target.value)}
              />
            </Field>
          )}
          <Field label="Cách tính học phí">
            <select value={feeType} onChange={(e) => setFeeType(e.target.value as FeeType)}>
              <option value="PER_SESSION">Theo buổi</option>
              <option value="MONTHLY">Theo tháng</option>
            </select>
          </Field>
          <Field
            label={feeType === 'MONTHLY' ? 'Học phí mỗi tháng (VND)' : 'Học phí mỗi buổi (VND)'}
          >
            <input
              type="number"
              min={1}
              step={1000}
              value={feeAmount}
              onChange={(e) => setFeeAmount(e.target.value)}
            />
          </Field>
        </div>
        {feeType === 'PER_SESSION' && (
          <label className="checkbox">
            <input
              type="checkbox"
              checked={chargeAbsent}
              onChange={(e) => setChargeAbsent(e.target.checked)}
            />
            Tính phí buổi vắng không phép (BR-BI-08)
          </label>
        )}
        {feeType === 'MONTHLY' && (
          <p className="hint">
            Lớp theo tháng: khi ghi danh, phụ huynh nhận ngay hóa đơn ghi danh cho tháng đầu (tính
            theo tỉ lệ số buổi) và có 7 ngày để thanh toán.
          </p>
        )}
        <ErrorBox error={error} />
        <ActionButton type="submit" onClick={submit} busyLabel="Đang tạo…">
          Tạo lớp
        </ActionButton>
      </form>
    </>
  );
}
