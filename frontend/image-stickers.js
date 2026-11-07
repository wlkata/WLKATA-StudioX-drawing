/* Vector sticker geometry shared by the canvas and execution path. */
(function(root) {
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

  function fit(item, grid) {
    const maximum = Math.min(grid.maxGx, grid.maxGy * item.aspect);
    item.width = clamp(item.width, Math.min(.05, maximum), maximum);
    item.height = item.width / item.aspect;
    item.gx = clamp(item.gx, 0, Math.max(0, grid.maxGx - item.width));
    item.gy = clamp(item.gy, 0, Math.max(0, grid.maxGy - item.height));
    return item;
  }

  function create(payload, grid) {
    if (!payload || !Number.isFinite(payload.aspect) || payload.aspect <= 0 || !Array.isArray(payload.paths) || !payload.paths.length)
      throw Error('The image must be converted to paths first.');

    let total = 0;

    for (const path of payload.paths) {
      if (!Array.isArray(path) || path.length < 2)
        throw Error('Invalid image path.');

      for (const point of path) {
        if (!Array.isArray(point) || point.length !== 2 || point.some(value => !Number.isFinite(value) || value < 0 || value > 1))
          throw Error('Invalid image path coordinates.');

        if (++total > 50000)
          throw Error('Image has too many path points.');
      }
    }

    const width = Math.min(grid.maxGx * .55, grid.maxGy * .55 * payload.aspect);

    return fit({
      ...payload,
      width,
      height: width / payload.aspect,
      gx: (grid.maxGx - width) / 2,
      gy: (grid.maxGy - width / payload.aspect) / 2
    }, grid);
  }

  function move(item, x, y, grid) {
    item.gx = x;
    item.gy = y;
    return fit(item, grid);
  }

  function resize(item, original, corner, x, y, grid) {
    const west = corner.includes('w'), north = corner.includes('n');
    const ax = original.gx + (west ? original.width : 0), ay = original.gy + (north ? original.height : 0);
    const sx = west ? -1 : 1, sy = north ? -1 : 1;
    const requested = ((x - ax) * sx + (y - ay) * sy / original.aspect) / (1 + 1 / (original.aspect * original.aspect));
    const maximum = Math.min(west ? ax : grid.maxGx - ax, (north ? ay : grid.maxGy - ay) * original.aspect);
    const width = clamp(requested, Math.min(.5, maximum), maximum);
    item.width = width;
    item.height = width / original.aspect;
    item.gx = west ? ax - width : ax;
    item.gy = north ? ay - item.height : ay;
    return fit(item, grid);
  }

  function segments(item) {
    return item.paths.map((path, index) => ({
      kind: 'image',
      label: 'Image ' + item.name + ' — path ' + (index + 1) + '/' + item.paths.length,

      points: path.map(point => ({
        gx: item.gx + point[0] * item.width,
        gy: item.gy + point[1] * item.height
      }))
    }));
  }

  const api = {
    create,
    fit,
    move,
    resize,
    segments
  };

  if (typeof module !== 'undefined' && module.exports)
    module.exports = api;

  root.DrawingImageStickers = api;
})(typeof window !== 'undefined' ? window : globalThis);
