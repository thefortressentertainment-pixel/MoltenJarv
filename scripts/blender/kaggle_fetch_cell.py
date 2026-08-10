# Kaggle: paste this ENTIRE cell, and run it. GPU T4x2 + Internet ON already set.
import time, requests, sys
URL = ('https://raw.githubusercontent.com/thefortressentertainment-pixel/MoltenJarv/'
       'main/scripts/blender/kaggle_notebook.py?v=' + str(int(time.time())))
r = requests.get(URL, headers={'Cache-Control': 'no-cache', 'Pragma': 'no-cache'})
assert r.status_code == 200, 'fetch failed: ' + str(r.status_code)
code = r.text
print('[kaggle-cell] fetched', len(code), 'chars')
# HARD CHECK: must be the fixed build (shim present AND build_ext --inplace).
ok1 = 'creating a shim' in code or 'python3-config shim' in code
ok2 = 'build_ext --inplace' in code
ok3 = '_s2.modules["bpy"] = _stub' in code or 'ModuleType("bpy")' in code
print('[kaggle-cell] shim:', ok1, '| build_ext:', ok2, '| bpy-stub:', ok3)
if not (ok1 and ok2):
    print('[kaggle-cell] STALE — fetch did not get the fixed build. Restart kernel & Run All to re-fetch.')
else:
    print('[kaggle-cell] OK: fixed notebook (bpy stub present:', ok3, '). Executing...')
    exec(compile(code, 'kaggle_notebook.py', 'exec'), {})
