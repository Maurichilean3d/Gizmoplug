// AdvancedGizmoPlugin.js
// Plugin "Gizmo+" compatible with PluginManager API:
//   export default class MyPlugin { constructor(api){...} init(){...} }
// Adds:
//   - Separate gizmo modes: Universal / Move / Rotate / Scale
//   - Orientation space: Global / Local / Surface Normal
//   - Axis locks: enable/disable X/Y/Z (also affects which planes appear)
//
// Notes:
// - This plugin is self-contained (no imports) so it can be loaded from URL/blob.
// - It patches the internal Gizmo instance used by the Transform tool by wrapping gizmo._updateMatrices().

export default class AdvancedGizmoPlugin {
  constructor(api) {
    this.api = api;

    // UI state
    this.mode = 'Universal'; // Universal | Move | Rotate | Scale
    this.space = 'Global';   // Global | Local | SurfaceNormal
    this.axis = { x: true, y: true, z: true };

    // internal
    this._patchedGizmos = new WeakSet();
    this._menu = null;
  }

  init() {
    // UI (prefer rich controls if available)
    this._buildUI();

    // Apply immediately
    this._applyToCurrentTool(true);
  }

  onToolChange() {
    this._applyToCurrentTool(true);
  }

  onRender() {
    // Keep applying in case tool is swapped without emitting onToolChange,
    // or a new gizmo instance is created lazily.
    this._applyToCurrentTool(false);
  }

  // ---------------------------
  // UI
  // ---------------------------
  _buildUI() {
    const gui = this.api.getGui && this.api.getGui();

    // Rich UI path (yagui)
    if (gui && gui._topbar && typeof gui._topbar.addMenu === 'function') {
      const menu = (this._menu = gui._topbar.addMenu('Gizmo+'));

      // If the menu supports combobox/checkbox, use them.
      const hasCombo = typeof menu.addCombobox === 'function';
      const hasCheck = typeof menu.addCheckbox === 'function';

      if (hasCombo) {
        // Mode
        menu.addCombobox(
          'Modo',
          0,
          (id) => {
            const opts = ['Universal', 'Mover', 'Rotar', 'Escalar'];
            const v = opts[id] || 'Universal';
            this.mode = (v === 'Mover') ? 'Move' : (v === 'Rotar') ? 'Rotate' : (v === 'Escalar') ? 'Scale' : 'Universal';
            this._applyToCurrentTool(true);
            this.api.render && this.api.render();
          },
          ['Universal', 'Mover', 'Rotar', 'Escalar']
        );

        // Space
        menu.addCombobox(
          'Espacio',
          0,
          (id) => {
            const opts = ['Global', 'Local', 'Normal superficie'];
            const v = opts[id] || 'Global';
            this.space = (v === 'Local') ? 'Local' : (v === 'Normal superficie') ? 'SurfaceNormal' : 'Global';
            this._applyToCurrentTool(true);
            this.api.render && this.api.render();
          },
          ['Global', 'Local', 'Normal superficie']
        );
      } else if (this.api.addGuiAction) {
        // Fallback inside topbar: create button-actions
        this._buildButtonUI();
        return;
      }

      if (hasCheck) {
        menu.addCheckbox('Eje X', this.axis.x, (v) => { this.axis.x = !!v; this._applyToCurrentTool(true); this.api.render && this.api.render(); });
        menu.addCheckbox('Eje Y', this.axis.y, (v) => { this.axis.y = !!v; this._applyToCurrentTool(true); this.api.render && this.api.render(); });
        menu.addCheckbox('Eje Z', this.axis.z, (v) => { this.axis.z = !!v; this._applyToCurrentTool(true); this.api.render && this.api.render(); });
      } else if (this.api.addGuiAction) {
        this._buildButtonUI();
      }

      return;
    }

    // Minimal UI path: only buttons via api.addGuiAction
    if (this.api.addGuiAction) this._buildButtonUI();
  }

  _buildButtonUI() {
    const add = this.api.addGuiAction.bind(this.api);

    // Modes
    add('Gizmo+', 'Modo: Universal', () => { this.mode = 'Universal'; this._applyToCurrentTool(true); this.api.render && this.api.render(); });
    add('Gizmo+', 'Modo: Mover',     () => { this.mode = 'Move';      this._applyToCurrentTool(true); this.api.render && this.api.render(); });
    add('Gizmo+', 'Modo: Rotar',     () => { this.mode = 'Rotate';    this._applyToCurrentTool(true); this.api.render && this.api.render(); });
    add('Gizmo+', 'Modo: Escalar',   () => { this.mode = 'Scale';     this._applyToCurrentTool(true); this.api.render && this.api.render(); });

    // Space
    add('Gizmo+', 'Espacio: Global',           () => { this.space = 'Global';        this._applyToCurrentTool(true); this.api.render && this.api.render(); });
    add('Gizmo+', 'Espacio: Local',            () => { this.space = 'Local';         this._applyToCurrentTool(true); this.api.render && this.api.render(); });
    add('Gizmo+', 'Espacio: Normal superficie',() => { this.space = 'SurfaceNormal'; this._applyToCurrentTool(true); this.api.render && this.api.render(); });

    // Axis toggles (labels are static, but state toggles)
    add('Gizmo+', 'Toggle Eje X', () => { this.axis.x = !this.axis.x; this._applyToCurrentTool(true); this.api.render && this.api.render(); });
    add('Gizmo+', 'Toggle Eje Y', () => { this.axis.y = !this.axis.y; this._applyToCurrentTool(true); this.api.render && this.api.render(); });
    add('Gizmo+', 'Toggle Eje Z', () => { this.axis.z = !this.axis.z; this._applyToCurrentTool(true); this.api.render && this.api.render(); });
  }

