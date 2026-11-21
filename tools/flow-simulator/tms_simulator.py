"""
TMS Flow & Stress Simulator
===========================

Ứng dụng Tkinter (chỉ dùng thư viện chuẩn) để:

1. Mô phỏng luồng chạy của từng endpoint qua API Gateway -> service -> PostgreSQL
   -> outbox -> RabbitMQ -> các consumer, theo đúng route table của
   backend/api-gateway/src/gateway/routes.ts và các bước trong gateway.service.ts
   (resolve route, rate limit theo IP, verify Firebase ID token, rate limit theo user,
   proxy). Có thể chọn kịch bản lỗi (401/403/429/502/504/400) hoặc gửi request thật.

2. Stress test:
   - Chế độ "Mô phỏng": mô hình hàng đợi (discrete-event simulation) của gateway
     (Node event loop), Redis rate limiter, các service với connection pool DB,
     timeout 30s của gateway, RabbitMQ backlog. Không cần backend chạy.
   - Chế độ "Gọi thật": bắn HTTP thật vào gateway (mặc định http://localhost:8080/api)
     bằng các virtual user (thread).

Chạy:  python tools/flow-simulator/tms_simulator.py
"""
from __future__ import annotations

import csv
import heapq
import itertools
import json
import math
import queue
import random
import re
import threading
import time
import tkinter as tk
import urllib.error
import urllib.request
from collections import Counter, deque
from dataclasses import dataclass
from tkinter import filedialog, messagebox, ttk
from tkinter import font as tkfont

# ----------------------------------------------------------------------------------
# Mô hình hệ thống (lấy từ code backend)
# ----------------------------------------------------------------------------------

SAMPLE_ID = "00000000-0000-4000-8000-000000000001"
GATEWAY_TIMEOUT_S = 30.0  # proxy.ts: timeout 30_000

SERVICES = {
    "identity": "identity-service :3001",
    "student": "student-service :3002",
    "class": "class-service :3003",
    "schedule": "schedule-service :3004",
    "billing": "billing-service :3006",
    "audit": "audit-service :3008",
}
SERVICE_ORDER = list(SERVICES)

# Ai subscribe event nào (grep messaging.subscribe trong backend/*/src).
EVENT_CONSUMERS = {
    "UserRegistered": ["student"],
    "StudentCreated": ["billing"],
    "StudentUpdated": ["billing"],
    "StudentStatusChanged": ["billing", "class"],
    "ClassCreated": ["schedule", "billing"],
    "ClassUpdated": ["schedule", "billing"],
    "ClassClosed": ["schedule"],
    "StudentEnrolled": ["schedule", "billing"],
    "StudentWithdrawn": ["schedule", "billing"],
    "EnrollmentConfirmed": ["class"],
    "EnrollmentSyncFailed": ["class"],
    "SessionScheduled": ["billing"],
    "SessionCancelled": ["billing"],
    "SessionRescheduled": ["billing"],
    "AttendanceRecorded": ["billing"],
    "AttendanceCorrected": ["billing"],
    "PaymentReceived": ["class"],
    # Not a business event: the gateway's Access record on exchange tms.audit (ADR-0005).
    "AccessRecorded": ["audit"],
}
# Consumer xử lý xong rồi publish tiếp event khác (saga ghi danh).
FOLLOW_UP = {("schedule", "StudentEnrolled"): "EnrollmentConfirmed"}


@dataclass(frozen=True)
class Endpoint:
    method: str
    path: str
    service: str  # "-" cho endpoint gateway tự trả lỗi
    access: str = "role"  # public | token-only | role | internal | not-implemented
    events: tuple = ()
    desc: str = ""

    @property
    def write(self) -> bool:
        return self.method != "GET" and not self.path.endswith("/preview")

    @property
    def label(self) -> str:
        return f"{self.method} {self.path}"

    def sample_path(self) -> str:
        return re.sub(r"\{[^}]+\}", SAMPLE_ID, self.path)

    def ok_status(self) -> int:
        return 201 if self.method == "POST" else 200


E = Endpoint
ENDPOINTS = [
    # identity
    E("POST", "/auth/register", "identity", "token-only", ("UserRegistered",), "Tutor tự đăng ký (token chưa có role)"),
    E("POST", "/auth/invitations", "identity", "role", (), "Tutor mời Parent/Student"),
    E("POST", "/auth/invitations/{token}/accept", "identity", "public", ("UserRegistered",), "Chấp nhận lời mời (không cần token)"),
    E("GET", "/users/me", "identity", desc="Thông tin tài khoản hiện tại"),
    E("GET", "/users", "identity", desc="Danh sách user"),
    E("GET", "/users/{id}", "identity", desc="Chi tiết user"),
    E("PATCH", "/users/{id}", "identity", desc="Cập nhật user"),
    # student
    E("GET", "/students", "student", desc="Danh sách học sinh"),
    E("POST", "/students", "student", events=("StudentCreated",), desc="Tạo học sinh"),
    E("GET", "/students/me", "student", desc="Hồ sơ của Student đang đăng nhập"),
    E("GET", "/students/{id}", "student", desc="Chi tiết học sinh"),
    E("PATCH", "/students/{id}", "student", events=("StudentUpdated",), desc="Sửa học sinh"),
    E("POST", "/students/{id}/status", "student", events=("StudentStatusChanged",), desc="Đổi trạng thái học sinh"),
    E("POST", "/students/{id}/parents", "student", events=("StudentUpdated",), desc="Gắn phụ huynh"),
    E("GET", "/parents/me/children", "student", desc="Parent xem các con"),
    # class
    E("GET", "/classes", "class", desc="Danh sách lớp"),
    E("POST", "/classes", "class", events=("ClassCreated",), desc="Tạo lớp"),
    E("GET", "/classes/{id}", "class", desc="Chi tiết lớp"),
    E("PATCH", "/classes/{id}", "class", events=("ClassUpdated",), desc="Sửa lớp / học phí"),
    E("POST", "/classes/{id}/close", "class", events=("ClassClosed",), desc="Đóng lớp"),
    E("GET", "/classes/{id}/students", "class", desc="Học sinh trong lớp"),
    E("POST", "/classes/{id}/enrollments", "class", events=("StudentEnrolled",), desc="Ghi danh (saga: schedule xác nhận)"),
    E("PATCH", "/classes/{id}/enrollments/{eid}", "class", events=("StudentWithdrawn",), desc="Rút khỏi lớp"),
    E("GET", "/students/{id}/classes", "class", desc="Lớp của 1 học sinh (route ngoại lệ -> class)"),
    # schedule
    E("GET", "/schedules", "schedule", desc="Danh sách lịch"),
    E("POST", "/schedules/preview", "schedule", desc="Xem trước các buổi học"),
    E("POST", "/schedules", "schedule", events=("SessionScheduled",), desc="Tạo lịch -> sinh Session"),
    E("GET", "/sessions", "schedule", desc="Danh sách buổi học"),
    E("POST", "/sessions/{id}/cancel", "schedule", events=("SessionCancelled",), desc="Huỷ buổi"),
    E("POST", "/sessions/{id}/reschedule", "schedule", events=("SessionRescheduled",), desc="Dời buổi"),
    E("PUT", "/sessions/{id}/attendance", "schedule", events=("AttendanceRecorded",), desc="Điểm danh -> tính phí"),
    E("GET", "/students/{id}/attendance", "schedule", desc="Điểm danh của học sinh (route ngoại lệ -> schedule)"),
    # billing
    E("GET", "/billing/invoices", "billing", desc="Danh sách hoá đơn"),
    E("GET", "/billing/invoices/{id}", "billing", desc="Chi tiết hoá đơn"),
    E("POST", "/billing/invoices/{id}/payments", "billing", events=("PaymentReceived",), desc="Ghi nhận thanh toán"),
    E("POST", "/billing/invoices/{id}/void", "billing", desc="Huỷ hoá đơn"),
    E("GET", "/billing/students/{id}/balance", "billing", desc="Công nợ học sinh"),
    E("GET", "/billing/reports/revenue", "billing", desc="Báo cáo doanh thu"),
    E("GET", "/billing/invoices/{id}/qr", "billing", desc="Mã QR thanh toán (TK giáo viên đã đồng ý, hoặc BILLING_BANK_*)"),
    E("GET", "/billing/bank-account", "billing", desc="Tài khoản ngân hàng của mình, số đã che (ADR-0006)"),
    E("PUT", "/billing/bank-account", "billing", desc="Lưu tài khoản ngân hàng: cần consent: true + policyVersion, số được mã hoá"),
    E("DELETE", "/billing/bank-account/consent", "billing", desc="Rút đồng ý: xoá số đầy đủ, chỉ giữ BIN + 4 số cuối"),
    E("GET", "/billing/bank-accounts", "billing", desc="Tài khoản của người thanh toán để hoàn tiền (Tutor, Admin)"),
    # audit
    E("GET", "/audit/access", "audit", desc="Access record: mọi request qua gateway (Admin, ADR-0005)"),
    E("GET", "/audit/changes", "audit", desc="Change record gộp từ 5 service qua /internal/audit (Admin)"),
    # gateway tự trả lỗi
    E("GET", "/internal/students/{id}", "-", "internal", desc="/internal/** không bao giờ đi qua gateway -> 404"),
    E("GET", "/academic/grades", "-", "not-implemented", desc="Ngoài phạm vi MVP -> 501"),
]

