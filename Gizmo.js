// AdvancedGizmoPlugin_v3.js
// Plugin "Gizmo+" for SculptGL modular plugins (constructor(api) + init()).
//
// Fixes vs v2:
// - Keeps gizmo visual/picking logic intact (no _updateMatrices patch) to avoid breaking viewport navigation.
// - Patches Gizmo edit math so that Mode/Space chosen in the plugin matches how the mesh is actually transformed.
//   * Mode: Move / Rotate / Scale / Universal (controls gizmo pickables)
//   * Space: Global / Local / Surface Normal (affects transform axes/orientation)
//   * Axis locks: X/Y/Z (controls which axes are available)
//
// Notes:
// - Self-contained (no imports). It relies on existing SculptGL internals (Transform tool + Gizmo).
// - "Surface Normal" uses the picked normal under the cursor when the drag starts.
//   If no normal is available, it falls back to Global.

export default class AdvancedGizmoPlugin {
  constructor(api) {
    this.api = api;

    this.mode = 'Universal'; // Universal | Move | Rotate | Scale
    this.space = 'Global';   // Global | Local | Normal
    this.axis = { x: true, y: true, z: true };

    this._patchedGizmos = new WeakSet();
    this._patchedGizmoProto = false;
  }

  init() {
    // Basic UI (PluginManager currently exposes only addGuiAction)
    if (this.api && this.api.addGuiAction) this._buildButtonUI();

    // Patch prototype once so behavior matches plugin selections
    this._patchGizmoPrototypeOnce();

    // Apply once at init (in case Transform tool already active)
    this._applyToCurrentTool(true);
  }

  // ---------------- UI ----------------

  _buildButtonUI() {
    const add = this.api.addGuiAction.bind(this.api);

    const rerender = () => { try { this.api.render && this.api.render(); } catch (e) {} };

    // Modes
    add('Gizmo+', 'Modo: Universal', () => { this.mode = 'Universal'; this._applyToCurrentTool(true); rerender(); });
    add('Gizmo+', 'Modo: Mover',     () => { this.mode = 'Move';      this._applyToCurrentTool(true); rerender(); });
    add('Gizmo+', 'Modo: Rotar',     () => { this.mode = 'Rotate';    this._applyToCurrentTool(true); rerender(); });
    add('Gizmo+', 'Modo: Escalar',   () => { this.mode = 'Scale';     this._applyToCurrentTool(true); rerender(); });

    // Space
    add('Gizmo+', 'Espacio: Global',            () => { this.space = 'Global'; this._applyToCurrentTool(false); rerender(); });
    add('Gizmo+', 'Espacio: Local',             () => { this.space = 'Local';  this._applyToCurrentTool(false); rerender(); });
    add('Gizmo+', 'Espacio: Normal Superficie', () => { this.space = 'Normal'; this._applyToCurrentTool(false); rerender(); });

    // Axis locks
    add('Gizmo+', `Ejes: X ${this.axis.x ? 'âœ…' : 'âŒ'}`, () => { this.axis.x = !this.axis.x; this._applyToCurrentTool(true); rerender(); });
    add('Gizmo+', `Ejes: Y ${this.axis.y ? 'âœ…' : 'âŒ'}`, () => { this.axis.y = !this.axis.y; this._applyToCurrentTool(true); rerender(); });
    add('Gizmo+', `Ejes: Z ${this.axis.z ? 'âœ…' : 'âŒ'}`, () => { this.axis.z = !this.axis.z; this._applyToCurrentTool(true); rerender(); });

    // Helper to refresh labels without richer UI:
    add('Gizmo+', 'Refrescar UI Gizmo+', () => { /* no-op button for now */ });
  }

  // ---------------- Core ----------------

  _applyToCurrentTool(forcePickables) {
    const main = (this.api.getScene && this.api.getScene()) || this.api.main;
    if (!main || !main.getSculptManager) return;

    const sculpt = main.getSculptManager();
    if (!sculpt || !sculpt.getCurrentTool) return;

    const tool = sculpt.getCurrentTool();
    if (!tool || !tool._gizmo) return;

    const gizmo = tool._gizmo;
    if (!gizmo || typeof gizmo.setActivatedType !== 'function') return;

    // Patch instance once to attach state + keep in sync
    this._patchGizmoInstanceOnce(gizmo);

    // Update state stored on gizmo (used by prototype patches)
    gizmo.__gizmoPlusMode = this.mode;
    gizmo.__gizmoPlusSpace = this.space;
    gizmo.__gizmoPlusAxis = { x: !!this.axis.x, y: !!this.axis.y, z: !!this.axis.z };

    // Update pickables based on mode/axis
    if (forcePickables) {
      const type = this._computeActivatedType(gizmo);
      gizmo.setActivatedType(type);
    }
  }

