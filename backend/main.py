"""Drawing extension backend: serve stroke medians from configured character folders."""

import json
import os
import re
import zipfile
from flask import Blueprint, jsonify, request

blueprint = Blueprint("drawing", __name__)

_EXT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_CHAR_ROOT = os.path.join(_EXT_ROOT, "characters")
_CONFIG_PATH = os.path.join(_CHAR_ROOT, "config.json")

_PATH_TAG_RE = re.compile(r"<path\b([^>]*)/?>", re.IGNORECASE)
_ATTR_RE = re.compile(r'([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"')
_NUM_RE = re.compile(r"[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?")
_PATH_TOK_RE = re.compile(
    r"([MmLlHhVvCcSsQqTtAaZz])|"
    r"([-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?)"
)
_WS = set(" \t\r\n\u3000")

_index = None  # cp -> ("file", path) | ("zip", zip_path, member)
_cache = {}
_DEFAULT_GITHUB = {
    "repo": "wlkata/StudioX",
    "assetPattern": r"^drawing-charset-(.+)\.zip$",
}


def _load_config():
    data = {"include": ["Chinese"], "github": dict(_DEFAULT_GITHUB)}
    try:
        with open(_CONFIG_PATH, "r", encoding="utf-8") as f:
            loaded = json.load(f)
        if isinstance(loaded, dict):
            if loaded.get("include"):
                data["include"] = loaded["include"]
            gh = loaded.get("github") or {}
            if isinstance(gh, dict):
                data["github"].update(gh)
    except (OSError, ValueError, json.JSONDecodeError):
        pass
    return data


def _save_config(data):
    tmp = _CONFIG_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    os.replace(tmp, _CONFIG_PATH)


def _reset_index():
    global _index, _cache
    _index = None
    _cache.clear()


def _load_include():
    folders = []
    inc = _load_config().get("include") or []
    for item in inc:
        if isinstance(item, str) and item:
            folders.append(item)
        elif isinstance(item, dict) and item.get("name"):
            folders.append(item["name"])
    return folders or ["Chinese"]


def _stem_to_cp(stem):
    if not stem:
        return None
    if len(stem) == 1:
        return ord(stem)
    if re.fullmatch(r"[0-9a-fA-F]{4,6}", stem) and (
        stem[0] == "0" or re.search(r"[a-fA-F]", stem)
    ):
        return int(stem, 16)
    if stem.isdigit():
        return int(stem, 10)
    if re.fullmatch(r"[0-9a-fA-F]+", stem):
        return int(stem, 16)
    return None


def _iter_set_svgs(name):
    zip_path = os.path.join(_CHAR_ROOT, name + ".zip")
    dir_path = os.path.join(_CHAR_ROOT, name)
    if os.path.isfile(zip_path):
        with zipfile.ZipFile(zip_path, "r") as zf:
            for info in zf.infolist():
                if info.is_dir():
                    continue
                base = os.path.basename(info.filename.replace("\\", "/"))
                if not base.endswith(".svg") or base.startswith("."):
                    continue
                yield ("zip", zip_path, info.filename)
        return
    if os.path.isdir(dir_path):
        for fn in os.listdir(dir_path):
            if not fn.endswith(".svg"):
                continue
            yield ("file", os.path.join(dir_path, fn))


def _set_source(name):
    zip_path = os.path.join(_CHAR_ROOT, name + ".zip")
    dir_path = os.path.join(_CHAR_ROOT, name)
    if os.path.isfile(zip_path):
        return "zip", zip_path
    if os.path.isdir(dir_path):
        return "folder", dir_path
    return None, None


def _count_svgs(name):
    n = 0
    for _ in _iter_set_svgs(name):
        n += 1
    return n


def _index_glyphs():
    global _index
    if _index is not None:
        return _index
    found = {}
    for folder in _load_include():
        for spec in _iter_set_svgs(folder):
            if spec[0] == "zip":
                base = os.path.basename(spec[2].replace("\\", "/"))
            else:
                base = os.path.basename(spec[1])
            cp = _stem_to_cp(base[:-4])
            if cp is None or cp in found:
                continue
            found[cp] = spec
    _index = found
    return _index


