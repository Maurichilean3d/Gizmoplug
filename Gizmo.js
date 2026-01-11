// AdvancedGizmoPlugin_v4.js
// - Compatible con PluginManager nuevo: export default class { constructor(api){} init(){} }
// - AÃ±ade: modos (Mover/Rotar/Escalar/Universal), espacio (Global/Local/Normal superficie), bloqueo de ejes (X/Y/Z)
// - Corrige: orientaciÃ³n local REAL (afecta a la malla) y evita bloquear la cÃ¡mara (no habilita planos por defecto)

import { vec2, vec3, mat3, mat4 } from 'gl-matrix';
import Gizmo from 'editing/Gizmo';

/**
 * Notas tÃ©cnicas (repo):
 * - Gizmo aplica Local para rot/scale via _scaleRotateEditMatrix (usa _editLocal/_editLocalInv).
 * - Translate/Plane NO pasan por _scaleRotateEditMatrix, pero sÃ­ usan _editScaleRotInv en _updateMatrixTranslate.
 * - Para que "Local" funcione en translate/plane, hay que cambiar la DIRECCIÃ“N del eje/plano en el espacio world
 *   (en coords de _editTransInv) de manera consistente con la orientaciÃ³n del gizmo.
 * - Para que el gizmo se vea local/normal, multiplicamos traScale por una rotaciÃ³n R antes de updateFinalMatrix.
 */

// ---- Helpers ----
function _normalize3(out, a) {
  const len = Math.hypot(a[0], a[1], a[2]) || 1.0;
  out[0] = a[0] / len; out[1] = a[1] / len; out[2] = a[2] / len;
  return out;
}

function _extractBasisFromMat4(m4) {
  // gl-matrix es column-major: columnas 0,1,2 son los ejes (con escala).
  const x = vec3.fromValues(m4[0], m4[1], m4[2]);
  const y = vec3.fromValues(m4[4], m4[5], m4[6]);
  const z = vec3.fromValues(m4[8], m4[9], m4[10]);
  _normalize3(x, x);
  _normalize3(y, y);
  _normalize3(z, z);

  // Re-ortogonalizar suave (Gram-Schmidt) por si hay skew numÃ©rico
  // y = normalize(y - dot(y,x)*x)
  const dotyx = x[0]*y[0]+x[1]*y[1]+x[2]*y[2];
  y[0] -= dotyx*x[0]; y[1] -= dotyx*x[1]; y[2] -= dotyx*x[2];
  _normalize3(y, y);

  // z = normalize(cross(x,y)) para garantizar mano derecha
  const zx = x[1]*y[2]-x[2]*y[1];
  const zy = x[2]*y[0]-x[0]*y[2];
  const zz = x[0]*y[1]-x[1]*y[0];
  const z2 = vec3.fromValues(zx, zy, zz);
  _normalize3(z2, z2);

  return { x, y, z: z2 };
}

function _basisToMat4(basis) {
  // Construye matriz rotaciÃ³n (column-major) a partir de ejes world
  const m = mat4.create();
  m[0]=basis.x[0]; m[1]=basis.x[1]; m[2]=basis.x[2];
  m[4]=basis.y[0]; m[5]=basis.y[1]; m[6]=basis.y[2];
  m[8]=basis.z[0]; m[9]=basis.z[1]; m[10]=basis.z[2];
  return m;
}