  _patchGizmoInstanceOnce(gizmo) {
    if (this._patchedGizmos.has(gizmo)) return;
    this._patchedGizmos.add(gizmo);

    // default state
    gizmo.__gizmoPlusMode = this.mode;
    gizmo.__gizmoPlusSpace = this.space;
    gizmo.__gizmoPlusAxis = { x: !!this.axis.x, y: !!this.axis.y, z: !!this.axis.z };

    // cache basis for Local space (computed at drag start)
    gizmo.__gizmoPlusBasis = null; // { x:[..], y:[..], z:[..] } in world space
    gizmo.__gizmoPlusNormal = null; // [..] in world space
  }

  _computeActivatedType(gizmo) {
    const G = gizmo.constructor;

    const onX = !!this.axis.x;
    const onY = !!this.axis.y;
    const onZ = !!this.axis.z;

    const TRANS = (onX ? G.TRANS_X : 0) | (onY ? G.TRANS_Y : 0) | (onZ ? G.TRANS_Z : 0);
    const ROT   = (onX ? G.ROT_X : 0)   | (onY ? G.ROT_Y : 0)   | (onZ ? G.ROT_Z : 0);
    const SCALE = (onX ? G.SCALE_X : 0) | (onY ? G.SCALE_Y : 0) | (onZ ? G.SCALE_Z : 0);

    // Planes depend on the two remaining axes
    const PLANE =
      ((onY && onZ) ? G.PLANE_X : 0) |
      ((onX && onZ) ? G.PLANE_Y : 0) |
      ((onX && onY) ? G.PLANE_Z : 0);

    if (this.mode === 'Move') return TRANS | PLANE;
    if (this.mode === 'Rotate') return ROT | ((onX || onY || onZ) ? G.ROT_W : 0);
    if (this.mode === 'Scale') return SCALE | ((onX || onY || onZ) ? G.SCALE_W : 0);

    // Universal
    const hasAny = (onX || onY || onZ);
    return TRANS | PLANE | ROT | SCALE | (hasAny ? (G.ROT_W | G.SCALE_W) : 0);
  }

  // ---------------- Gizmo behavior patching ----------------

