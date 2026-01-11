export default class PolyModeCorePlugin {
  constructor(api) {
    this.api = api;
    this.pluginName = 'PolyMode Core';
    this.active = false;
  }

  init() {
    // Esperamos a que el motor esté 100% cargado
    setTimeout(() => {
      this._installCorePatches();
      this._installUI();
      console.log(`${this.pluginName}: Núcleo de SculptGL intervenido.`);
    }, 500);
  }

  _installCorePatches() {
    const main = this.api.main;
    const sculptManager = main.getSculptManager();
    
    // =========================================================
    // 1. INTERVENCIÓN DE INPUT (SculptGL.js -> onDeviceDown)
    // =========================================================
    // Guardamos la función original para llamarla si no estamos en modo selección
    const originalOnDeviceDown = main.onDeviceDown.bind(main);

    main.onDeviceDown = (event) => {
      // Si el plugin está activo y estamos en modo selección (FACE)
      if (this.active) {
        // 1. Forzar cálculo de coordenadas nativo (arregla el problema de iPad/Retina)
        main.setMousePosition(event);
        
        // 2. Ejecutar picking interno
        const mouseX = main._mouseX;
        const mouseY = main._mouseY;
        const mesh = main.getMesh();
        
        if (mesh) {
          const picking = main.getPicking();
          if (picking.intersectionMouse(mesh, mouseX, mouseY)) {
            const faceIdx = picking._idId;
            this._toggleFaceSelection(mesh, faceIdx);
            
            // Bloqueamos que la cámara rote o se mueva
            return; 
          }
        }
      }
      
      // Si no es modo selección, ejecutamos el comportamiento normal (esculpir/cámara)
      originalOnDeviceDown(event);
    };

    // =========================================================
    // 2. INTERVENCIÓN DEL SCULPT MANAGER (Desactivar Pincel)
    // =========================================================
    const originalStart = sculptManager.start.bind(sculptManager);
    sculptManager.start = (elem) => {
      if (this.active) return false; // Bloqueo total del pincel
      return originalStart(elem);
    };
  }

  // =========================================================
  // LÓGICA DE GEOMETRÍA (Mesh.js Manipulation)
  // =========================================================

  _toggleFaceSelection(mesh, faceIdx) {
    // Inyectamos el Set de selección en el objeto mesh si no existe
    if (!mesh._polySelection) {
      mesh._polySelection = new Set();
      // Guardamos colores originales para poder restaurar
      mesh._originalColors = new Float32Array(mesh.getColors());
    }

    const sel = mesh._polySelection;
    if (sel.has(faceIdx)) {
      sel.delete(faceIdx);
    } else {
      sel.add(faceIdx);
    }

    this._updateMeshVisuals(mesh);
  }

  _updateMeshVisuals(mesh) {
    const faces = mesh.getFaces();
    const colors = mesh.getColors(); // Referencia directa al array de colores del motor
    const sel = mesh._polySelection;

    // 1. Restaurar todo a base (Blanco o el color original si lo guardamos)
    // Para feedback claro en iPad, usaremos Gris Oscuro como base y Verde como selección
    if (sel.size > 0) {
      // Si hay selección, oscurecemos el resto para resaltar
       for (let i = 0; i < colors.length; i++) colors[i] = 0.6; // Gris base
    } else {
       // Si no hay selección, volvemos a blanco
       colors.fill(1.0);
    }

    // 2. Pintar selección (VERDE NEÓN)
    sel.forEach(fIdx => {
      const v1 = faces[fIdx * 3];
      const v2 = faces[fIdx * 3 + 1];
      const v3 = faces[fIdx * 3 + 2];
      
      const r = 0.0, g = 1.0, b = 0.0; // Verde

      // Vértice 1
      colors[v1 * 3] = r; colors[v1 * 3 + 1] = g; colors[v1 * 3 + 2] = b;
      // Vértice 2
      colors[v2 * 3] = r; colors[v2 * 3 + 1] = g; colors[v2 * 3 + 2] = b;
      // Vértice 3
      colors[v3 * 3] = r; colors[v3 * 3 + 1] = g; colors[v3 * 3 + 2] = b;
    });

    // 3. ¡CRÍTICO! Forzar subida de buffer a GPU
    // Mesh.js tiene métodos específicos para esto. Intentamos todos.
    if (mesh.updateColor) mesh.updateColor();
    if (mesh.updateBuffers) mesh.updateBuffers();
    
    // 4. Renderizar escena
    this.api.render();
  }

  _clearSelection() {
    const mesh = this.api.getMesh();
    if (!mesh || !mesh._polySelection) return;
    
    mesh._polySelection.clear();
    
    // Restaurar blanco puro
    const colors = mesh.getColors();
    colors.fill(1.0);
    
    if (mesh.updateColor) mesh.updateColor();
    this.api.render();
  }

  // =========================================================
  // INTERFAZ DE USUARIO (UI)
  // =========================================================
  _installUI() {
    this._injectCSS();
    
    // Barra superior
    const topBar = document.querySelector('.gui-topbar');
    if (topBar && !document.getElementById('pm-core-bar')) {
      const div = document.createElement('div');
      div.id = 'pm-core-bar';
      div.className = 'pm-bar';
      
      // Botón Toggle Modo
      const btn = document.createElement('button');
      btn.innerText = '🖌️ Sculpt Mode';
      btn.className = 'pm-btn';
      btn.onclick = () => {
        this.active = !this.active;
        if (this.active) {
          btn.innerText = '🟩 POLY MODE (Activo)';
          btn.classList.add('active');
          this.api.main.setCanvasCursor('crosshair');
        } else {
          btn.innerText = '🖌️ Sculpt Mode';
          btn.classList.remove('active');
          this.api.main.setCanvasCursor('default');
          this._clearSelection(); // Limpiar visuales al salir
        }
      };
      
      div.appendChild(btn);
      topBar.appendChild(div);
    }

    // Menú lateral
    this.api.addGuiAction('PolyMode', 'Limpiar Selección', () => this._clearSelection());
    this.api.addGuiAction('PolyMode', 'Invertir', () => {
        const mesh = this.api.getMesh();
        if(!mesh) return;
        if(!mesh._polySelection) mesh._polySelection = new Set();
        const nbF = mesh.getNbFaces();
        for(let i=0; i<nbF; i++) {
            if(mesh._polySelection.has(i)) mesh._polySelection.delete(i);
            else mesh._polySelection.add(i);
        }
        this._updateMeshVisuals(mesh);
    });
  }

  _injectCSS() {
    if (document.getElementById('pm-css')) return;
    const style = document.createElement('style');
    style.id = 'pm-css';
    style.innerHTML = `
      .pm-bar { display: inline-block; margin-left: 20px; border-left: 1px solid #555; padding-left: 10px; height: 100%; vertical-align: middle; }
      .pm-btn { background: #333; color: white; border: 1px solid #444; padding: 5px 10px; border-radius: 4px; cursor: pointer; font-weight: bold; font-size: 12px; }
      .pm-btn.active { background: #00AA00; border-color: #00FF00; box-shadow: 0 0 8px rgba(0,255,0,0.5); }
    `;
    document.head.appendChild(style);
  }
}
