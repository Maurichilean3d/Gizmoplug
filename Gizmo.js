export default class AdvancedGizmoPlugin {
  constructor(api) {
    this.api = api;

    this.mode = 'universal'; // move | rotate | scale | universal
    this.space = 'global';   // global | local | normal
    this.axisMask = [true, true, true]; // X Y Z

    this._patched = false;
  }

  /* ================= UI ================= */

  init() {
    const api = this.api;

    // ---- MENU ----
    api.addGuiAction('Gizmo+', 'Modo: Universal', () => this.setMode('universal'));
    api.addGuiAction('Gizmo+', 'Modo: Mover', () => this.setMode('move'));
    api.addGuiAction('Gizmo+', 'Modo: Rotar', () => this.setMode('rotate'));
    api.addGuiAction('Gizmo+', 'Modo: Escalar', () => this.setMode('scale'));

    api.addGuiAction('Gizmo+', 'Espacio: Global', () => this.setSpace('global'));
    api.addGuiAction('Gizmo+', 'Espacio: Local', () => this.setSpace('local'));
    api.addGuiAction('Gizmo+', 'Espacio: Normal', () => this.setSpace('normal'));

    api.addGuiAction('Gizmo+', 'Eje X', () => this.toggleAxis(0));
    api.addGuiAction('Gizmo+', 'Eje Y', () => this.toggleAxis(1));
    api.addGuiAction('Gizmo+', 'Eje Z', () => this.toggleAxis(2));

    api.addGuiAction('Gizmo+', 'Refrescar Gizmo+', () => this.refresh());

    // parchear una sola vez
    this.patchGizmo();
  }

  /* ================= STATE ================= */

  setMode(m) {
    this.mode = m;
    this.refresh();
  }

  setSpace(s) {
    this.space = s;
    this.refresh();
  }

  toggleAxis(i) {
    this.axisMask[i] = !this.axisMask[i];
    this.refresh();
  }

  refresh() {
    const gizmo = this.api.getGizmo?.();
    if (!gizmo) return;

    // modo real
    if (this.mode === 'move') gizmo.setModeTranslate?.();
    else if (this.mode === 'rotate') gizmo.setModeRotate?.();
    else if (this.mode === 'scale') gizmo.setModeScale?.();
    else gizmo.setModeUniversal?.();

    // ejes visibles
    gizmo.showAxisX = this.axisMask[0];
    gizmo.showAxisY = this.axisMask[1];
    gizmo.showAxisZ = this.axisMask[2];

    // desactivar planos grandes (evita bloquear cámara)
    gizmo.showPlaneXY = false;
    gizmo.showPlaneXZ = false;
    gizmo.showPlaneYZ = false;

    gizmo.updateMatrices?.();
  }

  /* ================= CORE FIX ================= */

  patchGizmo() {
    if (this._patched) return;

    const gizmo = this.api.getGizmo?.();
    if (!gizmo) return;

    const plugin = this;

    // guardar original
    const _startTranslate = gizmo._startTranslateEdit;
    const _updateTranslate = gizmo._updateTranslateEdit;

    gizmo._startTranslateEdit = function (...args) {
      this._pluginSpace = plugin.space;
      this._pluginBasis = plugin.computeBasis();
      return _startTranslate.apply(this, args);
    };

    gizmo._updateTranslateEdit = function (...args) {
      if (this._pluginSpace !== 'global' && this._pluginBasis) {
        this._translateAxis = this._pluginBasis;
      }
      return _updateTranslate.apply(this, args);
    };

    this._patched = true;
  }

  /* ================= BASIS ================= */

  computeBasis() {
    const mesh = this.api.getMesh?.();
    if (!mesh) return null;

    // matriz local del mesh
    const m = mesh.getMatrix?.();
    if (!m) return null;

    // columnas X,Y,Z
    const x = [m[0], m[1], m[2]];
    const y = [m[4], m[5], m[6]];
    const z = [m[8], m[9], m[10]];

    // normalizar
    normalize(x);
    normalize(y);
    normalize(z);

    if (this.space === 'local') {
      return [x, y, z];
    }

    if (this.space === 'normal') {
      const n = this.api.getPicking?.()?.computePickedNormal?.();
      if (n) {
        normalize(n);
        return [n, cross(n, x), cross(n, y)];
      }
    }

    return null;
  }
}

/* ================= MATH ================= */

function normalize(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  v[0] /= l; v[1] /= l; v[2] /= l;
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
}
