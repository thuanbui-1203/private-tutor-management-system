"""Generates dashboards/tms-api.json. Edit this file, then run:  python infra/grafana/build-dashboard.py

Kept as code because a dashboard with ~30 panels is easier to review and change here than
as raw Grafana JSON. Grafana rescans the output folder every 30 s (provisioning/dashboards).
"""

import json
from pathlib import Path

DS = {"type": "prometheus", "uid": "prometheus"}
GW = "tms_gateway_requests_seconds"
SVC = "http_server_requests_seconds"
GW_SEL = 'target=~"$target", route=~"$route", method=~"$method"'
SVC_SEL = 'service=~"$service", route=~"$route", method=~"$method"'
RI = "$__rate_interval"

_next_id = 0
_y = 0


def nid():
    global _next_id
    _next_id += 1
    return _next_id


def target(expr, legend="", ref="A", instant=False, fmt=None):
    t = {"datasource": DS, "expr": expr, "legendFormat": legend, "refId": ref}
    if instant:
        t.update(instant=True, range=False)
    if fmt:
        t["format"] = fmt
    return t


def place(w, h, x):
    return {"x": x, "y": _y, "w": w, "h": h}


def row(title):
    global _y
    p = {"id": nid(), "type": "row", "title": title, "collapsed": False,
         "gridPos": {"x": 0, "y": _y, "w": 24, "h": 1}, "panels": []}
    _y += 1
    return p


def newline(h):
    global _y
    _y += h


def timeseries(title, targets, x, w, h=8, unit="reqps", desc="", stack=False, overrides=None):
    return {
        "id": nid(), "type": "timeseries", "title": title, "description": desc,
        "datasource": DS, "gridPos": place(w, h, x), "targets": targets,
        "fieldConfig": {
            "defaults": {
                "unit": unit,
                "min": 0,
                "custom": {
                    "drawStyle": "line", "lineWidth": 1, "fillOpacity": 15 if stack else 8,
                    "showPoints": "never", "spanNulls": True,
                    "stacking": {"mode": "normal" if stack else "none", "group": "A"},
                },
            },
            "overrides": overrides or [],
        },
        "options": {
            "legend": {"displayMode": "table", "placement": "right", "showLegend": True,
                       "calcs": ["mean", "max", "lastNotNull"]},
            "tooltip": {"mode": "multi", "sort": "desc"},
        },
    }


def stat(title, expr, x, w, unit="none", desc="", thresholds=None, decimals=None, legend="",
         mappings=None, color_mode="value"):
    d = {"unit": unit, "color": {"mode": "thresholds"},
         "thresholds": {"mode": "absolute",
                        "steps": thresholds or [{"color": "green", "value": None}]}}
    if decimals is not None:
        d["decimals"] = decimals
    if mappings:
        d["mappings"] = mappings
    return {
        "id": nid(), "type": "stat", "title": title, "description": desc, "datasource": DS,
        "gridPos": place(w, 4, x), "targets": [target(expr, legend, instant=True)],
        "fieldConfig": {"defaults": d, "overrides": []},
        "options": {"reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False},
                    "colorMode": color_mode, "graphMode": "none", "textMode": "auto",
                    "justifyMode": "center", "orientation": "auto"},
    }


