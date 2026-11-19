'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, Empty, Field, Loaded, Money, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { FEE_TYPE_LABEL } from '@/lib/labels';
import type { ClassView } from '@/lib/types';

export default function ClassesPage() {
  const [status, setStatus] = useState('OPEN');
  const list = useLoad(() => api.get<ClassView[]>('/classes', { status }), [status]);
  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>Lớp học</h1>
        <Link className="btn primary" href="/tutor/classes/new">
          Tạo lớp
        </Link>
      </div>
      <Field label="Trạng thái lớp">
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          style={{ maxWidth: 220 }}
        >
          <option value="OPEN">Đang mở</option>
          <option value="CLOSED">Đã đóng</option>
          <option value="">Tất cả</option>
        </select>
      </Field>
      <Loaded state={list}>
        {(classes) =>
          classes.length === 0 ? (
            <Empty>Chưa có lớp nào.</Empty>
          ) : (
            <div className="table-wrap" style={{ marginTop: '1rem' }}>
              <table>
                <thead>
                  <tr>
                    <th>Tên lớp</th>
                    <th>Môn</th>
                    <th>Loại</th>
                    <th>Học phí</th>
                    <th>Trạng thái</th>
                  </tr>
                </thead>
                <tbody>
                  {classes.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <Link href={`/tutor/classes/${c.id}`}>{c.name}</Link>
                      </td>
                      <td>{c.subject}</td>
                      <td>{c.type === 'GROUP' ? `Nhóm (tối đa ${c.maxStudents})` : '1-1'}</td>
                      <td>
                        <Money value={c.feeAmount} /> / {c.feeType === 'MONTHLY' ? 'tháng' : 'buổi'}
                        <div className="hint">{FEE_TYPE_LABEL[c.feeType]}</div>
                      </td>
                      <td>
                        {c.status === 'OPEN' ? (
                          <Badge tone="green">Đang mở</Badge>
                        ) : (
                          <Badge>Đã đóng</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </Loaded>
    </>
  );
}
