import { Controller, Get, NotFoundException, Param, ParseIntPipe } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PROVINCES, WARDS } from './vn-locations';

/** Vietnamese provinces and wards after the 2025 reform (34 provinces, no districts). */
const provinceName = new Map(PROVINCES);
const wardsOf = new Map<number, { code: number; name: string }[]>();
const wardProvince = new Map<number, number>();
for (const [code, name, province] of WARDS) {
  wardsOf.set(province, [...(wardsOf.get(province) ?? []), { code, name }]);
  wardProvince.set(code, province);
}
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'vi');
for (const list of wardsOf.values()) list.sort(byName);

export const isProvince = (code: number) => provinceName.has(code);
/** Whether the ward exists and lies in that province. */
export const wardIn = (ward: number, province: number) => wardProvince.get(ward) === province;

/** Lists for the forms. Any signed-in user may read them. */
@ApiTags('locations')
@Controller('tutors/locations')
export class LocationsController {
  @Get('provinces')
  provinces() {
    return PROVINCES.map(([code, name]) => ({ code, name })).sort(byName);
  }

  @Get('provinces/:code/wards')
  wards(@Param('code', ParseIntPipe) code: number) {
    if (!isProvince(code)) throw new NotFoundException('province not found');
    return wardsOf.get(code) ?? [];
  }
}
