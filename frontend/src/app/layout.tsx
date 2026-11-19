import type { Metadata } from 'next';
import { Providers } from '@/components/session';
import './globals.css';

export const metadata: Metadata = {
  title: 'Tutor Management System',
  description: 'Quản lý học sinh, lớp học, lịch học, điểm danh và học phí',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="vi">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
