// PolyModePlugin.js
export default class PolyModePlugin {
  constructor(api) {
    this.api = api;
    this.mode = 'FACE'; // VERTEX | EDGE | FACE
    this.topology = null; // Estructura de adyacencia
    this.selection = new Set();
  }

  init() {
    this._patchSculptManager();
    this._patchMeshDisplay();
    this._buildAdvancedUI();
  }

  // --- INTERVENCIÓN DEL SISTEMA DE SELECCIÓN ---
  
  _patchSculptManager() {
    const main = this.api.main || this.api.getScene();
    const sculpt = main.getSculptManager();
    
    // Sobrescribimos el click para capturar componentes en lugar de pintar máscaras
    const originalOnMouseDown = main.onMouseDown.bind(main);
    
    main.onMouseDown = (e) => {
      if (this.api.activePlugin === 'PolyMode') {
        this._handleSubObjectSelection(e);
        return; // Detenemos la propagación a la escultura normal
      }
      originalOnMouseDown(e);
    };
  }

  // --- LÓGICA DE TOPOLOGÍA (Estilo Three.js / Blender) ---

  _buildTopology(mesh) {
    const faces = mesh.getFaces();
    const nbVertices = mesh.getNbVertices();
    // Mapa de Adyacencia: Vértice -> [Lista de Caras que lo contienen]
    const vToF = Array.from({ length: nbVertices }, () => []);
    
    for (let i = 0; i < faces.length / 3; i++) {
      vToF[faces[i * 3]].push(i);
      vToF[faces[i * 3 + 1]].push(i);
      vToF[faces[i * 3 + 2]].push(i);
    }
    this.topology = vToF;
  }

  growSelection(mesh) {
    if (!this.topology) this._buildTopology(mesh);
    const newSelection = new Set(this.selection);
    const faces = mesh.getFaces();

    this.selection.forEach(faceIdx => {
      // Por cada cara seleccionada, buscamos sus 3 vértices
      for (let i = 0; i < 3; i++) {
        const vIdx = faces[faceIdx * 3 + i];
        // Buscamos todas las caras que comparten esos vértices
        this.topology[vIdx].forEach(neighborFace => newSelection.add(neighborFace));
      }
    });

    this.selection = newSelection;
    this._syncVisuals(mesh);
  }

  // --- RENDERIZADO (Integración visual) ---

  _syncVisuals(mesh) {
    const mask = mesh.getMaskArray();
    mask.fill(0.0);
    const fAr = mesh.getFaces();

    // Visualizamos la selección usando el canal de Máscara de SculptGL
    this.selection.forEach(fIdx => {
      mask[fAr[fIdx * 3]] = 1.0;
      mask[fAr[fIdx * 3 + 1]] = 1.0;
      mask[fAr[fIdx * 3 + 2]] = 1.0;
    });

    mesh.updateGeometry();
    this.api.render();
  }

  _buildAdvancedUI() {
    const add = this.api.addGuiAction.bind(this.api);
    add('PolyMode', 'Modo: Vértices', () => { this.mode = 'VERTEX'; });
    add('PolyMode', 'Modo: Caras', () => { this.mode = 'FACE'; });
    add('PolyMode', 'CRECER Selección (+)', () => {
      const mesh = this.api.main.getSelectedMeshes()[0];
      if(mesh) this.growSelection(mesh);
    });
  }
}
