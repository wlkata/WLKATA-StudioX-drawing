"""Drawing extension backend: serve Chinese stroke medians from Make Me a Hanzi SVGs."""

import os
import re
from flask import Blueprint, jsonify, request

blueprint = Blueprint("drawing", __name__)

_EXT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_CHAR_DIR = os.path.join(_EXT_ROOT, "characters", "Chinese")

_PATH_TAG_RE = re.compile(r"<path\b([^>]*)/?>", re.IGNORECASE)
_ATTR_RE = re.compile(r'([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"')
_NUM_RE = re.compile(r"[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?")
_WS = set(" \t\r\n\u3000")

_available = None
_cache = {}


def _index_codepoints():
    global _available
    if _available is not None:
        return _available
    found = set()
    if os.path.isdir(_CHAR_DIR):
        for name in os.listdir(_CHAR_DIR):
            if not name.endswith(".svg"):
                continue
            stem = name[:-4]
            if stem.isdigit():
                found.add(int(stem))
    _available = found
    return _available


def _parse_d(d):
    nums = [float(x) for x in _NUM_RE.findall(d or "")]
    pts = []
    for i in range(0, len(nums) - 1, 2):
        x = nums[i]
        y = nums[i + 1]
        pts.append({"x": x / 1024.0, "y": (900.0 - y) / 1024.0})
    return pts


def _parse_svg(text):
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
        pts = _parse_d(attrs.get("d") or "")
        if pts:
            items.append((idx, pts))
    items.sort(key=lambda t: t[0])
    return [pts for _, pts in items]


def _load_glyph(cp):
    if cp in _cache:
        return _cache[cp]
    path = os.path.join(_CHAR_DIR, str(cp) + ".svg")
    if not os.path.isfile(path):
        _cache[cp] = None
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            strokes = _parse_svg(f.read())
    except OSError:
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
    available = _index_codepoints()
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
    })