function _computeSurfaceNormalBasis(main) {
  const mesh = main.getMesh && main.getMesh();
  const picking = main.getPicking && main.getPicking();
  if (!mesh || !picking) return null;

  // Intersect ray con la malla (NO con pickables del gizmo) usando el picking principal
  // Esto es importante porque al arrastrar el gizmo el "picking actual" puede ser el del gizmo.
  // intersectionMouseMesh(mesh) usa la posiciÃ³n actual del mouse ya seteada en main.
  const hit = picking.intersectionMouseMesh(mesh);
  if (!hit) return null;
  picking.computePickedNormal();
  const nLocal = picking.getPickedNormal();
  if (!nLocal) return null;

  // Normal local -> world (usar mat3 del scaleRot y normalizar)
  const m4 = mesh.getMatrix();
  const m3 = mat3.create();
  mat3.fromMat4(m3, m4);
  const nWorld = vec3.create();
  vec3.transformMat3(nWorld, nLocal, m3);
  _normalize3(nWorld, nWorld);

  // Elegir un vector auxiliar para construir tangente (evitar paralelismo)
  const up = Math.abs(nWorld[1]) < 0.95 ? vec3.fromValues(0,1,0) : vec3.fromValues(1,0,0);
  const x = vec3.create();
  vec3.cross(x, up, nWorld);
  if (Math.hypot(x[0],x[1],x[2]) < 1e-6) return null;
  _normalize3(x, x);
  const y = vec3.create();
  vec3.cross(y, nWorld, x);
  _normalize3(y, y);

  return { x, y, z: nWorld };
}

function _axisMaskToActivatedType(mode, mask) {
  // mode: 'move' | 'rotate' | 'scale' | 'universal'
  const X = mask.x ? 1 : 0;
  const Y = mask.y ? 1 : 0;
  const Z = mask.z ? 1 : 0;

  // Bits del Gizmo (no exporta "PLANE_*" pÃºblicamente, pero sÃ­ TRANS/ROT/SCALE constantes).
  // Usamos getters estÃ¡ticos que existen en Gizmo.js.
  const T = (X ? Gizmo.TRANS_X : 0) | (Y ? Gizmo.TRANS_Y : 0) | (Z ? Gizmo.TRANS_Z : 0);
  const R = (X ? Gizmo.ROT_X : 0) | (Y ? Gizmo.ROT_Y : 0) | (Z ? Gizmo.ROT_Z : 0);
  const S = (X ? Gizmo.SCALE_X : 0) | (Y ? Gizmo.SCALE_Y : 0) | (Z ? Gizmo.SCALE_Z : 0);

  // IMPORTANTE: no incluimos planos por defecto (PLANE_*) porque capturan clicks y rompen la cÃ¡mara.
  // Si quieres planos luego, lo agregamos como opciÃ³n extra.
  if (mode === 'move') return T;
  if (mode === 'rotate') return R | Gizmo.ROT_W; // ROT_W (arco libre) Ãºtil, no rompe cÃ¡mara
  if (mode === 'scale') return S | Gizmo.SCALE_W;
  // universal
  return (T | R | S | Gizmo.ROT_W | Gizmo.SCALE_W);
}

// ---- Monkey-patch (una sola vez) ----
const PATCH_KEY = '__advancedGizmoPatchV4__';

