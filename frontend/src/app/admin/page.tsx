'use client';
/** Admin: the Tutors and their status; disable / re-enable (BR-CL-08). */
import { useState } from 'react';
import {
  Badge,
  Confirm,
  DateTime,
  Empty,
  ErrorBox,
  Field,
  Loaded,
  Notice,
  useLoad,
} from '@/components/ui';
import { ApiError, api, describeError } from '@/lib/api';
import type { UserView } from '@/lib/types';

const STATUS: Record<UserView['status'], [string, string]> = {
  ACTIVE: ['Đang hoạt động', 'green'],
  PENDING: ['Chờ kích hoạt', 'amber'],
  DISABLED: ['Đã vô hiệu hóa', 'red'],
};

export default function AdminHome() {
  const [status, setStatus] = useState('');
  const tutors = useLoad(() => api.get<UserView[]>('/users', { role: 'TUTOR', status }), [status]);
  const [target, setTarget] = useState<{ user: UserView; to: 'ACTIVE' | 'DISABLED' } | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  return (
    <>
      <h1>Giáo viên</h1>
      {message && <Notice tone="success">{message}</Notice>}
      <ErrorBox error={error} />
      <Field label="Trạng thái">
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          style={{ maxWidth: 220 }}
        >
          <option value="">Tất cả</option>
          <option value="ACTIVE">Đang hoạt động</option>
          <option value="DISABLED">Đã vô hiệu hóa</option>
        </select>
      </Field>
      <Loaded state={tutors}>
        {(list) =>
          list.length === 0 ? (
            <Empty>Không có giáo viên nào.</Empty>
          ) : (
            <div className="table-wrap" style={{ marginTop: '1rem' }}>
              <table>
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Tham gia</th>
                    <th>Trạng thái</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((u) => (
                    <tr key={u.id}>
                      <td>{u.email}</td>
                      <td>
                        <DateTime value={u.createdAt} />
                      </td>
                      <td>
                        <Badge tone={STATUS[u.status][1]}>{STATUS[u.status][0]}</Badge>
                      </td>
                      <td>
                        {u.status === 'ACTIVE' && (
                          <button
                            className="btn secondary small"
                            onClick={() => setTarget({ user: u, to: 'DISABLED' })}
                          >
                            Vô hiệu hóa
                          </button>
                        )}
                        {u.status === 'DISABLED' && (
                          <button
                            className="btn secondary small"
                            onClick={() => setTarget({ user: u, to: 'ACTIVE' })}
                          >
                            Kích hoạt lại
                          </button>
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
      <Confirm
        open={target !== null}
        title={
          target?.to === 'DISABLED'
            ? `Vô hiệu hóa ${target?.user.email}?`
            : `Kích hoạt lại ${target?.user.email}?`
        }
        confirmLabel={target?.to === 'DISABLED' ? 'Vô hiệu hóa' : 'Kích hoạt lại'}
        onCancel={() => setTarget(null)}
        onConfirm={async () => {
          const t = target!;
          setTarget(null);
          setError('');
          setMessage('');
          try {
            await api.patch(`/users/${t.user.id}`, { status: t.to });
            setMessage(
              t.to === 'DISABLED'
                ? `Đã vô hiệu hóa ${t.user.email}.`
                : `Đã kích hoạt lại ${t.user.email}.`,
            );
            tutors.reload();
          } catch (err) {
            const open =
              err instanceof ApiError
                ? (err.body as { openClassIds?: string[] })?.openClassIds
                : undefined;
            setError(
              open?.length
                ? `Không vô hiệu hóa được: giáo viên còn ${open.length} lớp đang mở. Hãy chuyển hoặc đóng các lớp đó trước (BR-CL-08).`
                : describeError(err),
            );
          }
        }}
      >
        <p>
          {target?.to === 'DISABLED'
            ? 'Giáo viên sẽ bị đăng xuất ngay và không đăng nhập được nữa. Không vô hiệu hóa được khi còn lớp đang mở.'
            : 'Giáo viên đăng nhập lại được bình thường.'}
        </p>
      </Confirm>
    </>
  );
}
