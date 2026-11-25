"""
TMS Load Tester
===============

Bản gọn của tools/flow-simulator (app gốc giữ nguyên để học), dùng cho demo trên VPS:

1. Tab "Luồng endpoint": mô phỏng từng bước một request đi qua API Gateway
   (resolveRoute -> rate limit IP -> verify Firebase token -> rate limit user -> proxy)
   -> service -> PostgreSQL -> outbox -> RabbitMQ -> consumer, và Access record cho
   audit-service. Có thể gửi request thật tới gateway (mặc định: VPS).
2. Tab "Stress test": các virtual user (thread) gọi HTTP thật qua gateway. App không vẽ
   biểu đồ: kết quả xem trên Grafana (dashboard "TMS – Luồng API"); app đánh dấu khoảng
   thời gian chạy lên dashboard bằng annotation.

Chỉ dùng thư viện chuẩn (Python 3.10+).   Chạy:  python tools/load-tester/tms_load.py
"""
from __future__ import annotations

import json
import os
import queue
import random
import re
import threading
import time
import tkinter as tk
import urllib.error
import urllib.request
import webbrowser
from base64 import b64encode
from collections import Counter, deque
from dataclasses import dataclass
from pathlib import Path
from tkinter import messagebox, ttk

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_API = "https://api.timgiasu.date/api"
DEFAULT_GRAFANA = "http://localhost:3030"
DASHBOARD_UID = "tms-api"
DEMO_ACCOUNTS = "gv.minh@tms.demo, gv.lan@tms.demo"
DEMO_PASSWORD = os.environ.get("DEMO_PASSWORD", "")  # never in the source: the repo is public
SAMPLE_ID = "00000000-0000-4000-8000-000000000001"
USER_AGENT = "TMS-LoadTester/1.0 (+tools/load-tester)"


def read_env(*files: Path) -> dict:
    """KEY=value của các file .env (file sau ghi đè file trước); file thiếu thì bỏ qua."""
    out = {}
    for f in files:
        if f.exists():
            for line in f.read_text(encoding="utf-8").splitlines():
                m = re.match(r"^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$", line)
                if m:
                    out[m[1]] = m[2].strip("\"'")
    return out


ENV = read_env(ROOT / ".env", ROOT / "frontend" / ".env.local")

# ----------------------------------------------------------------------------------
# Mô hình hệ thống (lấy từ backend: routes.ts, gateway.service.ts, các controller)
# ----------------------------------------------------------------------------------

SERVICES = ["identity", "student", "class", "schedule", "billing", "audit"]

EVENT_CONSUMERS = {
    "UserRegistered": ["student"], "StudentCreated": ["billing"], "StudentUpdated": ["billing"],
    "StudentStatusChanged": ["billing", "class"], "ClassCreated": ["schedule", "billing"],
    "ClassUpdated": ["schedule", "billing"], "ClassClosed": ["schedule"],
    "StudentEnrolled": ["schedule", "billing"], "StudentWithdrawn": ["schedule", "billing"],
    "EnrollmentConfirmed": ["class"], "SessionScheduled": ["billing"], "SessionCancelled": ["billing"],
    "SessionRescheduled": ["billing"], "AttendanceRecorded": ["billing"], "PaymentReceived": ["class"],
}
FOLLOW_UP = {("schedule", "StudentEnrolled"): "EnrollmentConfirmed"}  # saga ghi danh


@dataclass(frozen=True)
class Endpoint:
    method: str
    path: str
    service: str
    events: tuple = ()
    desc: str = ""
    access: str = "role"  # public | token-only | role

    @property
    def label(self) -> str:
        return f"{self.method} {self.path}"

    @property
    def write(self) -> bool:
        return self.method != "GET" and not self.path.endswith("/preview")

    def sample_path(self) -> str:
        return re.sub(r"\{[^}]+\}", SAMPLE_ID, self.path)


