"""Image-only OpenCV pipelines and contour paths. Never opens hardware or runs Python text."""
import base64
import hashlib
import json
import math
import os
import threading
import time
import uuid

MAX_BYTES = 20 * 1024 * 1024
MAX_PIXELS = 4_194_304
MAX_POINTS = 50000
LOCK = threading.RLock()
SESSIONS = {}
ACTIVE = None

# The manual entry accepts image filters only, with the current image as src.
MANUAL = {'cvtColor', 'resize', 'GaussianBlur', 'medianBlur', 'blur', 'bilateralFilter',
          'threshold', 'adaptiveThreshold', 'Canny', 'bitwise_not', 'equalizeHist',
          'erode', 'dilate', 'morphologyEx', 'filter2D', 'sepFilter2D', 'boxFilter',
          'sqrBoxFilter', 'Sobel', 'Scharr', 'Laplacian', 'convertScaleAbs', 'normalize',
          'flip', 'rotate', 'pyrDown', 'pyrUp', 'fastNlMeansDenoising',
          'fastNlMeansDenoisingColored', 'detailEnhance', 'edgePreservingFilter'}

def dependencies():
    try:
        import cv2
        import numpy as np
        return cv2, np
    except ImportError as exc:
        raise ValueError('Use Re-setup for Drawing in Settings → Extensions, then restart StudioX to install OpenCV.') from exc


def integer(value, name, low, high):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or int(value) != value or not low <= value <= high:
        raise ValueError(f'{name} must be an integer from {low} to {high}.')
    return int(value)


def number(value, name, low, high):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
        raise ValueError(f'{name} must be from {low} to {high}.')
    return float(value)


def check_image(image):
    _, np = dependencies()
    if not isinstance(image, np.ndarray) or image.ndim not in (2, 3) or not image.size or image.shape[0] * image.shape[1] > MAX_PIXELS:
        raise ValueError('The function must return an image with at most 4 megapixels.')
    if image.ndim == 3 and image.shape[2] not in (1, 3, 4):
        raise ValueError('The function must return a 1, 3, or 4 channel image.')
    if not np.isfinite(image).all():
        raise ValueError('Image contains non-finite values.')
    return image


def gray(image, space):
    cv, _ = dependencies()
    if image.ndim == 2 or image.shape[2] == 1:
        return image.reshape(image.shape[:2])
    return cv.cvtColor(display_bgr(image, space), cv.COLOR_BGR2GRAY)


def display_bgr(image, space):
    cv, np = dependencies()
    if image.dtype != np.uint8:
        image = np.clip(image, 0, 255).astype(np.uint8)
    if image.ndim == 2 or image.shape[2] == 1:
        return cv.cvtColor(image.reshape(image.shape[:2]), cv.COLOR_GRAY2BGR)
    code = {'RGB': 'COLOR_RGB2BGR', 'HSV': 'COLOR_HSV2BGR', 'LAB': 'COLOR_Lab2BGR', 'BGRA': 'COLOR_BGRA2BGR'}.get(space)
    return cv.cvtColor(image, getattr(cv, code)) if code else image


def preview(image, space):
    cv, _ = dependencies()
    bgr = display_bgr(image, space)
    scale = min(1, 1000 / max(bgr.shape[:2]))
    if scale < 1:
        bgr = cv.resize(bgr, None, fx=scale, fy=scale, interpolation=cv.INTER_AREA)
    ok, encoded = cv.imencode('.png', bgr)
    if not ok:
        raise ValueError('Could not encode the preview.')
    return 'data:image/png;base64,' + base64.b64encode(encoded).decode('ascii')


def expire():
    now = time.monotonic()
    for key in list(SESSIONS):
        if now - SESSIONS[key]['touched'] > 3600:
            del SESSIONS[key]