_EXCEPTIONS = [
    ("POST", re.compile(r"^/auth/invitations/[^/]+/accept$"), "identity", "public"),
    ("POST", re.compile(r"^/auth/register$"), "identity", "token-only"),
    (None, re.compile(r"^/students/[^/]+/classes$"), "class", "role"),
    (None, re.compile(r"^/students/[^/]+/attendance$"), "schedule", "role"),
    ("GET", re.compile(r"^/calendar/[^/]+\.ics$"), "schedule", "public"),
]
_BY_PREFIX = {
    "auth": "identity", "users": "identity", "students": "student", "parents": "student",
    "classes": "class", "schedules": "schedule", "sessions": "schedule", "billing": "billing",
    "audit": "audit",
    "academic": "not-implemented", "notifications": "not-implemented", "webhooks": "not-implemented",
}


def resolve_route(method: str, path: str):
    """Bản Python của resolveRoute() trong routes.ts -> (kind, service, access)."""
    path = path.split("?")[0]
    if re.search(r"(^|/)internal(/|$)", path):
        return "not-found", None, None
    for m, pattern, service, access in _EXCEPTIONS:
        if (m is None or m == method) and pattern.match(path):
            return "service", service, access
    parts = path.split("/")
    target = _BY_PREFIX.get(parts[1] if len(parts) > 1 else "")
    if not target:
        return "not-found", None, None
    if target == "not-implemented":
        return "not-implemented", None, None
    return "service", target, "role"


def percentile(sorted_values, p):
    if not sorted_values:
        return 0.0
    k = min(len(sorted_values) - 1, max(0, int(round(p / 100 * (len(sorted_values) - 1)))))
    return sorted_values[k]


# ----------------------------------------------------------------------------------
# Tab 1: mô phỏng luồng endpoint
# ----------------------------------------------------------------------------------

SCENARIOS = [
    "Thành công",
    "Thiếu token -> 401",
    "Token sai / hết hạn -> 401",
    "Tài khoản chưa có role -> 403",
    "Vượt rate limit IP -> 429",
    "Vượt rate limit user -> 429",
    "Body không hợp lệ (zod) -> 400",
    "Thiếu đồng ý lưu TK ngân hàng -> 400",
    "RabbitMQ sập (Access record vào spool)",
    "Service sập -> 502",
    "Service quá tải, timeout 30s -> 504",
    "Consumer sập (event nằm chờ trong RabbitMQ)",
]

C = {
    "bg": "#0f172a", "panel": "#1e293b", "line": "#334155", "text": "#e2e8f0", "muted": "#94a3b8",
    "client": "#38bdf8", "gateway": "#a78bfa", "redis": "#f87171", "firebase": "#fbbf24",
    "service": "#34d399", "db": "#60a5fa", "rabbit": "#fb923c",
    "ok": "#22c55e", "err": "#ef4444", "warn": "#f59e0b", "req": "#e2e8f0", "event": "#fb923c",
}

SERVICE_Y = {s: 50 + i * 72 for i, s in enumerate(SERVICE_ORDER)}
BUS_X = 590
EVENT_LANE_Y = 302


class FlowCanvas(tk.Canvas):
    W, H = 960, 480

    def __init__(self, master):
        super().__init__(master, width=self.W, height=self.H, bg=C["bg"], highlightthickness=0)
        self.nodes = {}
        self.chips = {}
        self.status_text = None
        self._draw_static()

    def _box(self, key, x, y, w, h, label, color, sub=""):
        r = self.create_rectangle(x - w / 2, y - h / 2, x + w / 2, y + h / 2, fill=C["panel"], outline=color, width=2)
        self.create_text(x, y - (7 if sub else 0), text=label, fill=C["text"], font=("Segoe UI", -13, "bold"))
        if sub:
            self.create_text(x, y + 10, text=sub, fill=C["muted"], font=("Segoe UI", -11))
        self.nodes[key] = (x, y, w, h, r, color)

    def _draw_static(self):
        L = dict(fill=C["line"], width=2)
        gx, gy = 260, 240
        # đường nối
        self.create_line(70, gy, gx, gy, **L)
        self.create_line(gx, 50, gx, gy, **L)
        self.create_line(gx, gy, gx, 435, **L)
        for s, y in SERVICE_Y.items():
            self.create_line(gx + 75, gy, 450, y, **L)
            self.create_line(500, y, 660, y, **L)
        self.create_line(BUS_X, SERVICE_Y[SERVICE_ORDER[0]], BUS_X, SERVICE_Y[SERVICE_ORDER[-1]], fill=C["event"], dash=(4, 4))
        self.create_line(BUS_X, EVENT_LANE_Y, 830, EVENT_LANE_Y, fill=C["event"], dash=(4, 4))
        # node
        self._box("client", 70, gy, 110, 60, "Client", C["client"], "Frontend / curl")
        self._box("redis", gx, 45, 130, 44, "Redis", C["redis"], "rate limit INCR")
        self._box("firebase", gx, 435, 150, 44, "Firebase Auth", C["firebase"], "verifyIdToken")
        x0, y0 = gx - 75, 100
        self.nodes["gateway"] = (gx, gy, 150, 270, self.create_rectangle(x0, y0, gx + 75, 380, fill=C["panel"], outline=C["gateway"], width=2), C["gateway"])
        self.create_text(gx, 116, text="API Gateway :8080", fill=C["text"], font=("Segoe UI", -13, "bold"))
        chips = [("route", "1. resolveRoute"), ("rl_ip", "2. rate limit IP"), ("auth", "3. verify token"),
                 ("rl_user", "4. rate limit user"), ("proxy", "5. proxy + headers")]
        for i, (k, t) in enumerate(chips):
            cy = 150 + i * 46
            r = self.create_rectangle(gx - 65, cy - 16, gx + 65, cy + 16, fill=C["bg"], outline=C["line"], width=1)
            self.create_text(gx, cy, text=t, fill=C["muted"], font=("Segoe UI", -12))
            self.chips[k] = (r, gx, cy)
        for s, y in SERVICE_Y.items():
            self._box(s, 500, y, 140, 50, s.capitalize(), C["service"], SERVICES[s].split()[1])
            self._box("db_" + s, 700, y, 90, 40, "PostgreSQL", C["db"], s + "_db")
        self._box("rabbit", 880, 240, 110, 380, "RabbitMQ", C["rabbit"], "events · audit")
        self.status_text = self.create_text(70, gy + 52, text="", fill=C["text"], font=("Segoe UI", -16, "bold"))
        self.backlog_text = self.create_text(880, 290, text="", fill=C["warn"], font=("Segoe UI", -12), justify="center")

    # tiện ích hình học / hiệu ứng
    def center(self, key):
        x, y, *_ = self.nodes[key]
        return x, y

    def edge(self, key, side):
        x, y, w, h, *_ = self.nodes[key]
        return {"l": (x - w / 2, y), "r": (x + w / 2, y), "t": (x, y - h / 2), "b": (x, y + h / 2)}[side]

    def highlight(self, key, color=None, on=True):
        if key in self.chips:
            r = self.chips[key][0]
            self.itemconfig(r, outline=(color or C["gateway"]) if on else C["line"], width=3 if on else 1,
                            fill="#312e81" if on else C["bg"])
            return
        _, _, _, _, r, base = self.nodes[key]
        self.itemconfig(r, outline=(color or "#ffffff") if on else base, width=4 if on else 2)

    def reset(self):
        for k in self.nodes:
            self.highlight(k, on=False)
        for k in self.chips:
            self.highlight(k, on=False)
        self.itemconfig(self.status_text, text="")
        self.itemconfig(self.backlog_text, text="")
        self.delete("packet")


class Animator:
    """Chạy một generator: mỗi giá trị yield là số ms chờ trước bước tiếp theo."""

    def __init__(self, widget):
        self.widget = widget
        self.gen = None
        self.token = 0

    def run(self, gen):
        self.token += 1
        self.gen = gen
        self._step(self.token)

    def stop(self):
        self.token += 1
        self.gen = None

    def _step(self, token):
        if token != self.token or self.gen is None:
            return
        try:
            delay = next(self.gen)
        except StopIteration:
            self.gen = None
            return
        self.widget.after(max(1, int(delay)), self._step, token)


