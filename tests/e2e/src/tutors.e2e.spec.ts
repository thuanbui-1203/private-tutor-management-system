/**
 * Tutor profiles through the gateway (docs/07 §2, §5): a credential file goes through the
 * gateway into the Realtime Database emulator, an Admin reviews it, and only the owner and Admins
 * get the file back.
 */
import { randomBytes } from 'node:crypto';
import { GATEWAY, newTutor, withClaims, type Client } from './support';

const file = Buffer.concat([Buffer.from('%PDF-1.4\n'), randomBytes(1_500_000)]);

async function download(client: Client, path: string) {
  const res = await fetch(`${GATEWAY}${path}`, {
    headers: { authorization: `Bearer ${client.token}` },
  });
  return {
    status: res.status,
    type: res.headers.get('content-type'),
    body: Buffer.from(await res.arrayBuffer()),
  };
}

describe('End-to-end: Tutor verification', () => {
  test('a Tutor submits with a 1.5 MB credential, an Admin verifies it; strangers get nothing', async () => {
    const tutor = await newTutor();
    const tutorId = (await tutor.get('/users/me')).body.id as string;
    const { client: admin } = await withClaims('ADMIN');

    const saved = await tutor.put('/tutors/me', {
      kind: 'GRADUATE',
      displayName: 'Trần Thị Bình',
      school: 'Đại học Bách khoa Hà Nội',
      schoolCountry: 'VN',
      subjects: [{ subject: 'Vật lý', gradeFrom: 10, gradeTo: 12, suggestedFee: 250000 }],
      areas: [{ kind: 'LOCAL', provinceCode: 1, wardCode: null }, { kind: 'ONLINE' }],
      availability: [{ weekday: 7, startTime: '08:00', endTime: '11:00' }],
    });
    expect(saved.status).toBe(200);
    const added = await tutor.post('/tutors/me/credentials', {
      kind: 'DEGREE',
      title: 'Kỹ sư Vật lý kỹ thuật',
      issuer: 'Đại học Bách khoa Hà Nội',
      country: 'VN',
      file: { name: 'bang.pdf', contentBase64: file.toString('base64') },
    });
    expect(added.status).toBe(201);
    const credentialId = added.body.credentials[0].id as string;
    expect((await tutor.post('/tutors/me/submit')).body.status).toBe('SUBMITTED');

    // Only an Admin reviews, and the file comes back byte for byte, through the gateway.
    expect((await tutor.get('/tutors')).status).toBe(403);
    const mine = await download(tutor, `/tutors/me/credentials/${credentialId}/file`);
    expect(mine.status).toBe(200);
    expect(mine.body.equals(file)).toBe(true);
    const other = await newTutor();
    expect((await download(other, `/tutors/me/credentials/${credentialId}/file`)).status).toBe(404);
    expect(
      (await download(other, `/tutors/${tutorId}/credentials/${credentialId}/file`)).status,
    ).toBe(403);
    const seen = await download(admin, `/tutors/${tutorId}/credentials/${credentialId}/file`);
    expect(seen.status).toBe(200);
    expect(seen.type).toBe('application/pdf');

    const waiting = await admin.get('/tutors?waiting=true');
    expect(waiting.body.map((r: { tutorId: string }) => r.tutorId)).toContain(tutorId);
    const profile = (await admin.get(`/tutors/${tutorId}`)).body;
    const verified = await admin.post(`/tutors/${tutorId}/review`, {
      decision: 'VERIFY',
      credentials: [{ id: credentialId, status: 'VERIFIED' }],
      subjects: profile.subjects.map((s: { id: string }) => ({ id: s.id, status: 'VERIFIED' })),
    });
    expect(verified.status).toBe(200);
    expect((await tutor.get('/tutors/me')).body.status).toBe('VERIFIED');
  });
});
