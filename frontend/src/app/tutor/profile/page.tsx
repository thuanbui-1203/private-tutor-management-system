'use client';
/**
 * The Tutor's own profile (docs/07 §2): who they are, what and where they teach, when, and the
 * credentials an Admin checks before the profile is verified.
 */
import { useState } from 'react';
import {
  ActionButton,
  Badge,
  Confirm,
  Empty,
  ErrorBox,
  Field,
  Loaded,
  Notice,
  useLoad,
} from '@/components/ui';
import { useLocations } from '@/components/locations';
import { ApiError, api, describeError, downloadFile } from '@/lib/api';
import { formatDate, formatMoney, WEEKDAY_LABEL } from '@/lib/format';
import {
  CREDENTIAL_LABEL,
  fileToBase64,
  gradesLabel,
  ITEM_STATUS,
  KIND_LABEL,
  PROFILE_STATUS,
  type AreaView,
  type CredentialKind,
  type SlotView,
  type TutorKind,
  type TutorProfileView,
} from '@/lib/tutors';

const MAX_BYTES = 5 * 1024 * 1024;
const LOCKED = new Set(['SUBMITTED', 'REJECTED', 'SUSPENDED']);

interface SubjectDraft {
  subject: string;
  gradeFrom: string;
  gradeTo: string;
  suggestedFee: string;
}
const num = (s: string) => (s.trim() === '' ? null : Number(s));

export default function TutorProfilePage() {
  const state = useLoad(() => api.get<TutorProfileView>('/tutors/me'));
  return (
    <>
      <h1>Hồ sơ gia sư</h1>
      <Loaded state={state}>
        {(p) => <Profile profile={p} onChange={(next) => state.setData(next)} />}
      </Loaded>
    </>
  );
}

function Profile({
  profile: p,
  onChange,
}: {
  profile: TutorProfileView;
  onChange: (p: TutorProfileView) => void;
}) {
  const locked = LOCKED.has(p.status);
  const [error, setError] = useState('');
  const [missing, setMissing] = useState<string[]>([]);
  const lastReview = p.reviews?.[0];

  async function submit() {
    setError('');
    setMissing([]);
    try {
      const { data } = await api.post<TutorProfileView>('/tutors/me/submit');
      onChange(data);
    } catch (err) {
      const list =
        err instanceof ApiError ? (err.body as { missing?: string[] } | null)?.missing : undefined;
      if (list) setMissing(list);
      else setError(describeError(err, { 409: 'Không có gì mới để gửi duyệt.' }));
    }
  }

  return (
    <>
      <p className="row">
        <span>Trạng thái:</span>
        <Badge tone={PROFILE_STATUS[p.status][1]}>{PROFILE_STATUS[p.status][0]}</Badge>
      </p>
      {p.status === 'SUBMITTED' && (
        <Notice>Hồ sơ đang chờ quản trị viên duyệt, tạm thời không sửa được.</Notice>
      )}
      {p.status === 'NEEDS_CHANGES' && (
        <Notice tone="warning">
          Quản trị viên yêu cầu bổ sung. Xem ghi chú ở từng mục, sửa rồi gửi lại.
        </Notice>
      )}
      {lastReview?.reason && <Notice tone="warning">Ghi chú gần nhất: {lastReview.reason}</Notice>}
      <BasicsForm profile={p} locked={locked} onSaved={onChange} />
      <Credentials profile={p} locked={locked} onChange={onChange} />
      {!locked && (
        <section className="card" style={{ marginTop: '1rem' }}>
          <h2 style={{ marginTop: 0 }}>Gửi duyệt</h2>
          <p className="hint">
            Cần đủ: loại gia sư, tên hiển thị, trường, ít nhất một môn, một khu vực và một minh
            chứng. Sinh viên cần thẻ sinh viên; giáo viên đang dạy cần xác nhận đã báo Hiệu trưởng.
          </p>
          {missing.length > 0 && (
            <div className="alert error" role="alert">
              Còn thiếu: {missing.join(', ')}
            </div>
          )}
          <ErrorBox error={error} />
          <ActionButton onClick={submit}>Gửi duyệt</ActionButton>
        </section>
      )}
    </>
  );
}