  // ---------------------------
  // Core logic
  // ---------------------------
  _applyToCurrentTool(force) {
    const main = (this.api.getScene && this.api.getScene()) || this.api.main;
    if (!main || !main.getSculptManager) return;

    const sculpt = main.getSculptManager();
    if (!sculpt || !sculpt.getCurrentTool) return;

    const tool = sculpt.getCurrentTool();
    if (!tool || !tool._gizmo) return;

    const gizmo = tool._gizmo;
    if (!gizmo || typeof gizmo.setActivatedType !== 'function') return;

    // Patch updateMatrices once per gizmo instance
    if (!this._patchedGizmos.has(gizmo)) {
      this._patchGizmoUpdateMatrices(gizmo);
      this._patchedGizmos.add(gizmo);
      force = true;
    }

    // Apply mode + axis mask
    if (force) {
      const type = this._computeActivatedType(gizmo);
      if (typeof gizmo.setActivatedType === 'function') gizmo.setActivatedType(type);

      // store current state on gizmo for the patched updater
      gizmo.__gizmoPlusSpace = this.space;
    } else {
      // keep state synced (cheap)
      gizmo.__gizmoPlusSpace = this.space;
    }
  }

  _computeActivatedType(gizmo) {
    const G = gizmo.constructor; // expects static getters (TRANS_X, ROT_X, ...)

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

    // Universal: keep default but respect axis toggles
    const hasAny = (onX || onY || onZ);
    return TRANS | PLANE | ROT | SCALE | (hasAny ? (G.ROT_W | G.SCALE_W) : 0);
  }