def _parse_mmah_d(d):
    nums = [float(x) for x in _NUM_RE.findall(d or "")]
    pts = []
    for i in range(0, len(nums) - 1, 2):
        x = nums[i]
        y = nums[i + 1]
        pts.append({"x": x / 1024.0, "y": (900.0 - y) / 1024.0})
    return pts


def _parse_mmah(text):
    items = []
    for m in _PATH_TAG_RE.finditer(text):
        attrs = dict(_ATTR_RE.findall(m.group(1)))
        pid = attrs.get("id") or ""
        if not pid.startswith("make-me-a-hanzi-animation-"):
            continue
        try:
            idx = int(pid.rsplit("-", 1)[-1])
        except ValueError:
            idx = len(items)
        pts = _parse_mmah_d(attrs.get("d") or "")
        if pts:
            items.append((idx, pts))
    items.sort(key=lambda t: t[0])
    return [pts for _, pts in items]


def _cubic(p0, p1, p2, p3, steps=12):
    pts = []
    for i in range(1, steps + 1):
        t = i / steps
        u = 1 - t
        x = (u ** 3) * p0[0] + 3 * (u ** 2) * t * p1[0] + 3 * u * (t ** 2) * p2[0] + (t ** 3) * p3[0]
        y = (u ** 3) * p0[1] + 3 * (u ** 2) * t * p1[1] + 3 * u * (t ** 2) * p2[1] + (t ** 3) * p3[1]
        pts.append((x, y))
    return pts


def _quad(p0, p1, p2, steps=10):
    pts = []
    for i in range(1, steps + 1):
        t = i / steps
        u = 1 - t
        x = (u ** 2) * p0[0] + 2 * u * t * p1[0] + (t ** 2) * p2[0]
        y = (u ** 2) * p0[1] + 2 * u * t * p1[1] + (t ** 2) * p2[1]
        pts.append((x, y))
    return pts


def _flatten_path(d, box=109.0):
    raw = []
    for cmd, num in _PATH_TOK_RE.findall(d or ""):
        if cmd:
            raw.append(("cmd", cmd))
        else:
            raw.append(("num", float(num)))

    cx = cy = 0.0
    sx = sy = 0.0
    last_c = None
    strokes = []
    cur = []
    i = 0
    implicit = None

    def flush():
        nonlocal cur
        if len(cur) >= 2:
            strokes.append([{"x": p[0] / box, "y": p[1] / box} for p in cur])
        cur = []

    def nums(n):
        nonlocal i
        out = []
        while len(out) < n and i < len(raw) and raw[i][0] == "num":
            out.append(raw[i][1])
            i += 1
        return out if len(out) == n else None

    while i < len(raw):
        if raw[i][0] == "cmd":
            cmd = raw[i][1]
            i += 1
            implicit = None
        elif implicit:
            cmd = implicit
        else:
            i += 1
            continue

        relative = cmd.islower()
        op = cmd.upper()

        if op == "Z":
            if cur and (abs(cx - sx) > 1e-6 or abs(cy - sy) > 1e-6):
                cur.append((sx, sy))
            cx, cy = sx, sy
            last_c = None
            implicit = None
            continue

        if op == "M":
            first = True
            while True:
                v = nums(2)
                if not v:
                    break
                x, y = v
                if relative:
                    x += cx
                    y += cy
                if first:
                    flush()
                    cur = [(x, y)]
                    sx, sy = x, y
                    first = False
                    implicit = "l" if relative else "L"
                else:
                    cur.append((x, y))
                cx, cy = x, y
                last_c = None
            continue

        if op == "L":
            implicit = cmd
            while True:
                v = nums(2)
                if not v:
                    break
                x, y = v
                if relative:
                    x += cx
                    y += cy
                cur.append((x, y))
                cx, cy = x, y
                last_c = None
            continue

        if op == "H":
            implicit = cmd
            while True:
                v = nums(1)
                if not v:
                    break
                x = v[0] + cx if relative else v[0]
                cur.append((x, cy))
                cx = x
                last_c = None
            continue

        if op == "V":
            implicit = cmd
            while True:
                v = nums(1)
                if not v:
                    break
                y = v[0] + cy if relative else v[0]
                cur.append((cx, y))
                cy = y
                last_c = None
            continue

        if op == "C":
            implicit = cmd
            while True:
                v = nums(6)
                if not v:
                    break
                x1, y1, x2, y2, x, y = v
                if relative:
                    x1 += cx
                    y1 += cy
                    x2 += cx
                    y2 += cy
                    x += cx
                    y += cy
                cur.extend(_cubic((cx, cy), (x1, y1), (x2, y2), (x, y)))
                last_c = (x2, y2)
                cx, cy = x, y
            continue

        if op == "S":
            implicit = cmd
            while True:
                v = nums(4)
                if not v:
                    break
                x2, y2, x, y = v
                if relative:
                    x2 += cx
                    y2 += cy
                    x += cx
                    y += cy
                if last_c:
                    x1 = 2 * cx - last_c[0]
                    y1 = 2 * cy - last_c[1]
                else:
                    x1, y1 = cx, cy
                cur.extend(_cubic((cx, cy), (x1, y1), (x2, y2), (x, y)))
                last_c = (x2, y2)
                cx, cy = x, y
            continue

        if op == "Q":
            implicit = cmd
            while True:
                v = nums(4)
                if not v:
                    break
                x1, y1, x, y = v
                if relative:
                    x1 += cx
                    y1 += cy
                    x += cx
                    y += cy
                cur.extend(_quad((cx, cy), (x1, y1), (x, y)))
                last_c = (x1, y1)
                cx, cy = x, y
            continue

        if op == "T":
            implicit = cmd
            while True:
                v = nums(2)
                if not v:
                    break
                x, y = v
                if relative:
                    x += cx
                    y += cy
                if last_c:
                    x1 = 2 * cx - last_c[0]
                    y1 = 2 * cy - last_c[1]
                else:
                    x1, y1 = cx, cy
                cur.extend(_quad((cx, cy), (x1, y1), (x, y)))
                last_c = (x1, y1)
                cx, cy = x, y
            continue

        implicit = None

    flush()
    return strokes