def upload(path):
    global ACTIVE
    cv, np = dependencies()
    if not isinstance(path, str) or not os.path.isfile(path) or os.path.getsize(path) > MAX_BYTES:
        raise ValueError('Select an image file smaller than 20 MB.')
    with open(path, 'rb') as file:
        data = file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError('Image file is too large.')
    image = cv.imdecode(np.frombuffer(data, np.uint8), cv.IMREAD_UNCHANGED)
    if image is None:
        raise ValueError('This file could not be decoded as an image.')
    h, w = image.shape[:2]
    if h * w > 16_777_216:
        raise ValueError('Choose an image with at most 16 megapixels.')
    if image.dtype == np.uint16:
        image = (image / 257).astype(np.uint8)
    if image.ndim == 2:
        image = cv.cvtColor(image, cv.COLOR_GRAY2BGR)
    elif image.shape[2] == 4:
        alpha = image[:, :, 3:4].astype(np.float32) / 255
        image = (image[:, :, :3] * alpha + 255 * (1 - alpha)).astype(np.uint8)
    scale = min(1, 2048 / max(h, w), math.sqrt(MAX_PIXELS / (h * w)))
    if scale < 1:
        image = cv.resize(image, None, fx=scale, fy=scale, interpolation=cv.INTER_AREA)
    check_image(image)
    token = uuid.uuid4().hex
    with LOCK:
        expire()
        if len(SESSIONS) >= 4:
            oldest = min(SESSIONS, key=lambda k: SESSIONS[k]['touched'])
            del SESSIONS[oldest]
        SESSIONS[token] = {'image': image, 'name': os.path.basename(path), 'originalSize': [w, h],
                           'touched': time.monotonic(), 'ticket': 0, 'result': None, 'status': 'editing'}
        ACTIVE = token
    return {'token': token, 'name': os.path.basename(path), 'originalSize': [w, h],
            'width': image.shape[1], 'height': image.shape[0], 'preview': preview(image, 'BGR')}


def session(token):
    with LOCK:
        expire()
        item = SESSIONS.get(token)
        if not item:
            raise ValueError('Image session expired. Upload the image again.')
        item['touched'] = time.monotonic()
        return item


def constant(value):
    cv, _ = dependencies()
    if isinstance(value, str) and value.startswith('cv2.'):
        name = value[4:]
        if not name.isidentifier() or name.startswith('_') or not isinstance(getattr(cv, name, None), int):
            raise ValueError('Unknown OpenCV integer constant: ' + value)
        return getattr(cv, name)
    if isinstance(value, list):
        return [constant(item) for item in value]
    if isinstance(value, dict):
        return {key: constant(item) for key, item in value.items()}
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    raise ValueError('Use JSON values and cv2.CONSTANT strings for parameters.')


