// Run with StudioX's Electron. Uses a real local OpenCV/Flask backend, no robot.
const {
  app,
  BrowserWindow,
  ipcMain
} = require("electron");

const fs = require("fs"),
      path = require("path"),
      os = require("os"),
      assert = require("assert"),
      {
        spawn
      } = require("child_process"),
      {
        pathToFileURL
      } = require("url");

const root = path.resolve(__dirname, ".."), temp = fs.mkdtempSync(path.join(os.tmpdir(), "studiox-drawing-images-"));
const host = path.resolve(root, "../blockly");
app.setPath("userData", path.join(temp, "profile"));
const python = process.env.DRAWING_TEST_PYTHON || path.join(host, "resources/python/bin/python3.12");
let server, parent, child, selection = null, pickers = 0;
const errors = [];
const url = p => pathToFileURL(p).href;

function run(win, source) {
  return win.webContents.executeJavaScript(source);
}

async function wait(win, source) {
  for (let i = 0; i < 250; i++) {
    if (win.isDestroyed())
      throw Error("Window closed: " + source);

    if (!win.webContents.isLoading() && (await run(win, source)))
      return;

    await new Promise(r => setTimeout(r, 30));
  }

  throw Error("Timed out: " + source);
}

async function pressPreview(selector, key = ' ') {
  await run(child, `var previewButton=document.querySelector(${JSON.stringify(selector)});previewButton.focus();previewButton.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true}));`);
}

async function releasePreview(selector, key = ' ') {
  await run(child, `document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new KeyboardEvent('keyup',{key:${JSON.stringify(key)},bubbles:true}));`);
  await wait(child, "document.getElementById('image-preview-label').textContent==='Final result'");
}

async function waitForPreview(label) {
  await wait(child, `document.getElementById('image-preview-label').textContent.includes(${JSON.stringify(label)}) && !document.getElementById('image-preview-label').textContent.includes('Loading') && document.getElementById('image-preview-label').dataset.error==='false'`);
}

function previewPixels() {
  return run(child, "document.getElementById('image-preview').toDataURL()");
}