def _viewbox_size(text):
    m = re.search(r'viewBox\s*=\s*"([^"]+)"', text, re.I)
    if not m:
        return 109.0
    parts = m.group(1).split()
    if len(parts) == 4:
        try:
            return float(parts[2])
        except ValueError:
            return 109.0
    return 109.0


def _parse_centerline(text):
    box = _viewbox_size(text)
    items = []
    for m in _PATH_TAG_RE.finditer(text):
        attrs = dict(_ATTR_RE.findall(m.group(1)))
        pid = attrs.get("id") or ""
        if "StrokeNumbers" in pid:
            continue
        d = attrs.get("d") or ""
        if not d:
            continue
        if pid.startswith("make-me-a-hanzi-animation-"):
            continue
        strokes = _flatten_path(d, box)
        items.extend(strokes)
    return items


def _parse_svg(text):
    mmah = _parse_mmah(text)
    if mmah:
        return mmah
    return _parse_centerline(text)


def _read_svg(spec):
    if spec[0] == "file":
        with open(spec[1], "r", encoding="utf-8") as f:
            return f.read()
    zip_path, member = spec[1], spec[2]
    with zipfile.ZipFile(zip_path, "r") as zf:
        return zf.read(member).decode("utf-8")


def _load_glyph(cp):
    if cp in _cache:
        return _cache[cp]
    index = _index_glyphs()
    spec = index.get(cp)
    if not spec:
        _cache[cp] = None
        return None
    try:
        strokes = _parse_svg(_read_svg(spec))
    except (OSError, zipfile.BadZipFile, UnicodeDecodeError):
        _cache[cp] = None
        return None
    if not strokes:
        _cache[cp] = None
        return None
    _cache[cp] = {"strokes": strokes}
    return _cache[cp]


@blueprint.route("/glyphs", methods=["GET"])
def glyphs():
    text = request.args.get("text") or ""
    available = _index_glyphs()
    glyphs_out = {}
    missing = []
    supported = []
    seen = set()
    for ch in text:
        if ch in _WS or ch in seen:
            continue
        seen.add(ch)
        cp = ord(ch)
        if cp not in available:
            missing.append(ch)
            continue
        data = _load_glyph(cp)
        if not data:
            missing.append(ch)
            continue
        glyphs_out[ch] = data
        supported.append(ch)
    return jsonify({
        "success": True,
        "glyphs": glyphs_out,
        "missing": missing,
        "supported": supported,
        "folders": _load_include(),
    })