class FlowTab(ttk.Frame):
    def __init__(self, master, app):
        super().__init__(master, padding=6)
        self.app = app
        self.sim_ms = 0.0
        self.speed = tk.DoubleVar(value=1.0)
        self.scenario = tk.StringVar(value=SCENARIOS[0])
        self.base_url = tk.StringVar(value="http://localhost:8080/api")
        self.token = tk.StringVar()
        self.custom_path = tk.StringVar()
        self.method = tk.StringVar(value="GET")
        self._build()

    # ---- UI
    def _build(self):
        left = ttk.Frame(self, width=360)
        left.pack(side="left", fill="y")
        right = ttk.Frame(self)
        right.pack(side="left", fill="both", expand=True, padx=(8, 0))

        ttk.Label(left, text="Endpoint (theo service)", style="H.TLabel").pack(anchor="w")
        tree_frame = ttk.Frame(left)
        tree_frame.pack(fill="both", expand=True)
        self.tree = ttk.Treeview(tree_frame, show="tree", height=16, selectmode="browse")
        sb = ttk.Scrollbar(tree_frame, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=sb.set)
        self.tree.pack(side="left", fill="both", expand=True)
        sb.pack(side="left", fill="y")
        self.ep_by_iid = {}
        groups = {}
        for s in SERVICE_ORDER + ["-"]:
            name = SERVICES.get(s, "Gateway (tự trả lỗi)")
            groups[s] = self.tree.insert("", "end", text=name, open=True)
        for ep in ENDPOINTS:
            iid = self.tree.insert(groups[ep.service], "end", text=f"{ep.method:<6} {ep.path}")
            self.ep_by_iid[iid] = ep
        self.tree.bind("<<TreeviewSelect>>", self._on_select)
        self.desc = ttk.Label(left, text="", wraplength=340, foreground="#475569")
        self.desc.pack(anchor="w", pady=(4, 6))

        box = ttk.LabelFrame(left, text="Mô phỏng", padding=6)
        box.pack(fill="x")
        ttk.Label(box, text="Kịch bản").grid(row=0, column=0, sticky="w")
        ttk.Combobox(box, textvariable=self.scenario, values=SCENARIOS, state="readonly", width=36).grid(row=0, column=1, sticky="ew")
        ttk.Label(box, text="Tốc độ").grid(row=1, column=0, sticky="w")
        ttk.Scale(box, from_=0.3, to=4, variable=self.speed).grid(row=1, column=1, sticky="ew")
        ttk.Button(box, text="▶  Chạy mô phỏng", style="Accent.TButton", command=self.run_simulated).grid(row=2, column=0, columnspan=2, sticky="ew", pady=(6, 0))
        box.columnconfigure(1, weight=1)

        real = ttk.LabelFrame(left, text="Gửi request thật qua Gateway", padding=6)
        real.pack(fill="x", pady=(8, 0))
        ttk.Label(real, text="Base URL").grid(row=0, column=0, sticky="w")
        ttk.Entry(real, textvariable=self.base_url).grid(row=0, column=1, columnspan=2, sticky="ew")
        ttk.Label(real, text="ID token").grid(row=1, column=0, sticky="w")
        ttk.Entry(real, textvariable=self.token, show="•").grid(row=1, column=1, columnspan=2, sticky="ew")
        ttk.Label(real, text="Request").grid(row=2, column=0, sticky="w")
        ttk.Combobox(real, textvariable=self.method, values=["GET", "POST", "PATCH", "PUT", "DELETE"], width=7, state="readonly").grid(row=2, column=1, sticky="w")
        ttk.Entry(real, textvariable=self.custom_path).grid(row=2, column=2, sticky="ew")
        ttk.Label(real, text="Body JSON").grid(row=3, column=0, sticky="nw")
        self.body = tk.Text(real, height=3, width=30, font=("Consolas", 9))
        self.body.grid(row=3, column=1, columnspan=2, sticky="ew")
        ttk.Button(real, text="⇄  Gửi thật", command=self.run_real).grid(row=4, column=0, columnspan=3, sticky="ew", pady=(6, 0))
        real.columnconfigure(2, weight=1)

        self.canvas = FlowCanvas(right)
        self.canvas.pack(anchor="nw")
        log_frame = ttk.Frame(right)
        log_frame.pack(fill="both", expand=True, pady=(6, 0))
        self.log = tk.Text(log_frame, height=10, bg="#020617", fg=C["text"], font=("Consolas", 9), insertbackground="white", relief="flat")
        lsb = ttk.Scrollbar(log_frame, command=self.log.yview)
        self.log.configure(yscrollcommand=lsb.set)
        self.log.pack(side="left", fill="both", expand=True)
        lsb.pack(side="left", fill="y")
        for tag, col in [("ok", C["ok"]), ("err", C["err"]), ("warn", C["warn"]), ("event", C["event"]), ("muted", C["muted"]), ("gw", C["gateway"])]:
            self.log.tag_configure(tag, foreground=col)

        self.anim = Animator(self)
        first = next(iter(self.ep_by_iid))
        self.tree.selection_set(first)
        self.tree.see(first)

    def _on_select(self, _=None):
        ep = self.selected()
        if ep:
            self.desc.configure(text=f"{ep.desc}\nService: {ep.service} · Access: {ep.access}"
                                     + (f" · Event: {', '.join(ep.events)}" if ep.events else ""))
            self.custom_path.set(ep.sample_path())
            self.method.set(ep.method)
            self.body.delete("1.0", "end")
            if ep.method in ("POST", "PATCH", "PUT"):
                self.body.insert("1.0", "{}")

    def selected(self):
        sel = self.tree.selection()
        return self.ep_by_iid.get(sel[0]) if sel else None

    # ---- log
    def say(self, text, tag=None, cost_ms=0.0):
        self.sim_ms += cost_ms
        self.log.insert("end", f"[+{self.sim_ms:8.1f} ms] ", "muted")
        self.log.insert("end", text + "\n", tag)
        self.log.see("end")

    # ---- hiệu ứng chuyển động
    def travel(self, points, color=C["req"], label=""):
        cv = self.canvas
        speed = 0.55 * self.speed.get()  # px / ms
        dot = cv.create_oval(0, 0, 12, 12, fill=color, outline="", tags="packet")
        txt = cv.create_text(0, 0, text=label, fill=color, font=("Segoe UI", -11, "bold"), tags="packet")
        for (x1, y1), (x2, y2) in zip(points, points[1:]):
            dist = math.hypot(x2 - x1, y2 - y1)
            frames = max(2, int(dist / speed / 16))
            for i in range(frames + 1):
                t = i / frames
                x, y = x1 + (x2 - x1) * t, y1 + (y2 - y1) * t
                cv.coords(dot, x - 6, y - 6, x + 6, y + 6)
                cv.coords(txt, x, y - 14)
                yield 16
        cv.delete(dot)
        cv.delete(txt)

    def pause(self, ms):
        yield ms / max(0.3, self.speed.get())

    def gw_to(self, key):
        return [self.canvas.edge("gateway", "t" if key == "redis" else "b"), self.canvas.edge(key, "b" if key == "redis" else "t")]

    def svc_points(self, service):
        y = SERVICE_Y[service]
        return [self.canvas.edge("gateway", "r"), (450, y)]

    def to_rabbit(self, service):
        y = SERVICE_Y[service]
        return [(570, y), (BUS_X, y), (BUS_X, EVENT_LANE_Y), self.canvas.edge("rabbit", "l")]

    # ---- chạy
    def start(self, gen):
        self.anim.stop()
        self.canvas.reset()
        self.sim_ms = 0.0
        self.log.delete("1.0", "end")
        self.anim.run(gen)

    def run_simulated(self):
        ep = self.selected()
        if ep:
            self.start(self.flow(ep, self.scenario.get()))

    def run_real(self):
        method, path = self.method.get(), self.custom_path.get().strip() or "/"
        if not path.startswith("/"):
            path = "/" + path
        body = self.body.get("1.0", "end").strip()
        url = self.base_url.get().rstrip("/") + path
        result = {}

        def worker():
            data = body.encode() if body and method != "GET" else None
            headers = {"content-type": "application/json"}
            if self.token.get().strip():
                headers["authorization"] = "Bearer " + self.token.get().strip()
            req = urllib.request.Request(url, data=data, method=method, headers=headers)
            t0 = time.perf_counter()
            try:
                with urllib.request.urlopen(req, timeout=35) as r:
                    result.update(status=r.status, body=r.read(2000).decode(errors="replace"), headers=dict(r.headers))
            except urllib.error.HTTPError as e:
                result.update(status=e.code, body=e.read(2000).decode(errors="replace"), headers=dict(e.headers))
            except Exception as e:  # noqa: BLE001
                result.update(status=0, body=f"{type(e).__name__}: {e}", headers={})
            result["ms"] = (time.perf_counter() - t0) * 1000

        self.start(self.flow_real(method, path, url, threading.Thread(target=worker, daemon=True), result))

    def flow_real(self, method, path, url, thread, result):
        cv = self.canvas
        self.say(f"{method} {url}", "gw")
        thread.start()
        yield from self.travel([cv.edge("client", "r"), cv.edge("gateway", "l")], label=method)
        kind, service, access = resolve_route(method, path)
        cv.highlight("route")
        self.say(f"resolveRoute -> {kind}" + (f" · service={service} · access={access}" if service else ""), "gw")
        while thread.is_alive():
            yield 50
        status, ms = result["status"], result["ms"]
        corr = next((v for k, v in result["headers"].items() if k.lower() == "x-correlation-id"), "-")
        if service and status not in (0, 401, 403, 429):
            cv.highlight("proxy")
            yield from self.travel(self.svc_points(service))
            cv.highlight(service, C["ok"] if status < 500 else C["err"])
            yield from self.travel(self.svc_points(service)[::-1], C["ok"] if status < 400 else C["err"], str(status))
        tag = "ok" if 200 <= status < 400 else "err"
        yield from self.travel([cv.edge("gateway", "l"), cv.edge("client", "r")], C[tag], str(status or "ERR"))
        cv.itemconfig(cv.status_text, text=str(status or "ERR"), fill=C[tag])
        self.say(f"HTTP {status or 'ERR'} sau {ms:.1f} ms thật · x-correlation-id: {corr}", tag)
        self.log.insert("end", result["body"][:2000] + "\n", "muted")
        self.log.see("end")

    def flow(self, ep: Endpoint, sc: str):
        cv = self.canvas
        path = ep.sample_path()
        has_token = sc != "Thiếu token -> 401"
        self.say(f"{ep.method} /api{path}" + ("   (Authorization: Bearer <Firebase ID token>)" if has_token and ep.access != "public" else ""), "gw")
        yield from self.travel([cv.edge("client", "r"), cv.edge("gateway", "l")], label=ep.method)
        self.say("Gateway nhận request, gắn x-correlation-id (UUID)", "gw", 0.3)

        def fail(status, msg, key=None, extra=""):
            if key:
                cv.highlight(key, C["err"])
            self.say(f"=> {status} {msg}{extra}", "err", 0.2)
            yield from self.travel([cv.edge("gateway", "l"), cv.edge("client", "r")], C["err"], str(status))
            cv.itemconfig(cv.status_text, text=str(status), fill=C["err"])
            yield from self.access_record(status, path, sc)

        # 1. route
        cv.highlight("route")
        kind, service, access = resolve_route(ep.method, path)
        self.say(f"resolveRoute('{ep.method}', '{path}') -> {kind}" + (f" · service={service} · access={access}" if service else ""), "gw", 0.1)
        yield from self.pause(350)
        if kind == "not-found":
            yield from fail(404, "not found (đường /internal/** chỉ dành cho service-to-service)", "route")
            return
        if kind == "not-implemented":
            yield from fail(501, "not implemented in the MVP (BR-SYS-03)", "route")
            return
        # 2. rate limit IP
        cv.highlight("rl_ip")
        yield from self.travel(self.gw_to("redis"), C["redis"], "INCR")
        cv.highlight("redis", C["redis"])
        self.say("Redis MULTI: INCR rl:ip:<ip>:<phút> + EXPIRE 61  (giới hạn 600/phút)", None, 0.6)
        yield from self.travel(self.gw_to("redis")[::-1], C["redis"])
        cv.highlight("redis", on=False)
        if sc == "Vượt rate limit IP -> 429":
            yield from fail(429, "too many requests", "rl_ip", "  (retry-after: giây còn lại của cửa sổ 1 phút)")
            return
        # 3. auth
        if access == "public":
            self.say("Route public: không cần token, chuyển tiếp luôn", "muted")
        else:
            cv.highlight("auth")
            if not has_token:
                yield from fail(401, "missing Firebase ID token", "auth")
                return
            yield from self.travel(self.gw_to("firebase"), C["firebase"], "JWT")
            cv.highlight("firebase", C["firebase"])
            self.say("firebase-admin verifyIdToken(token, checkRevoked) -> claims {userId, role}", None, 2.5)
            yield from self.pause(250)
            yield from self.travel(self.gw_to("firebase")[::-1], C["firebase"])
            cv.highlight("firebase", on=False)
            if sc == "Token sai / hết hạn -> 401":
                yield from fail(401, "invalid, expired or revoked Firebase ID token", "auth")
                return
            if access == "token-only":
                self.say("access=token-only: giữ header Authorization để Identity tự verify", "muted")
            else:
                if sc == "Tài khoản chưa có role -> 403":
                    yield from fail(403, "this account has no role yet: finish registration or accept the invitation", "auth")
                    return
                cv.highlight("rl_user")
                yield from self.travel(self.gw_to("redis"), C["redis"], "INCR")
                self.say("Redis: INCR rl:user:<userId>:<phút>  (giới hạn 300/phút)", None, 0.6)
                yield from self.travel(self.gw_to("redis")[::-1], C["redis"])
                if sc == "Vượt rate limit user -> 429":
                    yield from fail(429, "too many requests", "rl_user")
                    return
                self.say("Xoá x-user-* từ client, gắn x-user-id / x-user-role từ claims", "gw")
        # 4. proxy
        cv.highlight("proxy")
        target = SERVICES[service]
        self.say(f"proxy -> http://{target.replace(' :', ':')}{path}  (stream body, timeout 30s)", "gw", 0.3)
        yield from self.travel(self.svc_points(service), label="HTTP")
        if sc == "Service sập -> 502":
            cv.highlight(service, C["err"])
            self.say(f"ECONNREFUSED: {service}-service không phản hồi", "err", 1.0)
            yield from self.travel(self.svc_points(service)[::-1], C["err"])
            yield from fail(502, "the service is unavailable, try again later")
            return
        cv.highlight(service, C["service"])
        if sc == "Service quá tải, timeout 30s -> 504":
            self.say("Request nằm chờ connection pool DB... (rút gọn 30 giây)", "warn")
            for _ in range(6):
                cv.highlight(service, C["warn"])
                yield from self.pause(200)
                cv.highlight(service, C["service"])
                yield from self.pause(200)
            self.sim_ms += 30000
            self.say("upstream timeout -> gateway huỷ kết nối", "err")
            yield from self.travel(self.svc_points(service)[::-1], C["err"])
            yield from fail(504, "the service is unavailable, try again later")
            return
        self.say(f"{service}: Guard kiểm tra x-user-role · ZodValidationPipe kiểm tra body", None, 0.4)
        yield from self.pause(250)
        if sc in ("Body không hợp lệ (zod) -> 400", "Thiếu đồng ý lưu TK ngân hàng -> 400"):
            cv.highlight(service, C["err"])
            if sc.startswith("Thiếu đồng ý"):
                self.say("BankAccountInput: thiếu consent: true -> không lưu gì, không có Consent, không có Change record (ADR-0006)", "err")
            else:
                self.say("ZodValidationPipe: body không khớp schema của @tms/contracts", "err")
            yield from self.travel(self.svc_points(service)[::-1], C["err"], "400")
            yield from self.travel([cv.edge("gateway", "l"), cv.edge("client", "r")], C["err"], "400")
            cv.itemconfig(cv.status_text, text="400", fill=C["err"])
            self.say("=> 400 Bad Request (gateway trả nguyên response của service)", "err")
            yield from self.access_record(400, path, sc)
            return
        db = "db_" + service
        yield from self.travel([cv.edge(service, "r"), cv.edge(db, "l")], C["db"], "SQL")
        cv.highlight(db, C["db"])
        if ep.write:
            outbox = " · INSERT INTO outbox (event)" if ep.events else ""
            self.say(f"Prisma: BEGIN · UPDATE/INSERT ...{outbox} · INSERT INTO audit_log (Change record) · COMMIT", None, 6.0)
            self.say("Change record: ai, hành động, các trường đã đổi; dữ liệu cá nhân ghi [personal], số TK ••••1234 (ADR-0005)", "muted")
        else:
            self.say("Prisma: SELECT ... (lọc theo quyền của actor)", None, 2.5)
        yield from self.pause(300)
        yield from self.travel([cv.edge(db, "l"), cv.edge(service, "r")], C["db"])
        cv.highlight(db, on=False)
        code = ep.ok_status()
        yield from self.travel(self.svc_points(service)[::-1], C["ok"], str(code))
        self.say(f"{service} trả {code}; gateway pipe response + x-correlation-id", "ok", 0.5)
        yield from self.travel([cv.edge("gateway", "l"), cv.edge("client", "r")], C["ok"], str(code))
        cv.itemconfig(cv.status_text, text=str(code), fill=C["ok"])
        self.say(f"=> {code} OK  (client đã có response; phần dưới chạy bất đồng bộ)", "ok")
        yield from self.access_record(code, path, sc)
        # 5. event bất đồng bộ
        pending = [(service, ev) for ev in ep.events]
        consumer_down = sc.startswith("Consumer sập")
        backlog = 0
        while pending:
            publisher, ev = pending.pop(0)
            yield from self.pause(300)
            self.say(f"Outbox relay ({publisher}) publish '{ev}' -> RabbitMQ", "event", 3.0)
            yield from self.travel(self.to_rabbit(publisher), C["event"], ev)
            cv.highlight("rabbit", C["rabbit"])
            consumers = EVENT_CONSUMERS.get(ev, [])
            if not consumers:
                self.say(f"'{ev}' không có consumer nào", "muted")
            for cons in consumers:
                if consumer_down and cons == consumers[0]:
                    backlog += 1
                    cv.highlight(cons, C["err"])
                    cv.itemconfig(cv.backlog_text, text=f"{backlog} msg chờ\n({cons} sập)")
                    self.say(f"{cons}-service sập: '{ev}' nằm trong queue, sẽ xử lý khi service lên lại (at-least-once)", "warn")
                    continue
                yield from self.travel(self.to_rabbit(cons)[::-1], C["event"], ev)
                cv.highlight(cons, C["event"])
                self.say(f"{cons}: consumer nhận '{ev}' · INSERT processed_events (idempotent) · cập nhật bản sao", "event", 4.0)
                yield from self.travel([cv.edge(cons, "r"), cv.edge("db_" + cons, "l")], C["db"])
                yield from self.travel([cv.edge("db_" + cons, "l"), cv.edge(cons, "r")], C["db"])
                cv.highlight(cons, on=False)
                nxt = FOLLOW_UP.get((cons, ev))
                if nxt:
                    pending.append((cons, nxt))
            cv.highlight("rabbit", on=False)
        self.say("Hoàn tất luồng.", "ok")


    def access_record(self, status, path, sc):
        """ADR-0005: the gateway publishes one Access record per request, after the response."""
        cv = self.canvas
        shown = re.sub(r"^/auth/invitations/[^/]+/accept$", "/auth/invitations/:token/accept", path)
        self.say(f"Gateway: Access record {{status {status}, path {shown}, userId, ip}} -> tms.audit "
                 "(không body, không token, không giá trị query)", "gw", 0.1)
        if sc.startswith("RabbitMQ sập"):
            cv.highlight("rabbit", C["err"])
            self.say("Broker không xác nhận -> ghi vào file spool (volume gateway-audit-spool), "
                     "gửi lại mỗi 5s khi RabbitMQ lên lại", "warn")
            yield from self.pause(400)
            cv.highlight("rabbit", on=False)
            return
        lane = [cv.edge("gateway", "r"), (BUS_X - 10, 240), (BUS_X - 10, EVENT_LANE_Y), cv.edge("rabbit", "l")]
        yield from self.travel(lane, C["event"], "access")
        yield from self.travel(self.to_rabbit("audit")[::-1], C["event"], "access")
        cv.highlight("audit", C["event"])
        self.say("audit-service: INSERT access_log ON CONFLICT (id) DO NOTHING · ack", "event", 2.0)
        yield from self.travel([cv.edge("audit", "r"), cv.edge("db_audit", "l")], C["db"])
        cv.highlight("audit", on=False)