def endpoint_table(title, metric, sel, keys, x, w, h, desc):
    """One row per endpoint: traffic, errors and latency percentiles over the chosen range."""
    by = ", ".join(keys)
    rng = "$__range"
    queries = [
        ("A", f"sum by ({by}) (increase({metric}_count{{{sel}}}[{rng}]))", "Requests"),
        ("B", f"sum by ({by}) (rate({metric}_count{{{sel}}}[{rng}]))", "Req/s"),
        ("C", f'(sum by ({by}) (increase({metric}_count{{{sel}, status=~"5.."}}[{rng}])) or '
              f"(0 * sum by ({by}) (increase({metric}_count{{{sel}}}[{rng}])))) / "
              f"sum by ({by}) (increase({metric}_count{{{sel}}}[{rng}]))", "5xx %"),
        ("D", f'(sum by ({by}) (increase({metric}_count{{{sel}, status=~"4.."}}[{rng}])) or '
              f"(0 * sum by ({by}) (increase({metric}_count{{{sel}}}[{rng}])))) / "
              f"sum by ({by}) (increase({metric}_count{{{sel}}}[{rng}]))", "4xx %"),
        ("E", f"sum by ({by}) (increase({metric}_sum{{{sel}}}[{rng}])) / "
              f"sum by ({by}) (increase({metric}_count{{{sel}}}[{rng}]))", "Avg"),
        ("F", f"histogram_quantile(0.50, sum by ({by}, le) (increase({metric}_bucket{{{sel}}}[{rng}])))", "p50"),
        ("G", f"histogram_quantile(0.95, sum by ({by}, le) (increase({metric}_bucket{{{sel}}}[{rng}])))", "p95"),
        ("H", f"histogram_quantile(0.99, sum by ({by}, le) (increase({metric}_bucket{{{sel}}}[{rng}])))", "p99"),
    ]
    rename = {f"Value #{ref}": name for ref, _, name in queries}
    rename.update({k: k.capitalize() for k in keys})

    def unit_override(name, unit, extra=None):
        props = [{"id": "unit", "value": unit}]
        props += extra or []
        return {"matcher": {"id": "byName", "options": name}, "properties": props}

    pct_color = [{"id": "custom.cellOptions", "value": {"type": "color-text"}},
                 {"id": "thresholds", "value": {"mode": "absolute", "steps": [
                     {"color": "green", "value": None}, {"color": "orange", "value": 0.01},
                     {"color": "red", "value": 0.05}]}}]
    lat_color = [{"id": "custom.cellOptions", "value": {"type": "color-text"}},
                 {"id": "thresholds", "value": {"mode": "absolute", "steps": [
                     {"color": "green", "value": None}, {"color": "orange", "value": 0.3},
                     {"color": "red", "value": 1}]}}]
    return {
        "id": nid(), "type": "table", "title": title, "description": desc, "datasource": DS,
        "gridPos": place(w, h, x),
        "targets": [target(e, ref=r, instant=True, fmt="table") for r, e, _ in queries],
        "transformations": [
            {"id": "merge", "options": {}},
            {"id": "organize", "options": {"excludeByName": {"Time": True},
                                           "renameByName": rename,
                                           "indexByName": {**{k.capitalize(): i for i, k in enumerate(keys)},
                                                           **{n: len(keys) + i for i, (_, _, n) in enumerate(queries)}}}},
            {"id": "sortBy", "options": {"sort": [{"field": "Requests", "desc": True}]}},
        ],
        "fieldConfig": {
            "defaults": {"custom": {"align": "auto", "filterable": True}, "decimals": 2},
            "overrides": [
                unit_override("Requests", "short", [{"id": "decimals", "value": 0}]),
                unit_override("Req/s", "reqps"),
                unit_override("5xx %", "percentunit", pct_color),
                unit_override("4xx %", "percentunit"),
                unit_override("Avg", "s"),
                unit_override("p50", "s"),
                unit_override("p95", "s", lat_color),
                unit_override("p99", "s", lat_color),
            ],
        },
        "options": {"showHeader": True, "cellHeight": "sm",
                    "footer": {"show": False, "reducer": ["sum"], "fields": ""}},
    }


def variable(name, label, query, include_all=True):
    return {
        "name": name, "label": label, "type": "query", "datasource": DS,
        "query": {"query": query, "refId": name}, "definition": query,
        "refresh": 2, "multi": True, "includeAll": include_all, "allValue": ".*",
        "current": {"selected": True, "text": ["All"], "value": ["$__all"]}, "sort": 1,
    }


status_colors = [
    {"matcher": {"id": "byRegexp", "options": "^2.*"},
     "properties": [{"id": "color", "value": {"mode": "fixed", "fixedColor": "green"}}]},
    {"matcher": {"id": "byRegexp", "options": "^3.*"},
     "properties": [{"id": "color", "value": {"mode": "fixed", "fixedColor": "blue"}}]},
    {"matcher": {"id": "byRegexp", "options": "^4.*"},
     "properties": [{"id": "color", "value": {"mode": "fixed", "fixedColor": "orange"}}]},
    {"matcher": {"id": "byRegexp", "options": "^5.*"},
     "properties": [{"id": "color", "value": {"mode": "fixed", "fixedColor": "red"}}]},
]

panels = []

