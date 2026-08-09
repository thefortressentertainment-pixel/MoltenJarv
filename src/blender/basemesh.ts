/**
 * `bpy_base_mesh` — a real-topology base humanoid for reference-driven builds.
 *
 * WHY: Jarv's default is to assemble a character from disconnected primitives
 * (Torso + Head + L_UpperArm + ...), which reads as a cluster even when colored.
 * This instead builds ONE coherent low-poly humanoid (head, neck, torso, pelvis,
 * shoulders, both arms + hands, both legs + feet) from proportioned primitives
 * joined into a single smooth mesh. It's a genuinely better SILHOUETTE STARTING
 * POINT (real limb junctions, tapered limbs, smooth subsurf) than N scattered
 * boxes — so a reference like "green orc with tusks" becomes "load Base_Humanoid,
 * color it green, add/conform tusks + snout, exaggerate the shoulders" rather
 * than "rebuild a biped from parts".
 *
 * Generated in-engine via bpy (no external asset, no license/GPIO deps) and runs
 * through the same live bridge as bpy_exec — RAM-light (one joined mesh). The
 * builder then shades/sculpts/poses it by name. Apache/MIT-clean (our own code).
 */

/** The bpy snippet that produces `Base_Humanoid`. Additive: it never deletes
 *  existing user objects; it only adds the base body and names it. */
export const BASE_HUMANOID_SNIPPET = [
  `import bpy, math`,
  `# Build a low-poly base humanoid as ONE joined smooth mesh (origin ~ feet at Z=0).`,
  `base = bpy.data.objects.get('Base_Humanoid')`,
  `if base is None:`,
  `    _gen = lambda kind, loc, sc, name, rot=(0,0,0): None`,
  `    def _body():`,
  `        def _prim(kind, loc, sc, name, rot=(0,0,0)):`,
  `            if kind == 'sphere':`,
  `                bpy.ops.mesh.primitive_uv_sphere_add(segments=24, ring_count=12, location=loc, scale=sc)`,
  `            elif kind == 'cyl':`,
  `                bpy.ops.mesh.primitive_cylinder_add(vertices=12, radius=1, depth=2, location=loc, rotation=rot, scale=sc)`,
  `            else:`,
  `                bpy.ops.mesh.primitive_cube_add(location=loc, scale=sc)`,
  `            o = bpy.context.active_object; o.name = name; return o`,
  `        _prim('sphere',(0,0,1.72),(0.13,0.13,0.17),'Head')`,
  `        _prim('cyl',(0,0,1.50),(0.06,0.06,0.06),'Neck',(math.radians(90),0,0))`,
  `        _prim('cube',(0,0,1.05),(0.22,0.12,0.30),'Torso')`,
  `        _prim('cube',(0,0,0.80),(0.18,0.11,0.12),'Pelvis')`,
  `        _prim('sphere',(0.24,0,1.32),(0.09,0.07,0.08),'ShoulderL')`,
  `        _prim('sphere',(-0.24,0,1.32),(0.09,0.07,0.08),'ShoulderR')`,
  `        for side in ('L','R'):`,
  `            s = 1 if side=='L' else -1`,
  `            _prim('cyl',(s*0.28,0,1.15),(0.055,0.055,0.16),f'UpperArm{side}',(math.radians(88),0,0))`,
  `            _prim('cyl',(s*0.30,0,0.90),(0.045,0.045,0.13),f'Forearm{side}',(math.radians(88),0,0))`,
  `            _prim('sphere',(s*0.31,0,0.73),(0.04,0.03,0.05),f'Hand{side}')`,
  `            _prim('cyl',(s*0.09,0,0.48),(0.07,0.07,0.20),f'Thigh{side}')`,
  `            _prim('cyl',(s*0.09,0,0.22),(0.055,0.055,0.18),f'Calf{side}')`,
  `            _prim('cube',(s*0.09,-0.01,0.05),(0.08,0.055,0.05),f'Foot{side}')`,
  `    _body()`,
  `    bpy.ops.object.select_all(action='SELECT')`,
  `    meshes = [o for o in bpy.context.selected_objects if o.type=='MESH']`,
  `    for o in meshes:`,
  `        o.select_set(True)`,
  `    if meshes:`,
  `        bpy.context.view_layer.objects.active = meshes[0]`,
  `        bpy.ops.object.join()`,
  `        bpy.context.active_object.name = 'Base_Humanoid'`,
  `        bpy.ops.object.shade_smooth()`,
  `        bpy.ops.object.modifier_add(type='SUBSURF')`,
  `        bpy.context.active_object.modifiers[-1].levels = 1`,
  `    print('BASE_READY Base_Humanoid')`,
].join('\n');
