import { Injectable, Logger } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';

export interface InvitationMail {
  to: string;
  fullName: string;
  role: 'PARENT' | 'STUDENT';
  acceptUrl: string;
  expiresAt: Date;
}

const ROLE_LABEL = { PARENT: 'phụ huynh', STUDENT: 'học sinh' } as const;

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

/** The activation email (BR-AU-02), in Vietnamese, as plain text and HTML. */
export function renderInvitation(mail: InvitationMail) {
  const expires = mail.expiresAt.toLocaleString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    dateStyle: 'short',
    timeStyle: 'short',
  });
  const role = ROLE_LABEL[mail.role];
  const subject = 'Kích hoạt tài khoản Tìm Gia Sư';
  const text = [
    `Chào ${mail.fullName},`,
    '',
    `Giáo viên đã tạo tài khoản ${role} cho bạn trên hệ thống quản lý gia sư.`,
    'Mở liên kết sau để đặt mật khẩu và kích hoạt tài khoản:',
    '',
    mail.acceptUrl,
    '',
    `Liên kết chỉ dùng được một lần và hết hạn lúc ${expires}.`,
    'Nếu bạn không biết về lời mời này, hãy bỏ qua email.',
  ].join('\n');
  const name = escapeHtml(mail.fullName);
  const url = escapeHtml(mail.acceptUrl);
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#1f2937;line-height:1.5">
<p>Chào <strong>${name}</strong>,</p>
<p>Giáo viên đã tạo tài khoản <strong>${role}</strong> cho bạn trên hệ thống quản lý gia sư.</p>
<p><a href="${url}" style="display:inline-block;padding:10px 18px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px">Kích hoạt tài khoản</a></p>
<p style="font-size:13px;color:#6b7280">Hoặc mở liên kết: <a href="${url}">${url}</a><br>
Liên kết chỉ dùng được một lần và hết hạn lúc ${expires}.<br>
Nếu bạn không biết về lời mời này, hãy bỏ qua email.</p>
</body></html>`;
  return { subject, text, html };
}

/**
 * Sends activation emails over SMTP: Mailpit in development, a real provider (e.g.
 * Gmail with an App Password) on the VPS. Without SMTP_HOST nothing is sent and the
 * link is only logged. Notification-service would own this (BR-SYS-03), but only
 * Identity ever sees the token, so it sends the email itself.
 */
@Injectable()
export class InvitationMailer {
  private readonly logger = new Logger(InvitationMailer.name);
  private readonly from = process.env.SMTP_FROM || 'TMS <no-reply@tms.local>';
  private readonly transport: Transporter | null = process.env.SMTP_HOST
    ? createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        // 465 is implicit TLS; 587 / 1025 upgrade with STARTTLS when offered.
        secure: (process.env.SMTP_SECURE || String(process.env.SMTP_PORT === '465')) === 'true',
        ...(process.env.SMTP_USER && {
          auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? '' },
        }),
      })
    : null;

  get enabled() {
    return this.transport !== null;
  }

  /** Never throws: the invitation already exists and the Tutor can re-send it. */
  async send(mail: InvitationMail): Promise<boolean> {
    if (!this.transport) return false;
    try {
      await this.transport.sendMail({ from: this.from, to: mail.to, ...renderInvitation(mail) });
      this.logger.log(`activation email sent to ${mail.to}`);
      return true;
    } catch (err) {
      this.logger.warn(
        `activation email to ${mail.to} failed: ${err instanceof Error ? err.message : err}`,
      );
      return false;
    }
  }
}
