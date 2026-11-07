import importlib.util
import json
import sys
from pathlib import Path
import cv2
import numpy as np
from flask import Flask
from werkzeug.serving import make_server
root=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root/'backend'))
spec=importlib.util.spec_from_file_location('drawing_fixture',root/'backend/main.py')
backend=importlib.util.module_from_spec(spec);spec.loader.exec_module(backend)
image=np.full((120,160,3),255,np.uint8);cv2.rectangle(image,(20,20),(140,100),(0,0,0),3)
cv2.imwrite(sys.argv[1],image)
app=Flask(__name__);app.register_blueprint(backend.blueprint,url_prefix='/ext/drawing')
server=make_server('127.0.0.1',0,app,threaded=True)
print(json.dumps({'port':server.server_port,'path':sys.argv[1]}),flush=True)
server.serve_forever()
