'use client';
import { Loaded, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { ROLE_LABEL } from '@/lib/labels';
import type { UserView } from '@/lib/types';

export default function TutorHome() {
  const me = useLoad(() => api.get<UserView>('/users/me'));
  return (
    <>
      <h1>Tổng quan giáo viên</h1>
      <Loaded state={me}>
        {(u) => (
          <p className="muted">
            Xin chào {u.email}
            {u.role && ` · ${ROLE_LABEL[u.role]}`}.
          </p>
        )}
      </Loaded>
    </>
  );
}