# ----------------------------------------------------------------------------------
# Tab 2: stress test
# ----------------------------------------------------------------------------------

class Metrics:
    def __init__(self):
        self.lock = threading.Lock()
        self.buckets = {}  # giây -> [ok, err, [lat], Counter]
        self.per_ep = {}  # label -> [n, ok, [lat], Counter]
        self.codes = Counter()
        self.total = 0

    def record(self, t_sec, label, status, lat_ms):
        ok = 200 <= status < 400
        with self.lock:
            b = self.buckets.setdefault(int(t_sec), [0, 0, [], Counter()])
            b[0 if ok else 1] += 1
            b[2].append(lat_ms)
            b[3][status] += 1
            e = self.per_ep.setdefault(label, [0, 0, [], Counter()])
            e[0] += 1
            e[1] += ok
            e[2].append(lat_ms)
            e[3][status] += 1
            self.codes[status] += 1
            self.total += 1


class Req:
    __slots__ = ("ep", "vu", "t0", "done", "user", "ip")

    def __init__(self, ep, vu, t0, user, ip):
        self.ep, self.vu, self.t0, self.user, self.ip, self.done = ep, vu, t0, user, ip, False


class ServiceState:
    def __init__(self, workers, read_ms, write_ms):
        self.workers, self.read_ms, self.write_ms = workers, read_ms, write_ms
        self.busy = 0
        self.queue = deque()
        self.down = False
        # consumer RabbitMQ (prefetch 10)
        self.c_busy = 0
        self.c_queue = deque()
        self.consumed = 0


