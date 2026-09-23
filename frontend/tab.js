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
  var eraserSizeInput = document.getElementById('drawing-eraser-size');
  var eraserSizeWrap = document.getElementById('drawing-eraser-size-wrap');
  var textErrorEl = document.getElementById('drawing-text-error');
  var calibTLEl  = document.getElementById('drawing-calib-tl');
  var calibTREl  = document.getElementById('drawing-calib-tr');
  var calibBREl  = document.getElementById('drawing-calib-br');
  var calibStatusEl = document.getElementById('drawing-calib-status');
  var startBtn   = document.getElementById('drawing-start');
  var moveCountEl = document.getElementById('drawing-move-count');
  var stopBtn    = document.getElementById('drawing-stop');
  var progressEl = document.getElementById('drawing-progress');
  var deviceSelect  = document.getElementById('drawing-device-select');
  var deviceRefresh = document.getElementById('drawing-device-refresh');
  var modalEl    = document.getElementById('drawing-modal');
  var modalCancel = document.getElementById('drawing-modal-cancel');
  var modalConfirm = document.getElementById('drawing-modal-confirm');
  var charsetModal = document.getElementById('drawing-charset-modal');
  var downloadSetsBtn = document.getElementById('drawing-download-sets');

  // ---- State -------------------------------------------------------------

  var paths       = [];
  var currentPath = null;
  var isDrawing   = false;
  var toolMode    = 'draw';
  var erasePos    = null;
  var eraseDragging = false;
  var eraseDidChange = false;
  var undoStack   = [];

  var calib = { tl: null, tr: null, br: null };
  var isCalibrated = false;
  var executing    = false;
  var aborted      = false;
  var selectedPort = null;

  var textFields = [];
  var selectedTextId = null;
  var nextTextId = 1;
  var textDrag = null;
  var textResize = null;
  var textSelDrag = null;
  var caretTimer = null;
  var lastGrid = null;

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
      updateUI();
    }).catch(function () {});
  }

  deviceSelect.addEventListener('change', function () {
    selectedPort = deviceSelect.value || null;
    updateUI();
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
    if (res < 10) res = 10;
    if (res > 80) res = 80;
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

  function remapStoredGeometry(gi) {
    if (!gi || !gi.maxGx || !gi.maxGy) return;
    if (!lastGrid) {
      lastGrid = { maxGx: gi.maxGx, maxGy: gi.maxGy };
      return;
    }
    if (lastGrid.maxGx === gi.maxGx && lastGrid.maxGy === gi.maxGy) return;

    var sx = gi.maxGx / lastGrid.maxGx;
    var sy = gi.maxGy / lastGrid.maxGy;

    function mapPt(p) {
      return {
        gx: Math.min(gi.maxGx, Math.max(0, p.gx * sx)),
        gy: Math.min(gi.maxGy, Math.max(0, p.gy * sy))
      };
    }

    var i, j, f;
    for (i = 0; i < paths.length; i++) {
      for (j = 0; j < paths[i].length; j++) {
        paths[i][j] = mapPt(paths[i][j]);
      }
    }
    if (currentPath) {
      for (j = 0; j < currentPath.length; j++) {
        currentPath[j] = mapPt(currentPath[j]);
      }
    }
    for (i = 0; i < undoStack.length; i++) {
      for (j = 0; j < undoStack[i].length; j++) {
        var snapPath = undoStack[i][j];
        var k;
        for (k = 0; k < snapPath.length; k++) {
          snapPath[k] = mapPt(snapPath[k]);
        }
      }
    }
    for (i = 0; i < textFields.length; i++) {
      f = textFields[i];
      f.gx = Math.min(gi.maxGx, Math.max(0, f.gx * sx));
      f.gy = Math.min(gi.maxGy, Math.max(0, f.gy * sy));
      f.size = clampSize(Math.max(1, Math.round(f.size * sx)), gi);
    }
    lastGrid = { maxGx: gi.maxGx, maxGy: gi.maxGy };

    var sel = selectedField();
    if (sel && !sizeInput.disabled) sizeInput.value = String(sel.size);
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

  function fieldWrapCols(field, gi) {
    var charCells = clampSize(field.size, gi);
    var maxCols = Math.max(1, Math.floor((gi.maxGx - field.gx) / charCells));
    var cols = parseInt(field.cols, 10);
    if (!isFinite(cols) || cols < 1) cols = Math.min(4, maxCols);
    if (cols > maxCols) cols = maxCols;
    return cols;
  }

  function layoutField(field, gi) {
    var charCells = clampSize(field.size, gi);
    var cols = fieldWrapCols(field, gi);
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

  function walkLayout(field, gi) {
    var charCells = clampSize(field.size, gi);
    var cols = fieldWrapCols(field, gi);
    var rows = Math.floor((gi.maxGy - field.gy) / charCells);
    if (cols < 0) cols = 0;
    if (rows < 0) rows = 0;
    var text = field.text || '';
    var col = 0;
    var row = 0;
    var carets = [{ col: 0, row: 0 }];
    var occupied = [];
    var i, ch;

    function advance() {
      col += 1;
      if (cols > 0 && col >= cols) {
        col = 0;
        row += 1;
      }
    }

    for (i = 0; i < text.length; i++) {
      ch = text.charAt(i);
      if (ch === '\r') {
        carets.push({ col: col, row: row });
        continue;
      }
      if (ch === '\n') {
        col = 0;
        row += 1;
        carets.push({ col: col, row: row });
        continue;
      }
      occupied.push({ index: i, col: col, row: row, ch: ch });
      advance();
      carets.push({ col: col, row: row });
    }
    return {
      charCells: charCells,
      cols: cols,
      rows: rows,
      carets: carets,
      occupied: occupied
    };
  }

  function localInItem(el, e) {
    var r = el.getBoundingClientRect();
    var cs = window.getComputedStyle(el);
    return {
      x: e.clientX - r.left - (parseFloat(cs.borderLeftWidth) || 0),
      y: e.clientY - r.top - (parseFloat(cs.borderTopWidth) || 0)
    };
  }

  function indexFromLocalPoint(field, gi, localX, localY) {
    var walk = walkLayout(field, gi);
    var side = walk.charCells * gi.cell;
    if (side <= 0) return 0;
    var col = Math.floor(localX / side);
    var row = Math.floor(localY / side);
    var frac = localX / side - col;
    var i, occ, lastOnRow = null, firstOnRow = null;
    for (i = 0; i < walk.occupied.length; i++) {
      occ = walk.occupied[i];
      if (occ.col === col && occ.row === row) {
        return frac < 0.5 ? occ.index : occ.index + 1;
      }
      if (occ.row === row) {
        if (!firstOnRow) firstOnRow = occ;
        lastOnRow = occ;
      }
    }
    if (lastOnRow && col > lastOnRow.col) return lastOnRow.index + 1;
    if (firstOnRow) return firstOnRow.index;
    if (row > 0) {
      for (i = walk.occupied.length - 1; i >= 0; i--) {
        if (walk.occupied[i].row < row) return walk.occupied[i].index + 1;
      }
    }
    return (field.text || '').length;
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
    var maxCols = Math.max(1, Math.floor((gi.maxGx - gx) / size));
    var field = {
      id: nextTextId++,
      gx: gx,
      gy: gy,
      size: size,
      cols: Math.min(4, maxCols),
      text: ''
    };
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
    var resize = document.createElement('div');
    resize.className = 'drawing-text-item-resize';
    resize.title = 'Drag to set width';
    el.appendChild(bar);
    el.appendChild(ta);
    el.appendChild(resize);
    textLayer.appendChild(el);

    el.addEventListener('mousedown', function (e) {
      if (executing) return;
      selectTextField(field.id);
      if (e.target === bar) {
        e.preventDefault();
        startTextDrag(field, e);
      } else if (e.target === resize) {
        e.preventDefault();
        startTextResize(field, e);
      } else if (e.target === ta && !e.isComposing) {
        e.preventDefault();
        ta.focus();
        var gi = gridInfo();
        var pt = localInItem(el, e);
        var idx = indexFromLocalPoint(field, gi, pt.x, pt.y);
        ta.setSelectionRange(idx, idx);
        textSelDrag = { field: field, ta: ta, el: el, anchor: idx };
        document.addEventListener('mousemove', onTextSelMove);
        document.addEventListener('mouseup', onTextSelEnd);
        renderCanvas();
      }
      e.stopPropagation();
    });
    ta.addEventListener('input', function () {
      field.text = ta.value;
      scheduleGlyphFetch();
      renderCanvas();
      updateUI();
    });
    ta.addEventListener('keyup', function () { renderCanvas(); });
    ta.addEventListener('select', function () { renderCanvas(); });
    ta.addEventListener('focus', function () {
      selectTextField(field.id);
      startCaretBlink();
    });
    ta.addEventListener('blur', function () {
      stopCaretBlink();
      renderCanvas();
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
    var wrapW = fieldWrapCols(field, gi) * charCells;
    var maxGx = Math.max(0, gi.maxGx - wrapW);
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

  function startTextResize(field, e) {
    var gi = gridInfo();
    textResize = {
      field: field,
      origCols: fieldWrapCols(field, gi),
      x: e.clientX
    };
    document.addEventListener('mousemove', onTextResizeMove);
    document.addEventListener('mouseup', onTextResizeEnd);
  }

  function onTextResizeMove(e) {
    if (!textResize) return;
    var gi = gridInfo();
    var field = textResize.field;
    var charCells = clampSize(field.size, gi);
    var side = charCells * gi.cell;
    if (side <= 0) return;
    var maxCols = Math.max(1, Math.floor((gi.maxGx - field.gx) / charCells));
    var cols = Math.round(textResize.origCols + (e.clientX - textResize.x) / side);
    if (cols < 1) cols = 1;
    if (cols > maxCols) cols = maxCols;
    field.cols = cols;
    renderCanvas();
  }

  function onTextResizeEnd() {
    textResize = null;
    document.removeEventListener('mousemove', onTextResizeMove);
    document.removeEventListener('mouseup', onTextResizeEnd);
    updateUI();
  }

  function onTextSelMove(e) {
    if (!textSelDrag) return;
    var gi = gridInfo();
    var pt = localInItem(textSelDrag.el, e);
    var idx = indexFromLocalPoint(textSelDrag.field, gi, pt.x, pt.y);
    var a = textSelDrag.anchor;
    if (idx < a) textSelDrag.ta.setSelectionRange(idx, a);
    else textSelDrag.ta.setSelectionRange(a, idx);
    renderCanvas();
  }

  function onTextSelEnd() {
    textSelDrag = null;
    document.removeEventListener('mousemove', onTextSelMove);
    document.removeEventListener('mouseup', onTextSelEnd);
  }

  function startCaretBlink() {
    if (caretTimer) return;
    caretTimer = setInterval(function () {
      var f = selectedField();
      if (!f) { stopCaretBlink(); return; }
      var el = textLayer.querySelector('[data-text-id="' + f.id + '"]');
      var ta = el && el.querySelector('textarea');
      if (!ta || document.activeElement !== ta) { stopCaretBlink(); return; }
      renderCanvas();
    }, 500);
  }

  function stopCaretBlink() {
    if (!caretTimer) return;
    clearInterval(caretTimer);
    caretTimer = null;
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
      cols = Math.max(1, layout.cols);
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
        ta.style.fontSize = side + 'px';
        ta.style.lineHeight = side + 'px';
        ta.style.letterSpacing = '0px';
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
    remapStoredGeometry(gi);
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

    drawTextSelection(gi);

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

    drawEraseHover(gi);
    drawTextCaret(gi);
    syncTextOverlays();
    updateTextError(layouts);
  }

  function eraserSizePx() {
    var n = parseInt(eraserSizeInput.value, 10);
    if (!isFinite(n) || n < 2) n = 2;
    if (n > 80) n = 80;
    return n;
  }

  function eraserHalfGrid(gi) {
    return (eraserSizePx() / 2) / gi.cell;
  }

  function drawEraseHover(gi) {
    if (toolMode !== 'erase' || !erasePos) return;
    var side = eraserSizePx();
    var cx = gi.oX + erasePos.gx * gi.cell;
    var cy = gi.oY + erasePos.gy * gi.cell;
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.fillRect(cx - side / 2, cy - side / 2, side, side);
    ctx.strokeRect(cx - side / 2 + 0.5, cy - side / 2 + 0.5, side - 1, side - 1);
  }

  function selectedTextarea() {
    var field = selectedField();
    if (!field) return null;
    var el = textLayer.querySelector('[data-text-id="' + field.id + '"]');
    return el ? el.querySelector('textarea') : null;
  }

  function drawTextSelection(gi) {
    var field = selectedField();
    var ta = selectedTextarea();
    if (!field || !ta) return;
    var a = ta.selectionStart;
    var b = ta.selectionEnd;
    if (a === b) return;
    var lo = Math.min(a, b);
    var hi = Math.max(a, b);
    var walk = walkLayout(field, gi);
    var side = walk.charCells * gi.cell;
    var i, occ, x0, y0;
    ctx.fillStyle = 'rgba(33,150,243,0.28)';
    for (i = 0; i < walk.occupied.length; i++) {
      occ = walk.occupied[i];
      if (occ.index >= lo && occ.index < hi) {
        x0 = gi.oX + (field.gx + occ.col * walk.charCells) * gi.cell;
        y0 = gi.oY + (field.gy + occ.row * walk.charCells) * gi.cell;
        ctx.fillRect(x0, y0, side, side);
      }
    }
  }

  function drawTextCaret(gi) {
    var field = selectedField();
    var ta = selectedTextarea();
    if (!field || !ta || document.activeElement !== ta) return;
    if (ta.selectionStart !== ta.selectionEnd) return;
    if ((Date.now() % 1000) >= 530) return;
    var walk = walkLayout(field, gi);
    var side = walk.charCells * gi.cell;
    var caret = walk.carets[ta.selectionStart] || walk.carets[walk.carets.length - 1];
    if (!caret) return;
    var x0 = gi.oX + (field.gx + caret.col * walk.charCells) * gi.cell;
    var y0 = gi.oY + (field.gy + caret.row * walk.charCells) * gi.cell;
    ctx.strokeStyle = '#2196F3';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x0 + 1, y0 + 2);
    ctx.lineTo(x0 + 1, y0 + side - 2);
    ctx.stroke();
  }

  function clampResolutionInput() {
    var n = parseInt(resInput.value, 10);
    if (!isFinite(n) || n < 10) n = 10;
    if (n > 80) n = 80;
    if (String(n) !== resInput.value) resInput.value = n;
  }

  resInput.addEventListener('change', function () {
    clampResolutionInput();
    renderCanvas();
    updateUI();
  });
  resInput.addEventListener('blur', clampResolutionInput);
  resInput.addEventListener('input', function () {
    var n = parseInt(resInput.value, 10);
    if (isFinite(n) && n > 80) clampResolutionInput();
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

  function rawGridPos(e) {
    var gi = gridInfo();
    var rect = canvas.getBoundingClientRect();
    return {
      gx: (e.clientX - rect.left - gi.oX) / gi.cell,
      gy: (e.clientY - rect.top - gi.oY) / gi.cell
    };
  }

  function pointInEraser(p, cx, cy, half) {
    return Math.abs(p.gx - cx) <= half && Math.abs(p.gy - cy) <= half;
  }

  function segHitsEraser(a, b, cx, cy, half) {
    var minX = cx - half, maxX = cx + half, minY = cy - half, maxY = cy + half;
    var dx = b.gx - a.gx, dy = b.gy - a.gy;
    var t0 = 0, t1 = 1;
    function clip(p, q) {
      if (Math.abs(p) < 1e-12) return q >= 0;
      var r = q / p;
      if (p < 0) {
        if (r > t1) return false;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return false;
        if (r < t1) t1 = r;
      }
      return true;
    }
    if (!clip(-dx, a.gx - minX)) return false;
    if (!clip(dx, maxX - a.gx)) return false;
    if (!clip(-dy, a.gy - minY)) return false;
    if (!clip(dy, maxY - a.gy)) return false;
    return true;
  }

  function eraseAtSquare(cx, cy, half) {
    var next = [];
    var pi, i, path, keepV, keepE, run;
    for (pi = 0; pi < paths.length; pi++) {
      path = paths[pi];
      keepV = [];
      for (i = 0; i < path.length; i++) {
        keepV[i] = !pointInEraser(path[i], cx, cy, half);
      }
      keepE = [];
      for (i = 0; i < path.length - 1; i++) {
        if (!keepV[i] || !keepV[i + 1]) {
          keepE[i] = false;
        } else if (segHitsEraser(path[i], path[i + 1], cx, cy, half)) {
          keepE[i] = false;
        } else {
          keepE[i] = true;
        }
      }
      i = 0;
      while (i < path.length) {
        if (!keepV[i]) {
          i += 1;
          continue;
        }
        run = [{ gx: path[i].gx, gy: path[i].gy }];
        while (i < path.length - 1 && keepE[i] && keepV[i + 1]) {
          i += 1;
          run.push({ gx: path[i].gx, gy: path[i].gy });
        }
        next.push(run);
        i += 1;
      }
    }
    return next;
  }

  function pathsUnchanged(a, b) {
    if (a.length !== b.length) return false;
    var i, j;
    for (i = 0; i < a.length; i++) {
      if (a[i].length !== b[i].length) return false;
      for (j = 0; j < a[i].length; j++) {
        if (a[i][j].gx !== b[i][j].gx || a[i][j].gy !== b[i][j].gy) return false;
      }
    }
    return true;
  }

  function applyEraserAt(pos) {
    var half = eraserHalfGrid(gridInfo());
    var next = eraseAtSquare(pos.gx, pos.gy, half);
    if (pathsUnchanged(paths, next)) return;
    if (!eraseDidChange) {
      snapshotPaths();
      eraseDidChange = true;
    }
    paths = next;
  }

  function clonePaths(src) {
    return src.map(function (path) {
      return path.map(function (pt) { return { gx: pt.gx, gy: pt.gy }; });
    });
  }

  function snapshotPaths() {
    undoStack.push(clonePaths(paths));
    if (undoStack.length > 80) undoStack.shift();
  }

  function setToolMode(mode) {
    toolMode = mode;
    erasePos = null;
    eraseDragging = false;
    isDrawing = false;
    currentPath = null;
    canvas.classList.toggle('erasing', mode === 'erase');
    document.getElementById('drawing-mode-draw').classList.toggle('active', mode === 'draw');
    document.getElementById('drawing-mode-erase').classList.toggle('active', mode === 'erase');
    eraserSizeInput.disabled = mode !== 'erase' || executing;
    eraserSizeWrap.classList.toggle('active', mode === 'erase');
    renderCanvas();
  }

  document.getElementById('drawing-mode-draw').addEventListener('click', function () {
    setToolMode('draw');
  });
  document.getElementById('drawing-mode-erase').addEventListener('click', function () {
    setToolMode('erase');
  });

  eraserSizeInput.addEventListener('change', function () {
    var n = parseInt(eraserSizeInput.value, 10);
    if (!isFinite(n) || n < 2) n = 2;
    if (n > 80) n = 80;
    eraserSizeInput.value = n;
    renderCanvas();
  });

  function onEraseMove(e) {
    if (toolMode !== 'erase' || executing) return;
    erasePos = rawGridPos(e);
    if (eraseDragging) applyEraserAt(erasePos);
    renderCanvas();
    if (eraseDragging) updateUI();
  }

  function stopEraseDrag() {
    if (!eraseDragging) return;
    eraseDragging = false;
    document.removeEventListener('mousemove', onEraseMove);
    document.removeEventListener('mouseup', stopEraseDrag);
    updateUI();
  }

  canvas.addEventListener('mousedown', function (e) {
    if (executing) return;
    selectTextField(null);
    if (toolMode === 'erase') {
      erasePos = rawGridPos(e);
      eraseDragging = true;
      eraseDidChange = false;
      applyEraserAt(erasePos);
      document.addEventListener('mousemove', onEraseMove);
      document.addEventListener('mouseup', stopEraseDrag);
      renderCanvas();
      updateUI();
      return;
    }
    isDrawing   = true;
    currentPath = [canvasPos(e)];
    renderCanvas();
  });

  canvas.addEventListener('mousemove', function (e) {
    if (toolMode === 'erase') {
      onEraseMove(e);
      return;
    }
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
    if (currentPath.length > 0) {
      snapshotPaths();
      paths.push(currentPath);
    }
    currentPath = null;
    renderCanvas();
    updateUI();
  }

  canvas.addEventListener('mouseup', finishStroke);
  canvas.addEventListener('mouseleave', function () {
    if (toolMode === 'erase') {
      if (!eraseDragging) {
        erasePos = null;
        renderCanvas();
      }
      return;
    }
    finishStroke();
  });

  // ---- Undo / Clear ------------------------------------------------------

  undoBtn.addEventListener('click', function () {
    if (!undoStack.length || executing) return;
    paths = undoStack.pop();
    erasePos = eraseDragging ? erasePos : null;
    currentPath = null;
    isDrawing = false;
    renderCanvas();
    updateUI();
  });

  clearBtn.addEventListener('click', function () {
    if (executing) return;
    if (paths.length) snapshotPaths();
    paths       = [];
    currentPath = null;
    if (!eraseDragging) erasePos = null;
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
      if (jogBusy || !selectedPort) return;
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
    startBtn.disabled = !selectedPort || !isCalibrated || executing || (!hasDraw && !hasText) || textErr;
    if (moveCountEl && !executing) {
      var nMoves = countMoves();
      moveCountEl.textContent = nMoves + (nMoves === 1 ? ' move' : ' moves');
    }
    addTextBtn.disabled = executing;
    if (downloadSetsBtn) downloadSetsBtn.disabled = executing;
    removeTextBtn.disabled = executing || selectedTextId == null;
    undoBtn.disabled = executing || undoStack.length === 0;
    document.getElementById('drawing-mode-draw').disabled = executing;
    document.getElementById('drawing-mode-erase').disabled = executing;
    eraserSizeInput.disabled = executing || toolMode !== 'erase';
    eraserSizeWrap.classList.toggle('active', toolMode === 'erase');
    var jogOn = !!selectedPort && !executing;
    var jogBtnsUI = document.querySelectorAll('.drawing-jog-btn');
    var jb;
    for (jb = 0; jb < jogBtnsUI.length; jb++) jogBtnsUI[jb].disabled = !jogOn;
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

  function simplifyCollinear(points) {
    if (!points || points.length <= 2) return points ? points.slice() : [];
    var out = [points[0]];
    var i, a, b, c, dx1, dy1, dx2, dy2, len1, len2, cross, dot;
    for (i = 1; i < points.length - 1; i++) {
      a = out[out.length - 1];
      b = points[i];
      c = points[i + 1];
      dx1 = b.gx - a.gx;
      dy1 = b.gy - a.gy;
      len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
      if (len1 < 1e-9) continue;
      dx2 = c.gx - b.gx;
      dy2 = c.gy - b.gy;
      len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
      if (len2 < 1e-9) continue;
      cross = dx1 * dy2 - dy1 * dx2;
      dot = dx1 * dx2 + dy1 * dy2;
      if (Math.abs(cross) <= 1e-6 * len1 * len2 && dot > 0) continue;
      out.push(b);
    }
    var last = points[points.length - 1];
    var prev = out[out.length - 1];
    if (Math.abs(last.gx - prev.gx) > 1e-9 || Math.abs(last.gy - prev.gy) > 1e-9) {
      out.push(last);
    }
    return out;
  }

  function preparePath(path) {
    return simplifyCollinear(interpolatePath(path));
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function round2(n) {
    return Math.round(Number(n) * 100) / 100;
  }

  function cmdMove(x, y, z) {
    var body = {
      mode: 'coord', motion: 1,
      values: { x: round2(x), y: round2(y), z: round2(z) },
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
          interp = preparePath(pts);
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
      interp = preparePath(paths[i]);
      if (interp.length > 0) {
        segments.push({
          points: interp,
          label: 'Freehand ' + (i + 1) + '/' + paths.length
        });
      }
    }
    return segments;
  }

  function countMoves() {
    var segs = buildSegments();
    var n = 0;
    var i, len;
    for (i = 0; i < segs.length; i++) {
      len = segs[i].points.length;
      if (!len) continue;
      n += 2;
      if (len > 1) n += len - 1;
      n += 1;
    }
    return n;
  }

  async function runDrawing() {
    executing = true;
    aborted   = false;
    startBtn.disabled = true;
    stopBtn.disabled  = false;
    addTextBtn.disabled = true;
    removeTextBtn.disabled = true;
    undoBtn.disabled = true;

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
    if (!selectedPort || !isCalibrated) return;
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

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function charsetLabel(name) {
    var map = {
      Chinese: 'Chinese',
      numbers: 'Numbers',
      symbols: 'Symbols',
      letters: 'Letters',
      kanji_Chinese: 'Kanji'
    };
    if (map[name]) return map[name];
    return String(name || '').replace(/[_-]+/g, ' ');
  }

  function renderCharsetModal(data) {
    var meta = document.getElementById('drawing-charset-meta');
    var localEl = document.getElementById('drawing-charset-local');
    var remoteEl = document.getElementById('drawing-charset-remote');
    meta.textContent = (data && data.error) ? 'Could not load available sets. Try again later.' : '';

    function row(html) {
      var div = document.createElement('div');
      div.className = 'drawing-charset-row';
      div.innerHTML = html;
      return div;
    }

    localEl.innerHTML = '';
    var local = (data && data.local) || [];
    if (!local.length) {
      localEl.innerHTML = '<div class="drawing-charset-empty">Nothing installed yet.</div>';
    } else {
      local.forEach(function (s) {
        localEl.appendChild(row(
          '<span title="' + charsetLabel(s.name) + '">' + charsetLabel(s.name) + '</span>' +
          '<span class="drawing-charset-note">' + (s.count || 0) + ' characters</span>'
        ));
      });
    }

    remoteEl.innerHTML = '';
    var remote = (data && data.remote) || [];
    if (!remote.length) {
      remoteEl.innerHTML = '<div class="drawing-charset-empty">No extra sets are available right now.</div>';
    } else {
      remote.forEach(function (s) {
        var el = row(
          '<span title="' + charsetLabel(s.name) + '">' + charsetLabel(s.name) + '</span>' +
          '<span class="drawing-charset-note">' + (s.size ? fmtBytes(s.size) : '') + '</span>'
        );
        var btn = document.createElement('button');
        btn.className = 'drawing-btn-secondary';
        if (s.installed) {
          btn.textContent = 'Installed';
          btn.disabled = true;
        } else {
          btn.textContent = 'Download';
          btn.addEventListener('click', function () { downloadCharset(s, btn); });
        }
        el.appendChild(btn);
        remoteEl.appendChild(el);
      });
    }
  }

  function loadCharsets() {
    var meta = document.getElementById('drawing-charset-meta');
    meta.textContent = '';
    ExtensionAPI.fetch('drawing', '/charsets')
      .then(function (data) { renderCharsetModal(data || {}); })
      .catch(function () {
        renderCharsetModal({ local: [], remote: [], error: 'Cannot load character sets.' });
      });
  }

  function downloadCharset(item, btn) {
    btn.disabled = true;
    btn.textContent = 'Downloading…';
    ExtensionAPI.fetch('drawing', '/charsets/download', {
      method: 'POST',
      body: JSON.stringify({ name: item.name, url: item.url })
    }).then(function (data) {
      if (!data || !data.success) {
        btn.disabled = false;
        btn.textContent = 'Download';
        ExtensionAPI.showNotification((data && data.error) || 'Download failed', 'error');
        return;
      }
      ExtensionAPI.showNotification('Installed ' + item.name + ' (' + (data.count || 0) + ' glyphs)', 'info');
      scheduleGlyphFetch();
      loadCharsets();
    }).catch(function () {
      btn.disabled = false;
      btn.textContent = 'Download';
      ExtensionAPI.showNotification('Download failed', 'error');
    });
  }

  downloadSetsBtn.addEventListener('click', function () {
    charsetModal.hidden = false;
    loadCharsets();
  });
  document.getElementById('drawing-charset-close').addEventListener('click', function () {
    charsetModal.hidden = true;
  });
  document.getElementById('drawing-charset-refresh').addEventListener('click', loadCharsets);
  charsetModal.addEventListener('click', function (e) {
    if (e.target === charsetModal) charsetModal.hidden = true;
  });
})();
