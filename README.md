# WLKATA StudioX Drawing

Draw freehand, write text, or turn an image into vector paths, then replay the drawing on a calibrated WLKATA arm.

## Setup

Install this folder through StudioX Settings → Extensions. Run Setup (Re-setup for an existing installation) to install OpenCV and NumPy in Drawing's environment, then restart StudioX. Flask is supplied by StudioX.

Image preparation uses a separate extension window. It requires the StudioX host change that provides the `extensions:openWindow` command.

## Image to drawing

1. Click **Upload image** in Drawing and choose one image in the file picker. Cancelling leaves the canvas unchanged.
2. In the image window, click a function to append it to **Processing order**. The preview runs the entire list against the original image. Filters can appear more than once.
3. Edit each step's parameters. Use the arrows to reorder steps and × to remove one. The preview updates automatically. Press and hold **Hold to preview** on any step to see the image after that step and all preceding steps, or **Hold original** to compare with the uploaded image. Release to restore the final result. These buttons also work by holding Space or Enter while focused. Intermediate inspection does not change the pipeline or which paths are added to the canvas.
4. Finish with **Convert to paths**. It must be the last step. Adjust the foreground, contour mode, threshold, minimum area/length, and approximation to get suitable outlines. For edge images, use the nonzero foreground mode. Solid lines show pen-down paths; dashed blue lines show travel with the pen lifted. The processed image can be shown behind the paths.
5. Click **Add to canvas**. This is available only after the latest pipeline successfully produces non-empty paths. Closing the window cancels preparation.
6. Drag the added image to move it. Select it and drag any corner to resize while keeping its aspect ratio. Items stay inside the drawing area. Remove image deletes the selected item; Undo restores additions, movement, resizing, removal, and Clear.
7. Select a robot, calibrate the paper corners, and use **Start Drawing**. Image paths use the same calibration and pen lifts as freehand/text. Image preparation itself sends no robot commands.

The original file is never modified. PNG, JPEG, BMP, WebP, and TIFF are supported. Files must be under 20 MB and at most 16 megapixels. Large sources are reduced to a working image of at most 2048 pixels per edge. Preparation sessions and canvas items are kept in memory for the current app session.

## Functions

Common controls cover color conversion, resize, Gaussian/median blur, threshold, adaptive threshold, Canny edges, invert, morphology, brightness/contrast, rotate, and flip.

**Manual OpenCV function** accepts an image-processing function name and JSON keyword parameters. The current image is supplied as the first argument. The suggestions list contains the supported functions; file, camera, GUI, and arbitrary Python commands are excluded.

Examples:

| Function | Parameters (JSON) |
| --- | --- |
| `cv2.GaussianBlur` | `{"ksize":[5,5],"sigmaX":0}` |
| `cv2.bilateralFilter` | `{"d":9,"sigmaColor":75,"sigmaSpace":75}` |
| `cv2.cvtColor` | `{"code":"cv2.COLOR_BGR2GRAY"}` |
| `cv2.threshold` | `{"thresh":127,"maxval":255,"type":"cv2.THRESH_BINARY_INV"}` |
| `cv2.normalize` | `{"alpha":0,"beta":255,"norm_type":"cv2.NORM_MINMAX"}` |

Choose a color conversion that matches the current image space. Grayscale-only functions need a preceding grayscale conversion. Integer OpenCV constants are strings such as `"cv2.COLOR_BGR2GRAY"`; kernel matrices are JSON arrays. Invalid parameters identify the failing step and disable Add until corrected.

The final conversion uses OpenCV contours and polygon approximation, the same general approach used in the [WLKATA AI Drawing reference](https://github.com/wlkata/WLKATA-AI-Drawing-Extension/blob/main/src/wlkatapython_extensions/drawing/drawing.py). This produces outlines, rather than a filled image or automatic centerline tracing. The accepted vector vertices feed both the canvas and drawing playback; the freehand/text slope allowance does not simplify them again.

## Tests

With Flask, NumPy, and OpenCV available in the test Python environment:

```sh
python -B -m unittest discover -s tests -p 'test_*.py'
node tests/test_image_stickers.js
```

For the full Electron workflow, place this repository beside the StudioX `blockly` checkout and run its Electron binary with `tests/test_images.cjs`. `DRAWING_TEST_PYTHON` can override the fixture server's Python executable. The test uses a temporary profile, an image fixture, and simulated robot commands; it covers the file picker, separate processing window, filter edits/reordering, held step/original previews and delayed responses, path validation, canvas operations, Undo, and calibrated playback. It does not require a connected arm.
