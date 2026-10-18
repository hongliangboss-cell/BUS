#!/usr/bin/env python3
"""下载两个分类的静态 GTFS，解析成前端用的精简 JSON，写入 data/ 目录。

只用 Python 标准库。用法：
    python scripts/build_static.py                 # 从网上下载
    python scripts/build_static.py --local a.zip:rapid-bus-kl   # 用本地 zip 测试
"""
import csv, io, json, math, os, sys, zipfile, urllib.request
from collections import defaultdict

CATEGORIES = ["rapid-bus-kl", "rapid-bus-mrtfeeder"]
URL = "https://api.data.gov.my/gtfs-static/prasarana?category={}"
OUT = os.path.join(os.path.dirname(__file__), "..", "data")


def read_csv(z, name):
    if name not in z.namelist():
        return []
    with z.open(name) as f:
        text = io.TextIOWrapper(f, encoding="utf-8-sig")
        return [{k.strip(): (v or "").strip() for k, v in r.items() if k} for r in csv.DictReader(text)]


def hav(a, b):
    R = 6371000
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def to_min(t):
    h, m, s = (int(x) for x in t.split(":"))
    return h * 60 + m + s / 60


def project_along(shape, cum, p):
    """返回点 p 投影到折线 shape 上的沿线距离（米）。"""
    best, best_d = 0.0, float("inf")
    kx = math.cos(math.radians(p[0])) * 111320
    ky = 110540
    for i in range(len(shape) - 1):
        ax, ay = shape[i][1] * kx, shape[i][0] * ky
        bx, by = shape[i + 1][1] * kx, shape[i + 1][0] * ky
        px, py = p[1] * kx, p[0] * ky
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        t = 0 if L2 == 0 else max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / L2))
        qx, qy = ax + t * dx, ay + t * dy
        d = (px - qx) ** 2 + (py - qy) ** 2
        if d < best_d:
            best_d, best = d, cum[i] + t * (cum[i + 1] - cum[i])
    return best


def service_days(calendar):
    """service_id -> 'wd'/'sat'/'sun' 的集合。"""
    out = defaultdict(set)
    for c in calendar:
        sid = c["service_id"]
        if any(c.get(d) == "1" for d in ("monday", "tuesday", "wednesday", "thursday", "friday")):
            out[sid].add("wd")
        if c.get("saturday") == "1":
            out[sid].add("sat")
        if c.get("sunday") == "1":
            out[sid].add("sun")
    return out