function patchGizmoPrototype() {
  const proto = Gizmo.prototype;
  if (proto[PATCH_KEY]) return;
  proto[PATCH_KEY] = true;

  // Guardamos originales
  const _origUpdateMatrices = proto._updateMatrices;
  const _origStartTranslateEdit = proto._startTranslateEdit;
  const _origUpdateTranslateEdit = proto._updateTranslateEdit;
  const _origUpdatePlaneEdit = proto._updatePlaneEdit;

  // Utilidad en la instancia: obtener orientaciÃ³n deseada (mat4 rotaciÃ³n)
  proto._ag_getOrientMat = function () {
    const main = this._main;
    const mode = this._ag_orientMode || 'global';
    if (mode === 'global') return null;

    const mesh = main.getMesh && main.getMesh();
    if (!mesh) return null;

    if (mode === 'local') {
      const basis = _extractBasisFromMat4(mesh.getMatrix());
      return _basisToMat4(basis);
    }

    if (mode === 'normal') {
      const basis = _computeSurfaceNormalBasis(main);
      if (!basis) return null;
      return _basisToMat4(basis);
    }

    return null;
  };

  // Devuelve direcciÃ³n world del eje X/Y/Z segÃºn orientaciÃ³n activa
  proto._ag_getAxisWorld = function (axisIndex) {
    const R = this._ag_cachedOrientMat; // mat4 rot
    if (!R) {
      // global
      if (axisIndex === 0) return vec3.fromValues(1,0,0);
      if (axisIndex === 1) return vec3.fromValues(0,1,0);
      return vec3.fromValues(0,0,1);
    }
    // columnas del mat4
    if (axisIndex === 0) return vec3.fromValues(R[0], R[1], R[2]);
    if (axisIndex === 1) return vec3.fromValues(R[4], R[5], R[6]);
    return vec3.fromValues(R[8], R[9], R[10]);
  };

  // 1) VISUAL: rotar gizmo completo (traScale * R) si Local/Normal
  proto._updateMatrices = function () {
    // Calcula matrices y escala como siempre
    _origUpdateMatrices.call(this);

    // Pero si hay modo local/normal, re-calculamos el "mat base" y lo aplicamos
    // sin tocar la lÃ³gica de tamaÃ±o/screen-constant.
    // Para no duplicar todo el mÃ©todo, reconstruimos el mat que usa updateFinalMatrix:
    // usamos el centro ya computado (en _computeCenterGizmo) dentro de _origUpdateMatrices
    // NO disponible directamente => por eso hacemos una segunda pasada compacta.

    const R = this._ag_getOrientMat();
    this._ag_cachedOrientMat = R;

    if (!R) return; // global, ya estÃ¡

    const camera = this._main.getCamera();
    const trMesh = this._computeCenterGizmo(); // center world
    const eye = camera.computePosition();

    this._lastDistToEye = this._isEditing ? this._lastDistToEye : vec3.dist(eye, trMesh);
    const scaleFactor = (this._lastDistToEye * 80.0) / camera.getConstantScreen();

    const traScale = mat4.create();
    mat4.translate(traScale, traScale, trMesh);
    mat4.scale(traScale, traScale, [scaleFactor, scaleFactor, scaleFactor]);

    // mat = traScale * R
    const mat = mat4.create();
    mat4.mul(mat, traScale, R);

    // volver a setear matrices finales con orientaciÃ³n (sin cambiar arc rotation; ya se hizo)
    this._transX.updateFinalMatrix(mat);
    this._transY.updateFinalMatrix(mat);
    this._transZ.updateFinalMatrix(mat);

    this._planeX.updateFinalMatrix(mat);
    this._planeY.updateFinalMatrix(mat);
    this._planeZ.updateFinalMatrix(mat);

    this._rotX.updateFinalMatrix(mat);
    this._rotY.updateFinalMatrix(mat);
    this._rotZ.updateFinalMatrix(mat);
    this._rotW.updateFinalMatrix(traScale); // arco libre debe seguir en view-space (como el original)

    this._scaleX.updateFinalMatrix(mat);
    this._scaleY.updateFinalMatrix(mat);
    this._scaleZ.updateFinalMatrix(mat);
    this._scaleW.updateFinalMatrix(mat);
  };

  // 2) TRASLACIÃ“N: hacer que el eje/plano de intersecciÃ³n siga la orientaciÃ³n del gizmo
  proto._startTranslateEdit = function () {
    // Guardar matrices de ediciÃ³n igual que siempre (usa editScaleRotInv)
    this._saveEditMatrices();

    const main = this._main;
    const camera = main.getCamera();
    const origin = this._editLineOrigin;
    const dir = this._editLineDirection;

    // center
    this._computeCenterGizmo(origin);

    // direcciÃ³n world del eje seleccionado segÃºn orientaciÃ³n
    const nbAxis = this._selected._nbAxis;
    const axisWorld = (nbAxis === -1) ? vec3.fromValues(0,0,0) : this._ag_getAxisWorld(nbAxis);

    const p2 = vec3.create();
    vec3.add(p2, origin, axisWorld);

    // project
    vec3.copy(origin, camera.project(origin));
    vec3.copy(dir, camera.project(p2));

    vec2.normalize(dir, vec2.sub(dir, dir, origin));

    // offset (como original)
    const lastInter = this._selected._lastInter;
    vec3.transformMat4(lastInter, lastInter, this._selected._finalMatrix);
    vec3.copy(lastInter, camera.project(lastInter));

    vec2.sub(this._editOffset, lastInter, origin);
    vec2.set(this._editLineOrigin, main._mouseX, main._mouseY);
  };

  // 3) Update translate (lÃ­nea-lÃ­nea) con direcciÃ³n del eje orientada
  proto._updateTranslateEdit = function () {
    const main = this._main;
    const camera = main.getCamera();

    const origin2d = this._editLineOrigin;
    const dir2d = this._editLineDirection;

    let vec2d = [main._mouseX, main._mouseY, 0.0];
    vec2.sub(vec2d, vec2d, origin2d);
    vec2.sub(vec2d, vec2d, this._editOffset);
    vec2.scaleAndAdd(vec2d, origin2d, dir2d, vec2.dot(vec2d, dir2d));

    // helper line
    this._updateLineHelper(origin2d[0], origin2d[1], vec2d[0], vec2d[1]);

    // unproject ray
    const near = camera.unproject(vec2d[0], vec2d[1], 0.0);
    const far = camera.unproject(vec2d[0], vec2d[1], 0.1);

    vec3.transformMat4(near, near, this._editTransInv);
    vec3.transformMat4(far, far, this._editTransInv);

    // ray dir
    const rayDir = vec3.create();
    vec3.normalize(rayDir, vec3.sub(rayDir, far, near));

    // axis direction in editTransInv space (world centered)
    const nbAxis = this._selected._nbAxis;
    const axisWorld = (nbAxis === -1) ? vec3.fromValues(0,0,0) : this._ag_getAxisWorld(nbAxis);
    const axis = vec3.clone(axisWorld);
    _normalize3(axis, axis);

    // line-line closest points between:
    // L0: near + t*rayDir
    // L1: 0 + s*axis    (axis line through origin in centered space)
    const a01 = -vec3.dot(rayDir, axis);
    const b0 = vec3.dot(near, rayDir);
    const b1 = -vec3.dot(near, axis);
    const det = 1.0 - a01 * a01;
    if (Math.abs(det) < 1e-8) return false;
    const s = (a01 * b0 - b1) / det;

    const inter = vec3.create();
    vec3.scale(inter, axis, s);

    this._updateMatrixTranslate(inter);
    main.render();
  };

  // 4) Plane edit (mover en 2 ejes, bloqueando uno) con normal orientada
  proto._updatePlaneEdit = function () {
    const main = this._main;
    const camera = main.getCamera();

    const vec2d = [main._mouseX, main._mouseY, 0.0];
    vec2.sub(vec2d, vec2d, this._editOffset);

    this._updateLineHelper(
      this._editLineOrigin[0],
      this._editLineOrigin[1],
      main._mouseX,
      main._mouseY
    );

    const near = camera.unproject(vec2d[0], vec2d[1], 0.0);
    const far = camera.unproject(vec2d[0], vec2d[1], 0.1);

    vec3.transformMat4(near, near, this._editTransInv);
    vec3.transformMat4(far, far, this._editTransInv);

    const nbAxis = this._selected._nbAxis;
    const nWorld = (nbAxis === -1) ? vec3.fromValues(0,0,0) : this._ag_getAxisWorld(nbAxis);
    const planeN = vec3.clone(nWorld);
    _normalize3(planeN, planeN);

    const dist1 = vec3.dot(near, planeN);
    const dist2 = vec3.dot(far, planeN);
    if (dist1 === dist2) return false;

    const val = -dist1 / (dist2 - dist1);
    const inter = vec3.create();
    inter[0] = near[0] + (far[0] - near[0]) * val;
    inter[1] = near[1] + (far[1] - near[1]) * val;
    inter[2] = near[2] + (far[2] - near[2]) * val;

    this._updateMatrixTranslate(inter);
    main.render();
  };
}

