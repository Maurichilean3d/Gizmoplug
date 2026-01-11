export default class PolyModePlugin {
  constructor(api) {
    this.api = api;
    this.activeMode = 'SCULPT'; // Modos: SCULPT, VERTEX, FACE
    this.selection = new Set();
    this.topology = null;
  }

  init() {
    // 1. Añadir al menú lateral "Tools" de SculptGL
    this._setupSidebarMenu();

    // 2. Inyectar la barra de herramientas en la parte superior (UI externa)
    this._injectTopBar();

    // 3. Preparar los eventos del mouse para capturar clics
    this._setupInteraction();
    
    console.log("PolyMode Plugin: Cargado e Integrado en la interfaz.");
  }

  // --- INTEGRACIÓN EN EL MENÚ LATERAL (SIDEBAR) ---
  _setupSidebarMenu() {
    // addGuiAction(Carpeta, Etiqueta, Función)
    const add = this.api.addGuiAction.bind(this.api);

    add('PolyMode: Operaciones', 'Expandir Selección (+)', () => this._modifySelection('GROW'));
    add('PolyMode: Operaciones', 'Contraer Selección (-)', () => this._modifySelection('SHRINK'));
    add('PolyMode: Operaciones', 'Seleccionar Isla (L)', () => this._modifySelection('ISLAND'));
    add('PolyMode: Operaciones', 'Invertir Selección', () => this._modifySelection('INVERT'));
    add('PolyMode: Operaciones', 'Limpiar Selección', () => {
      this.selection.clear();
      this._updateVisuals();
    });
  }

  // --- INTEGRACIÓN EN LA BARRA SUPERIOR (TOPBAR) ---
  _injectTopBar() {
    // Buscamos el contenedor de la barra superior de SculptGL
    const topBar = document.querySelector('.gui-topbar');
    if (!topBar) return;

    // Crear el contenedor de botones de modo
    const modeContainer = document.createElement('div');
    modeContainer.style = "display: inline-flex; margin-left: 20px; border-left: 1px solid #555; padding-left: 15px;";
    modeContainer.id = "poly-mode-selector";

    const modes = [
      { id: 'SCULPT', icon: '🖌️', label: 'Esculpir' },
      { id: 'VERTEX', icon: '⚫', label: 'Vértices' },
      { id: 'FACE',   icon: '🟦', label: 'Caras' }
    ];

    modes.forEach(m => {
      const btn = document.createElement('button');
      btn.innerHTML = `${m.icon} ${m.label}`;
      btn.style = "background: #333; color: white; border: 1px solid #444; margin-right: 5px; cursor: pointer; padding: 4px 8px; font-size: 11px;";
      btn.id = `btn-mode-${m.id}`;
      
      if (m.id === 'SCULPT') btn.style.borderColor = '#00ffcc';

      btn.onclick = () => this._switchMode(m.id);
      modeContainer.appendChild(btn);
    });

    topBar.appendChild(modeContainer);
  }

  _switchMode(newMode) {
    this.activeMode = newMode;
    
    // Actualizar feedback visual de los botones
    document.querySelectorAll('#poly-mode-selector button').forEach(btn => {
      btn.style.borderColor = '#444';
    });
    document.getElementById(`btn-mode-${newMode}`).style.borderColor = '#00ffcc';

    // Si no es modo Sculpt, desactivamos la herramienta de escultura actual
    const sculptMgr = this.api.main.getSculptManager();
    if (newMode !== 'SCULPT') {
      sculptMgr._currentTool = null; 
      this.api.main.setCursor('crosshair');
    } else {
      this.api.main.setCursor('default');
    }
  }

  // --- MANEJO DE SELECCIÓN POR TOPOLOGÍA ---
  _setupInteraction() {
    const main = this.api.main;
    const canvas = main._canvas;
    
    // Sobrescribimos el comportamiento del click cuando el modo no es Sculpt
    canvas.addEventListener('mousedown', (e) => {
      if (this.activeMode === 'SCULPT') return;

      const mesh = main.getSelectedMeshes()[0];
      if (!mesh) return;

      const picking = main.getPicking();
      if (picking.intersectionMouse(mesh, e.pageX, e.pageY)) {
        const faceIdx = picking._idId; // ID de la cara seleccionada

        if (this.activeMode === 'FACE') {
          if (e.shiftKey) {
            this.selection.has(faceIdx) ? this.selection.delete(faceIdx) : this.selection.add(faceIdx);
          } else {
            this.selection.clear();
            this.selection.add(faceIdx);
          }
        }
        // Aquí se añadiría lógica para VERTEX buscando el vértice más cercano del triángulo
        
        this._updateVisuals(mesh);
      }
    }, true);
  }

  _modifySelection(action) {
    const mesh = this.api.main.getSelectedMeshes()[0];
    if (!mesh) return;

    if (!this.topology) this._buildTopology(mesh);
    const faces = mesh.getFaces();
    let newSelection = new Set(this.selection);

    if (action === 'GROW') {
      this.selection.forEach(fIdx => {
        for (let i = 0; i < 3; i++) {
          const vIdx = faces[fIdx * 3 + i];
          this.topology[vIdx].forEach(adjFace => newSelection.add(adjFace));
        }
      });
    }

    if (action === 'ISLAND') {
      let stack = Array.from(this.selection);
      while (stack.length > 0) {
        const fIdx = stack.pop();
        for (let i = 0; i < 3; i++) {
          const vIdx = faces[fIdx * 3 + i];
          this.topology[vIdx].forEach(adjFace => {
            if (!newSelection.has(adjFace)) {
              newSelection.add(adjFace);
              stack.push(adjFace);
            }
          });
        }
      }
    }

    this.selection = newSelection;
    this._updateVisuals(mesh);
  }

  _updateVisuals(mesh = this.api.main.getSelectedMeshes()[0]) {
    if (!mesh) return;
    const mask = mesh.getMaskArray();
    const faces = mesh.getFaces();
    
    mask.fill(0.0);
    this.selection.forEach(fIdx => {
      mask[faces[fIdx * 3]] = 1.0;
      mask[faces[fIdx * 3 + 1]] = 1.0;
      mask[faces[fIdx * 3 + 2]] = 1.0;
    });

    mesh.updateGeometry();
    this.api.render();
  }

  _buildTopology(mesh) {
    const nbV = mesh.getNbVertices();
    const faces = mesh.getFaces();
    this.topology = Array.from({ length: nbV }, () => []);
    for (let i = 0; i < faces.length / 3; i++) {
      this.topology[faces[i * 3]].push(i);
      this.topology[faces[i * 3 + 1]].push(i);
      this.topology[faces[i * 3 + 2]].push(i);
    }
  }
}
