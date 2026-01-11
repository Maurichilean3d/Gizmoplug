// AdvancedGizmoPlugin.js
// ES module plugin for sculptgl-modular-plugins
// Adds: Move/Rotate/Scale modes, Global/Local/Surface-Normal orientation, and axis locks (X/Y/Z).
//
// Usage:
//   - Put this file somewhere reachable (same origin or CORS enabled)
//   - In SculptGL: Add-ons -> "Cargar plugin desde URLâ€¦" and paste the URL
//   - Or register it in src/SculptGL.js: this._pluginManager.register(AdvancedGizmoPlugin);

class AdvancedGizmoPlugin {
  constructor(api) {
    this.api = api;

    // UI state
    this.mode = 'Universal'; // Universal | Move | Rotate | Scale
    this.space = 'Global';   // Global | Local | SurfaceNormal
    this.axisX = true;
    this.axisY = true;
    this.axisZ = true;

    this._patchedGizmos = new WeakSet();

    this._menu = null;
    this._buildUI();
  }

  // Called by core on each render (see PluginManager.onRender)
  onRender() {
    this._applyToCurrentTool();
  }

  // Called by core when tool changes (see GuiSculpting hook)
  onToolChange() {
    this._applyToCurrentTool(true);
  }

  // ---------------------------
  // UI
  // ---------------------------
  _buildUI() {
    const gui = this.api.getGui && this.api.getGui();
    if (!gui || !gui._topbar || !gui._topbar.addMenu) return;

    const menu = (this._menu = gui._topbar.addMenu('Gizmo+'));

    // Combobox: Mode
    menu.addCombobox(
      'Modo',
      0,
      (id) => {
        const opts = ['Universal', 'Mover', 'Rotar', 'Escalar'];
        const v = opts[id] || 'Universal';
        this.mode = (v === 'Mover') ? 'Move' : (v === 'Rotar') ? 'Rotate' : (v === 'Escalar') ? 'Scale' : 'Universal';
        this._applyToCurrentTool(true);
      },
      ['Universal', 'Mover', 'Rotar', 'Escalar']
    );

    // Combobox: Space
    menu.addCombobox(
      'Espacio',
      0,
      (id) => {
        const opts = ['Global', 'Local', 'Normal superficie'];
        const v = opts[id] || 'Global';
        this.space = (v === 'Local') ? 'Local' : (v === 'Normal superficie') ? 'SurfaceNormal' : 'Global';
        this._applyToCurrentTool(true);
      },
      ['Global', 'Local', 'Normal superficie']
    );

    // Axis locks
    menu.addCheckbox('Eje X', this, 'axisX', () => this._applyToCurrentTool(true));
    menu.addCheckbox('Eje Y', this, 'axisY', () => this._applyToCurrentTool(true));
    menu.addCheckbox('Eje Z', this, 'axisZ', () => this._applyToCurrentTool(true));

    // Helpful note
    menu.addTitle && menu.addTitle('Tip: en "Normal superficie" el gizmo toma la normal bajo el cursor.');
  }

