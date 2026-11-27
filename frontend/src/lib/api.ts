/**
 * The API client: every call to the gateway goes through here. It attaches
 * `Authorization: Bearer <ID token>`, parses JSON and turns HTTP failures into typed errors.
 * 401 signs the user out (the session was revoked or expired); the screens decide what to
 * show for the rest, usually through `describeError`.
 */
import { config } from './config';

export type ApiErrorKind =
  'unauthorized' | 'forbidden' | 'not-found' | 'business' | 'invalid' | 'unavailable';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly kind: ApiErrorKind,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
  }
}

export interface ApiResponse<T> {
  status: number;
  data: T;
}

interface Hooks {
  idToken(): Promise<string | null>;
  onUnauthorized(): void;
}
let hooks: Hooks = { idToken: async () => null, onUnauthorized: () => undefined };

/** Wired once by <ApiBridge> with the auth module. */
export function configureApi(h: Hooks) {
  hooks = h;
}

function kindOf(status: number): ApiErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  if (status === 400) return 'invalid';
  if (status === 409 || status === 410 || status === 422) return 'business';
  return 'unavailable';
}

function messageOf(body: unknown): string {
  const m = (body as { message?: unknown } | null)?.message;
  if (Array.isArray(m)) return m.join('; ');
  if (typeof m === 'string') return m;
  return '';
}

type Query = Record<string, string | number | undefined>;

export async function request<T>(
  method: string,
  path: string,
  options: { body?: unknown; query?: Query; auth?: boolean } = {},
): Promise<ApiResponse<T>> {
  const url = new URL(`${config.apiUrl}${path}`);
  for (const [k, v] of Object.entries(options.query ?? {})) {
    if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  }
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.auth !== false) {
    const token = await hooks.idToken();
    if (token) headers.authorization = `Bearer ${token}`;
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new ApiError(0, 'unavailable', 'network error', null);
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const err = new ApiError(res.status, kindOf(res.status), messageOf(data), data);
    if (err.kind === 'unauthorized' && options.auth !== false) hooks.onUnauthorized();
    throw err;
  }
  return { status: res.status, data: data as T };
}

export const api = {
  get: <T>(path: string, query?: Query) => request<T>('GET', path, { query }).then((r) => r.data),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, { body: body ?? {} }),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, { body: body ?? {} }),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, { body: body ?? {} }),
  delete: <T>(path: string) => request<T>('DELETE', path),
};

/** Downloads a protected file (an attachment) with the signed-in user's token, and saves it. */
export async function downloadFile(path: string, fallbackName = 'tep-tin'): Promise<void> {
  const token = await hooks.idToken();
  let res: Response;
  try {
    res = await fetch(`${config.apiUrl}${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  } catch {
    throw new ApiError(0, 'unavailable', 'network error', null);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(res.status, kindOf(res.status), messageOf(body), body);
  }
  const name =
    decodeURIComponent(
      res.headers.get('content-disposition')?.match(/filename\*=UTF-8''([^;]+)/)?.[1] ?? '',
    ) || fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** A Vietnamese sentence for an error, with the API's own detail for business rules. */
export function describeError(err: unknown, byStatus?: Partial<Record<number, string>>): string {
  if (!(err instanceof ApiError)) return 'Đã có lỗi không mong muốn. Vui lòng thử lại.';
  const own = byStatus?.[err.status];
  if (own) return own;
  switch (err.kind) {
    case 'unavailable':
      return 'Hệ thống đang tạm thời không phản hồi. Dữ liệu của bạn vẫn an toàn, vui lòng thử lại sau ít phút.';
    case 'forbidden':
      return 'Bạn không có quyền thực hiện thao tác này.';
    case 'not-found':
      return 'Không tìm thấy dữ liệu (có thể đã bị xóa hoặc bạn không có quyền xem).';
    case 'unauthorized':
      return 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.';
    case 'invalid':
      return `Dữ liệu chưa hợp lệ${err.message ? `: ${err.message}` : '.'}`;
    default:
      return `Không thực hiện được${err.message ? `: ${err.message}` : '.'}`;
  }
}