function BasicsForm({
  profile: p,
  locked,
  onSaved,
}: {
  profile: TutorProfileView;
  locked: boolean;
  onSaved: (p: TutorProfileView) => void;
}) {
  const [kind, setKind] = useState<TutorKind | ''>(p.kind ?? '');
  const [displayName, setDisplayName] = useState(p.displayName ?? '');
  const [bio, setBio] = useState(p.bio ?? '');
  const [school, setSchool] = useState(p.school ?? '');
  const [schoolCountry, setSchoolCountry] = useState(p.schoolCountry ?? 'VN');
  const [reported, setReported] = useState(p.reportedToPrincipal);
  const [noOwn, setNoOwn] = useState(p.noOwnPupils);
  const [subjects, setSubjects] = useState<SubjectDraft[]>(
    p.subjects.map((s) => ({
      subject: s.subject,
      gradeFrom: s.gradeFrom?.toString() ?? '',
      gradeTo: s.gradeTo?.toString() ?? '',
      suggestedFee: s.suggestedFee?.toString() ?? '',
    })),
  );
  const [areas, setAreas] = useState<AreaView[]>(p.areas);
  const [slots, setSlots] = useState<SlotView[]>(p.availability);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');

  async function save() {
    setError('');
    setSaved('');
    try {
      const { data } = await api.put<TutorProfileView>('/tutors/me', {
        kind: kind || null,
        displayName: displayName.trim() || null,
        bio: bio.trim() || null,
        school: school.trim() || null,
        schoolCountry: schoolCountry.trim().toUpperCase() || null,
        reportedToPrincipal: reported,
        noOwnPupils: noOwn,
        subjects: subjects.map((s) => ({
          subject: s.subject.trim(),
          gradeFrom: num(s.gradeFrom),
          gradeTo: num(s.gradeTo),
          suggestedFee: num(s.suggestedFee),
        })),
        areas,
        availability: slots,
      });
      onSaved(data);
      setSaved(
        p.status === 'VERIFIED' && data.status === 'SUBMITTED'
          ? 'Đã lưu. Bạn đổi thông tin nhận dạng nên hồ sơ được duyệt lại.'
          : 'Đã lưu.',
      );
    } catch (err) {
      setError(describeError(err, { 409: 'Hồ sơ đang bị khóa, chưa sửa được.' }));
    }
  }

  return (
    <form className="card stack" onSubmit={(e) => e.preventDefault()} aria-label="Thông tin gia sư">
      <h2 style={{ marginTop: 0 }}>Thông tin</h2>
      <fieldset disabled={locked} className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="grid">
          <Field label="Bạn là">
            <select value={kind} onChange={(e) => setKind(e.target.value as TutorKind | '')}>
              <option value="">Chọn</option>
              {Object.entries(KIND_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Tên hiển thị">
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </Field>
          <Field label="Trường" hint="Nơi bạn đang học, đã học hoặc đang dạy">
            <input value={school} onChange={(e) => setSchool(e.target.value)} />
          </Field>
          <Field label="Quốc gia của trường" hint="Mã 2 chữ, ví dụ VN, JP">
            <input
              value={schoolCountry}
              maxLength={2}
              onChange={(e) => setSchoolCountry(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Giới thiệu">
          <textarea rows={3} value={bio} onChange={(e) => setBio(e.target.value)} />
        </Field>
        {kind === 'TEACHER' && (
          <div className="stack">
            <label>
              <input
                type="checkbox"
                checked={reported}
                onChange={(e) => setReported(e.target.checked)}
              />{' '}
              Tôi đã báo cáo Hiệu trưởng về việc dạy thêm (môn, địa điểm, thời gian)
            </label>
            <label>
              <input type="checkbox" checked={noOwn} onChange={(e) => setNoOwn(e.target.checked)} />{' '}
              Tôi không nhận dạy có thu tiền học sinh mà trường phân công tôi dạy
            </label>
          </div>
        )}

        <h3>Môn dạy</h3>
        {subjects.length === 0 && <Empty>Chưa có môn nào.</Empty>}
        {subjects.map((s, i) => {
          const set = (patch: Partial<SubjectDraft>) =>
            setSubjects(subjects.map((x, j) => (j === i ? { ...x, ...patch } : x)));
          const reviewed = p.subjects.find(
            (r) => r.subject === s.subject && `${r.gradeFrom ?? ''}` === s.gradeFrom,
          );
          return (
            <div key={i} className="row" style={{ alignItems: 'flex-end' }}>
              <Field label="Môn">
                <input value={s.subject} onChange={(e) => set({ subject: e.target.value })} />
              </Field>
              <Field label="Từ lớp">
                <input
                  inputMode="numeric"
                  value={s.gradeFrom}
                  onChange={(e) => set({ gradeFrom: e.target.value })}
                />
              </Field>
              <Field label="Đến lớp">
                <input
                  inputMode="numeric"
                  value={s.gradeTo}
                  onChange={(e) => set({ gradeTo: e.target.value })}
                />
              </Field>
              <Field label="Học phí gợi ý (₫/buổi)">
                <input
                  inputMode="numeric"
                  value={s.suggestedFee}
                  onChange={(e) => set({ suggestedFee: e.target.value.replace(/\D/g, '') })}
                />
              </Field>
              {reviewed && (
                <Badge tone={ITEM_STATUS[reviewed.status][1]}>
                  {ITEM_STATUS[reviewed.status][0]}
                </Badge>
              )}
              <button
                type="button"
                className="btn secondary small"
                onClick={() => setSubjects(subjects.filter((_, j) => j !== i))}
              >
                Bỏ môn
              </button>
            </div>
          );
        })}
        <div>
          <button
            type="button"
            className="btn secondary small"
            onClick={() =>
              setSubjects([
                ...subjects,
                { subject: '', gradeFrom: '', gradeTo: '', suggestedFee: '' },
              ])
            }
          >
            Thêm môn
          </button>
        </div>

        <h3>Khu vực dạy</h3>
        <AreasEditor areas={areas} onChange={setAreas} />

        <h3>Giờ rảnh</h3>
        <SlotsEditor slots={slots} onChange={setSlots} />

        <ErrorBox error={error} />
        {saved && <Notice tone="success">{saved}</Notice>}
        <div>
          <ActionButton type="submit" onClick={save}>
            Lưu thông tin
          </ActionButton>
        </div>
      </fieldset>
    </form>
  );
}

function AreasEditor({
  areas,
  onChange,
}: {
  areas: AreaView[];
  onChange: (a: AreaView[]) => void;
}) {
  const places = useLocations(areas);
  const [kind, setKind] = useState<AreaView['kind']>('LOCAL');
  const [province, setProvince] = useState('');
  const [ward, setWard] = useState('');
  const [country, setCountry] = useState('');
  const [city, setCity] = useState('');
  const [timezone, setTimezone] = useState('');
  const add = () => {
    const area: AreaView =
      kind === 'ONLINE'
        ? { kind }
        : kind === 'LOCAL'
          ? { kind, provinceCode: Number(province), wardCode: ward ? Number(ward) : null }
          : {
              kind,
              country: country.toUpperCase(),
              city: city || null,
              timezone: timezone || null,
            };
    onChange([...areas, area]);
  };
  const valid =
    kind === 'ONLINE' ||
    (kind === 'LOCAL' && /^\d+$/.test(province)) ||
    (kind === 'ABROAD' && /^[a-zA-Z]{2}$/.test(country));
  return (
    <div className="stack">
      {areas.length === 0 && <Empty>Chưa có khu vực nào.</Empty>}
      <ul>
        {areas.map((a, i) => (
          <li key={i}>
            {places.label(a)}{' '}
            <button
              type="button"
              className="link"
              onClick={() => onChange(areas.filter((_, j) => j !== i))}
            >
              Bỏ
            </button>
          </li>
        ))}
      </ul>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <Field label="Hình thức">
          <select value={kind} onChange={(e) => setKind(e.target.value as AreaView['kind'])}>
            <option value="LOCAL">Tại Việt Nam</option>
            <option value="ONLINE">Online</option>
            <option value="ABROAD">Ở nước ngoài</option>
          </select>
        </Field>
        {kind === 'LOCAL' && (
          <>
            <Field label="Tỉnh/Thành phố">
              <select
                value={province}
                onChange={(e) => {
                  setProvince(e.target.value);
                  setWard('');
                  if (e.target.value) places.loadWards(Number(e.target.value));
                }}
              >
                <option value="">Chọn tỉnh/thành phố</option>
                {places.provinces.map((p) => (
                  <option key={p.code} value={p.code}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Phường/Xã">
              <select value={ward} disabled={!province} onChange={(e) => setWard(e.target.value)}>
                <option value="">Cả tỉnh/thành phố</option>
                {(places.wards[Number(province)] ?? []).map((w) => (
                  <option key={w.code} value={w.code}>
                    {w.name}
                  </option>
                ))}
              </select>
            </Field>
          </>
        )}
        {kind === 'ABROAD' && (
          <>
            <Field label="Quốc gia (mã 2 chữ)">
              <input maxLength={2} value={country} onChange={(e) => setCountry(e.target.value)} />
            </Field>
            <Field label="Thành phố">
              <input value={city} onChange={(e) => setCity(e.target.value)} />
            </Field>
            <Field label="Múi giờ" hint="Ví dụ Asia/Tokyo">
              <input value={timezone} onChange={(e) => setTimezone(e.target.value)} />
            </Field>
          </>
        )}
        <button type="button" className="btn secondary small" disabled={!valid} onClick={add}>
          Thêm khu vực
        </button>
      </div>
    </div>
  );
}

function SlotsEditor({
  slots,
  onChange,
}: {
  slots: SlotView[];
  onChange: (s: SlotView[]) => void;
}) {
  const [weekday, setWeekday] = useState(2);
  const [start, setStart] = useState('18:00');
  const [end, setEnd] = useState('20:00');
  return (
    <div className="stack">
      {slots.length === 0 && <Empty>Chưa có giờ rảnh nào.</Empty>}
      <ul>
        {slots.map((s, i) => (
          <li key={i}>
            {WEEKDAY_LABEL[s.weekday]} {s.startTime}–{s.endTime}{' '}
            <button
              type="button"
              className="link"
              onClick={() => onChange(slots.filter((_, j) => j !== i))}
            >
              Bỏ
            </button>
          </li>
        ))}
      </ul>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <Field label="Thứ">
          <select value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
            {Object.entries(WEEKDAY_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Từ">
          <input type="time" value={start} onChange={(e) => setStart(e.target.value)} />
        </Field>
        <Field label="Đến">
          <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
        </Field>
        <button
          type="button"
          className="btn secondary small"
          disabled={!(start < end)}
          onClick={() =>
            onChange([
              ...slots,
              { weekday, startTime: start, endTime: end, timezone: 'Asia/Ho_Chi_Minh' },
            ])
          }
        >
          Thêm giờ rảnh
        </button>
      </div>
    </div>
  );
}

function Credentials({
  profile: p,
  locked,
  onChange,
}: {
  profile: TutorProfileView;
  locked: boolean;
  onChange: (p: TutorProfileView) => void;
}) {
  const [kind, setKind] = useState<CredentialKind>('STUDENT_CARD');
  const [title, setTitle] = useState('');
  const [issuer, setIssuer] = useState('');
  const [country, setCountry] = useState('VN');
  const [number, setNumber] = useState('');
  const [issuedOn, setIssuedOn] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
  const fileError =
    file && file.size > MAX_BYTES
      ? 'Tệp lớn hơn 5 MB. Hãy dán link Google Drive vào phần giới thiệu.'
      : '';

  async function add() {
    setError('');
    if (!file) return;
    try {
      const { data } = await api.post<TutorProfileView>('/tutors/me/credentials', {
        kind,
        title: title.trim(),
        issuer: issuer.trim(),
        country: country.trim().toUpperCase(),
        number: number.trim() || null,
        issuedOn: issuedOn || null,
        expiresOn: expiresOn || null,
        file: { name: file.name, contentBase64: await fileToBase64(file) },
      });
      onChange(data);
      setTitle('');
      setNumber('');
      setFile(null);
    } catch (err) {
      setError(
        describeError(err, {
          413: 'Tệp lớn hơn 5 MB.',
          422: 'Chỉ nhận tệp PDF, PNG hoặc JPEG.',
          507: 'Kho lưu trữ đã đầy. Vui lòng báo quản trị viên.',
        }),
      );
    }
  }

  return (
    <section className="card" style={{ marginTop: '1rem' }} aria-label="Minh chứng">
      <h2 style={{ marginTop: 0 }}>Minh chứng (bằng cấp, chứng chỉ, thẻ sinh viên, bảng điểm)</h2>
      <p className="hint">
        Không tải ảnh căn cước. Che những thông tin không cần thiết trước khi tải lên. Tệp chỉ bạn
        và quản trị viên xem được.
      </p>
      {p.credentials.length === 0 ? (
        <Empty>Chưa có minh chứng nào.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Loại</th>
                <th>Tên</th>
                <th>Nơi cấp</th>
                <th>Hiệu lực</th>
                <th>Trạng thái</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {p.credentials.map((c) => (
                <tr key={c.id}>
                  <td>{CREDENTIAL_LABEL[c.kind]}</td>
                  <td>{c.title}</td>
                  <td>
                    {c.issuer} ({c.country})
                  </td>
                  <td>{c.expiresOn ? `đến ${formatDate(c.expiresOn)}` : 'Không thời hạn'}</td>
                  <td>
                    <Badge tone={ITEM_STATUS[c.status][1]}>{ITEM_STATUS[c.status][0]}</Badge>
                    {c.reviewNote && <div className="hint">{c.reviewNote}</div>}
                  </td>
                  <td className="row">
                    {c.file && (
                      <button
                        type="button"
                        className="btn secondary small"
                        onClick={() =>
                          downloadFile(`/tutors/me/credentials/${c.id}/file`, c.file!.name).catch(
                            (e) => setError(describeError(e)),
                          )
                        }
                      >
                        Tải tệp
                      </button>
                    )}
                    {!locked && (
                      <button
                        type="button"
                        className="btn secondary small"
                        onClick={() => setRemoving(c.id)}
                      >
                        Xóa
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!locked && (
        <form className="stack" onSubmit={(e) => e.preventDefault()} style={{ marginTop: '1rem' }}>
          <h3>Thêm minh chứng</h3>
          <div className="grid">
            <Field label="Loại">
              <select value={kind} onChange={(e) => setKind(e.target.value as CredentialKind)}>
                {Object.entries(CREDENTIAL_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Tên minh chứng">
              <input value={title} onChange={(e) => setTitle(e.target.value)} />
            </Field>
            <Field label="Nơi cấp">
              <input value={issuer} onChange={(e) => setIssuer(e.target.value)} />
            </Field>
            <Field label="Quốc gia nơi cấp (mã 2 chữ)">
              <input maxLength={2} value={country} onChange={(e) => setCountry(e.target.value)} />
            </Field>
            <Field label="Số hiệu" hint="Không bắt buộc; chỉ quản trị viên thấy">
              <input value={number} onChange={(e) => setNumber(e.target.value)} />
            </Field>
            <Field label="Ngày cấp">
              <input type="date" value={issuedOn} onChange={(e) => setIssuedOn(e.target.value)} />
            </Field>
            <Field label="Hết hạn" hint="Để trống nếu không có hạn">
              <input type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
            </Field>
            <Field label="Tệp (PDF, PNG, JPEG, tối đa 5 MB)">
              <input
                type="file"
                accept="application/pdf,image/png,image/jpeg"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </Field>
          </div>
          <ErrorBox error={fileError || error} />
          <div>
            <ActionButton
              type="submit"
              onClick={add}
              busyLabel="Đang tải lên…"
              disabled={
                !file ||
                !!fileError ||
                !title.trim() ||
                !issuer.trim() ||
                !/^[a-zA-Z]{2}$/.test(country)
              }
            >
              Tải lên
            </ActionButton>
          </div>
        </form>
      )}
      <Confirm
        open={removing !== null}
        title="Xóa minh chứng này?"
        confirmLabel="Xóa minh chứng"
        onCancel={() => setRemoving(null)}
        onConfirm={async () => {
          const id = removing!;
          setRemoving(null);
          try {
            const { data } = await api.delete<TutorProfileView>(`/tutors/me/credentials/${id}`);
            onChange(data);
          } catch (err) {
            setError(describeError(err));
          }
        }}
      >
        <p>Tệp đính kèm cũng bị xóa khỏi kho lưu trữ.</p>
      </Confirm>
      <p className="hint">
        {p.subjects.length > 0 &&
          `Môn đã khai: ${p.subjects.map((s) => `${s.subject} (${gradesLabel(s)}${s.suggestedFee ? `, ${formatMoney(s.suggestedFee)}` : ''})`).join('; ')}`}
      </p>
    </section>
  );
}