def apply(image, space, step):
    cv, np = dependencies()
    op, p = step.get('op'), step.get('params') or {}
    if not isinstance(p, dict):
        raise ValueError('Parameters must be a JSON object.')
    if op == 'color':
        source, target = p.get('from', 'BGR'), p.get('to', 'GRAY')
        spaces = {'BGR': 'BGR', 'RGB': 'RGB', 'GRAY': 'GRAY', 'HSV': 'HSV', 'LAB': 'Lab', 'BGRA': 'BGRA'}
        if source != space or source not in spaces or target not in spaces:
            raise ValueError(f'The current color space is {space}; select it as the source color.')
        if source == target:
            return image.copy(), space
        code = getattr(cv, 'COLOR_' + spaces[source] + '2' + spaces[target], None)
        if code is None:
            raise ValueError('This color conversion needs an intermediate BGR step.')
        return cv.cvtColor(image, code), target
    if op == 'resize':
        w, h = integer(p.get('width', 800), 'Width', 1, 4096), integer(p.get('height', 600), 'Height', 1, 4096)
        if p.get('keepRatio', True):
            scale = min(w / image.shape[1], h / image.shape[0]); w, h = max(1, round(image.shape[1] * scale)), max(1, round(image.shape[0] * scale))
        if w * h > MAX_PIXELS:
            raise ValueError('Resize output must be at most 4 megapixels.')
        return cv.resize(image, (w, h), interpolation=cv.INTER_AREA), space
    if op in ('gaussian', 'median', 'morphology', 'adaptive'):
        size = integer(p.get('size', 5 if op in ('gaussian', 'median') else 11 if op == 'adaptive' else 3), 'Kernel/block size', 1, 99)
        if size % 2 == 0 or op in ('median', 'adaptive') and size < 3:
            raise ValueError('Choose an odd kernel/block size (at least 3 for this operation).')
    if op == 'gaussian':
        return cv.GaussianBlur(image, (size, size), number(p.get('sigma', 0), 'Sigma', 0, 100)), space
    if op == 'median':
        return cv.medianBlur(image, size), space
    if op == 'threshold':
        g = gray(image, space)
        mode = cv.THRESH_BINARY_INV if p.get('inverse', True) else cv.THRESH_BINARY
        if p.get('otsu', False): mode |= cv.THRESH_OTSU
        return cv.threshold(g, number(p.get('value', 127), 'Threshold', 0, 255), 255, mode)[1], 'GRAY'
    if op == 'adaptive':
        return cv.adaptiveThreshold(gray(image, space), 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C,
                                    cv.THRESH_BINARY_INV if p.get('inverse', True) else cv.THRESH_BINARY,
                                    size, number(p.get('c', 5), 'C', -255, 255)), 'GRAY'
    if op == 'canny':
        return cv.Canny(gray(image, space), number(p.get('low', 50), 'Low threshold', 0, 1000), number(p.get('high', 150), 'High threshold', 0, 1000)), 'GRAY'
    if op == 'invert':
        return cv.bitwise_not(image), space
    if op == 'morphology':
        modes = {'erode': cv.MORPH_ERODE, 'dilate': cv.MORPH_DILATE, 'open': cv.MORPH_OPEN, 'close': cv.MORPH_CLOSE, 'gradient': cv.MORPH_GRADIENT}
        if p.get('mode', 'open') not in modes: raise ValueError('Choose a morphology operation.')
        return cv.morphologyEx(image, modes[p.get('mode', 'open')], np.ones((size, size), np.uint8), iterations=integer(p.get('iterations', 1), 'Iterations', 1, 20)), space
    if op == 'contrast':
        return np.clip(image.astype(np.float32) * number(p.get('alpha', 1), 'Contrast', 0, 10) + number(p.get('beta', 0), 'Brightness', -255, 255), 0, 255).astype(np.uint8), space
    if op == 'rotate':
        rotations = {'90': cv.ROTATE_90_CLOCKWISE, '180': cv.ROTATE_180, '270': cv.ROTATE_90_COUNTERCLOCKWISE}
        if str(p.get('degrees', '90')) not in rotations: raise ValueError('Choose 90, 180, or 270 degrees.')
        return cv.rotate(image, rotations[str(p.get('degrees', '90'))]), space
    if op == 'flip':
        return cv.flip(image, integer(p.get('axis', 1), 'Flip axis', -1, 1)), space
    if op != 'manual':
        raise ValueError('Unknown image operation: ' + str(op))
    name = p.get('function', '').removeprefix('cv2.')
    if name not in MANUAL:
        raise ValueError('Choose a supported image-processing function; Python statements, file I/O, and camera functions are not image filters.')
    kwargs = p.get('kwargs', {})
    if isinstance(kwargs, str):
        try: kwargs = json.loads(kwargs)
        except ValueError as exc: raise ValueError('Manual parameters must be a JSON object.') from exc
    if not isinstance(kwargs, dict) or any(k in kwargs for k in ('src', 'dst', 'filename')):
        raise ValueError('Use keyword parameters only; the current image is supplied as src.')
    kwargs = constant(kwargs)
    for key in ('kernel', 'kernelX', 'kernelY'):
        if key in kwargs: kwargs[key] = np.asarray(kwargs[key], dtype=np.float32)
    if name == 'resize':
        dims = kwargs.get('dsize', [0, 0])
        w = dims[0] or image.shape[1] * kwargs.get('fx', 0); h = dims[1] or image.shape[0] * kwargs.get('fy', 0)
        if w <= 0 or h <= 0 or w * h > MAX_PIXELS: raise ValueError('Manual resize output must be between 1 pixel and 4 megapixels.')
    if name == 'pyrUp' and image.shape[0] * image.shape[1] * 4 > MAX_PIXELS: raise ValueError('pyrUp output exceeds 4 megapixels.')
    next_space = space
    if name == 'cvtColor':
        source = 'Lab' if space == 'LAB' else space
        next_space = next((target for target in ('GRAY', 'RGB', 'HSV', 'Lab', 'BGR', 'BGRA')
                           if kwargs.get('code') == getattr(cv, 'COLOR_' + source + '2' + target, -999)), None)
        if next_space is None:
            raise ValueError(f'Choose a conversion from {space} to BGR, RGB, GRAY, HSV, Lab, or BGRA.')
        if next_space == 'Lab': next_space = 'LAB'
    # normalize requires a destination argument; OpenCV allocates it for us.
    output = cv.normalize(image, None, **kwargs) if name == 'normalize' else getattr(cv, name)(image, **kwargs)
    if isinstance(output, tuple):
        output = next((item for item in reversed(output) if isinstance(item, np.ndarray) and item.ndim in (2, 3)), None)
    check_image(output)
    space = next_space
    if output.ndim == 2: space = 'GRAY'
    return output, space


