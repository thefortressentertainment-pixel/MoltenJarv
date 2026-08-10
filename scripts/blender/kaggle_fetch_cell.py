# Kaggle config is done (GPU T4x2 + Internet ON). Paste ALL of this into ONE cell & run.
# It downloads the paint-host notebook from your MoltenJarv GitHub and RUNS it,
# so the HTTP server starts, a free trycloudflare tunnel opens, and the URL prints.
import requests, subprocess, sys
URL = 'https://raw.githubusercontent.com/thefortressentertainment-pixel/MoltenJarv/main/scripts/blender/kaggle_notebook.py'
r = requests.get(URL)
assert r.status_code == 200, 'fetch failed: ' + str(r.status_code)
code = r.text
print('[kaggle-cell] fetched kaggle_notebook.py', len(code), 'chars; executing...')
gw = {}
exec(compile(code, 'kaggle_notebook.py', 'exec'), gw)
