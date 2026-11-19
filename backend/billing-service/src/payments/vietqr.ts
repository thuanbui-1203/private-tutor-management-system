/**
 * VietQR (NAPAS 247) payload: EMVCo merchant-presented QR, the string a banking app scans.
 * Field ids follow the NAPAS VietQR spec: 38 = consumer account (GUID A000000727, BIN +
 * account, service QRIBFTTA = transfer to account), 53 currency 704 (VND), 54 amount,
 * 58 country, 62/08 transfer description, 63 CRC-16/CCITT-FALSE.
 */
const field = (id: string, value: string) =>
  `${id}${String(value.length).padStart(2, '0')}${value}`;

export function crc16(text: string): string {
  let crc = 0xffff;
  for (const byte of Buffer.from(text, 'utf8')) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++)
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

export function vietQrPayload(p: {
  bankBin: string;
  accountNumber: string;
  amount: number;
  description: string;
}): string {
  const account =
    field('00', 'A000000727') +
    field('01', field('00', p.bankBin) + field('01', p.accountNumber)) +
    field('02', 'QRIBFTTA');
  const body =
    field('00', '01') +
    field('01', p.amount > 0 ? '12' : '11') +
    field('38', account) +
    field('53', '704') +
    (p.amount > 0 ? field('54', String(p.amount)) : '') +
    field('58', 'VN') +
    field('62', field('08', p.description)) +
    '6304';
  return body + crc16(body);
}
