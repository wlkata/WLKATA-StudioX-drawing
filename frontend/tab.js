(function () {
  // ---- DOM refs ----------------------------------------------------------

  var canvas     = document.getElementById('drawing-canvas');
  var ctx        = canvas.getContext('2d');
  var canvasWrap = document.getElementById('drawing-canvas-wrap');
  var resInput   = document.getElementById('drawing-resolution');
  var undoBtn    = document.getElementById('drawing-undo');
  var clearBtn   = document.getElementById('drawing-clear');
  var textInput  = document.getElementById('drawing-text');
  var sizeInput  = document.getElementById('drawing-char-size');
  var sizeWrap   = document.getElementById('drawing-size-wrap');
  var textErrorEl = document.getElementById('drawing-text-error');
  var calibTLEl  = document.getElementById('drawing-calib-tl');
  var calibTREl  = document.getElementById('drawing-calib-tr');
  var calibBREl  = document.getElementById('drawing-calib-br');
  var calibStatusEl = document.getElementById('drawing-calib-status');
  var startBtn   = document.getElementById('drawing-start');
  var stopBtn    = document.getElementById('drawing-stop');
  var progressEl = document.getElementById('drawing-progress');
  var deviceSelect  = document.getElementById('drawing-device-select');
  var deviceRefresh = document.getElementById('drawing-device-refresh');
  var modalEl    = document.getElementById('drawing-modal');
  var modalCancel = document.getElementById('drawing-modal-cancel');
  var modalConfirm = document.getElementById('drawing-modal-confirm');

  // ---- State -------------------------------------------------------------

  var paths       = [];    // Array of arrays of {gx, gy} grid indices
  var currentPath = null;
  var isDrawing   = false;

  var calib = { tl: null, tr: null, br: null }; // each {x, y, z}
  var isCalibrated = false;
  var executing    = false;
  var aborted      = false;
  var selectedPort = null;  // serial port of the selected robot

  var glyphMap = {};        // char -> { strokes: [[{x,y}...]] }  coords 0–1
  var glyphMissing = [];    // unique missing characters
  var glyphFetchError = '';
  var glyphTimer = null;
  var glyphReq = 0;

  var _serverUrl = ExtensionAPI.getServerUrl();

  // ---- Device selector ---------------------------------------------------

  function loadDevices() {
    ExtensionAPI.getDevices().then(function (data) {
      if (!data.success || !data.ports) return;
      var prev = deviceSelect.value;
      deviceSelect.innerHTML = '<option value="">-- select a robot --</option>';
      data.ports.forEach(function (d) {
        if (!d.connected) return;
        var opt = document.createElement('option');
        opt.value = d.port;
        opt.textContent = d.model + ' (' + d.port + ')';
        deviceSelect.appendChild(opt);
      });
      if (prev) deviceSelect.value = prev;
      selectedPort = deviceSelect.value || null;
    }).catch(function () {});
  }

  deviceSelect.addEventListener('change', function () {
    selectedPort = deviceSelect.value || null;
  });
  deviceRefresh.addEventListener('click', loadDevices);
  loadDevices();

  // ---- Canvas sizing -----------------------------------------------------

  function resizeCanvas() {
    var rect = canvasWrap.getBoundingClientRect();
    canvas.width  = Math.round(rect.width);
    canvas.height = Math.round(rect.height);
    renderCanvas();
  }

  window.addEventListener('resize', resizeCanvas);
  setTimeout(resizeCanvas, 0);

  // ---- Grid helpers -------------------------------------------------------
  // Square cells. After calibration, the drawable box matches the paper
  // aspect (dist(TL,TR) / dist(TR,BR)) so an N×N cell block is a square
  // in the real world when the corners form a rectangle.

  function dist3(a, b) {
    var dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  function paperAspect() {
    if (!(calib.tl && calib.tr && calib.br)) return null;
    var w = dist3(calib.tl, calib.tr);
    var h = dist3(calib.tr, calib.br);
    if (w < 1e-6 || h < 1e-6) return null;
    return w / h;
  }

  function gridInfo() {
    var res = parseInt(resInput.value, 10) || 50;
    if (res < 1) res = 1;
    var w = canvas.width;
    var h = canvas.height;
    var aspect = paperAspect();
    if (!aspect || !isFinite(aspect)) {
      aspect = (h > 0) ? (w / h) : 1;
    }

    var maxGx = res;
    var maxGy = Math.max(1, Math.round(maxGx / aspect));
    var cell = (maxGx > 0 && maxGy > 0)
      ? Math.min(w / maxGx, h / maxGy)
      : 1;
    var boxW = maxGx * cell;
    var boxH = maxGy * cell;
    var oX = (w - boxW) / 2;
    var oY = (h - boxH) / 2;
    return { res: res, cell: cell, maxGx: maxGx, maxGy: maxGy,
             boxW: boxW, boxH: boxH, oX: oX, oY: oY };
  }

  function charSizeCells() {
    var gi = gridInfo();
    var n = parseInt(sizeInput.value, 10) || 10;
    if (n < 1) n = 1;
    var cap = Math.max(1, Math.min(gi.maxGx, gi.maxGy));
    if (n > cap) n = cap;
    return n;
  }

  // ---- Text layout -------------------------------------------------------

  var WS = /[ \t\u3000]/;

  function layoutText(gi) {
    var text = textInput.value || '';
    var charCells = charSizeCells();
    var cols = Math.floor(gi.maxGx / charCells);
    var rows = Math.floor(gi.maxGy / charCells);
    var cells = [];
    var missing = [];
    var overflow = false;
    var col = 0;
    var row = 0;
    var chars = Array.from(text);
    var i, ch, g;

    function advance() {
      col += 1;
      if (col >= cols) {
        col = 0;
        row += 1;
      }
    }

    for (i = 0; i < chars.length; i++) {
      ch = chars[i];
      if (ch === '\r') continue;
      if (ch === '\n') {
        col = 0;
        row += 1;
        continue;
      }
      if (WS.test(ch)) {
        if (cols < 1) { overflow = true; continue; }
        if (row >= rows) { overflow = true; continue; }
        advance();
        continue;
      }
      if (cols < 1 || row >= rows) {
        overflow = true;
        continue;
      }
      g = glyphMap[ch];
      cells.push({
        ch: ch,
        col: col,
        row: row,
        strokes: g ? g.strokes : null,
        missing: !g
      });
      if (!g && missing.indexOf(ch) < 0) missing.push(ch);
      advance();
    }

    return {
      cells: cells,
      missing: missing,
      overflow: overflow,
      cols: cols,
      rows: rows,
      charCells: charCells
    };
  }

  function mapGlyphPoint(cell, nx, ny, layout) {
    var inset = layout.charCells * 0.1;
    var inner = layout.charCells - 2 * inset;
    if (inner < 0.01) inner = layout.charCells;
    return {
      gx: cell.col * layout.charCells + inset + nx * inner,
      gy: cell.row * layout.charCells + inset + ny * inner
    };
  }

  function textHasContent(layout) {
    var i;
    for (i = 0; i < layout.cells.length; i++) {
      if (layout.cells[i].strokes && layout.cells[i].strokes.length) return true;
    }
    return false;
  }

  function textHasErrors(layout) {
    if (glyphFetchError) return true;
    if (layout.overflow) return true;
    if (glyphMissing.length) return true;
    var i;
    for (i = 0; i < layout.cells.length; i++) {
      if (layout.cells[i].missing) return true;
    }
    return false;
  }

  function updateTextError(layout) {
    var parts = [];
    if (glyphFetchError) {
      parts.push(glyphFetchError);
    } else if (glyphMissing.length) {
      parts.push('No stroke data for: ' + glyphMissing.join(' '));
    }
    if (layout.overflow) {
      parts.push('Text does not fit the drawing area.');
    }
    textErrorEl.textContent = parts.join(' ');
  }

  function scheduleGlyphFetch() {
    if (glyphTimer) clearTimeout(glyphTimer);
    glyphTimer = setTimeout(fetchGlyphs, 150);
  }

  function fetchGlyphs() {
    var text = textInput.value || '';
    var i, ch;
    var chars = Array.from(text);
    var need = [];
    var seen = {};
    for (i = 0; i < chars.length; i++) {
      ch = chars[i];
      if (ch === '\n' || ch === '\r' || WS.test(ch)) continue;
      if (seen[ch]) continue;
      seen[ch] = true;
      need.push(ch);
    }
    if (!need.length) {
      glyphReq += 1;
      glyphMap = {};
      glyphMissing = [];
      glyphFetchError = '';
      renderCanvas();
      updateUI();
      return;
    }
    var req = ++glyphReq;
    ExtensionAPI.fetch('drawing', '/glyphs?text=' + encodeURIComponent(need.join('')))
      .then(function (data) {
        if (req !== glyphReq) return;
        if (!data || !data.success) {
          glyphFetchError = (data && data.error) || 'Cannot load character data.';
          glyphMap = {};
          glyphMissing = need.slice();
        } else {
          glyphFetchError = '';
          glyphMap = data.glyphs || {};
          glyphMissing = data.missing || [];
        }
        renderCanvas();
        updateUI();
      })
      .catch(function () {
        if (req !== glyphReq) return;
        glyphFetchError = 'Cannot load character data.';
        glyphMap = {};
        glyphMissing = need.slice();
        renderCanvas();
        updateUI();
      });
  }

  textInput.addEventListener('input', function () {
    scheduleGlyphFetch();
    renderCanvas();
    updateUI();
  });
  textInput.addEventListener('focus', function () {
    sizeWrap.classList.add('active');
  });
  textInput.addEventListener('blur', function () {
    sizeWrap.classList.remove('active');
  });
  sizeInput.addEventListener('focus', function () {
    sizeWrap.classList.add('active');
  });
  sizeInput.addEventListener('blur', function () {
    if (document.activeElement !== textInput) sizeWrap.classList.remove('active');
  });
  function clampSizeInput() {
    var gi = gridInfo();
    var cap = Math.max(1, Math.min(gi.maxGx, gi.maxGy));
    var n = parseInt(sizeInput.value, 10);
    if (!isFinite(n) || n < 1) n = 1;
    if (n > cap) n = cap;
    if (String(n) !== sizeInput.value) sizeInput.value = n;
  }

  sizeInput.addEventListener('change', function () {
    clampSizeInput();
    renderCanvas();
    updateUI();
  });
  sizeInput.addEventListener('input', function () {
    renderCanvas();
    updateUI();
  });

  // ---- Canvas rendering --------------------------------------------------

  function renderCanvas() {
    var w = canvas.width;
    var h = canvas.height;
    if (w === 0 || h === 0) return;
    var gi = gridInfo();
    var layout = layoutText(gi);
    var i, j, p, cell, stroke, pt, px, py;

    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);

    ctx.fillStyle = 'rgba(0,0,0,0.04)';
    if (gi.oY > 0) {
      ctx.fillRect(0, 0, w, gi.oY);
      ctx.fillRect(0, gi.oY + gi.boxH, w, h - gi.oY - gi.boxH);
    }
    if (gi.oX > 0) {
      ctx.fillRect(0, gi.oY, gi.oX, gi.boxH);
      ctx.fillRect(gi.oX + gi.boxW, gi.oY, w - gi.oX - gi.boxW, gi.boxH);
    }

    var step = gi.res > 100 ? 5 : 1;
    ctx.strokeStyle = 'rgba(0,0,0,0.06)';
    ctx.lineWidth   = 0.5;
    for (var gx = 0; gx <= gi.maxGx; gx += step) {
      px = Math.round(gi.oX + gx * gi.cell) + 0.5;
      ctx.beginPath();
      ctx.moveTo(px, gi.oY);
      ctx.lineTo(px, gi.oY + gi.boxH);
      ctx.stroke();
    }
    for (var gy = 0; gy <= gi.maxGy; gy += step) {
      py = Math.round(gi.oY + gy * gi.cell) + 0.5;
      ctx.beginPath();
      ctx.moveTo(gi.oX, py);
      ctx.lineTo(gi.oX + gi.boxW, py);
      ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(33,150,243,0.5)';
    ctx.lineWidth   = 2;
    ctx.setLineDash([6, 3]);
    ctx.strokeRect(gi.oX + 1, gi.oY + 1, gi.boxW - 2, gi.boxH - 2);
    ctx.setLineDash([]);

    // Character cells
    for (i = 0; i < layout.cells.length; i++) {
      cell = layout.cells[i];
      var x0 = gi.oX + cell.col * layout.charCells * gi.cell;
      var y0 = gi.oY + cell.row * layout.charCells * gi.cell;
      var side = layout.charCells * gi.cell;
      if (cell.missing) {
        ctx.strokeStyle = 'rgba(198,40,40,0.7)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(x0 + 1, y0 + 1, side - 2, side - 2);
        ctx.setLineDash([]);
        ctx.fillStyle = '#c62828';
        ctx.font = Math.max(10, Math.floor(side * 0.45)) + 'px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(cell.ch, x0 + side / 2, y0 + side / 2);
        continue;
      }
      ctx.strokeStyle = 'rgba(0,0,0,0.08)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x0 + 0.5, y0 + 0.5, side - 1, side - 1);

      if (!cell.strokes) continue;
      ctx.strokeStyle = '#111';
      ctx.lineWidth = Math.max(1.2, gi.cell * 0.12);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (j = 0; j < cell.strokes.length; j++) {
        stroke = cell.strokes[j];
        if (!stroke.length) continue;
        ctx.beginPath();
        pt = mapGlyphPoint(cell, stroke[0].x, stroke[0].y, layout);
        ctx.moveTo(gi.oX + pt.gx * gi.cell, gi.oY + pt.gy * gi.cell);
        for (p = 1; p < stroke.length; p++) {
          pt = mapGlyphPoint(cell, stroke[p].x, stroke[p].y, layout);
          ctx.lineTo(gi.oX + pt.gx * gi.cell, gi.oY + pt.gy * gi.cell);
        }
        ctx.stroke();
      }
    }

    var allPaths = paths.slice();
    if (currentPath && currentPath.length > 0) allPaths.push(currentPath);

    ctx.strokeStyle = '#333';
    ctx.lineWidth   = 2;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';

    for (i = 0; i < allPaths.length; i++) {
      p = allPaths[i];
      if (p.length === 0) continue;

      if (p.length === 1) {
        ctx.fillStyle = '#333';
        ctx.beginPath();
        ctx.arc(gi.oX + p[0].gx * gi.cell, gi.oY + p[0].gy * gi.cell, 2, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }

      ctx.beginPath();
      ctx.moveTo(gi.oX + p[0].gx * gi.cell, gi.oY + p[0].gy * gi.cell);
      for (j = 1; j < p.length; j++) {
        ctx.lineTo(gi.oX + p[j].gx * gi.cell, gi.oY + p[j].gy * gi.cell);
      }
      ctx.stroke();
    }

    updateTextError(layout);
  }

  resInput.addEventListener('change', function () {
    renderCanvas();
    updateUI();
  });

  // ---- Canvas mouse handling ---------------------------------------------

  function snapToGrid(rawPxX, rawPxY) {
    var gi = gridInfo();
    return {
      gx: Math.min(gi.maxGx, Math.max(0, Math.round((rawPxX - gi.oX) / gi.cell))),
      gy: Math.min(gi.maxGy, Math.max(0, Math.round((rawPxY - gi.oY) / gi.cell)))
    };
  }

  function canvasPos(e) {
    var rect = canvas.getBoundingClientRect();
    return snapToGrid(e.clientX - rect.left, e.clientY - rect.top);
  }

  canvas.addEventListener('mousedown', function (e) {
    if (executing) return;
    isDrawing   = true;
    currentPath = [canvasPos(e)];
    renderCanvas();
  });

  canvas.addEventListener('mousemove', function (e) {
    if (!isDrawing || !currentPath) return;
    var gi   = gridInfo();
    var rect = canvas.getBoundingClientRect();
    var rawPxX = e.clientX - rect.left;
    var rawPxY = e.clientY - rect.top;
    var last = currentPath[currentPath.length - 1];
    var dxCells = (rawPxX - gi.oX) / gi.cell - last.gx;
    var dyCells = (rawPxY - gi.oY) / gi.cell - last.gy;
    var distCells = Math.sqrt(dxCells * dxCells + dyCells * dyCells);
    if (distCells < 0.9) return;
    var pos = snapToGrid(rawPxX, rawPxY);
    if (pos.gx === last.gx && pos.gy === last.gy) return;
    currentPath.push(pos);
    renderCanvas();
  });

  function finishStroke() {
    if (!isDrawing || !currentPath) return;
    isDrawing = false;
    if (currentPath.length > 0) paths.push(currentPath);
    currentPath = null;
    renderCanvas();
    updateUI();
  }

  canvas.addEventListener('mouseup',    finishStroke);
  canvas.addEventListener('mouseleave', finishStroke);

  // ---- Undo / Clear ------------------------------------------------------

  undoBtn.addEventListener('click', function () {
    if (paths.length > 0) {
      paths.pop();
      renderCanvas();
      updateUI();
    }
  });

  clearBtn.addEventListener('click', function () {
    paths       = [];
    currentPath = null;
    renderCanvas();
    updateUI();
  });

  // ---- Jog controls ------------------------------------------------------

  var jogStep = 5;
  var jogBusy = false;

  var stepBtns = document.querySelectorAll('.drawing-jog-step');
  for (var si = 0; si < stepBtns.length; si++) {
    stepBtns[si].addEventListener('click', function () {
      for (var k = 0; k < stepBtns.length; k++) stepBtns[k].classList.remove('active');
      this.classList.add('active');
      jogStep = parseInt(this.getAttribute('data-step'), 10);
    });
  }

  var jogBtns = document.querySelectorAll('.drawing-jog-btn');
  for (var ji = 0; ji < jogBtns.length; ji++) {
    jogBtns[ji].addEventListener('click', function () {
      if (jogBusy) return;
      var axis = this.getAttribute('data-axis').toUpperCase();
      var dir  = parseInt(this.getAttribute('data-dir'), 10);
      jogBusy  = true;
      var jogBody = { mode: 'coord', axis: axis, step: dir * jogStep };
      if (selectedPort) jogBody.port = selectedPort;
      fetch(_serverUrl + '/cmd/jog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(jogBody)
      }).then(function () { jogBusy = false; })
        .catch(function () { jogBusy = false; });
    });
  }

  // ---- Calibration -------------------------------------------------------

  function fmtPos(p) {
    return 'X' + p.x.toFixed(1) + ' Y' + p.y.toFixed(1) + ' Z' + p.z.toFixed(1);
  }

  function updateUI() {
    calibTLEl.textContent = calib.tl ? fmtPos(calib.tl) : '\u2014';
    calibTREl.textContent = calib.tr ? fmtPos(calib.tr) : '\u2014';
    calibBREl.textContent = calib.br ? fmtPos(calib.br) : '\u2014';

    isCalibrated = !!(calib.tl && calib.tr && calib.br);
    calibStatusEl.textContent = isCalibrated ? 'Calibrated' : 'Not calibrated';
    calibStatusEl.classList.toggle('calibrated', isCalibrated);

    var gi = gridInfo();
    var layout = layoutText(gi);
    var hasText = textHasContent(layout);
    var hasDraw = paths.length > 0;
    var textErr = (textInput.value || '').replace(/\s/g, '').length > 0 && textHasErrors(layout);
    startBtn.disabled = !isCalibrated || executing || (!hasDraw && !hasText) || textErr;
  }

  function recordCalibPoint(key) {
    ExtensionAPI.getRobotStatus(selectedPort).then(function (status) {
      if (!status.success) {
        ExtensionAPI.showNotification(status.error || 'Cannot read robot position', 'error');
        return;
      }
      calib[key] = {
        x: status.coordinates.X,
        y: status.coordinates.Y,
        z: status.coordinates.Z
      };
      ExtensionAPI.setData('drawing', 'calibration', calib);
      updateUI();
      renderCanvas();
      ExtensionAPI.showNotification(key.toUpperCase() + ' recorded: ' + fmtPos(calib[key]), 'info');
    });
  }

  document.getElementById('drawing-record-tl').addEventListener('click', function () { recordCalibPoint('tl'); });
  document.getElementById('drawing-record-tr').addEventListener('click', function () { recordCalibPoint('tr'); });
  document.getElementById('drawing-record-br').addEventListener('click', function () { recordCalibPoint('br'); });

  document.getElementById('drawing-clear-calib').addEventListener('click', function () {
    calib = { tl: null, tr: null, br: null };
    ExtensionAPI.setData('drawing', 'calibration', calib);
    updateUI();
    renderCanvas();
    ExtensionAPI.showNotification('Calibration cleared', 'info');
  });

  var saved = ExtensionAPI.getData('drawing', 'calibration');
  if (saved) { calib = saved; }
  updateUI();

  // ---- Coordinate transform ----------------------------------------------
  // TL=(0,0)  TR=(maxGx,0)  BR=(maxGx,maxGy)
  // BL = TL + BR − TR   (parallelogram)
  // P(u,v) = TL + u*(TR−TL) + v*(BL−TL)   where u,v ∈ [0,1]

  function canvasToRobot(gx, gy) {
    var gi = gridInfo();
    var u  = gx / gi.maxGx;
    var v  = gi.maxGy > 0 ? gy / gi.maxGy : 0;
    var tl = calib.tl, tr = calib.tr, br = calib.br;
    var blx = tl.x + br.x - tr.x;
    var bly = tl.y + br.y - tr.y;
    var blz = tl.z + br.z - tr.z;
    return {
      x: tl.x + u * (tr.x - tl.x) + v * (blx - tl.x),
      y: tl.y + u * (tr.y - tl.y) + v * (bly - tl.y),
      z: tl.z + u * (tr.z - tl.z) + v * (blz - tl.z)
    };
  }

  // ---- Path interpolation ------------------------------------------------

  function interpolatePath(path) {
    if (path.length <= 1) return path.slice();
    var gi = gridInfo();
    var result = [path[0]];
    for (var i = 1; i < path.length; i++) {
      var prev = path[i - 1], curr = path[i];
      var dgx  = curr.gx - prev.gx;
      var dgy  = curr.gy - prev.gy;
      var dist = Math.sqrt(dgx * dgx + dgy * dgy);
      var steps = Math.max(1, Math.ceil(dist));
      for (var s = 1; s <= steps; s++) {
        var t  = s / steps;
        var sx = Math.min(gi.maxGx, Math.max(0, prev.gx + dgx * t));
        var sy = Math.min(gi.maxGy, Math.max(0, prev.gy + dgy * t));
        var last = result[result.length - 1];
        if (Math.abs(sx - last.gx) > 0.01 || Math.abs(sy - last.gy) > 0.01) {
          result.push({ gx: sx, gy: sy });
        }
      }
    }
    return result;
  }

  // ---- Execution helpers -------------------------------------------------

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function cmdMove(x, y, z) {
    var body = {
      mode: 'coord', motion: 1,
      values: { x: x, y: y, z: z },
      isAbsolute: true
    };
    if (selectedPort) body.port = selectedPort;
    return fetch(_serverUrl + '/cmd/jog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  async function waitIdle(timeoutMs) {
    var deadline = Date.now() + (timeoutMs || 15000);
    while (Date.now() < deadline) {
      if (aborted) return;
      var st = await ExtensionAPI.getRobotStatus(selectedPort);
      if (st.success && st.state === 'Idle') return;
      await sleep(200);
    }
  }

  function setProgress(msg) {
    progressEl.textContent = msg;
    progressEl.classList.toggle('running', !!msg);
  }

  function buildSegments() {
    var gi = gridInfo();
    var layout = layoutText(gi);
    var segments = [];
    var i, j, k, cell, stroke, pts, interp, totalChars, charIndex, pt;

    totalChars = 0;
    for (i = 0; i < layout.cells.length; i++) {
      if (layout.cells[i].strokes && layout.cells[i].strokes.length) totalChars += 1;
    }
    charIndex = 0;
    for (i = 0; i < layout.cells.length; i++) {
      cell = layout.cells[i];
      if (!cell.strokes || !cell.strokes.length) continue;
      charIndex += 1;
      for (j = 0; j < cell.strokes.length; j++) {
        stroke = cell.strokes[j];
        pts = [];
        for (k = 0; k < stroke.length; k++) {
          pt = mapGlyphPoint(cell, stroke[k].x, stroke[k].y, layout);
          pts.push(pt);
        }
        interp = interpolatePath(pts);
        if (interp.length > 0) {
          segments.push({
            points: interp,
            label: 'Character ' + charIndex + '/' + totalChars + ' ' + cell.ch
                    + ' — stroke ' + (j + 1) + '/' + cell.strokes.length
          });
        }
      }
    }

    for (i = 0; i < paths.length; i++) {
      interp = interpolatePath(paths[i]);
      if (interp.length > 0) {
        segments.push({
          points: interp,
          label: 'Freehand ' + (i + 1) + '/' + paths.length
        });
      }
    }
    return segments;
  }

  async function runDrawing() {
    executing = true;
    aborted   = false;
    startBtn.disabled = true;
    stopBtn.disabled  = false;

    var liftZ = 10;
    var segments = buildSegments();
    var si, pi, seg, first, last, pt;

    for (si = 0; si < segments.length; si++) {
      if (aborted) break;
      seg = segments[si];

      setProgress(seg.label + ' — moving to start');

      first = canvasToRobot(seg.points[0].gx, seg.points[0].gy);
      await cmdMove(first.x, first.y, first.z + liftZ);
      await waitIdle();
      if (aborted) break;

      await cmdMove(first.x, first.y, first.z);
      await waitIdle();
      if (aborted) break;

      for (pi = 1; pi < seg.points.length; pi++) {
        if (aborted) break;
        pt = canvasToRobot(seg.points[pi].gx, seg.points[pi].gy);
        await cmdMove(pt.x, pt.y, pt.z);
        await waitIdle();
        setProgress(seg.label + ' — point ' + pi + '/' + (seg.points.length - 1));
      }
      if (aborted) break;

      last = canvasToRobot(seg.points[seg.points.length - 1].gx, seg.points[seg.points.length - 1].gy);
      await cmdMove(last.x, last.y, last.z + liftZ);
      await waitIdle();
    }

    executing = false;
    stopBtn.disabled = true;
    updateUI();

    if (aborted) {
      setProgress('Stopped');
      ExtensionAPI.showNotification('Drawing stopped', 'info');
    } else {
      setProgress('Done! ' + segments.length + ' stroke(s) drawn');
      ExtensionAPI.showNotification('Drawing complete', 'info');
    }
  }

  function hideModal() {
    modalEl.hidden = true;
  }

  function showModal() {
    modalEl.hidden = false;
  }

  startBtn.addEventListener('click', function () {
    if (!isCalibrated) return;
    var gi = gridInfo();
    var layout = layoutText(gi);
    if (!paths.length && !textHasContent(layout)) return;
    if ((textInput.value || '').replace(/\s/g, '').length > 0 && textHasErrors(layout)) return;
    showModal();
  });

  modalCancel.addEventListener('click', hideModal);
  modalEl.addEventListener('click', function (e) {
    if (e.target === modalEl) hideModal();
  });
  modalConfirm.addEventListener('click', function () {
    hideModal();
    runDrawing();
  });

  stopBtn.addEventListener('click', function () {
    aborted = true;
    stopBtn.disabled = true;
    setProgress('Stopping\u2026');
  });
})();
