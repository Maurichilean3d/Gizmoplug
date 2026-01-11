// ComponentSelectionPlugin.js
// Plugin for SculptGL modular plugins system
// Adds component selection (faces/edges/vertices) and converts selection to SculptGL mask.
//
// Usage (default shortcuts when plugin is Active):
//  - 1 / 2 / 3 : Vertex / Edge / Face mode
//  - Click      : Select under cursor (Shift=add, Ctrl/Cmd=subtract, Alt=toggle)
//  - Alt + Drag : Box select (Shift add, Ctrl/Cmd subtract)
//  - Ctrl/Cmd+L : Select linked (connected)
//  - Ctrl/Cmd+Plus / Ctrl/Cmd+Minus : Grow / Shrink selection
//  - Esc        : Exit selection mode (restores previous mask snapshot)
//
// Notes:
//  - This plugin uses the SculptGL per-vertex mask channel (materialsPBR[vert*3+2]) ONLY for visualization.
//    When activated, it snapshots the current mask and restores it when deactivated unless you "Commit Mask".

import { vec3, mat4 } from 'gl-matrix';

function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
function edgeKey(a, b) { return a < b ? (a + '_' + b) : (b + '_' + a); }

export default class ComponentSelectionPlugin {
  constructor(api) {
    this.api = api;
    this._active = false;
    this._mode = 'FACE'; // VERTEX | EDGE | FACE

    // selection sets
    this._selVerts = new Set();
    this._selFaces = new Set();
    this._selEdges = new Set(); // key "a_b"

    // caches (per mesh)
    this._cacheMesh = null;
    this._faces = null; // Uint32Array
    this._nbFaces = 0;
    this._nbVerts = 0;
    this._edgeToFaces = null; // Map key -> int[] faces
    this._edgeToVerts = null; // Map key -> [a,b]
    this._faceEdges = null; // Array of edge keys per face (computed)

    // mask snapshot for safe restore
    this._maskSnapshot = null;

    // DOM overlay for box selection
    this._boxDiv = null;
    this._boxStart = null;

    // bound handlers
    this._onMouseDown = this._onMouseDown.bind(this);
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onMouseUp = this._onMouseUp.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);
  }

  // ===== Plugin lifecycle =====

  init() {
    // UI actions (topbar)
    this.api.addGuiAction('Select', 'Toggle Selection Mode', () => this.toggle());
    this.api.addGuiAction('Select', 'Mode: Vertex (1)', () => this.setMode('VERTEX'));
    this.api.addGuiAction('Select', 'Mode: Edge (2)', () => this.setMode('EDGE'));
    this.api.addGuiAction('Select', 'Mode: Face (3)', () => this.setMode('FACE'));
    this.api.addGuiAction('Select', 'Select Linked (Ctrl+L)', () => this.selectLinked());
    this.api.addGuiAction('Select', 'Grow (Ctrl+Plus)', () => this.grow());
    this.api.addGuiAction('Select', 'Shrink (Ctrl+Minus)', () => this.shrink());
    this.api.addGuiAction('Select', 'Clear Selection', () => this.clearSelection());
    this.api.addGuiAction('Select', 'Commit Mask', () => this.commitMask());
    this.api.addGuiAction('Select', 'Restore Previous Mask', () => this.restoreSnapshot());

    // Listen always (lightweight), but only act when active
    const canvas = this.api.getCanvas && this.api.getCanvas();
    if (canvas) {
      canvas.addEventListener('mousedown', this._onMouseDown, true);
      window.addEventListener('mousemove', this._onMouseMove, true);
      window.addEventListener('mouseup', this._onMouseUp, true);
    }
    window.addEventListener('keydown', this._onKeyDown, true);
  }

  destroy() {
    const canvas = this.api.getCanvas && this.api.getCanvas();
    if (canvas) {
      canvas.removeEventListener('mousedown', this._onMouseDown, true);
      window.removeEventListener('mousemove', this._onMouseMove, true);
      window.removeEventListener('mouseup', this._onMouseUp, true);
    }
    window.removeEventListener('keydown', this._onKeyDown, true);

    this._removeBoxDiv();
    if (this._active) this.restoreSnapshot();
    this._active = false;
  }

  // ===== Public controls =====

  toggle() {
    if (this._active) this.deactivate();
    else this.activate();
  }

  activate() {
    if (this._active) return;
    const mesh = this.api.getMesh && this.api.getMesh();
    if (!mesh) return;

    this._active = true;
    this._cacheForMesh(mesh);
    this._snapshotMask(mesh);

    // start with empty visual selection
    this.clearSelection();
  }

  deactivate() {
    if (!this._active) return;
    this.restoreSnapshot();
    this.clearSelection(false);
    this._active = false;
    this._removeBoxDiv();
    this.api.render && this.api.render();
  }

  setMode(mode) {
    this._mode = mode;
    if (this._active) this.api.render && this.api.render();
  }

  clearSelection(updateMask = true) {
    this._selVerts.clear();
    this._selFaces.clear();
    this._selEdges.clear();
    if (updateMask) this._applySelectionToMask();
  }

  commitMask() {
    // Keep current mask as-is; just forget snapshot so "Restore" won't undo it.
    this._maskSnapshot = null;
    this.api.render && this.api.render();
  }

  restoreSnapshot() {
    const mesh = this.api.getMesh && this.api.getMesh();
    if (!mesh || !this._maskSnapshot) return;
    const mAr = mesh.getMaterials();
    if (!mAr) return;
    const nb = mesh.getNbVertices();
    for (let i = 0; i < nb; i++) {
      mAr[i * 3 + 2] = this._maskSnapshot[i];
    }
    mesh.updateMaterials && mesh.updateMaterials();
    this.api.render && this.api.render();
  }

  // ===== Core selection operations =====

  selectLinked() {
    if (!this._active) return;
    const mesh = this.api.getMesh && this.api.getMesh();
    if (!mesh) return;
    this._cacheForMesh(mesh);

    if (this._mode === 'VERTEX') {
      if (this._selVerts.size === 0) return;
      const seed = this._selVerts.values().next().value;
      const visited = new Set([seed]);
      const stack = [seed];
      const startCount = mesh.getVerticesRingVertStartCount();
      const ring = mesh.getVerticesRingVert();
      while (stack.length) {
        const v = stack.pop();
        const sc = v * 2;
        const start = startCount[sc];
        const count = startCount[sc + 1];
        for (let i = 0; i < count; i++) {
          const nv = ring[start + i];
          if (!visited.has(nv)) {
            visited.add(nv);
            stack.push(nv);
          }
        }
      }
      this._selVerts = visited;
    } else if (this._mode === 'FACE') {
      if (this._selFaces.size === 0) return;
      const seed = this._selFaces.values().next().value;
      const visited = new Set([seed]);
      const stack = [seed];
      while (stack.length) {
        const f = stack.pop();
        const edges = this._faceEdges[f] || [];
        for (const ek of edges) {
          const adj = this._edgeToFaces.get(ek);
          if (!adj) continue;
          for (const nf of adj) {
            if (!visited.has(nf)) {
              visited.add(nf);
              stack.push(nf);
            }
          }
        }
      }
      this._selFaces = visited;
    } else { // EDGE
      if (this._selEdges.size === 0) return;
      const seed = this._selEdges.values().next().value;
      const visited = new Set([seed]);
      const stack = [seed];
      // build vertex->edges adjacency on the fly
      const v2e = new Map();
      for (const ek of this._edgeToVerts.keys()) {
        const [a, b] = this._edgeToVerts.get(ek);
        if (!v2e.has(a)) v2e.set(a, []);
        if (!v2e.has(b)) v2e.set(b, []);
        v2e.get(a).push(ek);
        v2e.get(b).push(ek);
      }
      while (stack.length) {
        const ek = stack.pop();
        const [a, b] = this._edgeToVerts.get(ek);
        const neigh = (v2e.get(a) || []).concat(v2e.get(b) || []);
        for (const nek of neigh) {
          if (!visited.has(nek)) {
            visited.add(nek);
            stack.push(nek);
          }
        }
      }
      this._selEdges = visited;
    }

    this._applySelectionToMask();
  }

  grow() {
    if (!this._active) return;
    const mesh = this.api.getMesh && this.api.getMesh();
    if (!mesh) return;
    this._cacheForMesh(mesh);

    if (this._mode === 'VERTEX') {
      const startCount = mesh.getVerticesRingVertStartCount();
      const ring = mesh.getVerticesRingVert();
      const add = new Set(this._selVerts);
      for (const v of this._selVerts) {
        const sc = v * 2;
        const start = startCount[sc];
        const count = startCount[sc + 1];
        for (let i = 0; i < count; i++) add.add(ring[start + i]);
      }
      this._selVerts = add;
    } else if (this._mode === 'FACE') {
      const add = new Set(this._selFaces);
      for (const f of this._selFaces) {
        const edges = this._faceEdges[f] || [];
        for (const ek of edges) {
          const adj = this._edgeToFaces.get(ek) || [];
          for (const nf of adj) add.add(nf);
        }
      }
      this._selFaces = add;
    } else { // EDGE
      const add = new Set(this._selEdges);
      // add edges that share a vertex with any selected edge
      const selectedVerts = new Set();
      for (const ek of this._selEdges) {
        const [a, b] = this._edgeToVerts.get(ek);
        selectedVerts.add(a); selectedVerts.add(b);
      }
      for (const [ek, ab] of this._edgeToVerts.entries()) {
        if (add.has(ek)) continue;
        if (selectedVerts.has(ab[0]) || selectedVerts.has(ab[1])) add.add(ek);
      }
      this._selEdges = add;
    }

    this._applySelectionToMask();
  }

  shrink() {
    if (!this._active) return;
    const mesh = this.api.getMesh && this.api.getMesh();
    if (!mesh) return;
    this._cacheForMesh(mesh);

    if (this._mode === 'VERTEX') {
      const startCount = mesh.getVerticesRingVertStartCount();
      const ring = mesh.getVerticesRingVert();
      const keep = new Set();
      for (const v of this._selVerts) {
        const sc = v * 2;
        const start = startCount[sc];
        const count = startCount[sc + 1];
        let boundary = false;
        for (let i = 0; i < count; i++) {
          if (!this._selVerts.has(ring[start + i])) { boundary = true; break; }
        }
        if (!boundary) keep.add(v);
      }
      this._selVerts = keep;
    } else if (this._mode === 'FACE') {
      const keep = new Set();
      for (const f of this._selFaces) {
        let boundary = false;
        const edges = this._faceEdges[f] || [];
        for (const ek of edges) {
          const adj = this._edgeToFaces.get(ek) || [];
          // boundary if any adjacent face is not selected
          for (const nf of adj) {
            if (!this._selFaces.has(nf)) { boundary = true; break; }
          }
          if (boundary) break;
        }
        if (!boundary) keep.add(f);
      }
      this._selFaces = keep;
    } else { // EDGE
      const keep = new Set();
      const selectedVerts = new Map(); // v -> count of selected incident edges
      for (const ek of this._selEdges) {
        const [a, b] = this._edgeToVerts.get(ek);
        selectedVerts.set(a, (selectedVerts.get(a) || 0) + 1);
        selectedVerts.set(b, (selectedVerts.get(b) || 0) + 1);
      }
      for (const ek of this._selEdges) {
        const [a, b] = this._edgeToVerts.get(ek);
        // keep only if not on boundary: both endpoints have degree >=2 in selection
        if ((selectedVerts.get(a) || 0) >= 2 && (selectedVerts.get(b) || 0) >= 2) keep.add(ek);
      }
      this._selEdges = keep;
    }

    this._applySelectionToMask();
  }

  // ===== Input handling =====

  _onKeyDown(e) {
    if (!this._active) return;

    const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
    const ctrl = isMac ? e.metaKey : e.ctrlKey;

    if (e.key === 'Escape') {
      e.preventDefault();
      this.deactivate();
      return;
    }

    if (e.key === '1') { this.setMode('VERTEX'); return; }
    if (e.key === '2') { this.setMode('EDGE'); return; }
    if (e.key === '3') { this.setMode('FACE'); return; }

    if (ctrl && (e.key === 'l' || e.key === 'L')) { e.preventDefault(); this.selectLinked(); return; }
    if (ctrl && (e.key === '+' || e.key === '=')) { e.preventDefault(); this.grow(); return; }
    if (ctrl && (e.key === '-' || e.key === '_')) { e.preventDefault(); this.shrink(); return; }
  }

  _onMouseDown(e) {
    if (!this._active) return;
    if (e.button !== 0) return; // left only

    const canvas = this.api.getCanvas && this.api.getCanvas();
    if (!canvas) return;

    // Alt+Drag => box select
    if (e.altKey) {
      this._boxStart = { x: e.clientX, y: e.clientY, add: e.shiftKey, sub: (e.ctrlKey || e.metaKey) };
      this._ensureBoxDiv();
      this._updateBoxDiv(e.clientX, e.clientY);
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // Single pick
    const mesh = this.api.getMesh && this.api.getMesh();
    if (!mesh) return;
    const picking = this.api.getPicking && this.api.getPicking();
    if (!picking) return;

    // Update mouse coords for picking
    // SculptGL stores _mouseX/_mouseY, but we can compute relative to canvas.
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const hit = picking.intersectionMouseMeshes([mesh], mx, my);
    if (!hit) return;
    const faceId = picking.getPickedFace();
    if (faceId < 0) return;

    const inter = picking.getIntersectionPoint(); // local space of mesh
    const op = this._computeOp(e);
    this._applyPick(faceId, inter, op);

    e.preventDefault();
    e.stopPropagation();
  }

  _onMouseMove(e) {
    if (!this._active) return;
    if (!this._boxStart) return;
    this._updateBoxDiv(e.clientX, e.clientY);
    e.preventDefault();
    e.stopPropagation();
  }

  _onMouseUp(e) {
    if (!this._active) return;
    if (!this._boxStart) return;

    const canvas = this.api.getCanvas && this.api.getCanvas();
    const mesh = this.api.getMesh && this.api.getMesh();
    const cam = this.api.getCamera && this.api.getCamera();
    if (!canvas || !mesh || !cam) { this._boxStart = null; this._removeBoxDiv(); return; }

    const x0 = this._boxStart.x;
    const y0 = this._boxStart.y;
    const x1 = e.clientX;
    const y1 = e.clientY;
    const minX = Math.min(x0, x1);
    const maxX = Math.max(x0, x1);
    const minY = Math.min(y0, y1);
    const maxY = Math.max(y0, y1);

    const rect = canvas.getBoundingClientRect();
    const add = this._boxStart.add;
    const sub = this._boxStart.sub;

    const op = sub ? 'SUB' : (add ? 'ADD' : 'REPLACE');

    this._cacheForMesh(mesh);

    if (this._mode === 'VERTEX') {
      if (op === 'REPLACE') this._selVerts.clear();
      const vAr = mesh.getVertices();
      const mMat = mesh.getMatrix();
      const wpos = vec3.create();
      for (let v = 0; v < this._nbVerts; v++) {
        const iv = v * 3;
        vec3.set(wpos, vAr[iv], vAr[iv + 1], vAr[iv + 2]);
        vec3.transformMat4(wpos, wpos, mMat);
        const sp = cam.project(wpos);
        const sx = sp[0] + rect.left;
        const sy = sp[1] + rect.top;
        if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY) {
          if (op === 'SUB') this._selVerts.delete(v);
          else this._selVerts.add(v);
        }
      }
    } else if (this._mode === 'FACE') {
      if (op === 'REPLACE') this._selFaces.clear();
      const centers = mesh.getFaceCenters && mesh.getFaceCenters();
      if (centers) {
        const mMat = mesh.getMatrix();
        const wpos = vec3.create();
        for (let f = 0; f < this._nbFaces; f++) {
          const ic = f * 3;
          vec3.set(wpos, centers[ic], centers[ic + 1], centers[ic + 2]);
          vec3.transformMat4(wpos, wpos, mMat);
          const sp = cam.project(wpos);
          const sx = sp[0] + rect.left;
          const sy = sp[1] + rect.top;
          if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY) {
            if (op === 'SUB') this._selFaces.delete(f);
            else this._selFaces.add(f);
          }
        }
      }
    } else { // EDGE
      if (op === 'REPLACE') this._selEdges.clear();
      const vAr = mesh.getVertices();
      const mMat = mesh.getMatrix();
      const wA = vec3.create(), wB = vec3.create();
      for (const [ek, ab] of this._edgeToVerts.entries()) {
        const a = ab[0], b = ab[1];
        const ia = a * 3, ib = b * 3;
        vec3.set(wA, vAr[ia], vAr[ia + 1], vAr[ia + 2]);
        vec3.set(wB, vAr[ib], vAr[ib + 1], vAr[ib + 2]);
        vec3.transformMat4(wA, wA, mMat);
        vec3.transformMat4(wB, wB, mMat);
        const spA = cam.project(wA);
        const spB = cam.project(wB);
        const sx = (spA[0] + spB[0]) * 0.5 + rect.left;
        const sy = (spA[1] + spB[1]) * 0.5 + rect.top;
        if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY) {
          if (op === 'SUB') this._selEdges.delete(ek);
          else this._selEdges.add(ek);
        }
      }
    }

    this._applySelectionToMask();

    this._boxStart = null;
    this._removeBoxDiv();
    e.preventDefault();
    e.stopPropagation();
  }

  _computeOp(e) {
    const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
    const sub = isMac ? e.metaKey && e.altKey : (e.ctrlKey && e.altKey); // rare
    if (sub) return 'SUB';
    if (e.ctrlKey || e.metaKey) return 'SUB';
    if (e.shiftKey) return 'ADD';
    return 'TOGGLE';
  }

  _applyPick(faceId, inter, op) {
    const mesh = this.api.getMesh && this.api.getMesh();
    if (!mesh) return;
    this._cacheForMesh(mesh);

    if (this._mode === 'FACE') {
      if (op === 'ADD') this._selFaces.add(faceId);
      else if (op === 'SUB') this._selFaces.delete(faceId);
      else { // TOGGLE/REPLACE
        if (op === 'REPLACE') this._selFaces.clear();
        if (this._selFaces.has(faceId)) this._selFaces.delete(faceId);
        else this._selFaces.add(faceId);
      }
    } else if (this._mode === 'VERTEX') {
      const vid = this._nearestVertexInFace(mesh, faceId, inter);
      if (vid < 0) return;
      if (op === 'ADD') this._selVerts.add(vid);
      else if (op === 'SUB') this._selVerts.delete(vid);
      else {
        if (op === 'REPLACE') this._selVerts.clear();
        if (this._selVerts.has(vid)) this._selVerts.delete(vid);
        else this._selVerts.add(vid);
      }
    } else { // EDGE
      const ek = this._nearestEdgeInFace(mesh, faceId, inter);
      if (!ek) return;
      if (op === 'ADD') this._selEdges.add(ek);
      else if (op === 'SUB') this._selEdges.delete(ek);
      else {
        if (op === 'REPLACE') this._selEdges.clear();
        if (this._selEdges.has(ek)) this._selEdges.delete(ek);
        else this._selEdges.add(ek);
      }
    }

    this._applySelectionToMask();
  }

  _nearestVertexInFace(mesh, faceId, inter) {
    const fAr = this._faces;
    const base = faceId * 4;
    const ids = [fAr[base], fAr[base + 1], fAr[base + 2]];
    const id4 = fAr[base + 3];
    if (id4 !== 4294967295 && id4 !== -1) ids.push(id4); // Utils.TRI_INDEX is uint32 max in this repo

    const vAr = mesh.getVertices();
    let best = -1;
    let bestD = Infinity;
    for (const v of ids) {
      const iv = v * 3;
      const dx = vAr[iv] - inter[0];
      const dy = vAr[iv + 1] - inter[1];
      const dz = vAr[iv + 2] - inter[2];
      const d = dx*dx + dy*dy + dz*dz;
      if (d < bestD) { bestD = d; best = v; }
    }
    return best;
  }

  _nearestEdgeInFace(mesh, faceId, inter) {
    const fAr = this._faces;
    const base = faceId * 4;
    const v0 = fAr[base], v1 = fAr[base + 1], v2 = fAr[base + 2], v3 = fAr[base + 3];
    const ids = (v3 !== 4294967295 && v3 !== -1) ? [v0, v1, v2, v3] : [v0, v1, v2];
    const edges = [];
    for (let i = 0; i < ids.length; i++) {
      const a = ids[i];
      const b = ids[(i + 1) % ids.length];
      edges.push([a, b]);
    }

    const vAr = mesh.getVertices();
    let bestKey = null;
    let bestD = Infinity;
    const p = vec3.fromValues(inter[0], inter[1], inter[2]);
    const aV = vec3.create(), bV = vec3.create();
    for (const [a, b] of edges) {
      const ia = a * 3, ib = b * 3;
      vec3.set(aV, vAr[ia], vAr[ia + 1], vAr[ia + 2]);
      vec3.set(bV, vAr[ib], vAr[ib + 1], vAr[ib + 2]);
      const d = this._pointSegDist2(p, aV, bV);
      if (d < bestD) { bestD = d; bestKey = edgeKey(a, b); }
    }
    return bestKey;
  }

  _pointSegDist2(p, a, b) {
    const ab = vec3.create();
    vec3.sub(ab, b, a);
    const ap = vec3.create();
    vec3.sub(ap, p, a);
    const ab2 = vec3.dot(ab, ab);
    if (ab2 <= 1e-20) return vec3.sqrDist(p, a);
    let t = vec3.dot(ap, ab) / ab2;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    const proj = vec3.create();
    vec3.scaleAndAdd(proj, a, ab, t);
    return vec3.sqrDist(p, proj);
  }

  // ===== Mask application =====

  _applySelectionToMask() {
    const mesh = this.api.getMesh && this.api.getMesh();
    if (!mesh) return;
    this._cacheForMesh(mesh);

    const mAr = mesh.getMaterials();
    if (!mAr) return;

    // Reset mask to 0 for all (visual only)
    for (let i = 0; i < this._nbVerts; i++) mAr[i * 3 + 2] = 0.0;

    if (this._mode === 'VERTEX') {
      for (const v of this._selVerts) mAr[v * 3 + 2] = 1.0;
    } else if (this._mode === 'FACE') {
      for (const f of this._selFaces) {
        const base = f * 4;
        const a = this._faces[base], b = this._faces[base + 1], c = this._faces[base + 2], d = this._faces[base + 3];
        mAr[a * 3 + 2] = 1.0; mAr[b * 3 + 2] = 1.0; mAr[c * 3 + 2] = 1.0;
        if (d !== 4294967295 && d !== -1) mAr[d * 3 + 2] = 1.0;
      }
    } else { // EDGE
      for (const ek of this._selEdges) {
        const ab = this._edgeToVerts.get(ek);
        if (!ab) continue;
        mAr[ab[0] * 3 + 2] = 1.0;
        mAr[ab[1] * 3 + 2] = 1.0;
      }
    }

    mesh.updateMaterials && mesh.updateMaterials();
    this.api.render && this.api.render();
  }

  // ===== Mesh caching / topology =====

  _cacheForMesh(mesh) {
    if (this._cacheMesh === mesh && this._faces) return;

    this._cacheMesh = mesh;
    this._faces = mesh.getFaces();
    this._nbFaces = mesh.getNbFaces();
    this._nbVerts = mesh.getNbVertices();

    // build edge maps
    this._edgeToFaces = new Map();
    this._edgeToVerts = new Map();
    this._faceEdges = new Array(this._nbFaces);

    const fAr = this._faces;
    for (let f = 0; f < this._nbFaces; f++) {
      const base = f * 4;
      const v0 = fAr[base], v1 = fAr[base + 1], v2 = fAr[base + 2], v3 = fAr[base + 3];
      const ids = (v3 !== 4294967295 && v3 !== -1) ? [v0, v1, v2, v3] : [v0, v1, v2];
      const edges = [];
      for (let i = 0; i < ids.length; i++) {
        const a = ids[i];
        const b = ids[(i + 1) % ids.length];
        const ek = edgeKey(a, b);
        edges.push(ek);

        if (!this._edgeToFaces.has(ek)) this._edgeToFaces.set(ek, []);
        this._edgeToFaces.get(ek).push(f);

        if (!this._edgeToVerts.has(ek)) this._edgeToVerts.set(ek, [Math.min(a, b), Math.max(a, b)]);
      }
      this._faceEdges[f] = edges;
    }
  }

  _snapshotMask(mesh) {
    const mAr = mesh.getMaterials();
    if (!mAr) { this._maskSnapshot = null; return; }
    const nb = mesh.getNbVertices();
    const snap = new Float32Array(nb);
    for (let i = 0; i < nb; i++) snap[i] = clamp01(mAr[i * 3 + 2]);
    this._maskSnapshot = snap;
  }

  // ===== Box selection overlay =====

  _ensureBoxDiv() {
    if (this._boxDiv) return;
    const canvas = this.api.getCanvas && this.api.getCanvas();
    if (!canvas) return;
    const parent = canvas.parentElement || document.body;
    const div = document.createElement('div');
    div.style.position = 'fixed';
    div.style.pointerEvents = 'none';
    div.style.border = '1px dashed rgba(255,255,255,0.9)';
    div.style.background = 'rgba(255,255,255,0.1)';
    div.style.zIndex = '9999';
    div.style.left = '0px';
    div.style.top = '0px';
    div.style.width = '0px';
    div.style.height = '0px';
    parent.appendChild(div);
    this._boxDiv = div;
  }

  _updateBoxDiv(cx, cy) {
    if (!this._boxDiv || !this._boxStart) return;
    const x0 = this._boxStart.x;
    const y0 = this._boxStart.y;
    const minX = Math.min(x0, cx);
    const minY = Math.min(y0, cy);
    const w = Math.abs(cx - x0);
    const h = Math.abs(cy - y0);
    this._boxDiv.style.left = `${minX}px`;
    this._boxDiv.style.top = `${minY}px`;
    this._boxDiv.style.width = `${w}px`;
    this._boxDiv.style.height = `${h}px`;
  }

  _removeBoxDiv() {
    if (this._boxDiv && this._boxDiv.parentNode) this._boxDiv.parentNode.removeChild(this._boxDiv);
    this._boxDiv = null;
  }
}
