(function () {
  // ---- DOM refs ----------------------------------------------------------

  var canvas     = document.getElementById('drawing-canvas');
  var ctx        = canvas.getContext('2d');
  var canvasWrap = document.getElementById('drawing-canvas-wrap');
  var textLayer  = document.getElementById('drawing-text-layer');
  var resInput   = document.getElementById('drawing-resolution');
  var undoBtn    = document.getElementById('drawing-undo');
  var clearBtn   = document.getElementById('drawing-clear');
  var addTextBtn = document.getElementById('drawing-add-text');
  var removeTextBtn = document.getElementById('drawing-remove-text');
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

  var paths       = [];
  var currentPath = null;
  var isDrawing   = false;

  var calib = { tl: null, tr: null, br: null };
  var isCalibrated = false;
  var executing    = false;
  var aborted      = false;
  var selectedPort = null;

  var textFields = [];
  var selectedTextId = null;
  var nextTextId = 1;
  var textDrag = null;

  var glyphMap = {};
  var glyphMissing = [];
  var glyphFetchError = '';
  var glyphTimer = null;
  var glyphReq = 0;

  var _serverUrl = ExtensionAPI.getServerUrl();
  var WS = /[ \t\u3000]/;

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

  function clampSize(n, gi) {
    n = parseInt(n, 10) || 10;
    if (n < 1) n = 1;
    var cap = Math.max(1, Math.min(gi.maxGx, gi.maxGy));
    if (n > cap) n = cap;
    return n;
  }

  function selectedField() {
    var i;
    for (i = 0; i < textFields.length; i++) {
      if (textFields[i].id === selectedTextId) return textFields[i];
    }
    return null;
  }

  // ---- Text layout -------------------------------------------------------

  function layoutField(field, gi) {
    var charCells = clampSize(field.size, gi);
    var cols = Math.floor((gi.maxGx - field.gx) / charCells);
    var rows = Math.floor((gi.maxGy - field.gy) / charCells);
    if (cols < 0) cols = 0;
    if (rows < 0) rows = 0;
    var cells = [];
    var missing = [];
    var overflow = false;
    var col = 0;
    var row = 0;
    var usedCols = 0;
    var usedRows = 0;
    var chars = Array.from(field.text || '');
    var i, ch, g;

    function markUsed() {
      if (col + 1 > usedCols) usedCols = col + 1;
      if (row + 1 > usedRows) usedRows = row + 1;
    }

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
        if (cols < 1 || row >= rows) { overflow = true; continue; }
        markUsed();
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
      markUsed();
      advance();
    }

    if (!usedCols) usedCols = Math.min(2, Math.max(1, cols));
    if (!usedRows) usedRows = Math.min(1, Math.max(1, rows));

    return {
      field: field,
      cells: cells,
      missing: missing,
      overflow: overflow,
      charCells: charCells,
      cols: cols,
      rows: rows,
      usedCols: usedCols,
      usedRows: usedRows
    };
  }

  function layoutAll(gi) {
    var out = [];
    var i;
    for (i = 0; i < textFields.length; i++) {
      out.push(layoutField(textFields[i], gi));
    }
    return out;
  }

  function mapGlyphPoint(field, cell, nx, ny, charCells) {
    var inset = charCells * 0.1;
    var inner = charCells - 2 * inset;
    if (inner < 0.01) inner = charCells;
    return {
      gx: field.gx + cell.col * charCells + inset + nx * inner,
      gy: field.gy + cell.row * charCells + inset + ny * inner
    };
  }

  function combinedText() {
    var i, s = '';
    for (i = 0; i < textFields.length; i++) s += textFields[i].text || '';
    return s;
  }

  function textHasContent(layouts) {
    var i, j, cells;
    for (i = 0; i < layouts.length; i++) {
      cells = layouts[i].cells;
      for (j = 0; j < cells.length; j++) {
        if (cells[j].strokes && cells[j].strokes.length) return true;
      }
    }
    return false;
  }

  function textHasErrors(layouts) {
    var i, j;
    if (glyphFetchError) return true;
    if (glyphMissing.length) return true;
    for (i = 0; i < layouts.length; i++) {
      if (layouts[i].overflow) return true;
      for (j = 0; j < layouts[i].cells.length; j++) {
        if (layouts[i].cells[j].missing) return true;
      }
    }
    return false;
  }

  function textHasTypedChars() {
    return /[^\s\u3000]/.test(combinedText());
  }

  function updateTextError(layouts) {
    var parts = [];
    var overflow = false;
    var i;
    if (glyphFetchError) {
      parts.push(glyphFetchError);
    } else if (glyphMissing.length) {
      parts.push('No stroke data for: ' + glyphMissing.join(' '));
    }
    for (i = 0; i < layouts.length; i++) {
      if (layouts[i].overflow) overflow = true;
    }
    if (overflow) parts.push('Text does not fit the drawing area.');
    textErrorEl.textContent = parts.join(' ');
  }

  function scheduleGlyphFetch() {
    if (glyphTimer) clearTimeout(glyphTimer);
    glyphTimer = setTimeout(fetchGlyphs, 150);
  }

  function fetchGlyphs() {
    var text = combinedText();
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

  function selectTextField(id) {
    selectedTextId = id;
    var field = selectedField();
    if (field) {
      sizeInput.disabled = false;
      sizeInput.value = String(clampSize(field.size, gridInfo()));
      sizeWrap.classList.add('active');
      removeTextBtn.disabled = executing;
    } else {
      sizeInput.disabled = true;
      sizeWrap.classList.remove('active');
      removeTextBtn.disabled = true;
    }
    syncTextOverlays();
  }

  function addTextField() {
    var gi = gridInfo();
    var size = selectedField() ? clampSize(selectedField().size, gi) : 10;
    size = clampSize(size, gi);
    var gx = 2 + ((textFields.length * 3) % Math.max(1, gi.maxGx - size - 2));
    var gy = 3 + Math.floor(textFields.length / 6) * (size + 1);
    if (gy > gi.maxGy - size) gy = 3;
    if (gx < 0) gx = 0;
    if (gy < 0) gy = 0;
    var field = { id: nextTextId++, gx: gx, gy: gy, size: size, text: '' };
    textFields.push(field);
    selectTextField(field.id);
    renderCanvas();
    updateUI();
    var el = textLayer.querySelector('[data-text-id="' + field.id + '"]');
    if (el) {
      var ta = el.querySelector('textarea');
      if (ta) ta.focus();
    }
  }

  function removeSelectedText() {
    if (selectedTextId == null) return;
    textFields = textFields.filter(function (f) { return f.id !== selectedTextId; });
    selectTextField(null);
    scheduleGlyphFetch();
    renderCanvas();
    updateUI();
  }

  function createTextItem(field) {
    var el = document.createElement('div');
    el.className = 'drawing-text-item';
    el.setAttribute('data-text-id', String(field.id));
    var bar = document.createElement('div');
    bar.className = 'drawing-text-item-bar';
    bar.title = 'Drag to move';
    var ta = document.createElement('textarea');
    ta.className = 'drawing-text-item-input';
    ta.placeholder = '汉字';
    ta.spellcheck = false;
    ta.value = field.text || '';
    el.appendChild(bar);
    el.appendChild(ta);
    textLayer.appendChild(el);

    el.addEventListener('mousedown', function (e) {
      if (executing) return;
      selectTextField(field.id);
      if (e.target === bar) {
        e.preventDefault();
        startTextDrag(field, e);
      }
      e.stopPropagation();
    });
    ta.addEventListener('input', function () {
      field.text = ta.value;
      scheduleGlyphFetch();
      renderCanvas();
      updateUI();
    });
    ta.addEventListener('focus', function () {
      selectTextField(field.id);
    });
    return el;
  }

  function startTextDrag(field, e) {
    textDrag = {
      field: field,
      origGx: field.gx,
      origGy: field.gy,
      x: e.clientX,
      y: e.clientY
    };
    document.addEventListener('mousemove', onTextDragMove);
    document.addEventListener('mouseup', onTextDragEnd);
  }

  function onTextDragMove(e) {
    if (!textDrag) return;
    var gi = gridInfo();
    var field = textDrag.field;
    var charCells = clampSize(field.size, gi);
    var gx = Math.round(textDrag.origGx + (e.clientX - textDrag.x) / gi.cell);
    var gy = Math.round(textDrag.origGy + (e.clientY - textDrag.y) / gi.cell);
    var maxGx = Math.max(0, gi.maxGx - charCells);
    var maxGy = Math.max(0, gi.maxGy - charCells);
    if (gx < 0) gx = 0;
    if (gy < 0) gy = 0;
    if (gx > maxGx) gx = maxGx;
    if (gy > maxGy) gy = maxGy;
    field.gx = gx;
    field.gy = gy;
    renderCanvas();
  }

  function onTextDragEnd() {
    textDrag = null;
    document.removeEventListener('mousemove', onTextDragMove);
    document.removeEventListener('mouseup', onTextDragEnd);
    updateUI();
  }

  function syncTextOverlays() {
    var gi = gridInfo();
    if (!gi.cell) return;
    var seen = {};
    var i, field, el, ta, layout, side, cols, rows;
    for (i = 0; i < textFields.length; i++) {
      field = textFields[i];
      seen[field.id] = true;
      el = textLayer.querySelector('[data-text-id="' + field.id + '"]');
      if (!el) el = createTextItem(field);
      layout = layoutField(field, gi);
      side = layout.charCells * gi.cell;
      cols = Math.max(1, layout.usedCols);
      rows = Math.max(1, layout.usedRows);
      el.style.left = (gi.oX + field.gx * gi.cell) + 'px';
      el.style.top = (gi.oY + field.gy * gi.cell) + 'px';
      el.style.width = (cols * side) + 'px';
      el.style.height = (rows * side) + 'px';
      el.classList.toggle('selected', field.id === selectedTextId);
      ta = el.querySelector('textarea');
      if (ta) {
        if (document.activeElement !== ta && ta.value !== (field.text || '')) {
          ta.value = field.text || '';
        }
        ta.style.fontSize = Math.max(10, side * 0.72) + 'px';
        ta.style.lineHeight = side + 'px';
      }
    }
    var nodes = textLayer.querySelectorAll('.drawing-text-item');
    for (i = 0; i < nodes.length; i++) {
      if (!seen[nodes[i].getAttribute('data-text-id')]) {
        nodes[i].parentNode.removeChild(nodes[i]);
      }
    }
  }

  addTextBtn.addEventListener('click', addTextField);
  removeTextBtn.addEventListener('click', removeSelectedText);

  sizeInput.addEventListener('change', function () {
    var field = selectedField();
    if (!field) return;
    var gi = gridInfo();
    field.size = clampSize(sizeInput.value, gi);
    sizeInput.value = String(field.size);
    renderCanvas();
    updateUI();
  });
  sizeInput.addEventListener('input', function () {
    var field = selectedField();
    if (!field) return;
    field.size = clampSize(sizeInput.value, gridInfo());
    renderCanvas();
    updateUI();
  });
  sizeInput.addEventListener('focus', function () {
    if (selectedField()) sizeWrap.classList.add('active');
  });

  // ---- Canvas rendering --------------------------------------------------

  function renderCanvas() {
    var w = canvas.width;
    var h = canvas.height;
    if (w === 0 || h === 0) return;
    var gi = gridInfo();
    var layouts = layoutAll(gi);
    var i, j, p, cell, stroke, pt, px, py, layout, field, x0, y0, side;

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

    for (i = 0; i < layouts.length; i++) {
      layout = layouts[i];
      field = layout.field;
      for (j = 0; j < layout.cells.length; j++) {
        cell = layout.cells[j];
        x0 = gi.oX + (field.gx + cell.col * layout.charCells) * gi.cell;
        y0 = gi.oY + (field.gy + cell.row * layout.charCells) * gi.cell;
        side = layout.charCells * gi.cell;
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
        if (!cell.strokes) continue;
        ctx.strokeStyle = '#111';
        ctx.lineWidth = Math.max(1.2, gi.cell * 0.12);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        var s;
        for (s = 0; s < cell.strokes.length; s++) {
          stroke = cell.strokes[s];
          if (!stroke.length) continue;
          ctx.beginPath();
          pt = mapGlyphPoint(field, cell, stroke[0].x, stroke[0].y, layout.charCells);
          ctx.moveTo(gi.oX + pt.gx * gi.cell, gi.oY + pt.gy * gi.cell);
          for (p = 1; p < stroke.length; p++) {
            pt = mapGlyphPoint(field, cell, stroke[p].x, stroke[p].y, layout.charCells);
            ctx.lineTo(gi.oX + pt.gx * gi.cell, gi.oY + pt.gy * gi.cell);
          }
          ctx.stroke();
        }
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

    syncTextOverlays();
    updateTextError(layouts);
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
    selectTextField(null);
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
    var layouts = layoutAll(gi);
    var hasText = textHasContent(layouts);
    var hasDraw = paths.length > 0;
    var textErr = textHasTypedChars() && textHasErrors(layouts);
    startBtn.disabled = !isCalibrated || executing || (!hasDraw && !hasText) || textErr;
    addTextBtn.disabled = executing;
    removeTextBtn.disabled = executing || selectedTextId == null;
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
    var layouts = layoutAll(gi);
    var segments = [];
    var i, j, k, s, layout, cell, stroke, pts, interp, pt, totalChars, charIndex;

    totalChars = 0;
    for (i = 0; i < layouts.length; i++) {
      for (j = 0; j < layouts[i].cells.length; j++) {
        if (layouts[i].cells[j].strokes && layouts[i].cells[j].strokes.length) totalChars += 1;
      }
    }
    charIndex = 0;
    for (i = 0; i < layouts.length; i++) {
      layout = layouts[i];
      for (j = 0; j < layout.cells.length; j++) {
        cell = layout.cells[j];
        if (!cell.strokes || !cell.strokes.length) continue;
        charIndex += 1;
        for (s = 0; s < cell.strokes.length; s++) {
          stroke = cell.strokes[s];
          pts = [];
          for (k = 0; k < stroke.length; k++) {
            pt = mapGlyphPoint(layout.field, cell, stroke[k].x, stroke[k].y, layout.charCells);
            pts.push(pt);
          }
          interp = interpolatePath(pts);
          if (interp.length > 0) {
            segments.push({
              points: interp,
              label: 'Character ' + charIndex + '/' + totalChars + ' ' + cell.ch
                      + ' — stroke ' + (s + 1) + '/' + cell.strokes.length
            });
          }
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
    addTextBtn.disabled = true;
    removeTextBtn.disabled = true;

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
    var layouts = layoutAll(gi);
    if (!paths.length && !textHasContent(layouts)) return;
    if (textHasTypedChars() && textHasErrors(layouts)) return;
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
