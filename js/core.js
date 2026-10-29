'use strict';
/*
  Administración de Consorcios — núcleo de datos y reglas de negocio (sin servidor).
  Port a JavaScript de la lógica de server.ps1. Funciona sobre un "store" intercambiable:
    - FolderStore  : carpeta real del disco (File System Access API, Chrome/Edge)
    - MemoryStore  : memoria (modo demo y tests)
  Interfaz del store:  name (string) · async read(tabla) -> texto|null · async write(tabla, texto)
*/
(function (root) {

  /* ---------------------------------------------------------------- Esquema */
  const SCHEMA = {
    consorcios: ['id', 'nombre', 'direccion', 'localidad', 'cuit', 'fecha_inicio_administracion', 'email_contacto', 'telefono_contacto', 'notas', 'creado'],
    personal: ['id', 'consorcio_id', 'nombre', 'rol', 'empresa', 'servicio', 'telefono', 'email', 'horario', 'observaciones'],
    unidades: ['id', 'consorcio_id', 'numero_uf', 'piso', 'departamento', 'tipo', 'observaciones'],
    propietarios: ['id', 'nombre', 'dni', 'telefono', 'telefono_alt', 'email', 'observaciones'],
    unidad_propietarios: ['id', 'unidad_id', 'propietario_id', 'porcentaje'],
    inquilinos: ['id', 'unidad_id', 'nombre', 'dni', 'telefono', 'telefono_alt', 'email', 'fecha_desde', 'fecha_hasta', 'observaciones'],
    tipos_reclamo: ['id', 'nombre', 'naturaleza', 'icono', 'activo'],
    proveedores: ['id', 'nombre', 'telefono', 'email', 'tipo', 'empresa', 'observaciones', 'activo'],
    reclamo_proveedores: ['id', 'reclamo_id', 'proveedor_id', 'fecha_asignacion', 'operador'],
    reclamos: ['id', 'consorcio_id', 'unidad_id', 'ubicacion_detalle', 'tipo_id', 'naturaleza', 'urgencia', 'titulo', 'detalle', 'fecha_reclamo', 'estado', 'etapa', 'resolucion', 'fecha_cierre', 'motivo_cierre', 'solicitante_tipo', 'solicitante_nombre', 'solicitante_contacto', 'canal', 'operador', 'actualizado'],
    reiteraciones: ['id', 'reclamo_id', 'fecha', 'solicitante_tipo', 'solicitante_nombre', 'solicitante_contacto', 'unidad_id', 'canal', 'detalle', 'operador'],
    historial: ['id', 'reclamo_id', 'fecha', 'accion', 'detalle', 'operador']
  };
  const TABLES = Object.keys(SCHEMA);
  const REQUIRED = {
    consorcios: ['nombre', 'direccion'], personal: ['consorcio_id', 'nombre', 'rol'], unidades: ['consorcio_id', 'numero_uf'],
    propietarios: ['nombre'], unidad_propietarios: ['unidad_id', 'propietario_id'], inquilinos: ['unidad_id', 'nombre'],
    tipos_reclamo: ['nombre', 'naturaleza'], proveedores: ['nombre', 'telefono']
  };
  const FKS = {
    personal: [['consorcio_id', 'consorcios']], unidades: [['consorcio_id', 'consorcios']],
    unidad_propietarios: [['unidad_id', 'unidades'], ['propietario_id', 'propietarios']], inquilinos: [['unidad_id', 'unidades']]
  };
  // Al borrar: elimina en cascada los hijos.
  const CASCADE = {
    consorcios: [['personal', 'consorcio_id'], ['unidades', 'consorcio_id']],
    unidades: [['unidad_propietarios', 'unidad_id'], ['inquilinos', 'unidad_id']],
    propietarios: [['unidad_propietarios', 'propietario_id']],
    reclamos: [['reiteraciones', 'reclamo_id'], ['historial', 'reclamo_id'], ['reclamo_proveedores', 'reclamo_id']]
  };
  // Al borrar: bloquea si existen dependientes.
  const BLOCKS = {
    consorcios: [['reclamos', 'consorcio_id', 'No se puede eliminar: el consorcio tiene reclamos registrados.']],
    unidades: [['reclamos', 'unidad_id', 'No se puede eliminar: la unidad funcional tiene reclamos registrados.']],
    tipos_reclamo: [['reclamos', 'tipo_id', 'No se puede eliminar: hay reclamos de este tipo. Desactívalo en su lugar.']],
    proveedores: [['reclamo_proveedores', 'proveedor_id', 'No se puede eliminar: el proveedor está asignado a reclamos (queda el historial). Márcalo como inactivo en su lugar.']]
  };
  const LABELS = { telefono: 'Teléfono de contacto', tipo: 'Tipo (al menos una profesión)', nombre: 'Nombre', direccion: 'Dirección', consorcio_id: 'Consorcio', rol: 'Rol', numero_uf: 'N° de UF', unidad_id: 'Unidad funcional', propietario_id: 'Propietario', naturaleza: 'Naturaleza' };
  const URGENCIAS = ['Baja', 'Media', 'Alta', 'Urgente', 'Urgente Crítico'];
  const NATURALEZAS = ['Técnico', 'Administrativo'];
  const ROLES = ['Encargado', 'Empresa de limpieza', 'Proveedor de servicios', 'Administrativo', 'Seguridad', 'Otro'];
  const TIPOS_UNIDAD = ['Departamento', 'Cochera', 'Local', 'Baulera', 'Oficina', 'Otro'];
  const CANALES = ['Teléfono', 'WhatsApp', 'Email', 'Presencial', 'Otro'];
  const SOLICITANTE_TIPOS = ['Propietario', 'Inquilino', 'Personal del consorcio', 'Otro'];
  const ETAPAS = ['Nuevo', 'En espera de visita del proveedor', 'Visitado por el proveedor', 'Esperando presupuesto', 'Presupuesto aprobado', 'Trabajo en ejecución', 'Finalizado'];
  const RESOLUCIONES = ['Resuelto', 'Desestimado', 'Anulado'];
  const PROFESIONES = ['Plomero', 'Gasista', 'Electricista', 'Fumigador', 'Mantenimiento de ascensores', 'Albañil', 'Pintor', 'Techista', 'Durlockero', 'Cerrajero', 'Jardinero', 'Piletero', 'Limpieza', 'Herrero', 'Vidriero', 'Aire acondicionado'];
  const TIPOS_SEMILLA = [
    ['Problemas de agua', 'Técnico', '💧'], ['Electricidad', 'Técnico', '⚡'], ['Ascensores', 'Técnico', '🛗'],
    ['Plagas', 'Técnico', '🐜'], ['Gas', 'Técnico', '🔥'], ['Limpieza', 'Técnico', '🧹'],
    ['Jardinería', 'Técnico', '🌿'], ['Pileta', 'Técnico', '🏊'], ['SUM', 'Técnico', '🎉'],
    ['Estructural', 'Técnico', '🏗️'], ['Seguridad / Portería', 'Técnico', '🔒'], ['Ruidos / Convivencia', 'Administrativo', '🔊'],
    ['Pagos / Expensas', 'Administrativo', '💳'], ['Consulta de facturas', 'Administrativo', '🧾'], ['Otros', 'Administrativo', '📌']
  ];

  /* ---------------------------------------------------------------- CSV */
  function csvParse(text) {
    text = String(text ?? '');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const recs = []; let row = [], cell = '', q = false, any = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += c;
      } else if (c === '"') { q = true; any = true; }
      else if (c === ',') { row.push(cell); cell = ''; any = true; }
      else if (c === '\r' || c === '\n') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        if (any || cell !== '') { row.push(cell); recs.push(row); }
        row = []; cell = ''; any = false;
      } else { cell += c; any = true; }
    }
    if (any || cell !== '') { row.push(cell); recs.push(row); }
    return recs;
  }
  function csvQuote(v) { return '"' + String(v ?? '').replace(/"/g, '""') + '"'; }
  function csvSerialize(cols, rows) {
    let out = '﻿' + cols.join(',') + '\r\n';
    for (const r of rows) out += cols.map(c => csvQuote(r[c])).join(',') + '\r\n';
    return out;
  }
  // Devuelve { header: [..], rows: [{col: valor}] } con SOLO las columnas del esquema (faltantes = '').
  function tableFromCsv(t, text) {
    const recs = csvParse(text);
    const header = (recs[0] || []).map(h => h.trim());
    const rows = [];
    for (let i = 1; i < recs.length; i++) {
      const rec = recs[i];
      if (rec.every(x => x === '')) continue;
      const o = {};
      for (const c of SCHEMA[t]) { const k = header.indexOf(c); o[c] = k >= 0 && rec[k] !== undefined ? rec[k] : ''; }
      rows.push(o);
    }
    return { header, rows };
  }

  /* ---------------------------------------------------------------- Stores */
  class MemoryStore {
    constructor(files, name = 'memoria') { this.name = name; this.files = Object.assign({}, files || {}); this.writes = []; }
    async read(t) { return Object.prototype.hasOwnProperty.call(this.files, t) ? this.files[t] : null; }
    async write(t, text) { this.files[t] = text; this.writes.push(t); }
  }

  class FolderStore {
    constructor(dirHandle) { this.dir = dirHandle; this.name = dirHandle.name; }
    async read(t) {
      let fh;
      try { fh = await this.dir.getFileHandle(t + '.csv'); }
      catch (e) { if (e && e.name === 'NotFoundError') return null; throw e; }
      return await (await fh.getFile()).text();
    }
    async write(t, text) {
      const fh = await this.dir.getFileHandle(t + '.csv', { create: true });
      const w = await fh.createWritable();   // escritura atómica: el archivo se reemplaza recién al cerrar
      try { await w.write(text); await w.close(); } catch (e) { try { await w.abort(); } catch { } throw e; }
    }
  }

  /* ---------------------------------------------------------------- Core */
  class ApiError extends Error {
    constructor(code, msg, extra) { super(msg); this.code = code; this.extra = extra || null; }
  }
  const Fail = (code, msg, extra) => { throw new ApiError(code, msg, extra); };

  const pad = n => String(n).padStart(2, '0');
  const fmtNow = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const has = (b, c) => b != null && typeof b === 'object' && Object.prototype.hasOwnProperty.call(b, c);
  const val = (b, c) => { if (!has(b, c)) return null; const v = b[c]; return v == null ? '' : String(v).trim(); };
  const str = v => (v == null ? '' : String(v));
  const norm = s => str(s).trim().toLowerCase();
  const cmp = (a, b) => str(a).localeCompare(str(b), 'es', { sensitivity: 'base' });
  const sortBy = (arr, ...keys) => arr.slice().sort((x, y) => { for (const k of keys) { const r = k(x, y); if (r) return r; } return 0; });
  const pick = (row, cols) => { const o = {}; for (const c of cols) o[c] = str(row[c]); return o; };

  class Core {
    constructor(store, opts = {}) {
      this.store = store; this.nowFn = opts.now || (() => new Date());
      this.t = {}; this.dirty = new Set(); this.queue = Promise.resolve(); this.ready = false;
    }
    now() { return fmtNow(this.nowFn()); }

    /* ---- persistencia ---- */
    async load() {
      const t = {}; const migrate = [];
      for (const name of TABLES) {
        const text = await this.store.read(name);
        if (text == null) { t[name] = []; migrate.push(name); continue; }
        const { header, rows } = tableFromCsv(name, text);
        t[name] = rows;
        if (header.join(',') !== SCHEMA[name].join(',')) migrate.push(name);   // migración de columnas
      }
      this.t = t; this.dirty = new Set(migrate);
    }
    async init() {
      await this.load();
      this.migrated = [...this.dirty];
      if (this.t.tipos_reclamo.length === 0) {
        this.t.tipos_reclamo = TIPOS_SEMILLA.map((x, i) => ({ id: String(i + 1), nombre: x[0], naturaleza: x[1], icono: x[2], activo: 'SI' }));
        this.dirty.add('tipos_reclamo');
      }
      for (const r of this.t.reclamos) {   // reclamos previos a etapas/resoluciones
        if (!r.etapa) { r.etapa = 'Nuevo'; this.dirty.add('reclamos'); }
        if (r.estado === 'Cerrado' && !r.resolucion) { r.resolucion = 'Resuelto'; this.dirty.add('reclamos'); }
      }
      await this.flush();
      this.ready = true;
    }
    async flush() {
      for (const name of [...this.dirty]) {
        await this.store.write(name, csvSerialize(SCHEMA[name], this.t[name]));
        this.dirty.delete(name);
      }
    }
    // Vuelve a leer los CSV (por si se editaron fuera de la app). Serializado con las demás operaciones.
    reload() {
      const p = this.queue.then(() => this.load());
      this.queue = p.catch(() => { });
      return p;
    }
    touchTable(t) { this.dirty.add(t); }

    /* ---- API pública ---- */
    handle(method, url, body) {
      const run = async () => {
        let res;
        try { res = { status: 200, data: this.route(method, url, body) }; }
        catch (e) {
          if (e instanceof ApiError) res = { status: e.code, data: Object.assign({ error: e.message }, e.extra || {}) };
          else { console.error(e); res = { status: 500, data: { error: 'Error interno: ' + e.message } }; }
        }
        try { await this.flush(); }
        catch (e) {
          try { await this.load(); } catch { }
          res = { status: 500, data: { error: 'No se pudo guardar en la carpeta de datos: ' + e.message } };
        }
        res.data = res.data === undefined ? null : JSON.parse(JSON.stringify(res.data));
        return res;
      };
      const p = this.queue.then(run);
      this.queue = p.catch(() => { });
      return p;
    }

    /* ---- utilidades de tablas ---- */
    nextId(rows) { let m = 0; for (const r of rows) { const n = parseInt(r.id, 10); if (Number.isFinite(n) && n > m) m = n; } return String(m + 1); }
    index(t) { const m = new Map(); for (const r of this.t[t]) m.set(String(r.id), r); return m; }
    exists(t, id) { return this.t[t].some(r => r.id === String(id)); }
    getRow(t, id) { const r = this.t[t].find(x => x.id === String(id)); if (!r) Fail(404, 'Registro no encontrado.'); return r; }
    op(body) { const o = val(body, 'operador'); return o ? o : 'Operador'; }
    unitLabel(u) {
      if (!u) return 'Áreas comunes';
      let s = `UF ${u.numero_uf}`;
      if (u.piso) s += ` · Piso ${u.piso}`;
      if (u.departamento) s += ` Dto ${u.departamento}`;
      return s;
    }
    addHist(reclamoId, accion, detalle, op) {
      const h = this.t.historial;
      h.push({ id: this.nextId(h), reclamo_id: reclamoId, fecha: this.now(), accion, detalle, operador: op });
      this.touchTable('historial');
    }

    /* ---- CRUD genérico ---- */
    buildRow(t, body, existing) {
      const h = {};
      for (const c of SCHEMA[t]) {
        if (c === 'id') continue;
        if (has(body, c)) h[c] = val(body, c);
        else if (existing) h[c] = str(existing[c]);
        else h[c] = '';
      }
      if (t === 'proveedores') {
        if (has(body, 'tipo')) {
          const raw = Array.isArray(body.tipo) ? body.tipo : String(body.tipo ?? '').split('|');
          const seen = new Set(), uniq = [];
          for (const x of raw.map(s => str(s).replace(/\|/g, ' ').trim()).filter(Boolean)) {
            const k = x.toLowerCase(); if (!seen.has(k)) { seen.add(k); uniq.push(x); }
          }
          h.tipo = uniq.join('|');
        }
        if (!h.tipo) Fail(400, 'Falta completar: tipo (al menos una profesión).');
        if (!h.activo) h.activo = 'SI';
      }
      for (const c of REQUIRED[t] || []) {
        if (!str(h[c]).trim()) Fail(400, `Falta completar: ${LABELS[c] || c}.`);
      }
      for (const [col, ref] of FKS[t] || []) {
        if (h[col] && !this.exists(ref, h[col])) Fail(400, `Referencia inválida en ${col}.`);
      }
      if (t === 'personal' && h.rol && !ROLES.includes(h.rol)) Fail(400, 'Rol inválido.');
      if (t === 'unidades' && h.tipo && !TIPOS_UNIDAD.includes(h.tipo)) Fail(400, 'Tipo de unidad inválido.');
      if (t === 'tipos_reclamo') {
        if (!NATURALEZAS.includes(h.naturaleza)) Fail(400, 'Naturaleza inválida.');
        if (!h.activo) h.activo = 'SI';
      }
      return h;
    }
    checkUnique(t, h, selfId) {
      if (t === 'unidades') {
        for (const r of this.t.unidades) {
          if (r.id !== selfId && r.consorcio_id === h.consorcio_id && r.numero_uf === h.numero_uf && r.piso === h.piso && r.departamento === h.departamento && r.tipo === h.tipo)
            Fail(409, `Ya existe la unidad UF ${h.numero_uf} en este consorcio.`);
        }
      }
      if (t === 'tipos_reclamo') {
        for (const r of this.t.tipos_reclamo) if (r.id !== selfId && r.nombre.toLowerCase() === h.nombre.toLowerCase()) Fail(409, 'Ya existe un tipo de reclamo con ese nombre.');
      }
      if (t === 'unidad_propietarios') {
        for (const r of this.t[t]) if (r.id !== selfId && r.unidad_id === h.unidad_id && r.propietario_id === h.propietario_id) Fail(409, 'El propietario ya está asignado a esta unidad.');
      }
    }
    createRow(t, body) {
      const h = this.buildRow(t, body, null);
      this.checkUnique(t, h, '');
      const row = Object.assign({ id: this.nextId(this.t[t]) }, h);
      if (t === 'consorcios') row.creado = this.now();
      this.t[t].push(row); this.touchTable(t);
      return row;
    }
    updateRow(t, id, body) {
      const cur = this.t[t].find(r => r.id === id);
      if (!cur) Fail(404, 'Registro no encontrado.');
      const h = this.buildRow(t, body, cur);
      this.checkUnique(t, h, id);
      Object.assign(cur, h); this.touchTable(t);
      return cur;
    }
    deleteRow(t, id) {
      if (!this.exists(t, id)) Fail(404, 'Registro no encontrado.');
      for (const [bt, bc, msg] of BLOCKS[t] || []) if (this.t[bt].some(r => r[bc] === id)) Fail(409, msg);
      for (const [ct, cc] of CASCADE[t] || []) for (const r of this.t[ct].filter(x => x[cc] === id)) this.deleteRow(ct, r.id);
      this.t[t] = this.t[t].filter(r => r.id !== id); this.touchTable(t);
    }

    /* ---- enriquecimientos ---- */
    propietariosDeUnidad(unidadId, links, props) {
      const out = [];
      for (const l of links) if (l.unidad_id === unidadId && props.has(l.propietario_id)) {
        const p = props.get(l.propietario_id);
        out.push({ link_id: l.id, porcentaje: l.porcentaje, id: p.id, nombre: p.nombre, telefono: p.telefono, telefono_alt: p.telefono_alt, email: p.email, dni: p.dni });
      }
      return out;
    }
    inquilinoActivo(i) { return !i.fecha_hasta || i.fecha_hasta >= this.now().slice(0, 10); }
    shapeProveedor(p) {
      const o = pick(p, SCHEMA.proveedores);
      o.tipo = str(p.tipo).split('|').filter(Boolean);
      return o;
    }
    proveedoresDeReclamo(reclamoId) {
      const provs = this.index('proveedores'); const out = [];
      for (const l of this.t.reclamo_proveedores) if (l.reclamo_id === reclamoId && provs.has(l.proveedor_id)) {
        const o = this.shapeProveedor(provs.get(l.proveedor_id)); o.link_id = l.id; o.fecha_asignacion = l.fecha_asignacion; out.push(o);
      }
      return out;
    }
    enrichReclamos(rows) {
      const cons = this.index('consorcios'), uni = this.index('unidades'), tip = this.index('tipos_reclamo'), provs = this.index('proveedores');
      const provBy = new Map();
      for (const l of this.t.reclamo_proveedores) if (provs.has(l.proveedor_id)) {
        if (!provBy.has(l.reclamo_id)) provBy.set(l.reclamo_id, []);
        const p = provs.get(l.proveedor_id);
        provBy.get(l.reclamo_id).push({ id: l.proveedor_id, nombre: p.nombre, telefono: p.telefono });
      }
      const reit = new Map(), last = new Map();
      for (const r of this.t.reiteraciones) {
        reit.set(r.reclamo_id, (reit.get(r.reclamo_id) || 0) + 1);
        if (!last.has(r.reclamo_id) || r.fecha > last.get(r.reclamo_id)) last.set(r.reclamo_id, r.fecha);
      }
      return rows.map(r => {
        const o = pick(r, SCHEMA.reclamos);
        if (!o.etapa) o.etapa = 'Nuevo';
        if (o.estado === 'Cerrado' && !o.resolucion) o.resolucion = 'Resuelto';
        o.proveedores = provBy.get(r.id) || [];
        const c = cons.get(r.consorcio_id);
        o.consorcio_nombre = c ? c.nombre : ''; o.consorcio_direccion = c ? c.direccion : '';
        o.unidad_label = this.unitLabel(uni.get(r.unidad_id) || null);
        const tp = tip.get(r.tipo_id);
        o.tipo_nombre = tp ? tp.nombre : ''; o.tipo_icono = tp ? tp.icono : '';
        o.urgencia_nivel = URGENCIAS.indexOf(r.urgencia) + 1;
        o.reiteraciones = reit.get(r.id) || 0;
        o.ultima_reiteracion = last.get(r.id) || '';
        return o;
      });
    }

    /* ---- reclamos ---- */
    findDuplicados(consorcioId, tipoId, unidadId, detalleUbic, exceptId) {
      return this.t.reclamos.filter(r => r.estado === 'Abierto' && r.id !== exceptId && r.consorcio_id === consorcioId && r.tipo_id === tipoId &&
        r.unidad_id === unidadId && norm(r.ubicacion_detalle) === norm(detalleUbic));
    }
    createReclamo(body) {
      const h = {};
      for (const c of ['consorcio_id', 'unidad_id', 'ubicacion_detalle', 'tipo_id', 'naturaleza', 'urgencia', 'titulo', 'detalle', 'fecha_reclamo', 'solicitante_tipo', 'solicitante_nombre', 'solicitante_contacto', 'canal']) {
        const v = val(body, c); h[c] = v == null ? '' : v;
      }
      for (const c of ['consorcio_id', 'tipo_id', 'urgencia', 'detalle', 'solicitante_nombre']) if (!h[c]) Fail(400, `Falta completar: ${c}.`);
      if (!this.exists('consorcios', h.consorcio_id)) Fail(400, 'Consorcio inválido.');
      const tipo = this.getRow('tipos_reclamo', h.tipo_id);
      if (!URGENCIAS.includes(h.urgencia)) Fail(400, 'Urgencia inválida.');
      if (!h.naturaleza) h.naturaleza = tipo.naturaleza;
      if (!NATURALEZAS.includes(h.naturaleza)) Fail(400, 'Naturaleza inválida.');
      if (h.unidad_id) {
        const u = this.getRow('unidades', h.unidad_id);
        if (u.consorcio_id !== h.consorcio_id) Fail(400, 'La unidad no pertenece al consorcio.');
      }
      const dups = this.findDuplicados(h.consorcio_id, h.tipo_id, h.unidad_id, h.ubicacion_detalle, '');
      if (dups.length) Fail(409, 'Ya existe un reclamo abierto para este mismo incidente. No se puede duplicar: corresponde registrar una reiteración.', { duplicados: this.enrichReclamos(dups) });
      const op = this.op(body);
      h.fecha_reclamo = h.fecha_reclamo ? h.fecha_reclamo.replace('T', ' ') : this.now();
      if (!h.titulo) h.titulo = tipo.nombre;
      if (!h.canal) h.canal = 'Teléfono';
      if (!h.solicitante_tipo) h.solicitante_tipo = 'Otro';
      const row = Object.assign({ id: this.nextId(this.t.reclamos) }, h, { estado: 'Abierto', etapa: 'Nuevo', resolucion: '', fecha_cierre: '', motivo_cierre: '', operador: op, actualizado: this.now() });
      this.t.reclamos.push(row); this.touchTable('reclamos');
      this.addHist(row.id, 'Creado', `Reclamo registrado por ${h.solicitante_nombre} (${h.solicitante_tipo}) vía ${h.canal}. Urgencia: ${h.urgencia}.`, op);
      if (has(body, 'proveedor_ids')) this.asignarProveedores(row.id, [].concat(body.proveedor_ids ?? []), op);
      return row;
    }
    asignarProveedores(reclamoId, ids, op) {
      const provs = this.index('proveedores'); const links = this.t.reclamo_proveedores;
      const toAdd = [];
      for (let provId of ids) {
        provId = str(provId);
        if (!provId) continue;
        if (!provs.has(provId)) Fail(400, 'Proveedor inválido.');
        if (links.some(l => l.reclamo_id === reclamoId && l.proveedor_id === provId) || toAdd.includes(provId)) continue;
        toAdd.push(provId);
      }
      for (const provId of toAdd) links.push({ id: this.nextId(links), reclamo_id: reclamoId, proveedor_id: provId, fecha_asignacion: this.now(), operador: op });
      if (toAdd.length) {
        this.touchTable('reclamo_proveedores');
        this.addHist(reclamoId, 'Proveedor asignado', toAdd.map(i => provs.get(i).nombre).join(', '), op);
        this.touchReclamo(reclamoId, () => { });
      }
      return toAdd;
    }
    touchReclamo(id, change) {
      const cur = this.t.reclamos.find(r => r.id === id);
      if (!cur) Fail(404, 'Reclamo no encontrado.');
      change(cur); cur.actualizado = this.now(); this.touchTable('reclamos');
      return cur;
    }
    reiterar(id, body) {
      const rec = this.getRow('reclamos', id);
      if (rec.estado !== 'Abierto') Fail(409, 'El reclamo está cerrado. Reábrelo para poder registrar una reiteración.');
      const nombre = val(body, 'solicitante_nombre'); if (!nombre) Fail(400, 'Falta completar: quién llama.');
      const detalle = val(body, 'detalle'); if (!detalle) Fail(400, 'Falta completar: detalle de lo que informa.');
      let fecha = val(body, 'fecha'); fecha = fecha ? fecha.replace('T', ' ') : this.now();
      const rows = this.t.reiteraciones;
      const row = { id: this.nextId(rows), reclamo_id: id, fecha, solicitante_tipo: val(body, 'solicitante_tipo') ?? '', solicitante_nombre: nombre, solicitante_contacto: val(body, 'solicitante_contacto') ?? '', unidad_id: val(body, 'unidad_id') ?? '', canal: val(body, 'canal') ?? '', detalle, operador: this.op(body) };
      rows.push(row); this.touchTable('reiteraciones');
      const n = rows.filter(r => r.reclamo_id === id).length;
      this.addHist(id, 'Reiteración', `Reiteración N° ${n} de ${nombre} (${row.solicitante_tipo}): ${detalle}`, this.op(body));
      const niv = val(body, 'urgencia');
      if (niv && niv !== rec.urgencia && URGENCIAS.includes(niv)) {
        const old = rec.urgencia;
        this.touchReclamo(id, r => { r.urgencia = niv; });
        this.addHist(id, 'Urgencia modificada', `De ${old} a ${niv} (al reiterar).`, this.op(body));
      } else this.touchReclamo(id, () => { });
      return row;
    }
    reclamoDetalle(id) {
      const rec = this.getRow('reclamos', id);
      const e = this.enrichReclamos([rec])[0];
      e.proveedores = this.proveedoresDeReclamo(id);
      e.reiteraciones_lista = sortBy(this.t.reiteraciones.filter(r => r.reclamo_id === id), (a, b) => cmp(b.fecha, a.fecha));
      e.historial = sortBy(this.t.historial.filter(r => r.reclamo_id === id), (a, b) => parseInt(b.id, 10) - parseInt(a.id, 10));
      return e;
    }
    resumen() {
      const all = this.enrichReclamos(this.t.reclamos);
      const abiertos = all.filter(r => r.estado === 'Abierto');
      const por_urgencia = {}; for (const u of URGENCIAS) por_urgencia[u] = abiertos.filter(r => r.urgencia === u).length;
      const d = this.nowFn();
      const hace = n => fmtNow(new Date(d.getTime() - n * 86400000));
      const hace7 = hace(7), hace30 = hace(30);
      return {
        abiertos: abiertos.length,
        cerrados: all.filter(r => r.estado === 'Cerrado').length,
        resueltos_30d: all.filter(r => r.estado === 'Cerrado' && r.resolucion === 'Resuelto' && r.fecha_cierre >= hace30).length,
        por_etapa: ETAPAS.map(e => ({ etapa: e, cantidad: abiertos.filter(r => r.etapa === e).length })),
        reiteraciones_7d: this.t.reiteraciones.filter(r => r.fecha >= hace7).length,
        consorcios: this.t.consorcios.length, unidades: this.t.unidades.length, propietarios: this.t.propietarios.length,
        por_urgencia,
        prioritarios: sortBy(abiertos, (a, b) => b.urgencia_nivel - a.urgencia_nivel, (a, b) => (a.fecha_reclamo < b.fecha_reclamo ? -1 : a.fecha_reclamo > b.fecha_reclamo ? 1 : 0)).slice(0, 8)
      };
    }

    /* ---- router ---- */
    route(method, url, body) {
      const [path, qs] = String(url).split('?');
      const q = Object.fromEntries(new URLSearchParams(qs || ''));
      const segs = path.split('/').filter(s => s !== '').map(decodeURIComponent);
      const [t, id, sub] = segs;
      const T = this.t;

      if (t === 'meta') {
        const tipos = sortBy(T.tipos_reclamo, (a, b) => parseInt(a.id, 10) - parseInt(b.id, 10));
        const profs = PROFESIONES.slice();
        for (const p of T.proveedores) for (const x of str(p.tipo).split('|')) if (x && !profs.some(y => y.toLowerCase() === x.toLowerCase())) profs.push(x);
        profs.sort(cmp);
        return { urgencias: URGENCIAS, naturalezas: NATURALEZAS, roles: ROLES, tipos_unidad: TIPOS_UNIDAD, canales: CANALES, solicitante_tipos: SOLICITANTE_TIPOS, etapas: ETAPAS, resoluciones: RESOLUCIONES, profesiones: profs, tipos_reclamo: tipos, data_dir: this.store.name };
      }
      if (t === 'resumen') return this.resumen();
      if (t === 'db') return TABLES.map(k => ({ tabla: k, archivo: k + '.csv', filas: T[k].length, columnas: SCHEMA[k] }));
      if (!SCHEMA[t]) Fail(404, 'Recurso inexistente.');

      if (t === 'reclamos') return this.routeReclamos(method, id, sub, segs, q, body);

      if (method === 'GET' && t === 'consorcios') {
        if (!id) {
          return sortBy(T.consorcios, (a, b) => cmp(a.nombre, b.nombre)).map(c => {
            const o = pick(c, SCHEMA.consorcios);
            o.unidades_count = T.unidades.filter(u => u.consorcio_id === c.id).length;
            o.personal_count = T.personal.filter(p => p.consorcio_id === c.id).length;
            o.reclamos_abiertos = T.reclamos.filter(r => r.consorcio_id === c.id && r.estado === 'Abierto').length;
            o.reclamos_total = T.reclamos.filter(r => r.consorcio_id === c.id).length;
            return o;
          });
        }
        const c = this.getRow('consorcios', id);
        const props = this.index('propietarios');
        const dirCompleta = u => `${c.direccion}` + (u.piso ? `, Piso ${u.piso}` : '') + (u.departamento ? ` Dto ${u.departamento}` : '');
        const numUf = u => parseInt('0' + str(u.numero_uf).replace(/\D/g, ''), 10);
        const unidades = sortBy(T.unidades.filter(u => u.consorcio_id === id), (a, b) => cmp(a.piso, b.piso), (a, b) => cmp(a.departamento, b.departamento), (a, b) => numUf(a) - numUf(b)).map(u => {
          const o = pick(u, SCHEMA.unidades);
          o.label = this.unitLabel(u); o.direccion_completa = dirCompleta(u);
          o.propietarios = this.propietariosDeUnidad(u.id, T.unidad_propietarios, props);
          o.inquilinos = T.inquilinos.filter(i => i.unidad_id === u.id && this.inquilinoActivo(i));
          o.reclamos_abiertos = T.reclamos.filter(r => r.unidad_id === u.id && r.estado === 'Abierto').length;
          o.reclamos_total = T.reclamos.filter(r => r.unidad_id === u.id).length;
          return o;
        });
        const o = pick(c, SCHEMA.consorcios);
        o.personal = sortBy(T.personal.filter(p => p.consorcio_id === id), (a, b) => cmp(a.rol, b.rol), (a, b) => cmp(a.nombre, b.nombre));
        o.unidades = unidades;
        o.reclamos_abiertos = T.reclamos.filter(r => r.consorcio_id === id && r.estado === 'Abierto').length;
        return o;
      }
      if (method === 'GET' && t === 'unidades' && id) {
        const u = this.getRow('unidades', id); const c = this.getRow('consorcios', u.consorcio_id);
        const o = pick(u, SCHEMA.unidades);
        o.label = this.unitLabel(u); o.consorcio_nombre = c.nombre;
        o.direccion_completa = `${c.direccion}` + (u.piso ? `, Piso ${u.piso}` : '') + (u.departamento ? ` Dto ${u.departamento}` : '');
        o.propietarios = this.propietariosDeUnidad(u.id, T.unidad_propietarios, this.index('propietarios'));
        o.inquilinos = sortBy(T.inquilinos.filter(i => i.unidad_id === id), (a, b) => cmp(b.fecha_desde, a.fecha_desde)).map(i => Object.assign(pick(i, SCHEMA.inquilinos), { activo: this.inquilinoActivo(i) }));
        o.reclamos = this.enrichReclamos(sortBy(T.reclamos.filter(r => r.unidad_id === id), (a, b) => cmp(b.fecha_reclamo, a.fecha_reclamo)));
        return o;
      }
      if (method === 'GET' && t === 'proveedores') {
        const links = T.reclamo_proveedores, recs = this.index('reclamos');
        const shape = p => {
          const o = this.shapeProveedor(p);
          const mine = links.filter(l => l.proveedor_id === p.id && recs.has(l.reclamo_id));
          o.reclamos_activos = mine.filter(l => recs.get(l.reclamo_id).estado === 'Abierto').length;
          o.reclamos_total = mine.length;
          return o;
        };
        if (id) {
          const o = shape(this.getRow('proveedores', id));
          const ids = links.filter(l => l.proveedor_id === id).map(l => l.reclamo_id);
          o.reclamos = this.enrichReclamos(sortBy(T.reclamos.filter(r => ids.includes(r.id)), (a, b) => cmp(b.fecha_reclamo, a.fecha_reclamo)));
          return o;
        }
        return sortBy(T.proveedores, (a, b) => cmp(a.nombre, b.nombre)).map(shape);
      }
      if (method === 'GET' && t === 'propietarios') {
        const uni = this.index('unidades'), cons = this.index('consorcios'), links = T.unidad_propietarios;
        const shape = p => {
          const o = pick(p, SCHEMA.propietarios);
          o.unidades = links.filter(l => l.propietario_id === p.id && uni.has(l.unidad_id)).map(l => {
            const u = uni.get(l.unidad_id); const c = cons.get(u.consorcio_id);
            return { link_id: l.id, unidad_id: u.id, consorcio_id: u.consorcio_id, consorcio_nombre: c ? c.nombre : '', label: this.unitLabel(u) };
          });
          return o;
        };
        if (id) return shape(this.getRow('propietarios', id));
        return sortBy(T.propietarios, (a, b) => cmp(a.nombre, b.nombre)).map(shape);
      }
      if (method === 'GET' && t === 'unidades') {
        let rows = T.unidades;
        if (q.consorcio_id) rows = rows.filter(r => r.consorcio_id === q.consorcio_id);
        return rows.map(u => Object.assign(pick(u, SCHEMA.unidades), { label: this.unitLabel(u) }));
      }

      switch (method) {
        case 'GET': {
          if (id) return this.getRow(t, id);
          let rows = T[t];
          for (const c of SCHEMA[t]) if (q[c]) rows = rows.filter(r => r[c] === q[c]);
          return rows.slice();
        }
        case 'POST': return this.createRow(t, body);
        case 'PUT': if (!id) Fail(400, 'Falta el id.'); return this.updateRow(t, id, body);
        case 'DELETE': if (!id) Fail(400, 'Falta el id.'); this.deleteRow(t, id); return { ok: true };
      }
      Fail(405, 'Operación no soportada.');
    }

    routeReclamos(method, id, sub, segs, q, body) {
      const T = this.t;
      if (method === 'GET' && !id) {
        let rows = T.reclamos;
        if (q.consorcio_id) rows = rows.filter(r => r.consorcio_id === q.consorcio_id);
        if (q.unidad_id) rows = rows.filter(r => r.unidad_id === q.unidad_id);
        if (q.estado) rows = rows.filter(r => r.estado === q.estado);
        return this.enrichReclamos(rows);
      }
      if (method === 'GET' && id && !sub) return this.reclamoDetalle(id);
      if (method === 'POST' && !id) return this.reclamoDetalle(this.createReclamo(body).id);
      if (id && method === 'POST' && sub === 'reiterar') { this.reiterar(id, body); return this.reclamoDetalle(id); }
      if (id && method === 'POST' && sub === 'cerrar') {
        const rec = this.getRow('reclamos', id);
        if (rec.estado !== 'Abierto') Fail(409, 'El reclamo ya está cerrado.');
        const res = val(body, 'resolucion');
        if (!RESOLUCIONES.includes(res)) Fail(400, 'Indica cómo se cierra el reclamo: Resuelto, Desestimado o Anulado.');
        const m = val(body, 'motivo'); if (!m) Fail(400, 'Indica el motivo del cierre (qué se hizo o por qué se cierra).');
        this.touchReclamo(id, r => { r.estado = 'Cerrado'; r.resolucion = res; r.fecha_cierre = this.now(); r.motivo_cierre = m; });
        this.addHist(id, `Cerrado: ${res}`, m, this.op(body));
        return this.reclamoDetalle(id);
      }
      if (id && method === 'POST' && sub === 'etapa') {
        const rec = this.getRow('reclamos', id);
        const et = val(body, 'etapa');
        if (!ETAPAS.includes(et)) Fail(400, 'Etapa inválida.');
        const old = rec.etapa || 'Nuevo';
        if (old !== et) {
          this.touchReclamo(id, r => { r.etapa = et; });
          const nota = val(body, 'detalle');
          this.addHist(id, 'Etapa', `De «${old}» a «${et}».` + (nota ? ' ' + nota : ''), this.op(body));
        }
        return this.reclamoDetalle(id);
      }
      if (id && method === 'POST' && sub === 'proveedores') {
        this.getRow('reclamos', id);
        const ids = [].concat(body && body.proveedor_ids != null ? body.proveedor_ids : []).filter(x => str(x));
        if (!ids.length) Fail(400, 'Selecciona al menos un proveedor.');
        this.asignarProveedores(id, ids, this.op(body));
        return this.reclamoDetalle(id);
      }
      if (id && method === 'DELETE' && sub === 'proveedores' && segs[3]) {
        this.getRow('reclamos', id);
        const provId = segs[3];
        const links = T.reclamo_proveedores;
        if (!links.some(l => l.reclamo_id === id && l.proveedor_id === provId)) Fail(404, 'El proveedor no está asignado a este reclamo.');
        const prov = this.getRow('proveedores', provId);
        T.reclamo_proveedores = links.filter(l => !(l.reclamo_id === id && l.proveedor_id === provId)); this.touchTable('reclamo_proveedores');
        this.addHist(id, 'Proveedor desasignado', prov.nombre, this.op(body));
        return this.reclamoDetalle(id);
      }
      if (id && method === 'POST' && sub === 'reabrir') {
        const rec = this.getRow('reclamos', id);
        if (rec.estado !== 'Cerrado') Fail(409, 'El reclamo ya está abierto.');
        const m = val(body, 'motivo'); if (!m) Fail(400, 'Indica el motivo de la reapertura.');
        const dups = this.findDuplicados(rec.consorcio_id, rec.tipo_id, rec.unidad_id, rec.ubicacion_detalle, id);
        if (dups.length) Fail(409, 'No se puede reabrir: ya hay otro reclamo abierto para el mismo incidente.', { duplicados: this.enrichReclamos(dups) });
        this.touchReclamo(id, r => { r.estado = 'Abierto'; r.resolucion = ''; r.fecha_cierre = ''; r.motivo_cierre = ''; });
        this.addHist(id, 'Reabierto', m, this.op(body));
        return this.reclamoDetalle(id);
      }
      if (id && method === 'POST' && sub === 'notas') {
        const n = val(body, 'detalle'); if (!n) Fail(400, 'Escribe la nota.');
        this.getRow('reclamos', id);
        this.addHist(id, 'Nota', n, this.op(body));
        return this.reclamoDetalle(id);
      }
      if (id && method === 'PUT') {
        const rec = this.getRow('reclamos', id);
        const cambios = [];
        const nu = val(body, 'urgencia'), nn = val(body, 'naturaleza'), nt = val(body, 'titulo'), nd = val(body, 'detalle');
        if (nu && !URGENCIAS.includes(nu)) Fail(400, 'Urgencia inválida.');
        if (nn && !NATURALEZAS.includes(nn)) Fail(400, 'Naturaleza inválida.');
        if (nu && nu !== rec.urgencia) cambios.push(`Urgencia: ${rec.urgencia} → ${nu}`);
        if (nn && nn !== rec.naturaleza) cambios.push(`Naturaleza: ${rec.naturaleza} → ${nn}`);
        if (nt && nt !== rec.titulo) cambios.push('Título editado');
        if (nd && nd !== rec.detalle) cambios.push('Detalle editado');
        this.touchReclamo(id, r => { if (nu) r.urgencia = nu; if (nn) r.naturaleza = nn; if (nt) r.titulo = nt; if (nd) r.detalle = nd; });
        if (cambios.length) this.addHist(id, 'Modificado', cambios.join('; '), this.op(body));
        return this.reclamoDetalle(id);
      }
      if (id && method === 'DELETE') { this.deleteRow('reclamos', id); return { ok: true }; }
      Fail(405, 'Operación no soportada.');
    }
  }

  root.Consorcios = { Core, ApiError, MemoryStore, FolderStore, SCHEMA, TABLES, ETAPAS, RESOLUCIONES, URGENCIAS, csvParse, csvSerialize, tableFromCsv };
})(typeof window !== 'undefined' ? window : globalThis);