def contours(image, space, params):
    cv, np = dependencies()
    g = np.clip(gray(image, space), 0, 255).astype(np.uint8)
    foreground = params.get('foreground', 'auto')
    if foreground == 'nonzero':
        binary = np.where(g > 0, 255, 0).astype(np.uint8)
    else:
        if foreground not in ('auto', 'dark', 'light'): raise ValueError('Choose a foreground mode.')
        dark = foreground == 'dark' or foreground == 'auto' and np.mean(np.concatenate([g[0], g[-1], g[:, 0], g[:, -1]])) > 127
        binary = cv.threshold(g, number(params.get('threshold', 127), 'Threshold', 0, 255), 255, cv.THRESH_BINARY_INV if dark else cv.THRESH_BINARY)[1]
    retrieval = {'external': cv.RETR_EXTERNAL, 'list': cv.RETR_LIST, 'tree': cv.RETR_TREE}
    if params.get('retrieval', 'list') not in retrieval: raise ValueError('Choose a contour retrieval mode.')
    minimum = number(params.get('minArea', 3), 'Minimum area', 0, MAX_PIXELS)
    length = number(params.get('minLength', 5), 'Minimum length', 0, 100000)
    smooth = number(params.get('epsilon', 0.002), 'Approximation fraction', 0, 0.1)
    found, _ = cv.findContours(binary, retrieval[params.get('retrieval', 'list')], cv.CHAIN_APPROX_SIMPLE)
    paths, total = [], 0
    h, w = image.shape[:2]
    for contour in found:
        perimeter = cv.arcLength(contour, True)
        if abs(cv.contourArea(contour)) < minimum or perimeter < length: continue
        points = cv.approxPolyDP(contour, smooth * perimeter, True).reshape(-1, 2)
        if len(points) < 2: continue
        path = [[float(x) / max(w - 1, 1), float(y) / max(h - 1, 1)] for x, y in points]
        if path[-1] != path[0]: path.append(path[0][:])
        total += len(path)
        if total > MAX_POINTS or len(paths) >= 2000:
            raise ValueError('Too many path points. Increase minimum area or approximation, or resize the image.')
        paths.append(path)
    return paths


def _evaluate(item, steps, ticket=None):
    """Evaluate a pipeline without changing the session's accepted result."""
    if not isinstance(steps, list) or len(steps) > 40:
        raise ValueError('Use at most 40 processing steps.')
    image, space, paths = item['image'].copy(), 'BGR', None
    for index, step in enumerate(steps):
        with LOCK:
            if item['status'] != 'editing' or ticket is not None and item['ticket'] != ticket:
                raise ValueError('A newer image pipeline replaced this request.')
        try:
            if not isinstance(step, dict): raise ValueError('Invalid pipeline step.')
            if step.get('op') == 'contours':
                if index != len(steps) - 1: raise ValueError('Convert to paths must be the final step. Move it to the bottom.')
                paths = contours(image, space, step.get('params') or {})
            else:
                image, space = apply(image, space, step)
                check_image(image)
        except Exception as exc:
            raise ValueError(f'Step {index + 1}: {exc}') from exc
    return {'width': image.shape[1], 'height': image.shape[0], 'space': space,
            'preview': preview(image, space), 'paths': paths}


def preview_steps(token, steps):
    """Preview a prefix independently of full processing and commit validation."""
    item = session(token)
    with LOCK:
        if item['status'] != 'editing': raise ValueError('This image session is already finished.')
    return _evaluate(item, steps)


def process(token, steps):
    item = session(token)
    with LOCK:
        if item['status'] != 'editing': raise ValueError('This image session is already finished.')
        item['ticket'] += 1; ticket = item['ticket']; item['result'] = None
    result = _evaluate(item, steps, ticket)
    revision = hashlib.sha256((token + json.dumps(steps, sort_keys=True, allow_nan=False)).encode()).hexdigest()
    result.update(revision=revision, canAdd=bool(result['paths']), steps=steps)
    with LOCK:
        if item['ticket'] != ticket or item['status'] != 'editing':
            raise ValueError('A newer image pipeline replaced this result.')
        item['result'] = result
    return result


def commit(token, revision):
    item = session(token)
    with LOCK:
        result = item['result']
        if item['status'] != 'editing' or not result or not result['canAdd'] or result['revision'] != revision:
            raise ValueError('Convert the current pipeline to non-empty paths before adding it.')
        item['sticker'] = {'id': token, 'name': item['name'], 'aspect': result['width'] / result['height'], 'paths': result['paths'], 'steps': result['steps']}
        item['status'] = 'accepted'
    return {'success': True}


def status(token):
    item = session(token)
    with LOCK:
        return {'status': item['status'], 'sticker': item.get('sticker')}


def cancel(token):
    item = session(token)
    with LOCK:
        if item['status'] == 'editing': item['status'] = 'cancelled'; item['ticket'] += 1; item['result'] = None