class Simulator:
    """Discrete-event simulation; thời gian tính bằng giây mô phỏng."""

    def __init__(self, cfg, metrics: Metrics):
        self.cfg, self.m = cfg, metrics
        self.now = 0.0
        self.heap = []
        self.seq = itertools.count()
        self.rng = random.Random(cfg["seed"])
        self.svcs = {k: ServiceState(*v) for k, v in cfg["services"].items()}
        self.gw_busy = False
        self.gw_queue = deque()
        self.rl = Counter()
        self.inflight = 0
        self.active_vus = 0
        self.published = 0
        self.mix = cfg["mix"]
        self.weights = list(itertools.accumulate(w for _, w in self.mix))
        for vu in range(cfg["vus"]):
            start = cfg["ramp"] * vu / max(1, cfg["vus"])
            self.at(start, self.vu_start, vu)

    def at(self, t, fn, *args):
        heapq.heappush(self.heap, (t, next(self.seq), fn, args))

    def run_until(self, target, budget=300_000):
        n = 0
        while self.heap and self.heap[0][0] <= target and n < budget:
            t, _, fn, args = heapq.heappop(self.heap)
            self.now = t
            fn(*args)
            n += 1
        if not self.heap or self.heap[0][0] > target:
            self.now = max(self.now, target)

    def finished(self):
        return self.now >= self.cfg["duration"] and self.inflight == 0

    # ---- virtual user
    def vu_start(self, vu):
        self.active_vus += 1
        self.vu_send(vu)

    def vu_send(self, vu):
        if self.now >= self.cfg["duration"]:
            self.active_vus -= 1
            return
        ep = self.mix[self._pick()][0]
        req = Req(ep, vu, self.now, vu % self.cfg["users"], vu % self.cfg["ips"])
        self.inflight += 1
        self.at(self.now + 0.0005, self.gw_arrive, req)  # mạng client -> gateway

    def _pick(self):
        r = self.rng.random() * self.weights[-1]
        lo, hi = 0, len(self.weights) - 1
        while lo < hi:
            mid = (lo + hi) // 2
            if self.weights[mid] < r:
                lo = mid + 1
            else:
                hi = mid
        return lo

    def finish(self, req, status, extra=0.0005):
        if req.done:
            return
        req.done = True
        self.inflight -= 1
        end = self.now + extra
        self.m.record(end, req.ep.label, status, (end - req.t0) * 1000)
        self.at(end + 0.0005, self.publish, "AccessRecorded")  # ADR-0005, every request
        think = self.cfg["think"]
        delay = self.rng.expovariate(1 / think) if think > 0 else 0
        self.at(end + delay, self.vu_send, req.vu)

    # ---- gateway: 1 event loop Node.js -> 1 "CPU" dùng chung
    def gw_arrive(self, req):
        self.gw_queue.append(req)
        if not self.gw_busy:
            self.gw_next()

    def gw_next(self):
        if not self.gw_queue:
            self.gw_busy = False
            return
        self.gw_busy = True
        req = self.gw_queue.popleft()
        cpu = self.rng.expovariate(1000 / self.cfg["gw_cpu_ms"])
        self.at(self.now + cpu, self.gw_done, req)

    def gw_done(self, req):
        self.gw_next()
        ep = req.ep
        if ep.access == "internal":
            return self.finish(req, 404)
        if ep.access == "not-implemented":
            return self.finish(req, 501)
        t = 0.0
        window = int(self.now // 60)
        if self.cfg["redis"]:
            t += 0.0006
            self.rl[("ip", req.ip, window)] += 1
            if self.rl[("ip", req.ip, window)] > self.cfg["rl_ip"]:
                return self.at(self.now + t, self.finish, req, 429)
        if ep.access != "public":
            t += 0.0015  # verifyIdToken (khoá công khai đã cache)
            if ep.access == "role" and self.cfg["redis"]:
                t += 0.0006
                self.rl[("u", req.user, window)] += 1
                if self.rl[("u", req.user, window)] > self.cfg["rl_user"]:
                    return self.at(self.now + t, self.finish, req, 429)
        self.at(self.now + t + 0.0003, self.svc_arrive, req)

    # ---- service: worker = connection pool DB
    def svc_arrive(self, req):
        s = self.svcs[req.ep.service]
        if s.down:
            return self.at(self.now + 0.001, self.finish, req, 502)
        self.at(req.t0 + GATEWAY_TIMEOUT_S, self.timeout, req)
        if s.busy < s.workers:
            self.svc_start(s, req)
        else:
            s.queue.append(req)

    def svc_start(self, s, req):
        s.busy += 1
        mean = (s.write_ms if req.ep.write else s.read_ms) / 1000
        sigma = 0.5
        st = self.rng.lognormvariate(math.log(mean) - sigma * sigma / 2, sigma)
        self.at(self.now + st, self.svc_done, s, req)

    def svc_done(self, s, req):
        s.busy -= 1
        while s.queue:
            nxt = s.queue.popleft()
            if not nxt.done:
                self.svc_start(s, nxt)
                break
        if not req.done:
            self.finish(req, req.ep.ok_status())
            for ev in req.ep.events:
                self.at(self.now + self.rng.uniform(0.05, 0.5), self.publish, ev)  # outbox relay poll

    def timeout(self, req):
        if not req.done:
            self.finish(req, 504, 0)

    # ---- RabbitMQ
    def publish(self, ev):
        self.published += 1
        for cons in EVENT_CONSUMERS.get(ev, []):
            s = self.svcs[cons]
            s.c_queue.append(ev)
            self.c_next(cons)

    def c_next(self, cons):
        s = self.svcs[cons]
        prefetch = 50 if cons == "audit" else 10
        while not s.down and s.c_busy < prefetch and s.c_queue:
            ev = s.c_queue.popleft()
            s.c_busy += 1
            self.at(self.now + self.rng.lognormvariate(math.log(0.004), 0.4), self.c_done, cons, ev)

    def c_done(self, cons, ev):
        s = self.svcs[cons]
        s.c_busy -= 1
        s.consumed += 1
        nxt = FOLLOW_UP.get((cons, ev))
        if nxt:
            self.at(self.now + 0.1, self.publish, nxt)
        self.c_next(cons)

    def set_down(self, svc, down):
        s = self.svcs[svc]
        if s.down and not down:
            s.down = False
            self.c_next(svc)
        s.down = down

    def backlog(self):
        return sum(len(s.c_queue) for s in self.svcs.values())


class RealRunner:
    """Virtual user = thread gọi HTTP thật."""

    def __init__(self, cfg, metrics: Metrics):
        self.cfg, self.m = cfg, metrics
        self.stop_ev = threading.Event()
        self.t0 = time.perf_counter()
        self.threads = []
        self.active = 0
        self.lock = threading.Lock()
        tokens = [t.strip() for t in cfg["tokens"].split(",") if t.strip()]
        self.tokens = tokens
        for vu in range(cfg["vus"]):
            th = threading.Thread(target=self.vu, args=(vu,), daemon=True)
            self.threads.append(th)
            th.start()

    @property
    def now(self):
        return time.perf_counter() - self.t0

    def vu(self, vu):
        rng = random.Random(vu)
        cfg = self.cfg
        if self.stop_ev.wait(cfg["ramp"] * vu / max(1, cfg["vus"])):
            return
        with self.lock:
            self.active += 1
        eps, weights = zip(*cfg["mix"])
        try:
            while not self.stop_ev.is_set() and self.now < cfg["duration"]:
                ep = rng.choices(eps, weights)[0]
                headers = {"content-type": "application/json"}
                if self.tokens:
                    headers["authorization"] = "Bearer " + self.tokens[vu % len(self.tokens)]
                data = b"{}" if ep.method != "GET" else None
                req = urllib.request.Request(cfg["base"].rstrip("/") + ep.sample_path(), data=data, method=ep.method, headers=headers)
                t = time.perf_counter()
                try:
                    with urllib.request.urlopen(req, timeout=35) as r:
                        r.read()
                        status = r.status
                except urllib.error.HTTPError as e:
                    status = e.code
                except Exception:  # noqa: BLE001 - kết nối hỏng
                    status = 0
                self.m.record(self.now, ep.label, status, (time.perf_counter() - t) * 1000)
                think = cfg["think"]
                if think > 0 and self.stop_ev.wait(rng.expovariate(1 / think)):
                    break
        finally:
            with self.lock:
                self.active -= 1

    def finished(self):
        return not any(t.is_alive() for t in self.threads)

    def stop(self):
        self.stop_ev.set()


class LineChart(tk.Canvas):
    def __init__(self, master, title, unit=""):
        super().__init__(master, width=400, height=165, bg="white", highlightthickness=1, highlightbackground="#cbd5e1")
        self.title, self.unit = title, unit
        self.bind("<Configure>", lambda e: self.draw())
        self.series, self.xmax = {}, 10

    def set(self, series, xmax):
        self.series, self.xmax = series, max(1, xmax)
        self.draw()

    def draw(self):
        self.delete("all")
        w, h = self.winfo_width(), self.winfo_height()
        pl, pr, pt, pb = 44, 10, 38, 20
        self.create_text(8, 4, text=self.title, anchor="nw", font=("Segoe UI", -12, "bold"), fill="#0f172a")
        ymax = max([y for _, pts in self.series.values() for _, y in pts] + [1])
        ymax = self._nice(ymax)
        for i in range(5):
            y = pt + (h - pt - pb) * i / 4
            self.create_line(pl, y, w - pr, y, fill="#f1f5f9")
            self.create_text(pl - 4, y, text=self._fmt(ymax * (4 - i) / 4), anchor="e", font=("Segoe UI", -10), fill="#64748b")
        self.create_line(pl, h - pb, w - pr, h - pb, fill="#94a3b8")
        for i in range(6):
            x = pl + (w - pl - pr) * i / 5
            self.create_text(x, h - pb + 3, text=f"{self.xmax * i / 5:.0f}s", anchor="n", font=("Segoe UI", -10), fill="#64748b")
        lx = w - pr
        for name, (color, pts) in reversed(list(self.series.items())):
            if len(pts) >= 2:
                coords = []
                for x, y in pts:
                    coords += [pl + (w - pl - pr) * x / self.xmax, h - pb - (h - pt - pb) * y / ymax]
                self.create_line(*coords, fill=color, width=2)
            t = self.create_text(lx, 20, text=f"■ {name}", anchor="ne", fill=color, font=("Segoe UI", -11, "bold"))
            lx = self.bbox(t)[0] - 8

    @staticmethod
    def _nice(v):
        p = 10 ** math.floor(math.log10(v)) if v > 0 else 1
        for m in (1, 2, 2.5, 5, 10):
            if v <= m * p:
                return m * p
        return 10 * p

    @staticmethod
    def _fmt(v):
        return f"{v / 1000:.1f}k" if v >= 1000 else (f"{v:.0f}" if v >= 10 else f"{v:.1f}")


MIX_PRESETS = ["Hỗn hợp thực tế (80% đọc)", "Chỉ đọc (GET)", "Ghi nhiều (60% ghi)", "Chỉ endpoint đang chọn ở tab 1", "Dồn vào billing-service"]
DEFAULT_SVC = {"identity": (10, 6, 15), "student": (10, 8, 20), "class": (10, 8, 25), "schedule": (10, 10, 40), "billing": (10, 12, 30), "audit": (10, 6, 6)}


class StressTab(ttk.Frame):
    def __init__(self, master, app):
        super().__init__(master, padding=6)
        self.app = app
        self.runner = None
        self.metrics = None
        self.mode = tk.StringVar(value="sim")
        self.v = {k: tk.StringVar(value=str(d)) for k, d in dict(
            vus=300, ramp=10, duration=60, think=500, ips=300, users=300, rl_ip=600, rl_user=300, gw_cpu=0.25,
            speed=1, base="http://localhost:8080/api", tokens="").items()}
        self.redis = tk.BooleanVar(value=True)
        self.mix = tk.StringVar(value=MIX_PRESETS[0])
        self.svc_vars = {s: [tk.StringVar(value=str(x)) for x in DEFAULT_SVC[s]] + [tk.BooleanVar(value=False)] for s in SERVICE_ORDER}
        self._build()

    def _build(self):
        left = ttk.Frame(self)
        left.pack(side="left", fill="y")
        right = ttk.Frame(self)
        right.pack(side="left", fill="both", expand=True, padx=(8, 0))

        m = ttk.LabelFrame(left, text="Chế độ", padding=6)
        m.pack(fill="x")
        ttk.Radiobutton(m, text="Mô phỏng (không cần backend)", variable=self.mode, value="sim").pack(anchor="w")
        ttk.Radiobutton(m, text="Gọi thật qua API Gateway", variable=self.mode, value="real").pack(anchor="w")

        g = ttk.LabelFrame(left, text="Tải", padding=6)
        g.pack(fill="x", pady=(6, 0))
        rows = [("Virtual users", "vus"), ("Ramp-up (s)", "ramp"), ("Thời lượng (s)", "duration"),
                ("Think time TB (ms)", "think"), ("Số IP nguồn", "ips"), ("Số user (token)", "users")]
        for i, (t, k) in enumerate(rows):
            ttk.Label(g, text=t).grid(row=i, column=0, sticky="w")
            ttk.Entry(g, textvariable=self.v[k], width=10).grid(row=i, column=1, sticky="ew", pady=1)
        ttk.Label(g, text="Kịch bản").grid(row=len(rows), column=0, sticky="w")
        ttk.Combobox(g, textvariable=self.mix, values=MIX_PRESETS, state="readonly", width=28).grid(row=len(rows), column=1, sticky="ew")
        g.columnconfigure(1, weight=1)

        s = ttk.LabelFrame(left, text="Mô hình (chế độ mô phỏng)", padding=6)
        s.pack(fill="x", pady=(6, 0))
        ttk.Checkbutton(s, text="Redis rate limit", variable=self.redis).grid(row=0, column=0, columnspan=2, sticky="w")
        for i, (t, k) in enumerate([("Giới hạn IP / phút", "rl_ip"), ("Giới hạn user / phút", "rl_user"),
                                    ("Gateway CPU ms/req", "gw_cpu"), ("Tốc độ mô phỏng (x)", "speed")], 1):
            ttk.Label(s, text=t).grid(row=i, column=0, sticky="w")
            ttk.Entry(s, textvariable=self.v[k], width=8).grid(row=i, column=1, columnspan=3, sticky="ew", pady=1)
        hdr = ["Service", "Pool", "Đọc ms", "Ghi ms", "Sập"]
        tbl = ttk.Frame(s)
        tbl.grid(row=6, column=0, columnspan=4, sticky="ew", pady=(6, 0))
        for c, t in enumerate(hdr):
            ttk.Label(tbl, text=t, font=("Segoe UI", 8, "bold")).grid(row=0, column=c, sticky="w")
        for r, svc in enumerate(SERVICE_ORDER, 1):
            ttk.Label(tbl, text=svc).grid(row=r, column=0, sticky="w")
            for c in range(3):
                ttk.Entry(tbl, textvariable=self.svc_vars[svc][c], width=5).grid(row=r, column=c + 1, padx=1)
            ttk.Checkbutton(tbl, variable=self.svc_vars[svc][3]).grid(row=r, column=4)
        ttk.Label(s, text="Tick 'Sập' được khi đang chạy để xem 502 và RabbitMQ backlog.", foreground="#64748b", wraplength=300).grid(row=7, column=0, columnspan=4, sticky="w", pady=(4, 0))

        r = ttk.LabelFrame(left, text="Chế độ gọi thật", padding=6)
        r.pack(fill="x", pady=(6, 0))
        ttk.Label(r, text="Base URL").grid(row=0, column=0, sticky="w")
        ttk.Entry(r, textvariable=self.v["base"], width=28).grid(row=0, column=1, sticky="ew")
        ttk.Label(r, text="ID tokens (,)").grid(row=1, column=0, sticky="w")
        ttk.Entry(r, textvariable=self.v["tokens"], width=28, show="•").grid(row=1, column=1, sticky="ew")
        r.columnconfigure(1, weight=1)

        b = ttk.Frame(left)
        b.pack(fill="x", pady=(8, 0))
        self.start_btn = ttk.Button(b, text="▶  Bắt đầu", style="Accent.TButton", command=self.start)
        self.start_btn.pack(side="left", expand=True, fill="x")
        ttk.Button(b, text="■  Dừng", command=self.stop).pack(side="left", expand=True, fill="x", padx=4)
        ttk.Button(b, text="CSV", command=self.export).pack(side="left")

        # bên phải
        self.summary = ttk.Label(right, text="Chưa chạy.", style="H.TLabel", wraplength=900)
        self.summary.pack(anchor="w")
        grid = ttk.Frame(right)
        grid.pack(fill="both", expand=True)
        self.ch_rps = LineChart(grid, "Throughput (req/s)")
        self.ch_lat = LineChart(grid, "Độ trễ (ms)")
        self.ch_err = LineChart(grid, "Tỉ lệ lỗi (%)")
        self.ch_sys = LineChart(grid, "Hệ thống")
        for i, ch in enumerate([self.ch_rps, self.ch_lat, self.ch_err, self.ch_sys]):
            ch.grid(row=i // 2, column=i % 2, sticky="nsew", padx=2, pady=2)
        grid.columnconfigure((0, 1), weight=1)
        grid.rowconfigure((0, 1), weight=1)
        self.bars = tk.Canvas(right, height=118, bg="white", highlightthickness=1, highlightbackground="#cbd5e1")
        self.bars.pack(fill="x", pady=(2, 4))
        cols = ("ep", "n", "ok", "err", "p50", "p95", "max", "codes")
        self.table = ttk.Treeview(right, columns=cols, show="headings", height=7)
        for c, t, w in zip(cols, ["Endpoint", "Req", "OK", "Lỗi %", "p50 ms", "p95 ms", "max ms", "Status"],
                           [260, 60, 60, 60, 70, 70, 70, 220]):
            self.table.heading(c, text=t)
            self.table.column(c, width=w, anchor="w" if c in ("ep", "codes") else "e")
        self.table.pack(fill="both", expand=True)
        self.history = []

    # ---- cấu hình
    def _num(self, k, cast=float):
        try:
            return cast(self.v[k].get())
        except ValueError:
            raise ValueError(f"Giá trị không hợp lệ: {k}")

    def _mix(self):
        preset = self.mix.get()
        eps = [e for e in ENDPOINTS if e.service != "-"]
        heavy_excl = ("/auth/register", "/auth/invitations/{token}/accept")
        if preset.startswith("Chỉ endpoint đang chọn"):
            ep = self.app.flow_tab.selected()
            return [(ep, 1)] if ep else []
        if preset.startswith("Chỉ đọc"):
            return [(e, 1) for e in eps if not e.write]
        if preset.startswith("Ghi nhiều"):
            return [(e, 3 if e.write else 2) for e in eps if e.path not in heavy_excl]
        if preset.startswith("Dồn vào billing"):
            return [(e, 1) for e in eps if e.service == "billing"]
        reads = [e for e in eps if not e.write]
        writes = [e for e in eps if e.write and e.path not in heavy_excl]
        return [(e, 80 / len(reads)) for e in reads] + [(e, 20 / len(writes)) for e in writes]

    def _cfg(self):
        services = {}
        for s, vs in self.svc_vars.items():
            services[s] = (max(1, int(vs[0].get())), max(0.1, float(vs[1].get())), max(0.1, float(vs[2].get())))
        cfg = dict(
            vus=max(1, self._num("vus", int)), ramp=max(0.0, self._num("ramp")), duration=max(1.0, self._num("duration")),
            think=max(0.0, self._num("think")) / 1000, ips=max(1, self._num("ips", int)), users=max(1, self._num("users", int)),
            rl_ip=self._num("rl_ip", int), rl_user=self._num("rl_user", int), gw_cpu_ms=max(0.01, self._num("gw_cpu")),
            speed=max(0.1, self._num("speed")), redis=self.redis.get(), services=services, mix=self._mix(),
            base=self.v["base"].get(), tokens=self.v["tokens"].get(), seed=42,
        )
        if not cfg["mix"]:
            raise ValueError("Kịch bản không có endpoint nào (chọn 1 endpoint ở tab 1).")
        return cfg

    # ---- điều khiển
    def start(self):
        if self.runner:
            return
        try:
            cfg = self._cfg()
        except ValueError as e:
            messagebox.showerror("Cấu hình", str(e))
            return
        if self.mode.get() == "real" and cfg["vus"] > 300:
            if not messagebox.askyesno("Nhiều thread", f"{cfg['vus']} thread gọi thật vào {cfg['base']}. Tiếp tục?"):
                return
        self.cfg = cfg
        self.metrics = Metrics()
        self.history = []
        self.wall0 = time.perf_counter()
        self.runner = Simulator(cfg, self.metrics) if self.mode.get() == "sim" else RealRunner(cfg, self.metrics)
        self.start_btn.state(["disabled"])
        self.last_draw = 0
        self._tick()

    def stop(self):
        if isinstance(self.runner, RealRunner):
            self.runner.stop()
        elif isinstance(self.runner, Simulator):
            self.cfg["duration"] = min(self.cfg["duration"], self.runner.now)
            self.runner.cfg["duration"] = self.cfg["duration"]

    def _tick(self):
        r = self.runner
        if r is None:
            return
        if isinstance(r, Simulator):
            for svc, vs in self.svc_vars.items():
                r.set_down(svc, vs[3].get())
            target = (time.perf_counter() - self.wall0) * self.cfg["speed"]
            r.run_until(min(target, self.cfg["duration"] + GATEWAY_TIMEOUT_S + 1))
        now = r.now
        if int(now) > len(self.history) - 1:
            self._sample(r, int(now))
        if time.perf_counter() - self.last_draw > 0.5:
            self.last_draw = time.perf_counter()
            self.redraw()
        if r.finished() or (isinstance(r, Simulator) and now > self.cfg["duration"] + GATEWAY_TIMEOUT_S):
            self._sample(r, int(now) + 1)
            self.redraw(final=True)
            self.runner = None
            self.start_btn.state(["!disabled"])
            return
        self.after(40, self._tick)

    def _sample(self, r, sec):
        while len(self.history) <= sec:
            if isinstance(r, Simulator):
                util = {s: (st.busy / st.workers, len(st.queue), st.down) for s, st in r.svcs.items()}
                self.history.append(dict(vus=r.active_vus, inflight=r.inflight, backlog=r.backlog(), util=util,
                                         gwq=len(r.gw_queue)))
            else:
                self.history.append(dict(vus=r.active, inflight=r.active, backlog=None, util=None, gwq=None))

    def redraw(self, final=False):
        m, r = self.metrics, self.runner
        if m is None:
            return
        with m.lock:
            secs = sorted(m.buckets)
            bucket = {k: (v[0], v[1], sorted(v[2])) for k, v in m.buckets.items()}
            per_ep = {k: (v[0], v[1], sorted(v[2]), Counter(v[3])) for k, v in m.per_ep.items()}
            codes, total = Counter(m.codes), m.total
        dur = self.cfg["duration"]
        xmax = max(dur, (secs[-1] + 1) if secs else 1)
        last_full = (int(r.now) if r else (secs[-1] + 1 if secs else 0))
        rps_ok, rps_err, p50, p95, p99, errp = [], [], [], [], [], []
        for sec in range(0, last_full):
            ok, err, lat = bucket.get(sec, (0, 0, []))
            x = sec + 0.5
            rps_ok.append((x, ok))
            rps_err.append((x, err))
            p50.append((x, percentile(lat, 50)))
            p95.append((x, percentile(lat, 95)))
            p99.append((x, percentile(lat, 99)))
            errp.append((x, 100 * err / (ok + err) if ok + err else 0))
        self.ch_rps.set({"2xx": (C["ok"], rps_ok), "lỗi": (C["err"], rps_err)}, xmax)
        self.ch_lat.set({"p50": ("#3b82f6", p50), "p95": ("#f59e0b", p95), "p99": ("#ef4444", p99)}, xmax)
        self.ch_err.set({"lỗi %": (C["err"], errp)}, xmax)
        hist = self.history
        sysd = {"VU active": ("#6366f1", [(i, h["vus"]) for i, h in enumerate(hist)])}
        if hist and hist[-1]["backlog"] is not None:
            sysd["in-flight"] = ("#0ea5e9", [(i, h["inflight"]) for i, h in enumerate(hist)])
            sysd["RabbitMQ backlog"] = (C["rabbit"], [(i, h["backlog"]) for i, h in enumerate(hist)])
        self.ch_sys.set(sysd, xmax)

        # thanh tải service
        cv = self.bars
        cv.delete("all")
        w = cv.winfo_width()
        if isinstance(r, Simulator) or (hist and hist[-1]["util"]):
            if isinstance(r, Simulator):
                util = {s: (st.busy / st.workers, len(st.queue), st.down, len(st.c_queue)) for s, st in r.svcs.items()}
                gwq = len(r.gw_queue)
            else:
                util = {s: (*v, 0) for s, v in hist[-1]["util"].items()}
                gwq = hist[-1]["gwq"]
            cv.create_text(8, 6, anchor="nw", text=f"Tải service (pool DB đang dùng) · hàng đợi gateway: {gwq}", font=("Segoe UI", -12, "bold"))
            for i, (s, (u, q, down, cq)) in enumerate(util.items()):
                y = 26 + i * 18
                cv.create_text(8, y, anchor="nw", text=s, font=("Segoe UI", -11))
                bw = max(50, w - 330)
                cv.create_rectangle(80, y + 2, 80 + bw, y + 13, fill="#f1f5f9", outline="")
                col = C["err"] if down else (C["ok"] if u < 0.7 else C["warn"] if u < 0.95 else C["err"])
                cv.create_rectangle(80, y + 2, 80 + bw * u, y + 13, fill=col, outline="")
                txt = "SẬP" if down else f"{u * 100:3.0f}%  · chờ pool: {q}"
                cv.create_text(88 + bw, y, anchor="nw", text=f"{txt}  · event chờ: {cq}", font=("Segoe UI", -11))
        else:
            cv.create_text(8, 6, anchor="nw", text="Chế độ gọi thật: không đo được tải bên trong service (xem docker stats / logs).", font=("Segoe UI", -12))

        # bảng endpoint
        self.table.delete(*self.table.get_children())
        for label, (n, ok, lat, cs) in sorted(per_ep.items(), key=lambda kv: -kv[1][0]):
            self.table.insert("", "end", values=(label, n, ok, f"{100 * (n - ok) / n:.1f}", f"{percentile(lat, 50):.1f}",
                                                 f"{percentile(lat, 95):.1f}", f"{lat[-1]:.1f}" if lat else "0",
                                                 " ".join(f"{k or 'ERR'}:{v}" for k, v in sorted(cs.items()))))
        # tóm tắt
        all_lat = sorted(x for _, _, lat in bucket.values() for x in lat)
        elapsed = max(0.001, min(r.now if r else xmax, xmax))
        okc = sum(v for k, v in codes.items() if 200 <= k < 400)
        state = "Hoàn tất" if final else "Đang chạy"
        if r is not None and isinstance(r, Simulator):
            state += f" · t={r.now:5.1f}s mô phỏng · đã publish {r.published} message (event + Access record)"
        self.summary.configure(text=(f"{state} · {total} req · {total / elapsed:.0f} req/s TB · lỗi {100 * (total - okc) / max(1, total):.1f}% · "
                                     f"p50 {percentile(all_lat, 50):.0f} ms · p95 {percentile(all_lat, 95):.0f} ms · "
                                     + " ".join(f"{k or 'ERR'}:{v}" for k, v in sorted(codes.items()))))

    def export(self):
        if not self.metrics:
            return
        path = filedialog.asksaveasfilename(defaultextension=".csv", filetypes=[("CSV", "*.csv")], initialfile="stress-result.csv")
        if not path:
            return
        with self.metrics.lock, open(path, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.writer(f)
            w.writerow(["endpoint", "requests", "ok", "p50_ms", "p95_ms", "p99_ms", "max_ms", "status_codes"])
            for label, (n, ok, lat, cs) in self.metrics.per_ep.items():
                s = sorted(lat)
                w.writerow([label, n, ok, f"{percentile(s, 50):.2f}", f"{percentile(s, 95):.2f}", f"{percentile(s, 99):.2f}",
                            f"{s[-1]:.2f}" if s else 0, json.dumps({str(k): v for k, v in cs.items()})])
        messagebox.showinfo("CSV", f"Đã lưu {path}")


# ----------------------------------------------------------------------------------

class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("TMS — Mô phỏng luồng endpoint & Stress test")
        self.geometry("1400x860")
        self.minsize(1200, 760)
        style = ttk.Style(self)
        if "clam" in style.theme_names():
            style.theme_use("clam")
        style.configure(".", font=("Segoe UI", 9))
        style.configure("H.TLabel", font=("Segoe UI", 10, "bold"))
        line = tkfont.Font(family="Segoe UI", size=9).metrics("linespace")
        style.configure("Treeview", rowheight=int(line * 1.35))
        style.configure("Accent.TButton", font=("Segoe UI", 10, "bold"), foreground="white", background="#4f46e5")
        style.map("Accent.TButton", background=[("active", "#4338ca"), ("disabled", "#a5b4fc")])
        nb = ttk.Notebook(self)
        nb.pack(fill="both", expand=True)
        self.flow_tab = FlowTab(nb, self)
        self.stress_tab = StressTab(nb, self)
        nb.add(self.flow_tab, text="  Luồng endpoint  ")
        nb.add(self.stress_tab, text="  Stress test  ")


if __name__ == "__main__":
    App().mainloop()