def build_category(cat, data):
    z = zipfile.ZipFile(io.BytesIO(data))
    print(f"[{cat}] 文件：", z.namelist())
    routes = read_csv(z, "routes.txt")
    trips = read_csv(z, "trips.txt")
    stops = {s["stop_id"]: s for s in read_csv(z, "stops.txt")}
    stop_times = read_csv(z, "stop_times.txt")
    shapes_raw = read_csv(z, "shapes.txt")
    freqs = read_csv(z, "frequencies.txt")
    sdays = service_days(read_csv(z, "calendar.txt"))

    shapes = defaultdict(list)
    for r in shapes_raw:
        shapes[r["shape_id"]].append((int(r["shape_pt_sequence"]), float(r["shape_pt_lat"]), float(r["shape_pt_lon"])))
    for k in shapes:
        shapes[k] = [(a, b) for _, a, b in sorted(shapes[k])]

    st_by_trip = defaultdict(list)
    for r in stop_times:
        st_by_trip[r["trip_id"]].append(r)
    for k in st_by_trip:
        st_by_trip[k].sort(key=lambda r: int(r["stop_sequence"]))

    freq_by_trip = defaultdict(list)
    for f in freqs:
        freq_by_trip[f["trip_id"]].append(f)

    trips_by_route = defaultdict(list)
    for t in trips:
        trips_by_route[t["route_id"]].append(t)

    route_list, stop_routes = [], defaultdict(set)
    os.makedirs(os.path.join(OUT, "route"), exist_ok=True)
    for r in routes:
        rid = r["route_id"]
        key = f"{cat}~{rid}"
        rtrips = [t for t in trips_by_route.get(rid, []) if st_by_trip.get(t["trip_id"])]
        # 按 direction_id 分组；没有 direction_id 时按首末站分组
        groups = defaultdict(list)
        for t in rtrips:
            st = st_by_trip[t["trip_id"]]
            g = t.get("direction_id") or f"{st[0]['stop_id']}>{st[-1]['stop_id']}"
            groups[g].append(t)
        directions = []
        for g, gtrips in sorted(groups.items()):
            # 代表班次：站点最多的那一班
            rep = max(gtrips, key=lambda t: len(st_by_trip[t["trip_id"]]))
            st = st_by_trip[rep["trip_id"]]
            seq = [s for s in st if s["stop_id"] in stops]
            if len(seq) < 2:
                continue
            spts = [(float(stops[s["stop_id"]]["stop_lat"]), float(stops[s["stop_id"]]["stop_lon"])) for s in seq]
            shape = shapes.get(rep.get("shape_id", "")) or spts
            cum = [0.0]
            for i in range(1, len(shape)):
                cum.append(cum[-1] + hav(shape[i - 1], shape[i]))
            t0 = to_min(seq[0]["departure_time"] or seq[0]["arrival_time"]) if seq[0].get("departure_time") else None
            stop_objs, last = [], -1
            for s, p in zip(seq, spts):
                d = project_along(shape, cum, p)
                d = max(d, last)  # 保证单调递增
                last = d
                off = None
                tt = s.get("arrival_time") or s.get("departure_time")
                if t0 is not None and tt:
                    off = round(to_min(tt) - t0, 1)
                stop_objs.append({"id": s["stop_id"], "n": stops[s["stop_id"]].get("stop_name", s["stop_id"]),
                                  "lat": round(p[0], 6), "lon": round(p[1], 6), "d": round(d), "o": off})
                stop_routes[s["stop_id"]].add(key)
            # 计划发车时间（首站），按 平日/周六/周日
            starts = {"wd": set(), "sat": set(), "sun": set()}
            for t in gtrips:
                days = sdays.get(t["service_id"]) or {"wd", "sat", "sun"}
                tst = st_by_trip[t["trip_id"]]
                if freq_by_trip.get(t["trip_id"]):
                    mins = []
                    for f in freq_by_trip[t["trip_id"]]:
                        a, b, h = to_min(f["start_time"]), to_min(f["end_time"]), int(f["headway_secs"]) / 60
                        m = a
                        while m < b and h > 0:
                            mins.append(m); m += h
                elif tst[0].get("departure_time"):
                    mins = [to_min(tst[0]["departure_time"])]
                else:
                    mins = []
                for d in days:
                    starts[d].update(round(m) for m in mins)
            # 稀疏化形状点，减小文件
            step = max(1, len(shape) // 400)
            slim = [[round(a, 5), round(b, 5)] for a, b in shape[::step]]
            if slim[-1] != [round(shape[-1][0], 5), round(shape[-1][1], 5)]:
                slim.append([round(shape[-1][0], 5), round(shape[-1][1], 5)])
            directions.append({
                "dir": g, "head": rep.get("trip_headsign") or stop_objs[-1]["n"],
                "stops": stop_objs, "shape": slim, "len": round(cum[-1]),
                "trips": sorted(t["trip_id"] for t in gtrips),
                "starts": {k: sorted(v) for k, v in starts.items()},
            })
        if not directions:
            continue
        short = r.get("route_short_name") or rid
        info = {"key": key, "id": rid, "cat": cat, "short": short,
                "long": r.get("route_long_name", ""), "color": r.get("route_color", "")}
        route_list.append(info)
        with open(os.path.join(OUT, "route", safe(key) + ".json"), "w", encoding="utf-8") as f:
            json.dump({**info, "directions": directions}, f, ensure_ascii=False, separators=(",", ":"))

    stop_list = []
    for sid, keys in stop_routes.items():
        s = stops[sid]
        stop_list.append([sid, s.get("stop_name", sid), round(float(s["stop_lat"]), 6), round(float(s["stop_lon"]), 6), sorted(keys)])
    return route_list, stop_list


def safe(key):
    return "".join(c if c.isalnum() or c in "-_~" else "_" for c in key)


def main():
    sources = []
    if "--local" in sys.argv:
        for arg in sys.argv[sys.argv.index("--local") + 1:]:
            path, cat = arg.split(":")
            sources.append((cat, open(path, "rb").read()))
    else:
        for cat in CATEGORIES:
            print("下载", URL.format(cat))
            req = urllib.request.Request(URL.format(cat), headers={"User-Agent": "rapid-bus-tracker"})
            sources.append((cat, urllib.request.urlopen(req, timeout=120).read()))
    os.makedirs(OUT, exist_ok=True)
    rdir = os.path.join(OUT, "route")
    if os.path.isdir(rdir):
        for f in os.listdir(rdir):
            os.remove(os.path.join(rdir, f))
    all_routes, all_stops = [], {}
    for cat, data in sources:
        rl, sl = build_category(cat, data)
        all_routes += rl
        for s in sl:  # 同一车站可能两个分类都有
            if s[0] in all_stops:
                all_stops[s[0]][4] = sorted(set(all_stops[s[0]][4]) | set(s[4]))
            else:
                all_stops[s[0]] = s
        print(f"[{cat}] 线路 {len(rl)} 条，车站 {len(sl)} 个")
    if not all_routes:
        sys.exit("错误：没有解析到任何线路，保留旧数据")
    all_routes.sort(key=lambda r: (r["short"].lstrip("TtUu").zfill(6), r["short"]))
    import datetime
    meta = {"updated": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"), "routes": all_routes}
    with open(os.path.join(OUT, "routes.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(OUT, "stops.json"), "w", encoding="utf-8") as f:
        json.dump(list(all_stops.values()), f, ensure_ascii=False, separators=(",", ":"))
    print("完成：共", len(all_routes), "条线路")


if __name__ == "__main__":
    main()
