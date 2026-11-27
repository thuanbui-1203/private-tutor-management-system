'use client';
/** Vietnamese provinces and wards (tutor-service's copy, docs/07 §3), loaded as needed. */
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { AreaView } from '@/lib/tutors';
import { useLoad } from './ui';

export interface Place {
  code: number;
  name: string;
}

export function useLocations(areas: AreaView[] = []) {
  const provinces = useLoad(() => api.get<Place[]>('/tutors/locations/provinces'));
  const [wards, setWards] = useState<Record<number, Place[]>>({});

  const loadWards = useCallback((province: number) => {
    api.get<Place[]>(`/tutors/locations/provinces/${province}/wards`).then(
      (list) => setWards((w) => (w[province] ? w : { ...w, [province]: list })),
      () => undefined, // the codes are shown instead
    );
  }, []);

  // The wards of the provinces already chosen, to show their names.
  const shown = [
    ...new Set(areas.flatMap((a) => (a.kind === 'LOCAL' && a.wardCode ? [a.provinceCode] : []))),
  ];
  const key = shown.join(',');
  useEffect(() => {
    for (const p of key ? key.split(',').map(Number) : []) loadWards(p);
  }, [key, loadWards]);

  const provinceName = (code: number) =>
    provinces.data?.find((p) => p.code === code)?.name ?? `tỉnh mã ${code}`;
  const label = (a: AreaView) => {
    if (a.kind === 'ONLINE') return 'Dạy online';
    if (a.kind === 'ABROAD')
      return `Nước ngoài: ${a.country}${a.city ? `, ${a.city}` : ''}${a.timezone ? ` (${a.timezone})` : ''}`;
    if (!a.wardCode) return `${provinceName(a.provinceCode)} (cả tỉnh)`;
    const ward =
      wards[a.provinceCode]?.find((w) => w.code === a.wardCode)?.name ??
      `phường/xã mã ${a.wardCode}`;
    return `${ward}, ${provinceName(a.provinceCode)}`;
  };
  return { provinces: provinces.data ?? [], wards, loadWards, label };
}

/** Service areas with place names, e.g. "Phường Sài Gòn, Thành phố Hồ Chí Minh; Dạy online". */
export function AreaList({ areas }: { areas: AreaView[] }) {
  const { label } = useLocations(areas);
  return <>{areas.map(label).join('; ') || '—'}</>;
}
