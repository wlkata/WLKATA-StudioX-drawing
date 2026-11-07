const assert = require("assert"), model = require("../frontend/image-stickers");

const grid = {
        maxGx: 50,
        maxGy: 30
      },
      payload = {
        id: "test",
        name: "rectangle",
        aspect: 2,
        paths: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]
      };

const unchanged = JSON.stringify(payload.paths), item = model.create(payload, grid);
assert.strictEqual(item.width / item.height, 2);

for (const aspect of [1 / 4096, 4096]) {
  const thin = model.create({
    ...payload,
    aspect
  }, grid);

  model.move(thin, 1000, 1000, grid);
  assert.ok(thin.gx + thin.width <= grid.maxGx + 1e-9);
  assert.ok(thin.gy + thin.height <= grid.maxGy + 1e-9);
  assert.ok(Math.abs(thin.width / thin.height - aspect) < 1e-9);
}

for (const corner of ["nw", "ne", "sw", "se"]) {
  const original = {
    ...item
  };

  model.resize(item, original, corner, corner.includes("w") ? -100 : 100, corner.includes("n") ? -100 : 100, grid);
  assert.ok(Math.abs(item.width / item.height - 2) < 1e-10);

  assert.ok(
    item.gx >= 0 && item.gy >= 0 && item.gx + item.width <= 50 + 1e-9 && item.gy + item.height <= 30 + 1e-9
  );
}

model.move(item, -100, 100, grid);
assert.ok(item.gx >= 0 && item.gy + item.height <= 30 + 1e-9);
const path = model.segments(item)[0];
assert.strictEqual(path.kind, "image");
assert.strictEqual(path.points[0].gx, item.gx);
assert.strictEqual(path.points[2].gy, item.gy + item.height);
assert.strictEqual(JSON.stringify(payload.paths), unchanged, "normalised paths stay immutable");

assert.throws(() => model.create({
  ...payload,
  paths: [[[0, 0], [Infinity, 0]]]
}, grid));

assert.throws(() => model.create({
  ...payload,
  paths: []
}, grid));

console.log(
  "Image sticker geometry passed: bounds, four anchored corners, aspect ratio, execution coordinates, and immutable vectors."
);