  _patchGizmoPrototypeOnce() {
    if (this._patchedGizmoProto) return;

    // Try to locate Gizmo prototype through an existing instance (current tool)
    const main = (this.api.getScene && this.api.getScene()) || this.api.main;
    if (!main || !main.getSculptManager) return;
    const sculpt = main.getSculptManager();
    if (!sculpt || !sculpt.getCurrentTool) return;

    const tool = sculpt.getCurrentTool();
    if (!tool || !tool._gizmo) return;

    const gizmo = tool._gizmo;
    if (!gizmo) return;

    const proto = Object.getPrototypeOf(gizmo);
    if (!proto) return;

    // --- Minimal math helpers (column-major 4x4) ---
    const v3 = {
      dot: (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2],
      cross: (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]],
      len: (a) => Math.sqrt(a[0]*a[0] + a[1]*a[1] + a[2]*a[2]) || 1.0,
      norm: (a) => { const l = Math.sqrt(a[0]*a[0] + a[1]*a[1] + a[2]*a[2]) || 1.0; return [a[0]/l, a[1]/l, a[2]/l]; },
      scale: (a, s) => [a[0]*s, a[1]*s, a[2]*s],
      add: (a,b) => [a[0]+b[0], a[1]+b[1], a[2]+b[2]],
      sub: (a,b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]]
    };

    const m4 = {
      identity: () => [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1],
      mul: (a, b) => { // out = a*b
        const out = new Array(16);
        for (let c=0;c<4;c++) {
          const b0=b[c*4+0], b1=b[c*4+1], b2=b[c*4+2], b3=b[c*4+3];
          out[c*4+0] = a[0]*b0 + a[4]*b1 + a[8]*b2 + a[12]*b3;
          out[c*4+1] = a[1]*b0 + a[5]*b1 + a[9]*b2 + a[13]*b3;
          out[c*4+2] = a[2]*b0 + a[6]*b1 + a[10]*b2 + a[14]*b3;
          out[c*4+3] = a[3]*b0 + a[7]*b1 + a[11]*b2 + a[15]*b3;
        }
        return out;
      },
      rotAxis: (axis, angle) => {
        const a = v3.norm(axis);
        const x=a[0], y=a[1], z=a[2];
        const c=Math.cos(angle), s=Math.sin(angle), t=1-c;
        // column-major
        return [
          t*x*x + c,     t*x*y + s*z, t*x*z - s*y, 0,
          t*x*y - s*z,   t*y*y + c,   t*y*z + s*x, 0,
          t*x*z + s*y,   t*y*z - s*x, t*z*z + c,   0,
          0,             0,           0,           1
        ];
      },
      // Multiply 4x4 by vec3 as direction (w=0) or point (w=1)
      transformDir: (m, v) => {
        const x=v[0], y=v[1], z=v[2];
        return [
          m[0]*x + m[4]*y + m[8]*z,
          m[1]*x + m[5]*y + m[9]*z,
          m[2]*x + m[6]*y + m[10]*z
        ];
      }
    };

    const _getWorldBasisFromMesh = (mesh) => {
      // mesh.getMatrix() is column-major. Extract rotation+scale columns.
      // We'll normalize to get pure axes in world space.
      const m = mesh.getMatrix();
      const x = v3.norm([m[0], m[1], m[2]]);
      const y = v3.norm([m[4], m[5], m[6]]);
      const z = v3.norm([m[8], m[9], m[10]]);
      return { x, y, z };
    };

    const _getAxisWorld = (gizmo, nbAxis) => {
      const sp = gizmo.__gizmoPlusSpace || 'Global';

      // Normal space: prefer picked normal (for "Z"), build orthonormal basis
      if (sp === 'Normal' && gizmo.__gizmoPlusNormal) {
        const n = v3.norm(gizmo.__gizmoPlusNormal);
        // choose an arbitrary tangent
        const up = Math.abs(n[1]) < 0.9 ? [0,1,0] : [1,0,0];
        const t = v3.norm(v3.cross(up, n));
        const b = v3.norm(v3.cross(n, t));
        if (nbAxis === 0) return t;     // X -> tangent
        if (nbAxis === 1) return b;     // Y -> bitangent
        return n;                        // Z -> normal
      }

      if (sp === 'Local' && gizmo.__gizmoPlusBasis) {
        if (nbAxis === 0) return gizmo.__gizmoPlusBasis.x;
        if (nbAxis === 1) return gizmo.__gizmoPlusBasis.y;
        return gizmo.__gizmoPlusBasis.z;
      }

      // Global
      if (nbAxis === 0) return [1,0,0];
      if (nbAxis === 1) return [0,1,0];
      return [0,0,1];
    };

    // Patch onMouseDown to capture basis/normal at drag start
    const origOnMouseDown = proto.onMouseDown;
    proto.onMouseDown = function() {
      try {
        // Capture Local basis once when starting an edit
        const meshes = this._main.getSelectedMeshes && this._main.getSelectedMeshes();
        if (meshes && meshes.length) {
          this.__gizmoPlusBasis = _getWorldBasisFromMesh(meshes[0]);
        } else {
          this.__gizmoPlusBasis = null;
        }

        // Capture picked normal for Normal space
        const picking = this._main.getPicking && this._main.getPicking();
        if (picking && typeof picking.computePickedNormal === 'function') {
          const n = picking.computePickedNormal();
          this.__gizmoPlusNormal = n ? [n[0], n[1], n[2]] : null;
        } else {
          this.__gizmoPlusNormal = null;
        }
      } catch (e) {
        // ignore
      }
      return origOnMouseDown.apply(this, arguments);
    };

    // Patch _startTranslateEdit so screen direction matches space axis
    const origStartTranslate = proto._startTranslateEdit;
    proto._startTranslateEdit = function() {
      const main = this._main;
      const camera = main.getCamera();

      const origin = this._editLineOrigin;
      const dir2 = this._editLineDirection;

      // 3d origin (center of gizmo)
      this._computeCenterGizmo(origin);

      // 3d direction: use axis in world space based on space selection
      const nbAxis = this._selected._nbAxis;
      const axis = _getAxisWorld(this, nbAxis);
      const p1 = v3.add(origin, axis);

      // project on screen and get a 2D line
      const o2 = camera.project([origin[0], origin[1], origin[2]]);
      const d2 = camera.project([p1[0], p1[1], p1[2]]);

      origin[0]=o2[0]; origin[1]=o2[1]; origin[2]=o2[2];
      dir2[0]=d2[0]; dir2[1]=d2[1]; dir2[2]=d2[2];

      // normalize 2D direction
      const dx = dir2[0]-origin[0];
      const dy = dir2[1]-origin[1];
      const l = Math.sqrt(dx*dx+dy*dy) || 1.0;
      dir2[0]=dx/l; dir2[1]=dy/l;

      const offset = this._editOffset;
      offset[0] = main._mouseX - origin[0];
      offset[1] = main._mouseY - origin[1];
    };

    // Patch _updateTranslateEdit to use chosen axis (world) instead of fixed unit axis
    const origUpdateTranslate = proto._updateTranslateEdit;
    proto._updateTranslateEdit = function() {
      const main = this._main;
      const camera = main.getCamera();

      const origin2 = this._editLineOrigin;
      const dir2 = this._editLineDirection;

      // compute closest point on the 2D helper line
      let vx = main._mouseX - origin2[0];
      let vy = main._mouseY - origin2[1];
      vx -= this._editOffset[0];
      vy -= this._editOffset[1];
      const t2 = vx*dir2[0] + vy*dir2[1];
      const px = origin2[0] + dir2[0]*t2;
      const py = origin2[1] + dir2[1]*t2;

      this._updateLineHelper(origin2[0], origin2[1], px, py);

      // unproject a short ray in world
      let near = camera.unproject(px, py, 0.0);
      let far  = camera.unproject(px, py, 0.1);

      // move to gizmo-centered coordinates (translation only, direction unchanged)
      // (we keep original behavior using the existing matrices)
      const trInv = this._editTransInv;
      // apply translation inverse: p' = p - center
      near = [near[0] + trInv[12], near[1] + trInv[13], near[2] + trInv[14]];
      far  = [far[0]  + trInv[12], far[1]  + trInv[13], far[2]  + trInv[14]];

      // ray direction
      const rayDir = v3.norm(v3.sub(far, near));

      const nbAxis = this._selected._nbAxis;
      const axisDir = v3.norm(_getAxisWorld(this, nbAxis)); // direction in centered world

      // Closest points between:
      //   L0(s) = near + rayDir*s
      //   L1(u) = axisDir*u  (line through origin along axis)
      const a01 = -v3.dot(rayDir, axisDir);
      const b0  = v3.dot(near, rayDir);
      const det = Math.abs(1.0 - a01*a01) || 1e-8;
      const b1  = -v3.dot(near, axisDir);
      const u   = (a01*b0 - b1) / det;

      const inter = v3.scale(axisDir, u);
      this._updateMatrixTranslate(inter);

      main.render();
    };

    // Patch rotation update so Local/Normal rotates around the chosen axis (world)
    const origUpdateRotate = proto._updateRotateEdit;
    proto._updateRotateEdit = function() {
      const main = this._main;

      const origin = this._editLineOrigin;
      const dir = this._editLineDirection;

      const vec = [main._mouseX - origin[0], main._mouseY - origin[1], 0.0];
      const dist = vec[0]*dir[0] + vec[1]*dir[1];

      this._updateLineHelper(origin[0], origin[1], origin[0] + dir[0]*dist, origin[1] + dir[1]*dist);

      let angle = (7 * dist) / Math.min(main.getCanvasWidth(), main.getCanvasHeight());
      angle %= Math.PI * 2;

      const nbAxis = this._selected._nbAxis;
      const axisWorld = _getAxisWorld(this, nbAxis);

      const R = m4.rotAxis(axisWorld, -angle);

      const meshes = this._main.getSelectedMeshes();
      for (let i = 0; i < meshes.length; ++i) {
        // Build edit = T * R * Tinv (world space around gizmo center)
        const edit = m4.mul(this._editTrans, m4.mul(R, this._editTransInv));
        // Convert to mesh local: localInv * edit * local
        const localInv = this._editLocalInv[i];
        const local = this._editLocal[i];
        const editLocal = m4.mul(localInv, m4.mul(edit, local));

        // write into mesh edit matrix
        const mrot = meshes[i].getEditMatrix();
        for (let k=0;k<16;k++) mrot[k] = editLocal[k];
      }

      main.render();
    };

    // Mark patched
    this._patchedGizmoProto = true;
  }
}