E = Endpoint
ENDPOINTS = [
    E("POST", "/auth/register", "identity", ("UserRegistered",), "Tutor tự đăng ký", "token-only"),
    E("POST", "/auth/invitations/{token}/accept", "identity", ("UserRegistered",), "Chấp nhận lời mời", "public"),
    E("GET", "/users/me", "identity", desc="Tài khoản hiện tại"),
    E("GET", "/users", "identity", desc="Danh sách user (Admin)"),
    E("GET", "/students", "student", desc="Danh sách học sinh"),
    E("POST", "/students", "student", ("StudentCreated",), "Tạo học sinh"),
    E("PATCH", "/students/{id}", "student", ("StudentUpdated",), "Sửa học sinh"),
    E("GET", "/parents/me/children", "student", desc="Parent xem các con"),
    E("GET", "/classes", "class", desc="Danh sách lớp"),
    E("POST", "/classes", "class", ("ClassCreated",), "Tạo lớp"),
    E("POST", "/classes/{id}/enrollments", "class", ("StudentEnrolled",), "Ghi danh (saga qua schedule)"),
    E("GET", "/schedules", "schedule", desc="Danh sách lịch"),
    E("GET", "/sessions", "schedule", desc="Danh sách buổi học"),
    E("PUT", "/sessions/{id}/attendance", "schedule", ("AttendanceRecorded",), "Điểm danh -> tính phí"),
    E("GET", "/billing/invoices", "billing", desc="Danh sách hoá đơn (Tutor, Admin)"),
    E("POST", "/billing/invoices/{id}/payments", "billing", ("PaymentReceived",), "Ghi nhận thanh toán"),
    E("GET", "/billing/bank-account", "billing", desc="Tài khoản ngân hàng (số đã che)"),
    E("GET", "/audit/access", "audit", desc="Access record (Admin)"),
    E("GET", "/audit/changes", "audit", desc="Change record của 5 service (Admin)"),
]

# GET mà một Tutor gọi được (200): dùng cho stress test, không ghi gì vào dữ liệu demo.
TUTOR_READS = [e for e in ENDPOINTS if e.method == "GET" and e.path in (
    "/users/me", "/students", "/classes", "/schedules", "/sessions", "/billing/invoices", "/billing/bank-account")]
assert len(TUTOR_READS) == 7 and all(e.method == "GET" for e in TUTOR_READS)
NOT_FOUND = E("GET", "/khong-ton-tai", "-", desc="Route không có -> gateway trả 404")


def resolve_route(method: str, path: str):
    """Bản rút gọn của resolveRoute() trong routes.ts -> (kind, service)."""
    path = path.split("?")[0]
    if re.search(r"(^|/)internal(/|$)", path):
        return "not-found", None
    if re.match(r"^/students/[^/]+/classes$", path):
        return "service", "class"
    if re.match(r"^/students/[^/]+/attendance$", path):
        return "service", "schedule"
    prefix = {"auth": "identity", "users": "identity", "students": "student", "parents": "student",
              "classes": "class", "schedules": "schedule", "sessions": "schedule",
              "billing": "billing", "audit": "audit"}
    service = prefix.get(path.split("/")[1] if path.count("/") else "")
    return ("service", service) if service else ("not-found", None)


# ----------------------------------------------------------------------------------
# HTTP, Firebase, Grafana
# ----------------------------------------------------------------------------------