// ---- Plugin ----
export default class AdvancedGizmoPlugin {
  constructor(api) {
    this.api = api;
    this._mode = 'universal'; // move|rotate|scale|universal
    this._space = 'global'; // global|local|normal
    this._axisMask = { x: true, y: true, z: true };
  }

  init() {
    patchGizmoPrototype();

    const api = this.api;
    const main = api.main;

    // Asegurar que el gizmo actual (tool Transform) tome settings
    const applyToCurrentGizmo = () => {
      try {
        const sm = main.getSculptManager && main.getSculptManager();
        const tool = sm && sm.getCurrentTool && sm.getCurrentTool();
        // El Transform tool guarda this._gizmo
        const gizmo = tool && tool._gizmo;
        if (!gizmo) return;

        gizmo._ag_orientMode = this._space;
        gizmo.setActivatedType(_axisMaskToActivatedType(this._mode, this._axisMask));
        main.render();
      } catch (e) { /* ignore */ }
    };

    // UI: acciones simples (tu API actual solo garantiza addGuiAction)
    const menu = 'Gizmo+';

    api.addGuiAction(menu, `Modo: ${this._labelMode()}`, () => {
      this._mode = this._nextMode(this._mode);
      this._refreshMenu(menu);
      applyToCurrentGizmo();
    });

    api.addGuiAction(menu, `Espacio: ${this._labelSpace()}`, () => {
      this._space = this._nextSpace(this._space);
      this._refreshMenu(menu);
      applyToCurrentGizmo();
    });

    api.addGuiAction(menu, `Ejes: ${this._labelAxes()}`, () => {
      // ciclo simple de presets: XYZ -> X -> Y -> Z -> XY -> XZ -> YZ -> XYZ
      const presets = [
        { x: true, y: true, z: true },
        { x: true, y: false, z: false },
        { x: false, y: true, z: false },
        { x: false, y: false, z: true },
        { x: true, y: true, z: false },
        { x: true, y: false, z: true },
        { x: false, y: true, z: true },
      ];
      const cur = this._axisMask;
      let idx = presets.findIndex(p => p.x===cur.x && p.y===cur.y && p.z===cur.z);
      idx = (idx + 1) % presets.length;
      this._axisMask = presets[idx];
      this._refreshMenu(menu);
      applyToCurrentGizmo();
    });

    api.addGuiAction(menu, 'Refrescar UI Gizmo+', () => {
      this._refreshMenu(menu, true);
      applyToCurrentGizmo();
    });

    // aplicar al inicio
    applyToCurrentGizmo();
  }

