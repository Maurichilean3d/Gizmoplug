export default class PolyModePlugin {
  constructor(api) {
    this.api = api;
    this.activeMode = 'SCULPT'; 
    this.selection = new Set();
    this.topology = null;
    this.isMacOrIOS = /iPad|iPhone|iPod|Mac/.test(navigator.userAgent);
  }

  init() {
    // 1. Inyectamos la UI (Botones Arriba y Menú Lateral)
    this._injectStyles();
    this._buildTopBar();
    this._addMenuToSidebar();

    // 2. "Secuestramos" el evento pointerdown en fase de CAPTURA (antes que SculptGL)
    const canvas = this.api.getCanvas();
    if (canvas) {
      canvas.addEventListener('pointerdown', (e) => this._onPointerDown(e), true);
    }
    
    console.log("PolyMode: Listo para iPad/Desktop");
  }

  // --- LÓGICA CORE DE INTERACCIÓN ---
  _onPointerDown(e) {
    // Si estamos en modo esculpir, dejamos que SculptGL funcione normal
    if (this.activeMode === 'SCULPT') return;

    const main = this.api.main;
    const mesh = this.api.getMesh();
    if (!mesh) return;

    // --- CORRECCIÓN CRÍTICA DE COORDENADAS PARA IPAD ---
    // En lugar de calcular nosotros, forzamos a SculptGL a actualizar su posición interna
    // usando su propio método 'setMousePosition'.
    // Esto alinea perfectamente el raycast con el dedo.
    if (main.setMousePosition) {
      // Creamos un evento proxy compatible con la lógica interna de SculptGL
      const evProxy = { 
        pageX: e.pageX, 
        pageY: e.pageY, 
        clientX: e.clientX, 
        clientY: e.clientY 
      };
      main.setMousePosition(evProxy);
    }

    // Usamos las coordenadas internas que SculptGL acaba de calcular
    const mx = main._mouseX;
    const my = main._mouseY;

    const picking = this.api.getPicking();
    
    // Ejecutamos la intersección
    if (picking.intersectionMouse(mesh, mx, my)) {
      const faceIdx = picking._idId; // ID del triángulo tocado

      if (this.activeMode === 'FACE') {
        // Lógica Toggle: Si ya está, lo quita. Si no, lo pone.
        if (this.selection.has(faceIdx)) {
          this.selection.delete(faceIdx);
        } else {
          this.selection.add(faceIdx);
        }
      } 
      // Aquí se puede agregar lógica para Vértices (VERT) si se desea
      
      // Actualizamos visuales
      this._updateVisuals(mesh);

      // --- BLOQUEO DE CÁMARA ---
      // Detenemos el evento para que SculptGL no rote la cámara ni esculpa
      e.stopPropagation(); 
      e.preventDefault();
    }
  }

  // --- VISUALIZACIÓN (ROJO / MÁSCARA) ---
  _updateVisuals(mesh) {
    if (!mesh) return;
    
    // Obtenemos el array de máscaras (1.0 = Rojo Oscuro, 0.0 = Normal)
    const mask = mesh.getMaskArray();
    const faces = mesh.getFaces();
    
    // 1. Limpiamos la máscara actual (todo a 0)
    mask.fill(0.0);

    // 2. Pintamos las caras seleccionadas
    this.selection.forEach(fIdx => {
      // Un triángulo tiene 3 vértices
      const v1 = faces[fIdx * 3];
      const v2 = faces[fIdx * 3 + 1];
      const v3 = faces[fIdx * 3 + 2];
      
      mask[v1] = 1.0;
      mask[v2] = 1.0;
      mask[v3] = 1.0;
    });

    // 3. ¡IMPORTANTE! Avisar a la GPU que los colores cambiaron
    // updateMesh() a veces es pesado, updateFlatShading o updateGeometry son necesarios
    // para refrescar los buffers de color/máscara.
    mesh.updateGeometry(); 
    this.api.render();
  }

  // --- UI: MENÚ LATERAL ---
  _addMenuToSidebar() {
    this.api.addGuiAction('PolyMode', 'Expandir (+)', () => this._modifySelection('GROW'));
    this.api.addGuiAction('PolyMode', 'Invertir', () => this._invertSelection());
    this.api.addGuiAction('PolyMode', 'Limpiar (Esc)', () => {
      this.selection.clear();
      this._updateVisuals(this.api.getMesh());
    });
  }

  // --- UI: BARRA SUPERIOR ---
  _buildTopBar() {
    // Evita duplicar si recargas el script
    if (document.getElementById('pm-toolbar')) return;

    const topBar = document.querySelector('.gui-topbar');
    if (!topBar) return;

    const container = document.createElement('div');
    container.id = 'pm-toolbar';
    container.style = "display: inline-flex; align-items: center; margin-left: 10px; padding-left: 10px; border-left: 1px solid #666; height: 100%;";
    
    // Botones
    this._createBtn(container, 'SCULPT', '🖌️ Sculpt', true);
    this._createBtn(container, 'FACE', '🟥 Face', false);
    // (Opcional) this._createBtn(container, 'VERT', '⚫ Vert', false);

    topBar.appendChild(container);
  }

  _createBtn(parent, id, label, active) {
    const btn = document.createElement('button');
    btn.id = `pm-btn-${id}`;
    btn.innerText = label;
    btn.className = `pm-btn ${active ? 'active' : ''}`;
    btn.onclick = () => this._setMode(id);
    parent.appendChild(btn);
  }

  _setMode(mode) {
    this.activeMode = mode;
    
    // Actualizar estilo botones
    document.querySelectorAll('.pm-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`pm-btn-${mode}`).classList.add('active');

    const main = this.api.main;
    // Gestión del cursor y herramienta activa
    if (mode === 'SCULPT') {
      main.setCanvasCursor('default');
    } else {
      main.getSculptManager()._currentTool = -1; // Desactivar herramienta de escultura
      main.setCanvasCursor('crosshair'); // Cursor de mira
    }
  }

  // --- FUNCIONES AUXILIARES (LOGICA) ---
  _modifySelection(type) {
    const mesh = this.api.getMesh();
    if (!mesh) return;

    // Construir topología si no existe (lazy load)
    if (!this.topology || this.topology.length !== mesh.getNbVertices()) {
      this._buildTopology(mesh);
    }

    const faces = mesh.getFaces();
    const newSel = new Set(this.selection);

    if (type === 'GROW') {
      this.selection.forEach(fIdx => {
        // Busca vecinos de los 3 vértices de la cara
        for (let i = 0; i < 3; i++) {
          const vIdx = faces[fIdx * 3 + i];
          const neighbors = this.topology[vIdx]; 
          // topology[v] es un array de índices de cara
          for (let k = 0; k < neighbors.length; k++) {
            newSel.add(neighbors[k]);
          }
        }
      });
    }
    
    this.selection = newSel;
    this._updateVisuals(mesh);
  }

  _invertSelection() {
    const mesh = this.api.getMesh();
    if (!mesh) return;
    const nbFaces = mesh.getNbFaces();
    const newSel = new Set();
    
    for (let i = 0; i < nbFaces; i++) {
      if (!this.selection.has(i)) newSel.add(i);
    }
    this.selection = newSel;
    this._updateVisuals(mesh);
  }

  _buildTopology(mesh) {
    const nbV = mesh.getNbVertices();
    const faces = mesh.getFaces();
    const nbF = mesh.getNbFaces();
    
    // Array de arrays: vertice -> [lista de caras]
    this.topology = new Array(nbV);
    for(let i=0; i<nbV; i++) this.topology[i] = [];

    for (let i = 0; i < nbF; i++) {
      this.topology[faces[i * 3]].push(i);
      this.topology[faces[i * 3 + 1]].push(i);
      this.topology[faces[i * 3 + 2]].push(i);
    }
  }

  _injectStyles() {
    if (document.getElementById('pm-style')) return;
    const css = `
      .pm-btn {
        background: #222; border: 1px solid #444; color: #aaa;
        padding: 5px 10px; margin: 0 2px; border-radius: 4px; cursor: pointer;
        font-size: 12px; font-weight: bold;
      }
      .pm-btn.active {
        background: #d00; color: white; border-color: #f00;
      }
    `;
    const style = document.createElement('style');
    style.id = 'pm-style';
    style.innerText = css;
    document.head.appendChild(style);
  }
}
