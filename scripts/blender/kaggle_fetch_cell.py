# Kaggle config: GPU T4x2 + Internet ON. Paste this WHOLE cell and run it.
# It downloads the LATEST paint-host notebook from your MoltenJarv GitHub
# (with a cache-buster so it's never stale) and runs it.
import time, requests, sys
URL = ('https://raw.githubusercontent.com/thefortressentertainment-pixel/MoltenJarv/'
       'main/scripts/blender/kaggle_notebook.py?v=' + str(int(time.time())))
r = requests.get(URL, headers={'Cache-Control': 'no-cache', 'Pragma': 'no-cache'})
assert r.status_code == 200, 'fetch failed: ' + str(r.status_code)
code = r.text
print('[kaggle-cell] fetched', len(code), 'chars')
# SELF-CHECK: confirm this is the FIXED build (must contain the shim marker).
if 'python3-config shim' not in code and 'creating a shim' not in code:
    print('[kaggle-cell] WARNING: fetched notebook does NOT contain the python3-config fix.')
    print('[kaggle-cell] This old build will NOT compile the rasterizer. Check internet/GitHub.')
else:
    print('[kaggle-cell] OK: fixed notebook (python3-config shim present).')
exec(compile(code, 'kaggle_notebook.py', 'exec'), {})
