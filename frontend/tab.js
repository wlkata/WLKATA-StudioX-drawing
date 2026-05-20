(function () {
  // ---- DOM refs ----------------------------------------------------------

  var canvas     = document.getElementById('drawing-canvas');
  var ctx        = canvas.getContext('2d');
  var canvasWrap = document.getElementById('drawing-canvas-wrap');
  var resInput   = document.getElementById('drawing-resolution');
  var undoBtn    = document.getElementById('drawing-undo');
  var clearBtn   = document.getElementById('drawing-clear');
  var calibTLEl  = document.getElementById('drawing-calib-tl');
  var calibTREl  = document.getElementById('drawing-calib-tr');
  var calibBREl  = document.getElementById('drawing-calib-br');
  var calibStatusEl = document.getElementById('drawing-calib-status');
  var startBtn   = document.getElementById('drawing-start');
  var stopBtn    = document.getElementById('drawing-stop');
  var progressEl = document.getElementById('drawing-progress');
  var deviceSelect  = document.getElementById('drawing-device-select');
  var deviceRefresh = document.getElementById('drawing-device-refresh');

  // ---- State -------------------------------------------------------------

  var paths       = [];    // Array of arrays of {gx, gy} grid indices
  var currentPath = null;
  var isDrawing   = false;

  var calib = { tl: null, tr: null, br: null }; // each {x, y, z}
  var isCalibrated = false;
  var executing    = false;
  var aborted      = false;
  var selectedPort = null;  // serial port of the selected robot

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
      // Restore previous selection if still available
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
  // All grid math uses a single square cell size (cellW = canvasWidth / res)
  // for both axes so rendering and snapping always agree.

  function gridInfo() {
    var res  = parseInt(resInput.value) || 50;
    var w    = canvas.width;
    var h    = canvas.height;
    var cell = w / res;                         // square cell in px
    var maxGx = res;                            // grid columns
    var maxGy = Math.floor(h / cell);           // grid rows (full cells only)
    return { res: res, cell: cell, maxGx: maxGx, maxGy: maxGy,
             boxW: maxGx * cell, boxH: maxGy * cell };
  }

  // ---- Canvas rendering --------------------------------------------------

  function renderCanvas() {
    var w = canvas.width;
    var h = canvas.height;
    if (w === 0 || h === 0) return;
    var gi = gridInfo();

    // Background
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);

    // Grey out area below the bounding box (outside drawable region)
    if (gi.boxH < h) {
      ctx.fillStyle = 'rgba(0,0,0,0.04)';
      ctx.fillRect(0, gi.boxH, w, h - gi.boxH);
    }

    // Grid lines (inside bounding box only)
    var step = gi.res > 100 ? 5 : 1;
    ctx.strokeStyle = 'rgba(0,0,0,0.06)';
    ctx.lineWidth   = 0.5;
    for (var gx = 0; gx <= gi.maxGx; gx += step) {
      var px = Math.round(gx * gi.cell) + 0.5;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, gi.boxH);
      ctx.stroke();
    }
    for (var gy = 0; gy <= gi.maxGy; gy += step) {
      var py = Math.round(gy * gi.cell) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, py);
      ctx.lineTo(gi.boxW, py);
      ctx.stroke();
    }

    // Bounding box — shows the calibration region (TL ↔ BR)
    ctx.strokeStyle = 'rgba(33,150,243,0.5)';
    ctx.lineWidth   = 2;
    ctx.setLineDash([6, 3]);
    ctx.strokeRect(1, 1, gi.boxW - 2, gi.boxH - 2);
    ctx.setLineDash([]);

    // Collect all paths (including the one being drawn)
    var allPaths = paths.slice();
    if (currentPath && currentPath.length > 0) allPaths.push(currentPath);

    // Draw paths — convert stored {gx, gy} grid indices to pixels
    ctx.strokeStyle = '#333';
    ctx.lineWidth   = 2;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';

    for (var i = 0; i < allPaths.length; i++) {
      var p = allPaths[i];
      if (p.length === 0) continue;

      if (p.length === 1) {
        ctx.fillStyle = '#333';
        ctx.beginPath();
        ctx.arc(p[0].gx * gi.cell, p[0].gy * gi.cell, 2, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }

      ctx.beginPath();
      ctx.moveTo(p[0].gx * gi.cell, p[0].gy * gi.cell);
      for (var j = 1; j < p.length; j++) {
        ctx.lineTo(p[j].gx * gi.cell, p[j].gy * gi.cell);
      }
      ctx.stroke();
    }
  }

  resInput.addEventListener('change', renderCanvas);

  // ---- Canvas mouse handling ---------------------------------------------

  /** Snap raw pixel coords to the nearest grid corner, return {gx, gy}. */
  function snapToGrid(rawPxX, rawPxY) {
    var gi = gridInfo();
    return {
      gx: Math.min(gi.maxGx, Math.max(0, Math.round(rawPxX / gi.cell))),
      gy: Math.min(gi.maxGy, Math.max(0, Math.round(rawPxY / gi.cell)))
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
    // Distance from last point in grid-cell units
    var dxCells = rawPxX / gi.cell - last.gx;
    var dyCells = rawPxY / gi.cell - last.gy;
    var distCells = Math.sqrt(dxCells * dxCells + dyCells * dyCells);
    // Wait until mouse is ≥ 0.9 cells from the last point.
    // At 0.9, a 45° movement is at (0.64, 0.64) → rounds to (1,1) diagonal.
    // Shallower angles (< ~34°) correctly round to the adjacent-axis cell.
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

  // ---- Jog controls (same pattern as cv-pick) ----------------------------

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

    startBtn.disabled = !isCalibrated || paths.length === 0 || executing;
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
      ExtensionAPI.showNotification(key.toUpperCase() + ' recorded: ' + fmtPos(calib[key]), 'info');
    });
  }

  document.getElementById('drawing-record-tl').addEventListener('click', function () { recordCalibPoint('tl'); });
  document.getElementById('drawing-record-tr').addEventListener('click', function () { recordCalibPoint('tr'); });
  document.getElementById('drawing-record-br').addEventListener('click', function () { recordCalibPoint('br'); });

  // Restore saved calibration
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
  // Resample a path so consecutive points are at most 1 grid cell apart,
  // snapping every interpolated point to a grid corner and deduplicating.

  function interpolatePath(path) {
    if (path.length <= 1) return path.slice();
    var gi = gridInfo();
    var result = [path[0]];
    for (var i = 1; i < path.length; i++) {
      var prev = path[i - 1], curr = path[i];
      var dgx  = curr.gx - prev.gx;
      var dgy  = curr.gy - prev.gy;
      var dist = Math.sqrt(dgx * dgx + dgy * dgy);
      var steps = Math.max(1, Math.ceil(dist));  // 1 grid cell per step
      for (var s = 1; s <= steps; s++) {
        var t  = s / steps;
        var sx = Math.min(gi.maxGx, Math.max(0, Math.round(prev.gx + dgx * t)));
        var sy = Math.min(gi.maxGy, Math.max(0, Math.round(prev.gy + dgy * t)));
        var last = result[result.length - 1];
        if (sx !== last.gx || sy !== last.gy) {
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

  // ---- Execute drawing ---------------------------------------------------

  startBtn.addEventListener('click', async function () {
    if (!isCalibrated || paths.length === 0) return;

    executing = true;
    aborted   = false;
    startBtn.disabled = true;
    stopBtn.disabled  = false;

    var liftZ = 10; // mm above surface between segments

    // Pre-interpolate all paths
    var segments = [];
    for (var i = 0; i < paths.length; i++) {
      var interp = interpolatePath(paths[i]);
      if (interp.length > 0) segments.push(interp);
    }

    for (var si = 0; si < segments.length; si++) {
      if (aborted) break;
      var seg = segments[si];

      setProgress('Segment ' + (si + 1) + '/' + segments.length + ' — moving to start');

      // Move above the first point (lift Z)
      var first = canvasToRobot(seg[0].gx, seg[0].gy);
      await cmdMove(first.x, first.y, first.z + liftZ);
      await waitIdle();
      if (aborted) break;

      // Lower to drawing surface
      await cmdMove(first.x, first.y, first.z);
      await waitIdle();
      if (aborted) break;

      // Trace each point
      for (var pi = 1; pi < seg.length; pi++) {
        if (aborted) break;
        var pt = canvasToRobot(seg[pi].gx, seg[pi].gy);
        await cmdMove(pt.x, pt.y, pt.z);
        await waitIdle();
        setProgress('Segment ' + (si + 1) + '/' + segments.length
                    + ' — point ' + pi + '/' + (seg.length - 1));
      }
      if (aborted) break;

      // Lift after segment
      var last = canvasToRobot(seg[seg.length - 1].gx, seg[seg.length - 1].gy);
      await cmdMove(last.x, last.y, last.z + liftZ);
      await waitIdle();
    }

    // Finished
    executing = false;
    stopBtn.disabled = true;
    updateUI();

    if (aborted) {
      setProgress('Stopped');
      ExtensionAPI.showNotification('Drawing stopped', 'info');
    } else {
      setProgress('Done! ' + segments.length + ' segment(s) drawn');
      ExtensionAPI.showNotification('Drawing complete', 'info');
    }
  });

  stopBtn.addEventListener('click', function () {
    aborted = true;
    stopBtn.disabled = true;
    setProgress('Stopping\u2026');
  });
})();