def http(method, url, token=None, body=None, timeout=35, headers=None):
    """-> (status, ms, headers, body text). status 0 = lỗi kết nối.

    User-Agent riêng: Cloudflare chặn User-Agent mặc định "Python-urllib" (403, error 1010),
    nên request tới VPS (qua Cloudflare Tunnel) sẽ không tới được gateway nếu thiếu nó.
    """
    h = {"content-type": "application/json", "user-agent": USER_AGENT, **(headers or {})}
    if token:
        h["authorization"] = "Bearer " + token
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, (time.perf_counter() - t0) * 1000, dict(r.headers), r.read(4000).decode(errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, (time.perf_counter() - t0) * 1000, dict(e.headers), e.read(4000).decode(errors="replace")
    except Exception as e:  # noqa: BLE001 - kết nối hỏng, timeout
        return 0, (time.perf_counter() - t0) * 1000, {}, f"{type(e).__name__}: {e}"


def firebase_login(api_key, email, password):
    """Firebase Auth REST (giống frontend) -> ID token, hết hạn sau 1 giờ."""
    url = f"https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key={api_key}"
    status, _, _, body = http("POST", url, body={"email": email, "password": password, "returnSecureToken": True})
    data = json.loads(body) if body.startswith("{") else {}
    if status != 200:
        raise RuntimeError(f"{email}: {data.get('error', {}).get('message', body[:120])}")
    return data["idToken"]


class Grafana:
    """Annotation trên dashboard TMS: một vùng tô màu cho mỗi lần stress test."""

    def __init__(self, base, user, password):
        self.base = base.rstrip("/")
        self.auth = {"authorization": "Basic " + b64encode(f"{user}:{password}".encode()).decode()}

    def start(self, text):
        status, _, _, body = http("POST", self.base + "/api/annotations", headers=self.auth, timeout=5, body={
            "dashboardUID": DASHBOARD_UID, "time": int(time.time() * 1000), "tags": ["stress-test"], "text": text})
        return json.loads(body).get("id") if status == 200 else None

    def end(self, ann_id, text):
        if ann_id:
            http("PATCH", f"{self.base}/api/annotations/{ann_id}", headers=self.auth, timeout=5,
                 body={"timeEnd": int(time.time() * 1000), "text": text})

    def url(self, since_ms):
        return f"{self.base}/d/{DASHBOARD_UID}?from={since_ms - 60_000}&to=now&refresh=5s"


# ----------------------------------------------------------------------------------
# Tab 1: luồng endpoint
# ----------------------------------------------------------------------------------

STAGES = [
    ("client", "Client"), ("route", "1. resolveRoute"), ("rl_ip", "2. Rate limit IP (Redis)"),
    ("auth", "3. Verify token (Firebase)"), ("rl_user", "4. Rate limit user (Redis)"),
    ("proxy", "5. Proxy -> service"), ("service", "Service (guard, zod)"), ("db", "PostgreSQL"),
    ("rabbit", "Outbox -> RabbitMQ"), ("consumers", "Consumer (service khác)"), ("audit", "audit-service"),
]
SCENARIOS = ["Thành công", "Thiếu token -> 401", "Token sai / hết hạn -> 401", "Chưa có role -> 403",
             "Vượt rate limit IP -> 429", "Vượt rate limit user -> 429", "Body không hợp lệ -> 400",
             "Service sập -> 502", "Timeout 30s -> 504", "Consumer sập (event chờ trong queue)"]
COLORS = {"ok": "#16a34a", "err": "#dc2626", "warn": "#d97706", "event": "#ea580c", "info": "#4f46e5",
          "idle": "#e2e8f0", "idle_fg": "#475569"}


def simulate(ep: Endpoint, sc: str):
    """Các bước (stage, dòng log, màu) của một request theo kịch bản."""
    path = ep.sample_path()
    steps = [("client", f"{ep.method} /api{path}", "info")]
    access_rec = ("audit", "Gateway gửi Access record (status, path, userId, IP) -> tms.audit; "
                           "audit-service INSERT access_log", "event")

    def fail(stage, status, msg):
        return steps + [(stage, f"=> {status} {msg}", "err"), access_rec]

    kind, service = resolve_route(ep.method, path)
    steps.append(("route", f"resolveRoute -> {kind}" + (f", service={service}" if service else ""), "info"))
    if kind != "service":
        return fail("route", 404, "not found")
    steps.append(("rl_ip", "Redis INCR rl:ip:<ip>:<phút> (giới hạn 600/phút/IP)", "info"))
    if sc.startswith("Vượt rate limit IP"):
        return fail("rl_ip", 429, "too many requests (retry-after)")
    if ep.access == "public":
        steps.append(("auth", "Route public: không cần token", "info"))
    else:
        if sc.startswith("Thiếu token"):
            return fail("auth", 401, "missing Firebase ID token")
        steps.append(("auth", "verifyIdToken(token, checkRevoked) -> claims {userId, role}", "info"))
        if sc.startswith("Token sai"):
            return fail("auth", 401, "invalid, expired or revoked Firebase ID token")
        if sc.startswith("Chưa có role") and ep.access == "role":
            return fail("auth", 403, "account has no role yet")
        if ep.access == "role":
            steps.append(("rl_user", "Redis INCR rl:user:<userId>:<phút> (giới hạn 300/phút/user)", "info"))
            if sc.startswith("Vượt rate limit user"):
                return fail("rl_user", 429, "too many requests")
    steps.append(("proxy", f"proxy -> {service}-service{path}, gắn x-user-id / x-user-role, timeout 30s", "info"))
    if sc.startswith("Service sập"):
        return fail("proxy", 502, f"{service}-service không phản hồi (ECONNREFUSED)")
    if sc.startswith("Timeout"):
        return steps + [("service", "Request chờ connection pool DB quá 30 giây", "warn")] + fail("proxy", 504, "upstream timeout")[-2:]
    steps.append(("service", "RolesGuard kiểm tra x-user-role; ZodValidationPipe kiểm tra body", "info"))
    if sc.startswith("Body không hợp lệ"):
        return fail("service", 400, "body không khớp schema @tms/contracts")
    if ep.write:
        outbox = " + INSERT outbox" if ep.events else ""
        steps.append(("db", f"BEGIN; UPDATE/INSERT{outbox} + INSERT audit_log (Change record); COMMIT", "info"))
    else:
        steps.append(("db", "SELECT ... (lọc theo quyền của người gọi)", "info"))
    code = 201 if ep.method == "POST" else 200
    steps += [("client", f"=> {code} (client đã có response; phần sau chạy bất đồng bộ)", "ok"), access_rec]
    pending = [(ep.service, ev) for ev in ep.events]
    while pending:
        publisher, ev = pending.pop(0)
        steps.append(("rabbit", f"Outbox relay ({publisher}) publish '{ev}'", "event"))
        for i, cons in enumerate(EVENT_CONSUMERS.get(ev, [])):
            if sc.startswith("Consumer sập") and i == 0:
                steps.append(("consumers", f"{cons}-service sập: '{ev}' nằm chờ trong queue (at-least-once)", "warn"))
                continue
            steps.append(("consumers", f"{cons}: nhận '{ev}', INSERT processed_events (idempotent), cập nhật DB", "event"))
            if (cons, ev) in FOLLOW_UP:
                pending.append((cons, FOLLOW_UP[(cons, ev)]))
    return steps


class FlowTab(ttk.Frame):
    def __init__(self, master, app):
        super().__init__(master, padding=8)
        self.app = app
        self.scenario = tk.StringVar(value=SCENARIOS[0])
        self.path = tk.StringVar()
        self.token = None
        self.job = None
        self.ep_by_iid = {}

        left = ttk.Frame(self)
        left.pack(side="left", fill="y")
        self.tree = ttk.Treeview(left, show="tree", height=18, selectmode="browse")
        self.tree.pack(fill="y", expand=True)
        groups = {s: self.tree.insert("", "end", text=f"{s}-service", open=True) for s in SERVICES}
        for ep in ENDPOINTS:
            self.ep_by_iid[self.tree.insert(groups[ep.service], "end", text=f"{ep.method:<6} {ep.path}")] = ep
        self.tree.bind("<<TreeviewSelect>>", self._select)
        self.desc = ttk.Label(left, wraplength=300, foreground="#475569")
        self.desc.pack(anchor="w", pady=4)
        ttk.Combobox(left, textvariable=self.scenario, values=SCENARIOS, state="readonly").pack(fill="x")
        ttk.Button(left, text="▶ Mô phỏng", command=self.run_sim).pack(fill="x", pady=(4, 10))
        ttk.Label(left, text="Gửi thật (tài khoản đầu tiên ở tab Stress test)").pack(anchor="w")
        ttk.Entry(left, textvariable=self.path).pack(fill="x")
        ttk.Button(left, text="⇄ Gửi thật qua gateway", command=self.run_real).pack(fill="x", pady=4)

        right = ttk.Frame(self)
        right.pack(side="left", fill="both", expand=True, padx=(10, 0))
        lane = ttk.Frame(right)
        lane.pack(fill="x")
        self.chips = {}
        for i, (key, text) in enumerate(STAGES):
            chip = tk.Label(lane, text=text, bg=COLORS["idle"], fg=COLORS["idle_fg"], width=24, pady=5,
                            font=("Segoe UI", 9, "bold"))
            chip.grid(row=i // 4, column=i % 4, padx=3, pady=3, sticky="ew")
            self.chips[key] = chip
        self.log = tk.Text(right, height=20, font=("Consolas", 10), bg="#0f172a", fg="#e2e8f0", relief="flat")
        self.log.pack(fill="both", expand=True, pady=(8, 0))
        for tag, color in [("ok", "#4ade80"), ("err", "#f87171"), ("warn", "#fbbf24"), ("event", "#fb923c"),
                           ("info", "#c7d2fe"), ("muted", "#94a3b8")]:
            self.log.tag_configure(tag, foreground=color)
        first = next(iter(self.ep_by_iid))
        self.tree.selection_set(first)

    def selected(self):
        sel = self.tree.selection()
        return self.ep_by_iid.get(sel[0]) if sel else None

    def _select(self, _=None):
        ep = self.selected()
        if ep:
            events = f" · event: {', '.join(ep.events)}" if ep.events else ""
            self.desc.configure(text=f"{ep.desc}\naccess: {ep.access}{events}")
            self.path.set(f"{ep.method} {ep.sample_path()}")

    def reset(self):
        if self.job:
            self.after_cancel(self.job)
        for chip in self.chips.values():
            chip.configure(bg=COLORS["idle"], fg=COLORS["idle_fg"])
        self.log.delete("1.0", "end")

    def play(self, steps, delay=450):
        """Tô lần lượt từng bước; bước cuối của mỗi stage giữ màu của nó."""
        self.reset()

        def step(i):
            if i >= len(steps):
                return
            stage, text, tag = steps[i]
            self.chips[stage].configure(bg=COLORS[tag], fg="white")
            self.log.insert("end", f"{i + 1:>2}. ", "muted")
            self.log.insert("end", text + "\n", tag)
            self.log.see("end")
            self.job = self.after(delay, step, i + 1)

        step(0)

    def run_sim(self):
        ep = self.selected()
        if ep:
            self.play(simulate(ep, self.scenario.get()))

    def run_real(self):
        method, _, path = self.path.get().strip().partition(" ")
        url = self.app.api.get().rstrip("/") + (path or "/")
        self.reset()
        self.log.insert("end", f"{method} {url} ...\n", "muted")

        def worker():
            try:
                token = self.app.tokens()[0]
            except Exception as e:  # noqa: BLE001
                return self.app.call(self.log.insert, "end", f"Không đăng nhập được: {e}\n", "err")
            status, ms, headers, body = http(method or "GET", url, token)
            self.app.call(self.show_real, method, path, status, ms, headers, body)

        threading.Thread(target=worker, daemon=True).start()

    def show_real(self, method, path, status, ms, headers, body):
        kind, service = resolve_route(method, path)
        reached = {401: "auth", 403: "auth", 404: "route" if kind != "service" else "db", 429: "rl_user", 502: "proxy",
                   504: "proxy"}.get(status, "db" if status else "client")
        tag = "ok" if 200 <= status < 400 else "err"
        order = [k for k, _ in STAGES]
        for key in order[: order.index(reached) + 1]:
            if key in ("rabbit", "consumers") or (key in ("service", "db") and not service):
                continue
            self.chips[key].configure(bg=COLORS["info"], fg="white")
        self.chips[reached].configure(bg=COLORS[tag], fg="white")
        self.chips["audit"].configure(bg=COLORS["event"], fg="white")
        corr = next((v for k, v in headers.items() if k.lower() == "x-correlation-id"), "-")
        self.log.insert("end", f"HTTP {status or 'lỗi kết nối'} sau {ms:.0f} ms · x-correlation-id: {corr}\n", tag)
        self.log.insert("end", "(tìm correlation id này trong GET /audit/access bằng tài khoản Admin)\n", "muted")
        self.log.insert("end", body[:1500] + "\n", "muted")


# ----------------------------------------------------------------------------------
# Tab 2: stress test (chỉ gọi thật; biểu đồ ở Grafana)
# ----------------------------------------------------------------------------------

MIXES = {
    "Giáo viên đọc dữ liệu (7 GET, không ghi gì)": [(e, 1) for e in TUTOR_READS],
    "Như trên + 10% request lỗi 404": [(e, 1) for e in TUTOR_READS] + [(NOT_FOUND, 0.8)],
    "Chỉ endpoint đang chọn ở tab 1": None,
}


class Runner:
    """Virtual user = thread; mỗi VU dùng một tài khoản (xoay vòng) để chia hạn mức theo user."""

    def __init__(self, base, tokens, mix, vus, duration, ramp, think):
        self.base, self.tokens, self.mix = base.rstrip("/"), tokens, mix
        self.vus, self.duration, self.ramp, self.think = vus, duration, ramp, think
        self.stop_ev = threading.Event()
        self.lock = threading.Lock()
        self.codes = Counter()
        self.recent = deque(maxlen=5000)  # (thời điểm xong, latency ms)
        self.active = 0
        self.t0 = time.perf_counter()
        self.threads = [threading.Thread(target=self.vu, args=(i,), daemon=True) for i in range(vus)]
        for t in self.threads:
            t.start()

    def elapsed(self):
        return time.perf_counter() - self.t0

    def vu(self, i):
        rng = random.Random(i)
        if self.stop_ev.wait(self.ramp * i / max(1, self.vus)):
            return
        with self.lock:
            self.active += 1
        eps, weights = zip(*self.mix)
        try:
            while not self.stop_ev.is_set() and self.elapsed() < self.duration:
                ep = rng.choices(eps, weights)[0]
                status, ms, _, _ = http(ep.method, self.base + ep.sample_path(), self.tokens[i % len(self.tokens)])
                with self.lock:
                    self.codes[status] += 1
                    self.recent.append((time.perf_counter(), ms))
                if self.think > 0 and self.stop_ev.wait(rng.expovariate(1 / self.think)):
                    break
        finally:
            with self.lock:
                self.active -= 1

    def snapshot(self):
        with self.lock:
            now = time.perf_counter()
            last5 = [ms for t, ms in self.recent if now - t <= 5]
            lat = sorted(ms for _, ms in self.recent)
            return {"active": self.active, "codes": dict(self.codes), "total": sum(self.codes.values()),
                    "rps": len(last5) / 5, "p50": lat[len(lat) // 2] if lat else 0,
                    "p95": lat[int(len(lat) * 0.95)] if lat else 0}

    def finished(self):
        return not any(t.is_alive() for t in self.threads)


class StressTab(ttk.Frame):
    def __init__(self, master, app):
        super().__init__(master, padding=10)
        self.app = app
        self.runner = None
        self.ann = None
        self.started_ms = None
        self.v = {k: tk.StringVar(value=val) for k, val in [
            ("vus", "10"), ("duration", "60"), ("ramp", "10"), ("think", "0.5"),
            ("grafana", DEFAULT_GRAFANA), ("g_user", "admin"), ("g_pass", ENV.get("GRAFANA_ADMIN_PASSWORD", "admin"))]}
        self.mix = tk.StringVar(value=next(iter(MIXES)))

        form = ttk.LabelFrame(self, text="Cấu hình", padding=8)
        form.pack(fill="x")
        rows = [("API gateway", self.app.api, 50), ("Tài khoản (phẩy)", self.app.accounts, 50),
                ("Mật khẩu", self.app.password, 20), ("Firebase API key", self.app.api_key, 50),
                ("Virtual user", self.v["vus"], 8), ("Thời gian (giây)", self.v["duration"], 8),
                ("Ramp-up (giây)", self.v["ramp"], 8), ("Think time TB (giây)", self.v["think"], 8),
                ("Grafana", self.v["grafana"], 30), ("Grafana user / pass", None, 0)]
        for r, (label, var, width) in enumerate(rows):
            ttk.Label(form, text=label).grid(row=r, column=0, sticky="w", pady=1)
            if var is None:
                ttk.Entry(form, textvariable=self.v["g_user"], width=12).grid(row=r, column=1, sticky="w")
                ttk.Entry(form, textvariable=self.v["g_pass"], width=20, show="•").grid(row=r, column=1, sticky="e")
            else:
                ttk.Entry(form, textvariable=var, width=width, show="•" if "Mật" in label else "").grid(
                    row=r, column=1, sticky="w")
        ttk.Label(form, text="Kịch bản").grid(row=len(rows), column=0, sticky="w")
        ttk.Combobox(form, textvariable=self.mix, values=list(MIXES), state="readonly", width=48).grid(
            row=len(rows), column=1, sticky="w")

        bar = ttk.Frame(self)
        bar.pack(fill="x", pady=8)
        self.start_btn = ttk.Button(bar, text="▶ Chạy stress test", command=self.start)
        self.start_btn.pack(side="left")
        ttk.Button(bar, text="■ Dừng", command=self.stop).pack(side="left", padx=6)
        ttk.Button(bar, text="📈 Mở Grafana", command=self.open_grafana).pack(side="left")

        self.status = ttk.Label(self, text="Chưa chạy.", font=("Consolas", 11), justify="left")
        self.status.pack(anchor="w")
        ttk.Label(self, foreground="#64748b", wraplength=760, justify="left", text=(
            "Giới hạn của gateway: 600 request/phút cho mỗi IP và 300/phút cho mỗi user. Mọi VU từ máy này "
            "chung một IP, nên quá khoảng 10 request/giây sẽ thấy 429 trên Grafana (panel theo status code). "
            "Muốn đo sức chịu tải thật thì nâng tạm RATE_LIMIT_* trên VPS (tools/load-tester/README.md).")
        ).pack(anchor="w", pady=(8, 0))

    def _num(self, key, cast=float):
        return cast(self.v[key].get())

    def start(self):
        if self.runner and not self.runner.finished():
            return
        mix = MIXES[self.mix.get()]
        if mix is None:
            ep = self.app.flow.selected()
            if not ep or ep.method != "GET":
                return messagebox.showwarning("Stress test", "Chọn một endpoint GET ở tab Luồng endpoint.")
            mix = [(ep, 1)]
        try:
            cfg = (self._num("vus", int), self._num("duration"), self._num("ramp"), self._num("think"))
        except ValueError:
            return messagebox.showerror("Stress test", "VU, thời gian, ramp-up, think time phải là số.")
        self.start_btn.configure(state="disabled")
        self.status.configure(text="Đang đăng nhập các tài khoản ...")

        def boot():
            try:
                tokens = self.app.tokens()
            except Exception as e:  # noqa: BLE001
                return self.app.call(self._failed, str(e))
            grafana = Grafana(self.v["grafana"].get(), self.v["g_user"].get(), self.v["g_pass"].get())
            text = f"Stress test: {cfg[0]} VU, {cfg[1]:.0f}s, {self.mix.get()}"
            self.ann = (grafana, grafana.start(text), text)
            self.started_ms = int(time.time() * 1000)
            self.runner = Runner(self.app.api.get(), tokens, mix, *cfg)
            self.app.call(self.tick)

        threading.Thread(target=boot, daemon=True).start()

    def _failed(self, msg):
        self.start_btn.configure(state="normal")
        self.status.configure(text="Lỗi: " + msg)

    def stop(self):
        if self.runner:
            self.runner.stop_ev.set()

    def tick(self):
        r = self.runner
        s = r.snapshot()
        codes = "  ".join(f"{c or 'ERR'}: {n}" for c, n in sorted(s["codes"].items()))
        self.status.configure(text=(
            f"Đã chạy {r.elapsed():5.0f}s / {r.duration:.0f}s   VU đang chạy: {s['active']}\n"
            f"Request: {s['total']}   ~{s['rps']:.1f} req/s (5s gần nhất)   p50 {s['p50']:.0f} ms   p95 {s['p95']:.0f} ms\n"
            f"Status: {codes or '-'}"))
        if r.finished():
            grafana, ann_id, text = self.ann
            threading.Thread(target=grafana.end, args=(ann_id, f"{text} · {s['total']} request · {codes}"),
                             daemon=True).start()
            self.start_btn.configure(state="normal")
            self.status.configure(text=self.status.cget("text") + "\nXong. Xem chi tiết trên Grafana.")
            return
        self.after(1000, self.tick)

    def open_grafana(self):
        since = self.started_ms or int(time.time() * 1000) - 15 * 60_000
        webbrowser.open(Grafana(self.v["grafana"].get(), "", "").url(since))


# ----------------------------------------------------------------------------------

class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("TMS Load Tester · luồng endpoint + stress test (biểu đồ trên Grafana)")
        self.geometry("1180x700")
        self.api = tk.StringVar(value=DEFAULT_API)
        self.accounts = tk.StringVar(value=DEMO_ACCOUNTS)
        self.password = tk.StringVar(value=DEMO_PASSWORD)
        self.api_key = tk.StringVar(value=ENV.get("NEXT_PUBLIC_FIREBASE_API_KEY", ""))
        self._tokens = (None, 0.0, [])  # (khoá cấu hình, thời điểm lấy, tokens)
        self._ui = queue.Queue()  # Tkinter chỉ được gọi từ thread chính: thread nền gửi việc qua đây
        self.after(50, self._drain)
        tabs = ttk.Notebook(self)
        tabs.pack(fill="both", expand=True)
        self.flow = FlowTab(tabs, self)
        tabs.add(self.flow, text="  Luồng endpoint  ")
        tabs.add(StressTab(tabs, self), text="  Stress test  ")

    def call(self, fn, *args):
        """Từ thread nền: chạy fn(*args) trên thread giao diện."""
        self._ui.put((fn, args))

    def _drain(self):
        while not self._ui.empty():
            fn, args = self._ui.get_nowait()
            fn(*args)
        self.after(50, self._drain)

    def tokens(self):
        """ID token của các tài khoản, dùng lại trong 50 phút (token sống 1 giờ)."""
        key = (self.api_key.get(), self.accounts.get(), self.password.get())
        cached_key, at, tokens = self._tokens
        if cached_key == key and time.time() - at < 50 * 60:
            return tokens
        if not self.api_key.get():
            raise RuntimeError("thiếu Firebase API key (NEXT_PUBLIC_FIREBASE_API_KEY trong .env)")
        emails = [e.strip() for e in self.accounts.get().split(",") if e.strip()]
        tokens = [firebase_login(self.api_key.get(), e, self.password.get()) for e in emails]
        self._tokens = (key, time.time(), tokens)
        return tokens


if __name__ == "__main__":
    App().mainloop()