# ---------- Overview ----------
panels.append(row("Tổng quan"))
panels += [
    stat("Service đang chạy", 'sum(up{job="tms"})', 0, 4,
         desc="Số app Prometheus scrape được (tối đa 6: gateway + 5 service).",
         thresholds=[{"color": "red", "value": None}, {"color": "orange", "value": 5},
                     {"color": "green", "value": 6}]),
    stat("Request / s (gateway)", f"sum(rate({GW}_count{{{GW_SEL}}}[{RI}]))", 4, 4,
         unit="reqps", decimals=2),
    stat("Request trong khoảng", f"sum(increase({GW}_count{{{GW_SEL}}}[$__range]))", 8, 4,
         unit="short", decimals=0),
    stat("Tỉ lệ lỗi 5xx",
         f'(sum(rate({GW}_count{{{GW_SEL}, status=~"5.."}}[{RI}])) or vector(0)) / '
         f"sum(rate({GW}_count{{{GW_SEL}}}[{RI}]))", 12, 4, unit="percentunit", decimals=2,
         thresholds=[{"color": "green", "value": None}, {"color": "orange", "value": 0.01},
                     {"color": "red", "value": 0.05}]),
    stat("Latency p95 (gateway)",
         f"histogram_quantile(0.95, sum by (le) (rate({GW}_bucket{{{GW_SEL}}}[{RI}])))", 16, 4,
         unit="s", decimals=3,
         thresholds=[{"color": "green", "value": None}, {"color": "orange", "value": 0.3},
                     {"color": "red", "value": 1}]),
    stat("Đang xử lý", 'sum(http_server_requests_in_flight{job="tms"})', 20, 4,
         desc="Request đang được xử lý ở mọi app (không tính /api đang proxy ở gateway).",
         decimals=0),
]
newline(4)
panels.append(stat(
    "Trạng thái từng service", 'up{job="tms", service=~"$service"}', 0, 24, legend="{{service}}",
    mappings=[{"type": "value", "options": {"0": {"text": "DOWN", "color": "red", "index": 0},
                                            "1": {"text": "UP", "color": "green", "index": 1}}}],
    thresholds=[{"color": "red", "value": None}, {"color": "green", "value": 1}],
    color_mode="background"))
newline(4)

# ---------- Gateway: client traffic ----------
panels.append(row("Luồng truy cập qua API Gateway (client → gateway → service)"))
panels += [
    timeseries("Request / s theo service đích", [
        target(f"sum by (target) (rate({GW}_count{{{GW_SEL}}}[{RI}]))", "{{target}}")],
        0, 12, stack=True,
        desc="`target` = service nhận request sau gateway; `gateway` = gateway tự trả lời "
             "(401 thiếu token, 403, 404, 429 rate limit, 501)."),
    timeseries("Request / s theo status code", [
        target(f"sum by (status) (rate({GW}_count{{{GW_SEL}}}[{RI}]))", "{{status}}")],
        12, 12, stack=True, overrides=status_colors),
]
newline(8)
panels.append(endpoint_table(
    "Tất cả endpoint qua gateway", GW, GW_SEL, ["method", "route", "target"], 0, 24, 12,
    "Mỗi dòng là một endpoint (route template: id được thay bằng :id). Số liệu tính trên "
    "khoảng thời gian đang chọn ở góc phải. Bấm tiêu đề cột để sắp xếp, icon phễu để lọc."))
newline(12)
panels += [
    timeseries("Top 10 endpoint theo request / s", [
        target(f"topk(10, sum by (method, route) (rate({GW}_count{{{GW_SEL}}}[{RI}])))",
               "{{method}} {{route}}")], 0, 12),
    timeseries("Latency p95 theo endpoint", [
        target(f"histogram_quantile(0.95, sum by (method, route, le) "
               f"(rate({GW}_bucket{{{GW_SEL}}}[{RI}])))", "{{method}} {{route}}")],
        12, 12, unit="s"),
]
newline(8)
panels += [
    timeseries("Lỗi 4xx / 5xx theo endpoint", [
        target(f'sum by (method, route, status) (rate({GW}_count{{{GW_SEL}, status=~"[45].."}}[{RI}]))',
               "{{status}} {{method}} {{route}}")], 0, 12, overrides=status_colors),
    timeseries("Latency p50 / p95 / p99 (toàn gateway)", [
        target(f"histogram_quantile(0.50, sum by (le) (rate({GW}_bucket{{{GW_SEL}}}[{RI}])))", "p50", "A"),
        target(f"histogram_quantile(0.95, sum by (le) (rate({GW}_bucket{{{GW_SEL}}}[{RI}])))", "p95", "B"),
        target(f"histogram_quantile(0.99, sum by (le) (rate({GW}_bucket{{{GW_SEL}}}[{RI}])))", "p99", "C"),
    ], 12, 12, unit="s"),
]
newline(8)

# ---------- Per service ----------
panels.append(row("Endpoint trong từng service (gồm cả gọi nội bộ /internal/**)"))
panels += [
    timeseries("Request / s theo service", [
        target(f"sum by (service) (rate({SVC}_count{{{SVC_SEL}}}[{RI}]))", "{{service}}")],
        0, 12, stack=True,
        desc="Mọi request mà service trả lời: từ gateway và từ service khác (/internal/**). "
             "Không tính /health, /metrics, /docs."),
    timeseries("Latency p95 theo service", [
        target(f"histogram_quantile(0.95, sum by (service, le) (rate({SVC}_bucket{{{SVC_SEL}}}[{RI}])))",
               "{{service}}")], 12, 12, unit="s"),
]
newline(8)
panels.append(endpoint_table(
    "Tất cả endpoint của các service", SVC, SVC_SEL, ["service", "method", "route"], 0, 24, 12,
    "Route template lấy từ controller NestJS. Lọc theo service bằng biến `service` ở đầu trang."))