  // ---------------------------
  // Gizmo patching (orientation)
  // ---------------------------
  _patchGizmoUpdateMatrices(gizmo) {
    if (!gizmo || typeof gizmo._updateMatrices !== 'function') return;
    if (gizmo.__gizmoPlusPatched) return;
    gizmo.__gizmoPlusPatched = true;

    const original = gizmo._updateMatrices.bind(gizmo);

    const v3 = {
      add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
      sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
      dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
      cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
      len: (a) => Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]),
      norm: (a) => {
        const l = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]) || 1.0;
        return [a[0] / l, a[1] / l, a[2] / l];
      }
    };

    const m4 = {
      identity: () => [1, 0, 0, 0,
                      0, 1, 0, 0,
                      0, 0, 1, 0,
                      0, 0, 0, 1],
      multiply: (a, b) => {
        // column-major 4x4: out = a * b
        const out = new Array(16);
        for (let c = 0; c < 4; c++) {
          const bc0 = b[c * 4 + 0], bc1 = b[c * 4 + 1], bc2 = b[c * 4 + 2], bc3 = b[c * 4 + 3];
          out[c * 4 + 0] = a[0] * bc0 + a[4] * bc1 + a[8]  * bc2 + a[12] * bc3;
          out[c * 4 + 1] = a[1] * bc0 + a[5] * bc1 + a[9]  * bc2 + a[13] * bc3;
          out[c * 4 + 2] = a[2] * bc0 + a[6] * bc1 + a[10] * bc2 + a[14] * bc3;
          out[c * 4 + 3] = a[3] * bc0 + a[7] * bc1 + a[11] * bc2 + a[15] * bc3;
        }
        return out;
      },
      translate: (t) => [1, 0, 0, 0,
                        0, 1, 0, 0,
                        0, 0, 1, 0,
                        t[0], t[1], t[2], 1],
      scale: (s) => [s[0], 0,    0,    0,
                     0,    s[1], 0,    0,
                     0,    0,    s[2], 0,
                     0,    0,    0,    1],
      fromBasis: (x, y, z) => [
        x[0], x[1], x[2], 0,
        y[0], y[1], y[2], 0,
        z[0], z[1], z[2], 0,
        0,    0,    0,    1
      ] // NOTE: this is ROW-major; we will transpose to column-major below
    };

    const toColumnMajor = (rowMajor) => {
      // convert 4x4 row-major array to column-major
      return [
        rowMajor[0], rowMajor[4], rowMajor[8],  rowMajor[12],
        rowMajor[1], rowMajor[5], rowMajor[9],  rowMajor[13],
        rowMajor[2], rowMajor[6], rowMajor[10], rowMajor[14],
        rowMajor[3], rowMajor[7], rowMajor[11], rowMajor[15]
      ];
    };

    const extractWorldBasisFromMeshMatrix = (mat) => {
      // mat is column-major from gl-matrix
      const x = v3.norm([mat[0], mat[1], mat[2]]);
      const y = v3.norm([mat[4], mat[5], mat[6]]);
      const z = v3.norm([mat[8], mat[9], mat[10]]);
      return { x, y, z };
    };

    const normalToWorld = (nLocal, meshMat) => {
      // approximate: multiply by upper 3x3 then normalize
      const nx = nLocal[0], ny = nLocal[1], nz = nLocal[2];
      const wx = meshMat[0] * nx + meshMat[4] * ny + meshMat[8]  * nz;
      const wy = meshMat[1] * nx + meshMat[5] * ny + meshMat[9]  * nz;
      const wz = meshMat[2] * nx + meshMat[6] * ny + meshMat[10] * nz;
      return v3.norm([wx, wy, wz]);
    };

    const buildBasisFromNormal = (n, fallbackDir) => {
      // Make Z = n, X = normalize(cross(fallbackDir, Z)), Y = cross(Z, X)
      const z = v3.norm(n);
      let f = fallbackDir || [0, 1, 0];
      // if too parallel, pick another
      if (Math.abs(v3.dot(v3.norm(f), z)) > 0.95) f = [1, 0, 0];
      const x = v3.norm(v3.cross(f, z));
      const y = v3.cross(z, x);
      return { x, y, z };
    };

    gizmo._updateMatrices = function () {
      const space = this.__gizmoPlusSpace || 'Global';
      if (space === 'Global') {
        return original();
      }

      // We reproduce the top part of the original _updateMatrices,
      // but we inject an extra rotation into the T*S matrix.
      const camera = this._main.getCamera();
      const trMesh = this._computeCenterGizmo();
      const eye = camera.computePosition();

      this._lastDistToEye = this._isEditing ? this._lastDistToEye : this._vec3Dist(eye, trMesh);
      const scaleFactor = (this._lastDistToEye * 80.0) / camera.getConstantScreen(); // GIZMO_SIZE=80.0

      // Orientation basis
      let basis = null;

      if (space === 'Local') {
        const mesh = this._main.getMesh && this._main.getMesh();
        if (mesh && typeof mesh.getMatrix === 'function') {
          basis = extractWorldBasisFromMeshMatrix(mesh.getMatrix());
        }
      } else if (space === 'SurfaceNormal') {
        const picking = this._main.getPicking && this._main.getPicking();
        const mesh = this._main.getMesh && this._main.getMesh();
        if (picking && mesh && typeof picking.getPickedNormal === 'function' && typeof mesh.getMatrix === 'function') {
          const nLocal = picking.getPickedNormal();
          if (nLocal && (nLocal[0] || nLocal[1] || nLocal[2])) {
            const nWorld = normalToWorld(nLocal, mesh.getMatrix());
            // use view direction as fallback to keep X stable
            const viewDir = v3.norm(v3.sub(trMesh, eye)); // from eye to center
            basis = buildBasisFromNormal(nWorld, viewDir);
          }
        }
      }

      if (!basis) {
        // fallback to original if we cannot compute basis
        return original();
      }

      // Create R (column-major)
      const R_row = m4.fromBasis(basis.x, basis.y, basis.z);
      const R = toColumnMajor(R_row);

      // T * R * S
      const T = m4.translate(trMesh);
      const S = m4.scale([scaleFactor, scaleFactor, scaleFactor]);
      const TR = m4.multiply(T, R);
      const traScale = m4.multiply(TR, S);

      // update arc rotation (uses normalized eye dir, same as original)
      const eyeDir = v3.norm(v3.sub(eye, trMesh));
      this._updateArcRotation && this._updateArcRotation(eyeDir);

      // push matrices to all gizmo elements
      this._transX && this._transX.updateFinalMatrix(traScale);
      this._transY && this._transY.updateFinalMatrix(traScale);
      this._transZ && this._transZ.updateFinalMatrix(traScale);

      this._planeX && this._planeX.updateFinalMatrix(traScale);
      this._planeY && this._planeY.updateFinalMatrix(traScale);
      this._planeZ && this._planeZ.updateFinalMatrix(traScale);

      this._rotX && this._rotX.updateFinalMatrix(traScale);
      this._rotY && this._rotY.updateFinalMatrix(traScale);
      this._rotZ && this._rotZ.updateFinalMatrix(traScale);
      this._rotW && this._rotW.updateFinalMatrix(traScale);

      this._scaleX && this._scaleX.updateFinalMatrix(traScale);
      this._scaleY && this._scaleY.updateFinalMatrix(traScale);
      this._scaleZ && this._scaleZ.updateFinalMatrix(traScale);
      this._scaleW && this._scaleW.updateFinalMatrix(traScale);
    };

    // helper using gl-matrix vec3.dist behaviour
    gizmo._vec3Dist = function(a, b) {
      const x = a[0] - b[0], y = a[1] - b[1], z = a[2] - b[2];
      return Math.sqrt(x * x + y * y + z * z);
    };
  }
}