def _github_cfg():
    gh = _load_config().get("github") or {}
    repo = (gh.get("repo") or _DEFAULT_GITHUB["repo"]).strip()
    pattern = gh.get("assetPattern") or _DEFAULT_GITHUB["assetPattern"]
    return repo, pattern


def _fetch_github_assets():
    import urllib.request
    repo, pattern = _github_cfg()
    cre = re.compile(pattern)
    url = "https://api.github.com/repos/%s/releases?per_page=15" % repo
    req = urllib.request.Request(url, headers={
        "Accept": "application/vnd.github+json",
        "User-Agent": "WLKATA-StudioX-drawing",
    })
    with urllib.request.urlopen(req, timeout=15) as resp:
        releases = json.loads(resp.read().decode("utf-8"))
    if not isinstance(releases, list):
        releases = []
    seen = set()
    assets = []
    for rel in releases:
        if rel.get("draft"):
            continue
        for asset in rel.get("assets") or []:
            fname = asset.get("name") or ""
            m = cre.match(fname)
            if not m:
                continue
            set_name = m.group(1) if m.lastindex else os.path.splitext(fname)[0]
            if not set_name or set_name in seen:
                continue
            seen.add(set_name)
            assets.append({
                "name": set_name,
                "file": fname,
                "size": asset.get("size") or 0,
                "url": asset.get("browser_download_url") or "",
                "release": rel.get("tag_name") or "",
            })
    return repo, pattern, assets


@blueprint.route("/charsets", methods=["GET"])
def charsets():
    local = []
    for name in _load_include():
        kind, path = _set_source(name)
        if not kind:
            continue
        local.append({
            "name": name,
            "source": kind,
            "count": _count_svgs(name),
        })
    remote = []
    repo, pattern = _github_cfg()
    err = ""
    try:
        repo, pattern, remote = _fetch_github_assets()
    except Exception as e:
        err = str(e)
    installed = set(x["name"] for x in local)
    for item in remote:
        item["installed"] = item["name"] in installed
    return jsonify({
        "success": True,
        "local": local,
        "remote": remote,
        "github": {"repo": repo, "assetPattern": pattern},
        "error": err,
    })


def _safe_set_name(name):
    return bool(re.fullmatch(r"[A-Za-z0-9_-]+", name or ""))


def _allowed_download_url(url):
    if not url or not url.startswith("https://"):
        return False
    host = url.split("/")[2].lower()
    return host in (
        "github.com",
        "objects.githubusercontent.com",
        "release-assets.githubusercontent.com",
    )


@blueprint.route("/charsets/download", methods=["POST"])
def charsets_download():
    import urllib.request
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    url = (body.get("url") or "").strip()
    if not _safe_set_name(name):
        return jsonify({"success": False, "error": "Invalid set name."}), 400
    if not _allowed_download_url(url):
        return jsonify({"success": False, "error": "Download URL is not allowed."}), 400
    os.makedirs(_CHAR_ROOT, exist_ok=True)
    dest = os.path.join(_CHAR_ROOT, name + ".zip")
    tmp = dest + ".part"
    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": "WLKATA-StudioX-drawing",
            "Accept": "application/octet-stream",
        })
        with urllib.request.urlopen(req, timeout=120) as resp, open(tmp, "wb") as out:
            while True:
                chunk = resp.read(1024 * 256)
                if not chunk:
                    break
                out.write(chunk)
        with zipfile.ZipFile(tmp, "r") as zf:
            if zf.testzip() is not None:
                raise zipfile.BadZipFile("corrupt zip")
            has_svg = any(
                os.path.basename(i.filename.replace("\\", "/")).endswith(".svg")
                and not i.is_dir()
                for i in zf.infolist()
            )
            if not has_svg:
                raise zipfile.BadZipFile("zip has no SVG files")
        os.replace(tmp, dest)
    except Exception as e:
        try:
            if os.path.isfile(tmp):
                os.remove(tmp)
        except OSError:
            pass
        return jsonify({"success": False, "error": str(e)}), 400

    cfg = _load_config()
    inc = list(cfg.get("include") or [])
    if name not in inc:
        inc.append(name)
        cfg["include"] = inc
        _save_config(cfg)
    _reset_index()
    return jsonify({
        "success": True,
        "name": name,
        "count": _count_svgs(name),
        "include": _load_include(),
    })