app.whenReady().then(async () => {
  try {
    server = spawn(
      python,
      ["-B", path.join(root, "tests/image_fixture_server.py"), path.join(temp, "rectangle.png")],
      {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    let stderr = "";
    server.stderr.on("data", d => stderr += d.toString());

    const info = await new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(Error("Backend startup timed out: " + stderr)), 10000);

      server.stdout.on("data", d => {
        output += d;
        const line = output.split("\n")[0];

        try {
          const data = JSON.parse(line);
          clearTimeout(timer);
          resolve(data);
        } catch (_) {}
      });

      server.on("exit", () => {
        clearTimeout(timer);
        reject(Error("Backend exited: " + stderr));
      });
    });

    ipcMain.handle("dialog:openFile", (_event, options) => {
      pickers++;
      assert.strictEqual(options.title, "Select an image to draw");
      assert.ok(options.filters[0].extensions.includes("png"));
      return selection;
    });

    ipcMain.handle("extensions:openWindow", async (_event, name) => {
      assert.strictEqual(name, "drawing");

      if (child && !child.isDestroyed()) {
        child.focus();

        return {
          success: true
        };
      }

      const settings = {
        title: "Drawing · Image processing",
        basePath: root,
        html: "frontend/image-window.html",
        js: "frontend/image-window.js",
        css: "frontend/image-window.css",
        serverPort: String(info.port),
        extensionName: "drawing"
      };

      child = new BrowserWindow({
        show: false,
        width: 960,
        height: 640,

        webPreferences: {
          nodeIntegration: true,
          contextIsolation: false,
          additionalArguments: ["--studiox-extension-window=" + encodeURIComponent(JSON.stringify(settings))]
        }
      });

      child.webContents.on("console-message", event => {
        if (event.level === "error")
          errors.push(event.message);
      });

      await child.loadFile(path.join(host, "extension-window.html"));

      return {
        success: true
      };
    });

    parent = new BrowserWindow({
      show: false,
      width: 1400,
      height: 1000,

      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    });

    parent.webContents.on("console-message", event => {
      if (event.level === "error")
        errors.push(event.message);
    });

    const html = `<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="${url(path.join(root, "frontend/tab.css"))}"><style>html,body{height:100%;margin:0;font-family:system-ui}</style></head><body>${fs.readFileSync(path.join(root, "frontend/tab.html"), "utf8")}
  <script>window.getServerUrl=()=>${JSON.stringify("http://127.0.0.1:" + info.port)};</script><script src="${url(path.join(host, "js/extensions/extensionAPI.js"))}"></script>
  <script>window.commands=[];window.notifications=[];const originalFetch=window.fetch.bind(window);window.fetch=(url,options)=>{if(String(url).includes('/cmd/jog')){commands.push(JSON.parse(options.body));return Promise.resolve({ok:true,json:async()=>({success:true})});}return originalFetch(url,options);};
  ExtensionAPI.getDevices=async()=>({success:true,ports:[{model:'Test arm',port:'VirtualMirobot',connected:true}]});ExtensionAPI.getRobotStatus=async()=>({success:true,state:'Idle'});ExtensionAPI.showNotification=message=>notifications.push(message);
  ExtensionAPI.getData=(name,key)=>key==='calibration'?{tl:{x:0,y:0,z:0},tr:{x:100,y:0,z:0},br:{x:100,y:100,z:0}}:null;</script>
  <script src="${url(path.join(root, "frontend/tab.js"))}"></script></body></html>`;

    fs.writeFileSync(path.join(temp, "parent.html"), html);
    await parent.loadFile(path.join(temp, "parent.html"));

    await wait(
      parent,
      "window.DrawingImageStickers && document.getElementById('drawing-canvas').width>0 && !document.getElementById('drawing-upload-image').disabled"
    );

    await run(parent, "document.getElementById('drawing-upload-image').click()");
    await new Promise(r => setTimeout(r, 150));
    assert.strictEqual(pickers, 1);
    assert.ok(!child);
    selection = info.path;
    await run(parent, "document.getElementById('drawing-upload-image').click()");

    for (let i = 0; i < 150 && !child; i++)
      await new Promise(r => setTimeout(r, 30));

    assert.ok(child);
    await wait(child, "document.getElementById('image-source').textContent.includes('rectangle.png')");
    assert.strictEqual(await run(child, "document.getElementById('image-add').disabled"), true);

    await run(
      child,
      "document.querySelector('[data-op=color]').click();document.querySelector('[data-op=gaussian]').click();document.querySelector('[data-op=gaussian]').click()"
    );

    assert.strictEqual(await run(child, "document.querySelectorAll('.image-step').length"), 3);
    await wait(child, "document.getElementById('image-status').textContent.includes('GRAY')");

    await run(
      child,
      "var kernel=document.querySelectorAll('.image-step')[1].querySelector('[data-param=size]');kernel.value=4;kernel.dispatchEvent(new Event('input'))"
    );

    await wait(child, "document.getElementById('image-status').dataset.error==='true'");
    assert.strictEqual(await run(child, "document.getElementById('image-add').disabled"), true);
    await pressPreview('.image-step:nth-child(1) .image-step-preview');
    await waitForPreview('After step 1: Convert color');
    assert.strictEqual(await run(child, "document.getElementById('image-status').dataset.error"), 'true', 'inspecting an earlier step preserves the later pipeline error');
    await releasePreview('.image-step:nth-child(1) .image-step-preview');
    assert.strictEqual(await run(child, "document.getElementById('image-add').disabled"), true);
    await run(child, "kernel.value=3;kernel.dispatchEvent(new Event('input'))");
    await wait(child, "document.getElementById('image-status').dataset.error==='false'");
    const ids = await run(child, "Array.from(document.querySelectorAll('.image-step')).map(el=>el.dataset.stepId)");

    await run(
      child,
      "document.querySelectorAll('.image-step')[2].querySelector('button[title=\"Move up\"]').click()"
    );

    assert.deepStrictEqual(
      await run(child, "Array.from(document.querySelectorAll('.image-step')).map(el=>el.dataset.stepId)"),
      [ids[0], ids[2], ids[1]]
    );

    await run(
      child,
      "document.querySelectorAll('.image-step')[1].querySelector('button[title=\"Remove step\"]').click();document.querySelector('[data-op=resize]').click()"
    );

    await run(
      child,
      "var fields=document.querySelectorAll('.image-step')[2];for(const [key,value] of [['width',80],['height',60]]){var input=fields.querySelector('[data-param='+key+']');input.value=value;input.dispatchEvent(new Event('input'));}document.querySelector('[data-op=manual]').click()"
    );

    await run(
      child,
      "var manual=document.querySelectorAll('.image-step')[3];var fn=manual.querySelector('[data-param=function]');fn.value='cv2.bitwise_not';fn.dispatchEvent(new Event('input'));var kwargs=manual.querySelector('[data-param=kwargs]');kwargs.value='{}';kwargs.dispatchEvent(new Event('input'))"
    );

    await wait(
      child,
      "document.getElementById('image-status').dataset.error==='false' && document.getElementById('image-status').textContent.includes('Image preview')"
    );

    assert.strictEqual(await run(child, "document.getElementById('image-add').disabled"), true);
    await run(child, "document.querySelector('[data-op=contours]').click()");
    await wait(child, "!document.getElementById('image-add').disabled");
    await run(child, "document.querySelector('[data-op=invert]').click()");
    await wait(child, "document.getElementById('image-status').dataset.error==='true'");
    assert.strictEqual(await run(child, "document.getElementById('image-add').disabled"), true);
    await run(child, "document.querySelector('.image-terminal button[title=\"Move down\"]').click()");
    await wait(child, "!document.getElementById('image-add').disabled");
    const finalPixels = await previewPixels();
    await pressPreview('.image-step:nth-child(4) .image-step-preview');
    await waitForPreview('After step 4: Manual OpenCV function');
    assert.ok(await previewPixels() !== finalPixels, 'intermediate output differs from the final paths');
    assert.strictEqual(await run(child, "document.getElementById('image-preview').getContext('2d').getImageData(0,0,1,1).data[0]"), 0, 'the intermediate invert produces a black background');
    assert.strictEqual(await run(child, "document.getElementById('image-add').disabled"), false, 'inspecting a step preserves final path validity');
    await child.webContents.capturePage().then(image => fs.writeFileSync('/private/tmp/studiox-drawing-step-preview.png', image.toPNG()));
    await releasePreview('.image-step:nth-child(4) .image-step-preview');
    assert.ok(await previewPixels() === finalPixels, 'release restores the final path preview');

    await pressPreview('#image-original', 'Enter');
    await waitForPreview('Original image · 160 × 120');
    assert.ok(await previewPixels() !== finalPixels, 'original preview shows the unprocessed image');
    await run(child, "window.dispatchEvent(new Event('blur'))");
    await releasePreview('#image-original', 'Enter');
    assert.ok(await previewPixels() === finalPixels, 'window blur restores the final result');

    // Intermediate frames must use current parameters instead of an older cache.
    for (const [width, height] of [[40, 30], [80, 60]]) {
      await run(child, `for(const [key,value] of [['width',${width}],['height',${height}]]){const input=document.querySelector('.image-step:nth-child(3) [data-param='+key+']');input.value=value;input.dispatchEvent(new Event('input'));}`);
      await pressPreview('.image-step:nth-child(3) .image-step-preview');
      await waitForPreview('After step 3: Resize · ' + width + ' × ' + height);
      await releasePreview('.image-step:nth-child(3) .image-step-preview');
      await wait(child, "!document.getElementById('image-add').disabled");
    }

    const restoredFinal = await previewPixels();
    await run(child, `window.originalPreviewFetch=window.fetch;window.delayedPreviewDone=false;window.fetch=(url,options)=>String(url).endsWith('/preview')?new Promise((resolve,reject)=>{window.releaseStepResponse=()=>originalPreviewFetch(url,options).then(resolve,reject).finally(()=>window.delayedPreviewDone=true);}):originalPreviewFetch(url,options);void 0;`);
    await pressPreview('.image-step:nth-child(2) .image-step-preview');
    await wait(child, "typeof window.releaseStepResponse==='function'");
    await releasePreview('.image-step:nth-child(2) .image-step-preview');
    await run(child, 'window.releaseStepResponse()');
    await wait(child, 'window.delayedPreviewDone');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(await previewPixels() === restoredFinal, 'late intermediate responses cannot replace the restored final result');
    await run(child, 'window.fetch=window.originalPreviewFetch;void 0');

    const originalButton = await run(child, "(()=>{const r=document.getElementById('image-original').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()");
    child.webContents.sendInputEvent({type:'mouseDown',...originalButton,button:'left',clickCount:1});
    await waitForPreview('Original image');
    child.webContents.sendInputEvent({type:'mouseMove',x:10,y:10});
    child.webContents.sendInputEvent({type:'mouseUp',x:10,y:10,button:'left',clickCount:1});
    await wait(child, "document.getElementById('image-preview-label').textContent==='Final result'");
    assert.ok(await previewPixels() === restoredFinal, 'releasing outside the held button restores the final result');

    await child.webContents.capturePage().then(image => fs.writeFileSync("/private/tmp/studiox-drawing-image-window.png", image.toPNG()));
    assert.strictEqual(await run(parent, "commands.length"), 0, "preparing images must not touch hardware");
    await run(child, "document.getElementById('image-add').click()");
    await wait(parent, "document.querySelectorAll('.drawing-image-item').length===1");

    const box = () => run(
      parent,
      "(()=>{const r=document.querySelector('.drawing-image-item').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};})()"
    );

    const initial = await box();

    await run(
      parent,
      `document.querySelector('.drawing-image-item').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,clientX:${initial.x + 10},clientY:${initial.y + 10}}));document.dispatchEvent(new MouseEvent('mousemove',{clientX:${initial.x + 30},clientY:${initial.y + 20}}));document.dispatchEvent(new MouseEvent('mouseup'));`
    );

    assert.ok((await box()).x > initial.x);
    await run(parent, "document.getElementById('drawing-undo').click()");
    assert.ok(Math.abs((await box()).x - initial.x) < .01);
    await run(parent, "document.querySelector('.drawing-image-item').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));document.dispatchEvent(new MouseEvent('mouseup'))");

    await run(
      parent,
      `document.querySelector('.drawing-image-handle.se').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,clientX:${initial.x + initial.w},clientY:${initial.y + initial.h}}));document.dispatchEvent(new MouseEvent('mousemove',{clientX:${initial.x + initial.w + 30},clientY:${initial.y + initial.h + 30}}));document.dispatchEvent(new MouseEvent('mouseup'));`
    );

    const resized = await box();
    assert.ok(resized.w > initial.w);
    assert.ok(Math.abs(resized.w / resized.h - initial.w / initial.h) < .001);

    await run(
      parent,
      "document.getElementById('drawing-undo').click();document.getElementById('drawing-remove-image').click()"
    );

    // Undo deselects; select the item first to remove it.
    await run(
      parent,
      "var item=document.querySelector('.drawing-image-item');item.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));document.dispatchEvent(new MouseEvent('mouseup'));document.getElementById('drawing-remove-image').click()"
    );

    assert.strictEqual(await run(parent, "document.querySelectorAll('.drawing-image-item').length"), 0);
    await run(parent, "document.getElementById('drawing-undo').click()");
    assert.strictEqual(await run(parent, "document.querySelectorAll('.drawing-image-item').length"), 1);
    await run(parent, "document.getElementById('drawing-clear').click()");
    assert.strictEqual(await run(parent, "document.querySelectorAll('.drawing-image-item').length"), 0);

    await run(
      parent,
      "document.getElementById('drawing-undo').click();var select=document.getElementById('drawing-device-select');select.value='VirtualMirobot';select.dispatchEvent(new Event('change'))"
    );

    const moveCount = await run(parent, "parseInt(document.getElementById('drawing-move-count').textContent)");
    assert.ok(moveCount > 0);

    assert.strictEqual(
      await run(parent, "document.getElementById('drawing-start').disabled"),
      false,
      "image paths alone can be drawn"
    );

    await parent.webContents.capturePage().then(image => fs.writeFileSync("/private/tmp/studiox-drawing-image-sticker.png", image.toPNG()));

    await run(
      parent,
      "document.getElementById('drawing-start').click();document.getElementById('drawing-modal-confirm').click()"
    );

    await wait(parent, "document.getElementById('drawing-progress').textContent.startsWith('Done!')");
    assert.strictEqual(await run(parent, `!!document.elementFromPoint(${initial.x + initial.w / 2},${initial.y + initial.h / 2}).closest('.drawing-image-item')`), true, 'image is selectable again after playback');

    assert.strictEqual(
      await run(parent, "commands.length"),
      moveCount,
      "preview point paths are the executed drawing segments"
    );

    assert.strictEqual(await run(
      parent,
      "commands.every(c=>c.values.x>=0&&c.values.x<=100&&c.values.y>=0&&c.values.y<=100&&(c.values.z===0||c.values.z===10))"
    ), true);

    await run(parent, "document.getElementById('drawing-upload-image').click()");

    for (let i = 0; i < 150 && (!child || child.isDestroyed()); i++)
      await new Promise(resolve => setTimeout(resolve, 30));

    await wait(child, "document.getElementById('image-source').textContent.includes('rectangle.png')");
    await run(child, "document.querySelector('[data-op=gaussian]').click()");
    assert.strictEqual(await run(child, "document.querySelectorAll('.image-step').length"), 1);

    // Uploading again focuses the existing window and starts a fresh pipeline.
    const reused = child;

    await run(parent, "document.getElementById('drawing-upload-image').click()");
    await wait(child, "document.querySelectorAll('.image-step').length===0");
    assert.strictEqual(child, reused);
    await run(child, "document.querySelector('[data-op=contours]').click()");
    await wait(child, "!document.getElementById('image-add').disabled");
    await run(child, "document.getElementById('image-add').click()");
    await wait(parent, "document.querySelectorAll('.drawing-image-item').length===2");
    await run(parent, "document.getElementById('drawing-upload-image').click()");

    for (let i = 0; i < 150 && (!child || child.isDestroyed()); i++)
      await new Promise(resolve => setTimeout(resolve, 30));

    await wait(child, "document.getElementById('image-source').textContent.includes('rectangle.png')");
    child.close();

    await wait(
      parent,
      `fetch('http://127.0.0.1:${info.port}/ext/drawing/images/active').then(r=>r.json()).then(d=>d.token===null)`
    );

    assert.strictEqual(await run(parent, "document.querySelectorAll('.drawing-image-item').length"), 2);

    assert.strictEqual(
      await run(parent, "commands.length"),
      moveCount,
      "repeat uploads and cancellation do not move the robot"
    );

    assert.deepStrictEqual(errors, []);

    console.log(
      "Drawing image UI passed: picker cancel/select, separate window, duplicate/reordered filters, editable/manual parameters, stale/error gating, held step/original previews and release handling, final paths, sticker add/move/ratio resize/remove/clear/undo, and calibrated execution."
    );
  } catch (error) {
    console.error(error);
    console.error("Renderer errors", errors);
    process.exitCode = 1;
  } finally {
    if (child && !child.isDestroyed())
      child.destroy();

    if (parent && !parent.isDestroyed())
      parent.destroy();

    if (server)
      server.kill();

    fs.rmSync(temp, {
      recursive: true,
      force: true
    });

    app.exit(process.exitCode || 0);
  }
});
