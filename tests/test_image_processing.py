import base64
import importlib.util
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

import cv2
import numpy as np
from flask import Flask

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
import drawing_image_processing as images
spec = importlib.util.spec_from_file_location('drawing_test_backend', ROOT / 'backend/main.py')
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)


class ProcessingTests(unittest.TestCase):
    def setUp(self):
        images.SESSIONS.clear(); images.ACTIVE = None
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.file = Path(self.temp.name) / 'shape.png'
        image = np.full((120, 180, 3), 255, np.uint8)
        cv2.rectangle(image, (25, 25), (150, 95), (0, 0, 0), 3)
        cv2.imwrite(str(self.file), image)
        self.token = images.upload(str(self.file))['token']

    def steps(self):
        return [{'op': 'color', 'params': {'from': 'BGR', 'to': 'GRAY'}},
                {'op': 'gaussian', 'params': {'size': 3}},
                {'op': 'gaussian', 'params': {'size': 3}},
                {'op': 'contours', 'params': {}}]

    def test_pipeline_duplicate_operations_normalized_paths_and_commit(self):
        result = images.process(self.token, self.steps())
        self.assertTrue(result['canAdd']); self.assertTrue(result['preview'].startswith('data:image/png;'))
        for path in result['paths']:
            self.assertEqual(path[0], path[-1])
            self.assertTrue(all(0 <= v <= 1 for p in path for v in p))
        images.commit(self.token, result['revision'])
        payload = images.status(self.token)['sticker']
        self.assertEqual(payload['aspect'], 1.5)
        self.assertEqual(payload['paths'], result['paths'])
        self.assertEqual(payload['steps'], self.steps())

    def test_terminal_gate_stale_and_failed_results_cannot_commit(self):
        raw = images.process(self.token, [])
        self.assertFalse(raw['canAdd'])
        with self.assertRaises(ValueError): images.commit(self.token, raw['revision'])
        valid = images.process(self.token, self.steps())
        for steps in [[{'op': 'contours'}, {'op': 'invert'}], [{'op': 'gaussian', 'params': {'size': 4}}], None]:
            with self.assertRaises(ValueError): images.process(self.token, steps)
            with self.assertRaises(ValueError): images.commit(self.token, valid['revision'])
        valid = images.process(self.token, self.steps())
        changed = images.process(self.token, [{'op': 'invert'}, {'op': 'contours'}])
        self.assertNotEqual(valid['revision'], changed['revision'])
        with self.assertRaises(ValueError): images.commit(self.token, valid['revision'])

    def test_empty_paths_parameters_and_color_state(self):
        white = np.full((80, 80, 3), 255, np.uint8)
        cv2.imwrite(str(self.file), white)
        token = images.upload(str(self.file))['token']
        self.assertFalse(images.process(token, [{'op': 'contours'}])['canAdd'])
        with self.assertRaisesRegex(ValueError, 'current color space'):
            images.process(token, [{'op': 'color'}, {'op': 'color'}])
        with self.assertRaises(ValueError): images.process(token, [{'op': 'resize', 'params': {'width': 4096, 'height': 4096, 'keepRatio': False}}])

    def test_common_operations_manual_parameters_and_color_constants(self):
        for step in [
            {'op':'resize','params':{'width':100,'height':100}}, {'op':'median'}, {'op':'threshold'},
            {'op':'adaptive'}, {'op':'canny'}, {'op':'morphology'}, {'op':'contrast'}, {'op':'rotate'}, {'op':'flip'},
            {'op':'manual','params':{'function':'cv2.GaussianBlur','kwargs':'{"ksize":[3,3],"sigmaX":0}'}},
            {'op':'manual','params':{'function':'cv2.cvtColor','kwargs':{'code':'cv2.COLOR_BGR2Lab'}}},
            {'op':'manual','params':{'function':'cv2.normalize','kwargs':{'alpha':0,'beta':255,'norm_type':'cv2.NORM_MINMAX'}}},
        ]:
            self.assertTrue(images.process(self.token, [step])['preview'])
        result = images.process(self.token, [{'op':'manual','params':{'function':'cv2.cvtColor','kwargs':{'code':'cv2.COLOR_BGR2HSV'}}}])
        self.assertEqual(result['space'], 'HSV')
        with self.assertRaisesRegex(ValueError, 'Choose a conversion'):
            images.process(self.token, [{'op':'manual','params':{'function':'cv2.cvtColor','kwargs':{'code':'cv2.COLOR_BGR2YUV'}}}])
        for function in ['imwrite', 'VideoCapture', '__import__', 'os.system']:
            with self.assertRaises(ValueError): images.process(self.token,[{'op':'manual','params':{'function':function}}])
        with self.assertRaises(ValueError): images.process(self.token,[{'op':'manual','params':{'function':'blur','kwargs':'not JSON'}}])

    def test_resize_original_immutable_transparency_and_decode_errors(self):
        original = images.session(self.token)['image'].copy()
        result = images.process(self.token,[{'op':'resize','params':{'width':90,'height':60}}])
        self.assertEqual((result['width'],result['height']),(90,60))
        np.testing.assert_array_equal(original, images.session(self.token)['image'])
        alpha=np.zeros((10,10,4),np.uint8);cv2.imwrite(str(self.file),alpha)
        token=images.upload(str(self.file))['token']
        self.assertTrue((images.session(token)['image']==255).all())
        self.file.write_text('broken')
        with self.assertRaises(ValueError):images.upload(str(self.file))

    def test_newer_request_and_cancellation_supersede_old_processing(self):
        start, release=threading.Event(),threading.Event(); errors=[]
        original=images.apply
        def slow(image,space,step):
            if step.get('op')=='invert':start.set();release.wait(2)
            return original(image,space,step)
        def run():
            try:images.process(self.token,[{'op':'invert'},{'op':'contours'}])
            except ValueError as exc:errors.append(str(exc))
        with mock.patch.object(images,'apply',side_effect=slow):
            thread=threading.Thread(target=run);thread.start();self.assertTrue(start.wait(2))
            current=images.process(self.token,self.steps());release.set();thread.join(3)
        self.assertFalse(thread.is_alive());self.assertTrue(errors)
        self.assertEqual(images.session(self.token)['result']['revision'],current['revision'])
        images.cancel(self.token)
        with self.assertRaises(ValueError):images.commit(self.token,current['revision'])

    def test_intermediate_previews_leave_full_result_and_commit_unchanged(self):
        final = images.process(self.token, self.steps())
        ticket = images.session(self.token)['ticket']
        original = images.preview_steps(self.token, [])
        inverted = images.preview_steps(self.token, [{'op': 'invert'}])
        decode = lambda result: cv2.imdecode(np.frombuffer(base64.b64decode(result['preview'].split(',')[1]), np.uint8), cv2.IMREAD_COLOR)
        np.testing.assert_array_equal(decode(inverted), 255 - decode(original))
        self.assertIsNone(inverted['paths'])
        self.assertNotIn('revision', inverted)
        self.assertNotIn('canAdd', inverted)
        resized = images.preview_steps(self.token, [{'op': 'resize', 'params': {'width': 90, 'height': 60}}])
        self.assertEqual((resized['width'], resized['height']), (90, 60))
        path_preview = images.preview_steps(self.token, self.steps())
        self.assertEqual(path_preview['paths'], final['paths'])
        with self.assertRaises(ValueError):
            images.preview_steps(self.token, [{'op': 'gaussian', 'params': {'size': 4}}])
        self.assertEqual(images.session(self.token)['ticket'], ticket)
        self.assertIs(images.session(self.token)['result'], final)
        images.commit(self.token, final['revision'])
        self.assertEqual(images.status(self.token)['sticker']['paths'], final['paths'])

    def test_inspecting_valid_prefix_does_not_make_invalid_pipeline_addable(self):
        with self.assertRaises(ValueError):
            images.process(self.token, [{'op': 'contours'}, {'op': 'invert'}])
        self.assertTrue(images.preview_steps(self.token, [{'op': 'contours'}])['paths'])
        self.assertIsNone(images.session(self.token)['result'])
        with self.assertRaises(ValueError):
            images.commit(self.token, None)

    def test_intermediate_request_does_not_supersede_running_full_pipeline(self):
        start, release = threading.Event(), threading.Event()
        results, errors = [], []
        original = images.apply
        def slow(image, space, step):
            if step.get('op') == 'invert':
                start.set(); release.wait(2)
            return original(image, space, step)
        def run():
            try: results.append(images.process(self.token, [{'op': 'invert'}, {'op': 'contours'}]))
            except Exception as exc: errors.append(exc)
        with mock.patch.object(images, 'apply', side_effect=slow):
            thread = threading.Thread(target=run)
            thread.start()
            try:
                self.assertTrue(start.wait(2))
                self.assertTrue(images.preview_steps(self.token, [{'op': 'color'}])['preview'])
            finally:
                release.set(); thread.join(3)
        self.assertFalse(thread.is_alive())
        self.assertFalse(errors)
        self.assertTrue(results[0]['canAdd'])
        self.assertIs(images.session(self.token)['result'], results[0])

    def test_http_routes_and_session_isolation(self):
        app=Flask(__name__);app.register_blueprint(backend.blueprint,url_prefix='/ext/drawing')
        client=app.test_client();base='/ext/drawing'
        self.assertEqual(client.get(base+'/images/active').json['token'],self.token)
        self.assertNotIn('preview',client.get(base+'/images/active?known='+self.token).json)
        self.assertEqual(client.post(base+'/images/'+self.token+'/commit',json={'revision':'bad'}).status_code,409)
        result=client.post(base+'/images/'+self.token+'/process',json={'steps':self.steps()}).json
        self.assertTrue(result['success'])
        preview=client.post(base+'/images/'+self.token+'/preview',json={'steps':[{'op':'invert'}]})
        self.assertEqual(preview.status_code,200)
        self.assertNotIn('revision',preview.json)
        self.assertEqual(client.post(base+'/images/'+self.token+'/preview',json={'steps':None}).status_code,400)
        self.assertEqual(client.post(base+'/images/'+self.token+'/commit',json={'revision':result['revision']}).status_code,200)
        self.assertEqual(client.get(base+'/images/'+self.token+'/status').json['status'],'accepted')
        self.assertEqual(client.get(base+'/images/not-a-session/status').status_code,404)
        self.assertTrue(client.get(base+'/charsets').json['success'])


if __name__ == '__main__':unittest.main()
