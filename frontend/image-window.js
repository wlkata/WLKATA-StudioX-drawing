(function() {
  const base = 'http://127.0.0.1:' + (window.STUDIOX_PORT || '5080') + '/ext/drawing';
  const $ = id => document.getElementById('image-' + id);
  const canvas = $('preview'), ctx = canvas.getContext('2d');

  const field = (key, label, type, value, extra = {}) => ({
    key,
    label,
    type,
    value,
    ...extra
  });

  const numeric = (key, label, value, min, max, step = 1) => field(key, label, 'number', value, {
    min,
    max,
    step
  });

  const select = (key, label, value, options) => field(key, label, 'select', value, {
    options
  });

  const checkbox = (key, label, value) => field(key, label, 'checkbox', value);
  const spaces = ['BGR', 'GRAY', 'RGB', 'HSV', 'LAB', 'BGRA'];

  const tools = [{
    op: 'color',
    label: 'Convert color',
    fields: [select('from', 'From', 'BGR', spaces), select('to', 'To', 'GRAY', spaces)]
  }, {
    op: 'resize',
    label: 'Resize',

    fields: [
      numeric('width', 'Width', 800, 1, 4096),
      numeric('height', 'Height', 600, 1, 4096),
      checkbox('keepRatio', 'Keep ratio', true)
    ]
  }, {
    op: 'gaussian',
    label: 'Gaussian blur',
    fields: [numeric('size', 'Kernel size', 5, 1, 99, 2), numeric('sigma', 'Sigma', 0, 0, 100, .1)]
  }, {
    op: 'median',
    label: 'Median blur',
    fields: [numeric('size', 'Kernel size', 5, 3, 99, 2)]
  }, {
    op: 'threshold',
    label: 'Threshold',

    fields: [
      numeric('value', 'Threshold', 127, 0, 255),
      checkbox('inverse', 'Invert', true),
      checkbox('otsu', 'Otsu automatic', false)
    ]
  }, {
    op: 'adaptive',
    label: 'Adaptive threshold',

    fields: [
      numeric('size', 'Block size', 11, 3, 99, 2),
      numeric('c', 'C', 5, -255, 255, .1),
      checkbox('inverse', 'Invert', true)
    ]
  }, {
    op: 'canny',
    label: 'Canny edges',
    fields: [numeric('low', 'Low threshold', 50, 0, 1000), numeric('high', 'High threshold', 150, 0, 1000)]
  }, {
    op: 'invert',
    label: 'Invert',
    fields: []
  }, {
    op: 'morphology',
    label: 'Morphology',

    fields: [
      select('mode', 'Operation', 'open', ['erode', 'dilate', 'open', 'close', 'gradient']),
      numeric('size', 'Kernel size', 3, 1, 99, 2),
      numeric('iterations', 'Iterations', 1, 1, 20)
    ]
  }, {
    op: 'contrast',
    label: 'Brightness / contrast',
    fields: [numeric('alpha', 'Contrast', 1, 0, 10, .1), numeric('beta', 'Brightness', 0, -255, 255)]
  }, {
    op: 'rotate',
    label: 'Rotate',
    fields: [select('degrees', 'Clockwise', '90', ['90', '180', '270'])]
  }, {
    op: 'flip',
    label: 'Flip',
    fields: [numeric('axis', 'Axis (0 vertical, 1 horizontal)', 1, -1, 1)]
  }, {
    op: 'manual',
    label: 'Manual OpenCV function',

    fields: [
      field('function', 'Function', 'text', 'cv2.GaussianBlur'),
      field('kwargs', 'Parameters (JSON)', 'textarea', '{"ksize":[5,5],"sigmaX":0}')
    ]
  }, {
    op: 'contours',
    label: 'Convert to paths',

    fields: [
      select('foreground', 'Foreground', 'auto', ['auto', 'dark', 'light', 'nonzero']),
      numeric('threshold', 'Threshold', 127, 0, 255),
      select('retrieval', 'Contours', 'list', ['external', 'list', 'tree']),
      numeric('minArea', 'Minimum area', 3, 0, 4194304),
      numeric('minLength', 'Minimum length', 5, 0, 100000),
      numeric('epsilon', 'Approximation', .002, 0, .1, .001)
    ]
  }];

  let token = null, steps = [], generation = 0, timer, result = null, image = null, done = false, polling = false, committing = false;
  let originalFrame = null, heldPreview = null;
  const stepPreviews = new Map();

  async function request(path, body) {
    const response = await fetch(base + path, body === undefined ? undefined : {
      method: 'POST',

      headers: {
        'Content-Type': 'application/json'
      },

      body: JSON.stringify(body)
    });

    const data = await response.json();

    if (!response.ok || !data.success)
      throw Error(data.error || 'Image processing failed.');

    return data;
  }

  function status(message, error = false) {
    $('status').textContent = message;
    $('status').dataset.error = String(error);
  }

  function draw() {
    const frame = heldPreview?.frame;
    const frameReady = frame?.image.complete && frame.image.naturalWidth;
    const displayed = frame?.data || result;
    const picture = frame?.image || image;
    const w = displayed?.width || picture?.naturalWidth || 800;
    const h = displayed?.height || picture?.naturalHeight || 600;
    canvas.style.opacity = heldPreview ? (frameReady ? '1' : '.4') : (result || !steps.length ? '1' : '.4');
    $('preview-label').textContent = heldPreview
      ? heldPreview.label + (heldPreview.error ? ' · ' + heldPreview.error : frameReady ? ' · ' + w + ' × ' + h : ' · Loading…')
      : 'Final result';
    $('preview-label').dataset.error = String(!!heldPreview?.error);
    const scale = 1000 / Math.max(w, h);
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (picture?.complete && picture.naturalWidth && (!displayed?.paths || $('show-source').checked))
      ctx.drawImage(picture, 0, 0, canvas.width, canvas.height);

    if (!displayed?.paths)
      return;

    let previous;

    displayed.paths.forEach(path => {
      if (previous && $('show-travel').checked) {
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = '#527fc0';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(previous[0] * canvas.width, previous[1] * canvas.height);
        ctx.lineTo(path[0][0] * canvas.width, path[0][1] * canvas.height);
        ctx.stroke();
      }

      ctx.setLineDash([]);
      ctx.strokeStyle = '#111';
      ctx.lineWidth = 1.3;
      ctx.beginPath();

      path.forEach(
        (point, index) => ctx[index ? 'lineTo' : 'moveTo'](point[0] * canvas.width, point[1] * canvas.height)
      );

      ctx.stroke();
      previous = path[path.length - 1];
    });
  }

  function loadPreview(url) {
    const current = new Image();

    current.onload = () => {
      if (image !== current)
        return;

      draw();
    };

    image = current;
    current.src = url;
  }

  function previewFrame(data) {
    const picture = new Image();
    picture.onload = draw;
    picture.src = data.preview;
    return {data, image: picture};
  }

  function releasePreview(button) {
    if (!heldPreview || button && heldPreview.button !== button)
      return;
    heldPreview.button.setAttribute('aria-pressed', 'false');
    heldPreview = null;
    draw();
  }

  async function holdPreview(button, index) {
    if (!token || committing || heldPreview?.button === button)
      return;
    releasePreview();
    const selectedToken = token, revision = generation;
    const held = {
      button,
      label: index < 0 ? 'Original image' : 'After step ' + (index + 1) + ': ' + tools.find(tool => tool.op === steps[index].op).label,
      frame: index < 0 ? originalFrame : stepPreviews.get(index)
    };
    heldPreview = held;
    button.setAttribute('aria-pressed', 'true');
    draw();
    if (index < 0 || held.frame)
      return;
    try {
      const data = await request('/images/' + selectedToken + '/preview', {
        steps: steps.slice(0, index + 1)
      });
      if (token !== selectedToken || generation !== revision)
        return;
      const frame = previewFrame(data);
      stepPreviews.set(index, frame);
      // Keep only a few decoded images; long pipelines may contain large frames.
      if (stepPreviews.size > 6)
        stepPreviews.delete(stepPreviews.keys().next().value);
      if (heldPreview === held) {
        held.frame = frame;
        draw();
      }
    } catch (error) {
      if (heldPreview === held) {
        held.error = error.message;
        draw();
      }
    }
  }

  function bindHoldPreview(button, index) {
    button.type = 'button';
    button.classList.add('image-hold-preview');
    button.setAttribute('aria-pressed', 'false');
    button.title = index < 0 ? 'Hold to preview the original image' : 'Hold to preview the image after this step';
    button.addEventListener('pointerdown', event => {
      if (event.button !== 0 || button.disabled)
        return;
      event.preventDefault();
      button.focus({preventScroll: true});
      holdPreview(button, index);
      button.setPointerCapture(event.pointerId);
    });
    const isPreviewKey = event => event.key === ' ' || event.key === 'Enter';
    button.addEventListener('keydown', event => {
      if (isPreviewKey(event)) {
        event.preventDefault();
        holdPreview(button, index);
      }
    });
    button.addEventListener('keyup', event => {
      if (isPreviewKey(event)) {
        event.preventDefault();
        releasePreview(button);
      }
    });
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture', 'blur'])
      button.addEventListener(name, () => releasePreview(button));
    button.addEventListener('click', event => event.preventDefault());
  }

  function invalidate() {
    releasePreview();
    stepPreviews.clear();
    generation++;
    result = null;
    $('add').disabled = true;
    canvas.style.opacity = '.4';
    status('Updating preview…');
    clearTimeout(timer);
    const revision = generation;
    timer = setTimeout(() => run(revision), 220);
  }

  async function run(revision) {
    if (!token)
      return;

    try {
      const data = await request('/images/' + token + '/process', {
        steps
      });

      if (revision !== generation)
        return;

      result = data;
      loadPreview(data.preview);
      draw();
      $('add').disabled = !data.canAdd;
      const count = data.paths?.reduce((n, path) => n + path.length, 0) || 0;

      status(
        data.paths ? data.paths.length + ' paths · ' + count + ' points' + (!data.canAdd ? ' · No drawable paths; adjust the filters.' : ' · Ready to add.') : 'Image preview · ' + data.space + ' · Finish with Convert to paths.'
      );
    } catch (error) {
      if (revision !== generation)
        return;

      status(error.message, true);
      $('add').disabled = true;
    }
  }

  function list() {
    releasePreview();
    const container = $('steps');
    container.replaceChildren();

    if (!steps.length) {
      const p = document.createElement('p');
      p.className = 'image-empty';
      p.textContent = 'Choose a function on the left. Your original image stays unchanged.';
      container.appendChild(p);
    }

    steps.forEach((step, index) => {
      const tool = tools.find(t => t.op === step.op), li = document.createElement('li');
      li.className = 'image-step' + (step.op === 'contours' ? ' image-terminal' : '');
      li.dataset.stepId = step.id;
      const header = document.createElement('header'), title = document.createElement('strong');
      title.textContent = (index + 1) + '. ' + tool.label;
      header.appendChild(title);

      for (const [label, action, disabled] of [['↑', () => {
        [steps[index - 1], steps[index]] = [steps[index], steps[index - 1]];
      }, index === 0], ['↓', () => {
        [steps[index + 1], steps[index]] = [steps[index], steps[index + 1]];
      }, index === steps.length - 1], ['×', () => steps.splice(index, 1), false]]) {
        const button = document.createElement('button');
        button.textContent = label;
        button.title = label === '×' ? 'Remove step' : label === '↑' ? 'Move up' : 'Move down';
        button.disabled = disabled;

        button.onclick = () => {
          action();
          list();
          invalidate();
        };

        header.appendChild(button);
      }

      li.appendChild(header);
      const previewButton = document.createElement('button');
      previewButton.className = 'image-step-preview';
      previewButton.textContent = 'Hold to preview';
      bindHoldPreview(previewButton, index);
      li.appendChild(previewButton);

      tool.fields.forEach(spec => {
        const label = document.createElement('label');
        label.className = 'image-param' + (spec.type === 'textarea' ? ' stack' : '');
        const text = document.createElement('span');
        text.textContent = spec.label;
        label.appendChild(text);
        const input = document.createElement(spec.type === 'select' ? 'select' : spec.type === 'textarea' ? 'textarea' : 'input');
        input.dataset.param = spec.key;

        if (spec.type === 'select') spec.options.forEach(value => {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = value;
          input.appendChild(option);
        });
        else if (spec.type !== 'textarea')
          input.type = spec.type;

        if (spec.type === 'checkbox')
          input.checked = step.params[spec.key];
        else
          input.value = step.params[spec.key];

        for (const key of ['min', 'max', 'step']) if (spec[key] !== undefined)
          input[key] = spec[key];

        if (step.op === 'manual' && spec.key === 'function')
          input.setAttribute('list', 'image-manual-functions');

        input.oninput = () => {
          step.params[spec.key] = spec.type === 'checkbox' ? input.checked : spec.type === 'number' ? Number(input.value) : input.value;
          invalidate();
        };

        label.appendChild(input);
        li.appendChild(label);
      });

      if (step.op === 'manual') {
        const p = document.createElement('p');
        p.className = 'image-hint';
        p.textContent = 'The current image is the first argument. Use JSON keyword parameters and "cv2.CONSTANT" strings.';
        li.appendChild(p);
      }

      container.appendChild(li);
    });

    document.querySelector('[data-op="contours"]').disabled = !token || steps.some(s => s.op === 'contours');
  }

  tools.forEach(tool => {
    const button = document.createElement('button');
    button.textContent = tool.label;
    button.dataset.op = tool.op;
    button.disabled = true;

    button.onclick = () => {
      if (!token)
        return;

      if (steps.length >= 40) {
        status('Use at most 40 processing steps.', true);
        return;
      }

      const params = Object.fromEntries(tool.fields.map(spec => [spec.key, spec.value]));

      if (tool.op === 'color' && result)
        params.from = result.space;

      steps.push({
        id: crypto.randomUUID(),
        op: tool.op,
        params
      });

      list();
      invalidate();

      $('steps').lastElementChild?.scrollIntoView({
        block: 'nearest'
      });
    };

    $('functions').appendChild(button);
  });

  async function active() {
    if (polling || done || committing)
      return;

    polling = true;

    try {
      const data = await request('/images/active?known=' + encodeURIComponent(token || ''));

      if (!data.token || data.token === token)
        return;

      releasePreview();
      stepPreviews.clear();
      clearTimeout(timer);
      token = data.token;
      steps = [];
      result = null;
      generation++;
      $('add').disabled = true;
      $('original').disabled = false;
      $('source').textContent = data.name + ' · ' + data.width + ' × ' + data.height + (data.originalSize[0] !== data.width || data.originalSize[1] !== data.height ? ' (working image resized from ' + data.originalSize.join(' × ') + ')' : '');
      $('manual-functions').replaceChildren();

      (data.manualFunctions || []).forEach(name => {
        const option = document.createElement('option');
        option.value = 'cv2.' + name;
        $('manual-functions').appendChild(option);
      });

      document.querySelectorAll('#image-functions button').forEach(button => button.disabled = false);
      list();
      originalFrame = previewFrame({...data, space: 'BGR', paths: null});
      image = originalFrame.image;
      draw();
      status('Choose image filters, then finish with Convert to paths.');
    } catch (error) {
      status(error.message, true);
    } finally {
      polling = false;
    }
  }

  $('add').onclick = async () => {
    if (!result?.canAdd || committing)
      return;

    releasePreview();
    $('add').disabled = true;
    committing = true;

    const controls = Array.from(document.querySelectorAll(
      '#image-original, #image-functions button, #image-steps button, #image-steps input, #image-steps select, #image-steps textarea'
    ));

    const disabled = controls.map(control => control.disabled);
    controls.forEach(control => control.disabled = true);

    try {
      await request('/images/' + token + '/commit', {
        revision: result.revision
      });

      done = true;
      window.close();
    } catch (error) {
      committing = false;
      controls.forEach((control, index) => control.disabled = disabled[index]);
      status(error.message, true);
    }
  };

  $('show-source').onchange = draw;
  $('show-travel').onchange = draw;
  bindHoldPreview($('original'), -1);
  window.addEventListener('blur', () => releasePreview());
  window.addEventListener('pointerup', () => releasePreview());
  window.addEventListener('pointercancel', () => releasePreview());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden)
      releasePreview();
  });

  window.addEventListener('beforeunload', () => {
    if (token && !done)
      navigator.sendBeacon(base + '/images/' + token + '/cancel');
  });

  new ResizeObserver(() => {
    if (image?.complete)
      draw();
  }).observe(canvas.parentElement);

  list();
  active();
  setInterval(active, 1400);
})();