  // ---------------------------
  // Core integration
  // ---------------------------
  _applyToCurrentTool(force = false) {
    const main = this.api.main;
    if (!main || !main.getSculptManager) return;

    const tool = main.getSculptManager().getCurrentTool && main.getSculptManager().getCurrentTool();
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
      gizmo.setActivatedType(type);
      gizmo.__advGizmoSpace = this.space;
      gizmo.__advAxis = { x: !!this.axisX, y: !!this.axisY, z: !!this.axisZ };
    } else {
      // keep in sync even if user drags UI during same frame
      gizmo.__advGizmoSpace = this.space;
      gizmo.__advAxis = { x: !!this.axisX, y: !!this.axisY, z: !!this.axisZ };
      gizmo.__advMode = this.mode;
    }
  }

  _computeActivatedType(gizmo) {
    const G = gizmo.constructor;
    const onX = !!this.axisX, onY = !!this.axisY, onZ = !!this.axisZ;

    const TRANS = (onX ? G.TRANS_X : 0) | (onY ? G.TRANS_Y : 0) | (onZ ? G.TRANS_Z : 0);
    const ROT   = (onX ? G.ROT_X : 0)   | (onY ? G.ROT_Y : 0)   | (onZ ? G.ROT_Z : 0);
    const SCALE = (onX ? G.SCALE_X : 0) | (onY ? G.SCALE_Y : 0) | (onZ ? G.SCALE_Z : 0);

    // Planes depend on the two remaining axes
    const PLANE =
      ((onY && onZ) ? G.PLANE_X : 0) |
      ((onX && onZ) ? G.PLANE_Y : 0) |
      ((onX && onY) ? G.PLANE_Z : 0);

    if (this.mode === 'Move') return TRANS | PLANE;
    if (this.mode === 'Rotate') return ROT | (onX || onY || onZ ? G.ROT_W : 0);
    if (this.mode === 'Scale') return SCALE | (onX || onY || onZ ? G.SCALE_W : 0);

    // Universal (original behavior but respecting axis locks)
    return TRANS | PLANE | ROT | SCALE | G.ROT_W | G.SCALE_W;
  }

  // ---------------------------
  // Gizmo patch: orientation spaces
  // ---------------------------
  _patchGizmoUpdateMatrices(gizmo) {
    const original = gizmo._updateMatrices && gizmo._updateMatrices.bind(gizmo);
    if (!original) return;

    // Helper math (minimal, no external deps)
    const v3 = {
      sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
      add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
      dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
      cross: (a, b) => [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0]
      ],
      len: (a) => Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]),
      norm: (a) => {
        const l = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]) || 1.0;
        return [a[0] / l, a[1] / l, a[2] / l];
      },
      dist: (a, b) => {
        const x = a[0] - b[0], y = a[1] - b[1], z = a[2] - b[2];
        return Math.sqrt(x * x + y * y + z * z);
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
        for (let i = 0; i < 4; i++) { // row
          for (let j = 0; j < 4; j++) { // col
            out[j * 4 + i] =
              a[0 * 4 + i] * b[j * 4 + 0] +
              a[1 * 4 + i] * b[j * 4 + 1] +
              a[2 * 4 + i] * b[j * 4 + 2] +
              a[3 * 4 + i] * b[j * 4 + 3];
          }
        }
        return out;
      },
      translate: (m, v) => {
        const t = m4.identity();
        t[12] = v[0]; t[13] = v[1]; t[14] = v[2];
        return m4.multiply(m, t);
      },
      scale: (m, s) => {
        const sm = m4.identity();
        sm[0] = s[0]; sm[5] = s[1]; sm[10] = s[2];
        return m4.multiply(m, sm);
      }
    };

    const buildRotFromBasis = (x, y, z) => ([
      x[0], x[1], x[2], 0,
      y[0], y[1], y[2], 0,
      z[0], z[1], z[2], 0,
      0,    0,    0,    1
    ]);

    const extractOrthoBasisFromMat4 = (mat) => {
      // columns are basis (with scale), column-major
      const x = v3.norm([mat[0], mat[1], mat[2]]);
      const y = v3.norm([mat[4], mat[5], mat[6]]);
      let z = v3.cross(x, y);
      const zl = v3.len(z);
      if (zl < 1e-6) z = v3.norm([mat[8], mat[9], mat[10]]);
      else z = [z[0] / zl, z[1] / zl, z[2] / zl];
      // re-orthogonalize y to ensure orthonormal
      const y2 = v3.norm(v3.cross(z, x));
      return { x, y: y2, z };
    };

    gizmo._updateMatrices = function () {
      const camera = this._main.getCamera();
      const trMesh = this._computeCenterGizmo();
      const eye = camera.computePosition();

      this._lastDistToEye = this._isEditing ? this._lastDistToEye : v3.dist(eye, trMesh);
      const scaleFactor = (this._lastDistToEye * 80.0) / camera.getConstantScreen(); // GIZMO_SIZE = 80.0

      // Base transform: T * R * S
      let traScale = m4.identity();
      traScale = m4.translate(traScale, trMesh);

      // --- orientation space ---
      let rot = m4.identity();
      const space = this.__advGizmoSpace || 'Global';

      if (space === 'Local') {
        const meshes = this._main.getSelectedMeshes && this._main.getSelectedMeshes();
        const mesh = meshes && meshes[0];
        if (mesh && mesh.getMatrix) {
          const basis = extractOrthoBasisFromMat4(mesh.getMatrix());
          rot = buildRotFromBasis(basis.x, basis.y, basis.z);
        }
      } else if (space === 'SurfaceNormal') {
        const picking = this._main.getPicking && this._main.getPicking();
        const n0 = picking && picking.getPickedNormal && picking.getPickedNormal();
        if (n0 && (n0[0] || n0[1] || n0[2])) {
          const z = v3.norm([n0[0], n0[1], n0[2]]);
          const viewDir = v3.norm(v3.sub(eye, trMesh)); // from center to eye
          let x = v3.cross(viewDir, z);
          if (v3.len(x) < 1e-6) x = v3.cross([0, 1, 0], z);
          x = v3.norm(x);
          const y = v3.norm(v3.cross(z, x));
          rot = buildRotFromBasis(x, y, z);
        }
      }

      traScale = m4.multiply(traScale, rot);
      traScale = m4.scale(traScale, [scaleFactor, scaleFactor, scaleFactor]);

      // manage arc stuffs (same call as original)
      const toEye = v3.norm(v3.sub(trMesh, eye)); // direction from eye to center? original uses normalize(eye, sub(eye,trMesh,eye))
      // The original does: vec3.sub(eye, trMesh, eye) => trMesh - eye, then normalize into eye
      this._updateArcRotation(toEye);

      // update matrices for every gizmo part
      this._transX.updateFinalMatrix(traScale);
      this._transY.updateFinalMatrix(traScale);
      this._transZ.updateFinalMatrix(traScale);

      this._planeX.updateFinalMatrix(traScale);
      this._planeY.updateFinalMatrix(traScale);
      this._planeZ.updateFinalMatrix(traScale);

      this._rotX.updateFinalMatrix(traScale);
      this._rotY.updateFinalMatrix(traScale);
      this._rotZ.updateFinalMatrix(traScale);
      this._rotW.updateFinalMatrix(traScale);

      this._scaleX.updateFinalMatrix(traScale);
      this._scaleY.updateFinalMatrix(traScale);
      this._scaleZ.updateFinalMatrix(traScale);
      this._scaleW.updateFinalMatrix(traScale);

      return traScale;
    };

    gizmo.__advGizmoPatched = true;
    gizmo.__advOriginalUpdateMatrices = original; // for debugging
  }
}

export default AdvancedGizmoPlugin;
