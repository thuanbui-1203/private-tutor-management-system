import { renderInvitation } from '../src/invitations/invitation-mailer';

describe('activation email', () => {
  const mail = {
    to: 'ph@example.com',
    fullName: 'Nguyễn <Lan>',
    role: 'PARENT' as const,
    acceptUrl: 'https://app.example.com/invite/abc_123',
    expiresAt: new Date('2030-01-08T03:00:00Z'),
  };

  it('carries the activation link, role and expiry (Vietnam time) in text and HTML', () => {
    const { subject, text, html } = renderInvitation(mail);
    expect(subject).toContain('Kích hoạt');
    expect(text).toContain('https://app.example.com/invite/abc_123');
    expect(text).toContain('phụ huynh');
    expect(text).toContain('10:00');
    expect(html).toContain('href="https://app.example.com/invite/abc_123"');
  });

  it('escapes the name in HTML', () => {
    expect(renderInvitation(mail).html).toContain('Nguyễn &lt;Lan&gt;');
  });
});