newline(12)
panels += [
    timeseries("Request / s theo endpoint", [
        target(f"sum by (service, method, route) (rate({SVC}_count{{{SVC_SEL}}}[{RI}]))",
               "{{service}} {{method}} {{route}}")], 0, 12),
    timeseries("Latency p95 theo endpoint", [
        target(f"histogram_quantile(0.95, sum by (service, method, route, le) "
               f"(rate({SVC}_bucket{{{SVC_SEL}}}[{RI}])))", "{{service}} {{method}} {{route}}")],
        12, 12, unit="s"),
]
newline(8)
panels += [
    timeseries("Gọi đồng bộ giữa các service (/internal/**)", [
        target(f'sum by (service, method, route, status) (rate({SVC}_count{{service=~"$service", route=~"/internal/.*"}}[{RI}]))',
               "→ {{service}} {{method}} {{route}} {{status}}")], 0, 12,
        desc="Service nhận (`→ service`) của các lời gọi nội bộ: ví dụ class-service hỏi "
             "student-service, student-service hỏi billing-service."),
    timeseries("Lỗi 5xx theo endpoint", [
        target(f'sum by (service, method, route, status) (rate({SVC}_count{{{SVC_SEL}, status=~"5.."}}[{RI}]))',
               "{{status}} {{service}} {{method}} {{route}}")], 12, 12),
]
newline(8)

# ---------- Events ----------
panels.append(row("Luồng sự kiện bất đồng bộ (outbox → RabbitMQ → consumer)"))
panels += [
    timeseries("Event publish từ outbox / s", [
        target(f'sum by (service) (rate(tms_outbox_published_total{{service=~"$service"}}[{RI}]))',
               "{{service}}")], 0, 8, unit="ops"),
    timeseries("Event consume / s theo loại", [
        target(f'sum by (service, event_type) (rate(tms_events_consumed_total{{service=~"$service", outcome="handled"}}[{RI}]))',
               "{{service}} ← {{event_type}}")], 8, 8, unit="ops"),
    timeseries("Event retry / trùng / DLQ", [
        target(f'sum by (service, event_type, outcome) (rate(tms_events_consumed_total{{service=~"$service", outcome!="handled"}}[{RI}]))',
               "{{outcome}} {{service}} ← {{event_type}}")], 16, 8, unit="ops"),
]
newline(8)
panels.append(timeseries("RabbitMQ: message đang chờ trong queue", [
    target('sum by (queue) (rabbitmq_queue_messages_ready{job="rabbitmq"})', "{{queue}}", "A"),
    target('sum by (queue) (rabbitmq_queue_messages_unacked{job="rabbitmq"})', "{{queue}} (đang xử lý)", "B"),
], 0, 24, unit="short",
    desc="Queue tăng liên tục nghĩa là consumer xử lý không kịp hoặc đang lỗi."))
newline(8)

# ---------- Runtime ----------
panels.append(row("Tài nguyên (Node.js)"))
panels += [
    timeseries("CPU", [target(f'rate(process_cpu_seconds_total{{job="tms", service=~"$service"}}[{RI}])',
                              "{{service}}")], 0, 8, unit="percentunit"),
    timeseries("Bộ nhớ (RSS)", [target('process_resident_memory_bytes{job="tms", service=~"$service"}',
                                       "{{service}}")], 8, 8, unit="bytes"),
    timeseries("Event loop lag p99", [target('nodejs_eventloop_lag_p99_seconds{job="tms", service=~"$service"}',
                                             "{{service}}")], 16, 8, unit="s"),
]
newline(8)

dashboard = {
    "uid": "tms-api",
    "title": "TMS – Luồng API",
    "description": "Lưu lượng, lỗi và độ trễ của mọi endpoint: qua API Gateway và trong từng service.",
    "tags": ["tms", "api", "microservices"],
    "timezone": "browser",
    "schemaVersion": 41,
    "version": 1,
    "editable": True,
    "refresh": "10s",
    "time": {"from": "now-1h", "to": "now"},
    "templating": {"list": [
        variable("service", "Service", 'label_values(up{job="tms"}, service)'),
        variable("target", "Service đích (gateway)", f"label_values({GW}_count, target)"),
        # Both metrics: the gateway names every path parameter :id, services keep their own names.
        variable("method", "Method", f'label_values({{__name__=~"{SVC}_count|{GW}_count"}}, method)'),
        variable("route", "Endpoint", f'label_values({{__name__=~"{SVC}_count|{GW}_count"}}, route)'),
    ]},
    "annotations": {"list": []},
    "panels": panels,
}

out = Path(__file__).parent / "dashboards" / "tms-api.json"
out.write_text(json.dumps(dashboard, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"wrote {out} ({len(panels)} panels)")
