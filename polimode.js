export default class PolyModeMask {
  constructor(api) {
    this.api = api;
    this.active = false;
    this.selection = new Set();
  }

  init() {
    // Esperamos un momento para asegurar la carga
    setTimeout(() => {
      this._injectUI();
      this._overrideInput(); // Intervención quirúrgica del input
      console.log("PolyMode Mask: Integrado con el sistema nativo de máscaras.");
    }, 500);
  }

  // =================================================================
  // 1. INTERVENCIÓN DEL INPUT (Inspirado en el core de SculptGL)
  // =================================================================
  _overrideInput() {
    const main = this.api.main;
    const originalOnDeviceDown = main.onDeviceDown.bind(main);

    // Reemplazamos el manejador de entrada principal
    main.onDeviceDown = (event) => {
      // Si NO estamos en modo selección, dejamos pasar el evento normal
      if (!this.active) {
        return originalOnDeviceDown(event);
      }

      // --- MODO SELECCIÓN ACTIVO ---
      
      // 1. Obtener la malla
      const mesh = main.getMesh();
      if (!mesh) return;

      // 2. Cálculo de Coordenadas para iPad Retina (La parte crítica)
      // SculptGL usa coordenadas físicas (pixels reales), no lógicas (css pixels).
      const canvas = main.getCanvas();
      const rect = canvas.getBoundingClientRect();
      const pr = window.devicePixelRatio || 1.0;
      
      // Coordenada X e Y exactas en el buffer WebGL
      const mx = (event.clientX - rect.left) * pr;
      const my = (event.clientY - rect.top) * pr;

      // 3. Picking (Raycasting)
      const picking = main.getPicking();
      
      // intersectionMouse espera coordenadas ya escaladas por el PixelRatio
      if (picking.intersectionMouse(mesh, mx, my)) {
        const faceIdx = picking._idId; // ID de la cara seleccionada
        
        // 4. Lógica de Selección
        this._toggleFace(mesh, faceIdx);
        
        // 5. BLOQUEO: Evitamos que SculptGL procese esto como un trazo de escultura
        event.stopPropagation();
        event.preventDefault();
        return; 
      }
    };
  }

  // =================================================================
  // 2. LÓGICA DE MÁSCARA (Basada en mask.js)
  // =================================================================
  _toggleFace(mesh, faceIdx) {
    // Actualizamos nuestro Set lógico
    if (this.selection.has(faceIdx)) {
      this.selection.delete(faceIdx);
    } else {
      this.selection.add(faceIdx);
    }

    // Actualizamos el array visual nativo
    this._updateMaskVisuals(mesh);
  }

  _updateMaskVisuals(mesh) {
    // Obtenemos el array de máscaras nativo (Float32Array)
    // Si no existe, SculptGL lo crea automáticamente al llamarlo
    const mask = mesh.getMaskArray(); 
    const faces = mesh.getFaces();
    
    // 1. Resetear máscara (llenar de ceros)
    mask.fill(0.0);

    // 2. Pintar selección (1.0 = Rojo intenso / Seleccionado)
    this.selection.forEach(fIdx => {
      // Un triángulo tiene 3 vértices
      const v1 = faces[fIdx * 3];
      const v2 = faces[fIdx * 3 + 1];
      const v3 = faces[fIdx * 3 + 2];

      mask[v1] = 1.0;
      mask[v2] = 1.0;
      mask[v3] = 1.0;
    });

    // 3. IMPORTANTE: Avisar al motor que actualice la geometría
    // Esto es lo que 'mask.js' hace para que se vea el cambio
    if (mesh.updateGeometry) mesh.updateGeometry(); // Actualiza buffers
    else if (mesh.updateBuffers) mesh.updateBuffers(); // Fallback para versiones viejas
    
    // Asegurarse de que el renderizado de máscaras esté activo en el shader
    // (A veces SculptGL optimiza y no lo dibuja si cree que está vacío)
    if (mesh.setShowMask) mesh.setShowMask(true);

    this.api.render();
  }

  // =================================================================
  // 3. INTERFAZ DE USUARIO
  // =================================================================
  _injectUI() {
    // Botón en la barra superior
    const topBar = document.querySelector('.gui-topbar');
    if (topBar && !document.getElementById('pm-mask-btn')) {
      const btn = document.createElement('button');
      btn.id = 'pm-mask-btn';
      btn.innerText = '🖌️ SCULPT';
      btn.style = `
        background: #333; color: #fff; border: 1px solid #555; 
        padding: 6px 12px; margin-left: 15px; border-radius: 4px; 
        font-weight: bold; cursor: pointer; display: inline-flex; align-items: center;
      `;
      
      btn.onclick = () => {
        this.active = !this.active;
        if (this.active) {
          btn.innerText = '🟥 SELECT FACE';
          btn.style.background = '#d00'; // Rojo para indicar máscara
          btn.style.borderColor = '#ff5555';
          this.api.main.setCanvasCursor('crosshair');
        } else {
          btn.innerText = '🖌️ SCULPT';
          btn.style.background = '#333';
          btn.style.borderColor = '#555';
          this.api.main.setCanvasCursor('default');
          
          // Opcional: Limpiar máscara al salir
          // this.selection.clear(); 
          // this._updateMaskVisuals(this.api.main.getMesh());
        }
      };

      topBar.appendChild(btn);
    }
    
    // Acciones extra
    this.api.addGuiAction('PolyMode', 'Limpiar Selección', () => {
      this.selection.clear();
      const mesh = this.api.main.getMesh();
      if (mesh) this._updateMaskVisuals(mesh);
    });
    
    this.api.addGuiAction('PolyMode', 'Invertir Selección', () => {
       const mesh = this.api.main.getMesh();
       if(!mesh) return;
       const nbFaces = mesh.getNbFaces();
       const newSel = new Set();
       for(let i=0; i<nbFaces; i++) {
           if(!this.selection.has(i)) newSel.add(i);
       }
       this.selection = newSel;
       this._updateMaskVisuals(mesh);
    });
  }
}