  _labelMode() {
    return this._mode === 'move' ? 'Mover'
      : this._mode === 'rotate' ? 'Rotar'
      : this._mode === 'scale' ? 'Escalar'
      : 'Universal';
  }

  _labelSpace() {
    return this._space === 'global' ? 'Global'
      : this._space === 'local' ? 'Local'
      : 'Normal';
  }

  _labelAxes() {
    const a = this._axisMask;
    return `${a.x?'X':''}${a.y?'Y':''}${a.z?'Z':''}` || 'â€”';
  }

  _nextMode(m) {
    if (m === 'universal') return 'move';
    if (m === 'move') return 'rotate';
    if (m === 'rotate') return 'scale';
    return 'universal';
  }

  _nextSpace(s) {
    if (s === 'global') return 'local';
    if (s === 'local') return 'normal';
    return 'global';
  }

  _refreshMenu(menuName, hard) {
    // Con tu API actual no hay update de labels; esto es solo informativo:
    // los labels se ven "fijos" hasta que refrescas la pÃ¡gina.
    // Para que no sea confuso, dejamos un botÃ³n "Refrescar UI Gizmo+".
    // Si luego agregas api.updateGuiLabel(...), aquÃ­ lo conectamos.
    if (hard) {
      console.log('[Gizmo+] Estado:', {
        modo: this._mode,
        espacio: this._space,
        ejes: this._axisMask
      });
    }
  }
}
