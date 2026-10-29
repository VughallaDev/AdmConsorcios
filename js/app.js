'use strict';
/* ====================== utilidades ====================== */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ls = {
  get: (k, d = '') => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { } }
};
const state = { meta: null, operador: ls.get('operador', '') };

// Sin servidor: la "API" es el núcleo de datos (core.js) que lee/escribe los CSV de la carpeta elegida.
let core = null;
async function api(method, url, body) {
  if (!core) throw new Error('No hay una carpeta de datos conectada.');
  const r = await core.handle(method, url, body === undefined ? undefined : { ...body, operador: state.operador });
  const data = r.data || {};
  if (r.status >= 400) { const e = new Error(data.error || 'Error inesperado'); e.data = data; e.status = r.status; throw e; }
  return data;
}
const GET = u => api('GET', u), POST = (u, b) => api('POST', u, b || {}), PUT = (u, b) => api('PUT', u, b), DEL = u => api('DELETE', u);

function toast(msg, err) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : ''); t.textContent = msg;
  $('#toasts').appendChild(t); setTimeout(() => t.remove(), err ? 6000 : 3200);
}
const rid = id => 'R-' + String(id).padStart(4, '0');
const uClass = u => 'u-' + String(u).replace(/ /g, '-');
const sClass = u => 'stripe-' + String(u).replace(/ /g, '-');
const fmtDate = s => s ? s.replace(/^(\d{4})-(\d{2})-(\d{2})/, '$3/$2/$1') : '';
const initials = n => String(n || '?').split(/\s+/).slice(0, 2).map(x => x[0]).join('').toUpperCase();
function antiguedad(desde) {
  if (!desde) return '';
  const d = new Date(desde), n = new Date();
  if (isNaN(d)) return '';
  let m = (n.getFullYear() - d.getFullYear()) * 12 + n.getMonth() - d.getMonth();
  if (n.getDate() < d.getDate()) m--;
  if (m < 0) return '';
  const y = Math.floor(m / 12), mm = m % 12;
  const parts = [];
  if (y) parts.push(y + (y === 1 ? ' año' : ' años'));
  if (mm || !y) parts.push(mm + (mm === 1 ? ' mes' : ' meses'));
  return parts.join(' y ');
}
const nowLocal = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const contactLine = p => [p.telefono && '📞 ' + esc(p.telefono), p.telefono_alt && '📱 ' + esc(p.telefono_alt), p.email && '✉️ ' + esc(p.email)].filter(Boolean).join(' &nbsp; ');

const etapaBadge = e => `<span class="badge etapa e${Math.max(0, state.meta.etapas.indexOf(e))}">${esc(e)}</span>`;
const resBadge = r => `<span class="badge res-${esc(r)}">${{ Resuelto: '✔', Desestimado: '⊘', Anulado: '✖' }[r] || ''} ${esc(r)}</span>`;
const chipsHtml = (name, options, selected = []) => `<div class="chips" data-chips="${name}">${options.map(o => `<label class="chip"><input type="checkbox" value="${esc(o.value ?? o)}" ${selected.includes(o.value ?? o) ? 'checked' : ''}><span>${esc(o.label ?? o)}</span></label>`).join('')}</div>`;
const chipsValue = (root, name) => $$(`[data-chips="${name}"] input:checked`, root).map(i => i.value);

/* ====================== modales y formularios ====================== */
function openModal(title, bodyHtml, { wide = false, footer = '' } = {}) {
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog"><div class="modal-head"><h2>${title}</h2><button class="x" aria-label="Cerrar">×</button></div><div class="modal-body">${bodyHtml}</div>${footer ? `<div class="modal-foot">${footer}</div>` : ''}</div>`;
  $('#modals').appendChild(ov);
  const close = () => ov.remove();
  $('.x', ov).onclick = close;
  ov.addEventListener('mousedown', e => { if (e.target === ov) ov._down = true; else ov._down = false; });
  ov.addEventListener('mouseup', e => { if (e.target === ov && ov._down) close(); });
  return { el: ov, close, $: s => $(s, ov) };
}
function fieldHtml(f, v) {
  const val = v ?? f.value ?? '';
  const req = f.required ? '<span class="req"> *</span>' : '';
  let input;
  if (f.type === 'select') {
    const opts = (f.options || []).map(o => typeof o === 'string' ? { value: o, label: o } : o);
    input = `<select name="${f.name}" ${f.required ? 'required' : ''}>${f.blank !== undefined ? `<option value="">${esc(f.blank)}</option>` : ''}${opts.map(o => `<option value="${esc(o.value)}" ${String(o.value) === String(val) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
  } else if (f.type === 'textarea') {
    input = `<textarea name="${f.name}" ${f.required ? 'required' : ''} placeholder="${esc(f.placeholder || '')}">${esc(val)}</textarea>`;
  } else {
    input = `<input name="${f.name}" type="${f.type || 'text'}" value="${esc(val)}" ${f.required ? 'required' : ''} placeholder="${esc(f.placeholder || '')}">`;
  }
  return `<div class="field ${f.full ? 'full' : ''}"><label>${esc(f.label)}${req}</label>${input}</div>`;
}
function formData(form) { const o = {}; new FormData(form).forEach((v, k) => o[k] = v); return o; }
/** Modal de formulario genérico. onSubmit(values) puede lanzar Error para mostrar el mensaje. */
function formModal({ title, fields, values = {}, submit = 'Guardar', onSubmit, wide }) {
  const m = openModal(esc(title),
    `<div id="ferr"></div><form id="f" class="form-grid">${fields.map(f => fieldHtml(f, values[f.name])).join('')}</form>`,
    { wide, footer: `<button class="btn" data-x>Cancelar</button><button class="btn primary" data-ok>${esc(submit)}</button>` });
  $('[data-x]', m.el).onclick = m.close;
  const go = async () => {
    const form = $('#f', m.el);
    if (!form.reportValidity()) return;
    const btn = $('[data-ok]', m.el); btn.disabled = true;
    try { await onSubmit(formData(form), m); }
    catch (e) { $('#ferr', m.el).innerHTML = `<div class="alert err">${esc(e.message)}</div>`; btn.disabled = false; }
  };
  $('[data-ok]', m.el).onclick = go;
  $('#f', m.el).addEventListener('submit', e => { e.preventDefault(); go(); });
  setTimeout(() => $('input,select,textarea', m.el)?.focus(), 30);
  return m;
}
function confirmBox(msg, okLabel = 'Confirmar', danger = true) {
  return new Promise(res => {
    const m = openModal('Confirmar', `<p style="margin:0">${msg}</p>`, { footer: `<button class="btn" data-x>Cancelar</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(okLabel)}</button>` });
    $('[data-x]', m.el).onclick = () => { m.close(); res(false); };
    $('.x', m.el).onclick = () => { m.close(); res(false); };
    $('[data-ok]', m.el).onclick = () => { m.close(); res(true); };
  });
}
async function safe(fn) { try { return await fn(); } catch (e) { toast(e.message, true); } }

/* ====================== router ====================== */
const routes = [];
const route = (re, fn) => routes.push([re, fn]);
let current = null;
async function render() {
  if (!core) return;
  const hash = location.hash.replace(/^#/, '') || '/inicio';
  const key = hash.split('/')[1];
  $$('#nav a').forEach(a => a.classList.toggle('on', a.dataset.k === key || (key === 'unidades' && a.dataset.k === 'consorcios')));
  for (const [re, fn] of routes) {
    const m = hash.match(re);
    if (m) {
      const token = current = {};
      $('#main').innerHTML = '<p class="muted">Cargando…</p>';
      try { await fn(...m.slice(1), () => token === current); }
      catch (e) { $('#main').innerHTML = `<div class="alert err">${esc(e.message)}</div>`; }
      return;
    }
  }
  location.hash = '#/inicio';
}
window.addEventListener('hashchange', render);
const go = h => { if (location.hash === h) render(); else location.hash = h; };

/* ====================== INICIO ====================== */
route(/^\/inicio$/, async () => {
  const r = await GET('resumen');
  const colors = { 'Baja': '#22c55e', 'Media': '#3b82f6', 'Alta': '#f59e0b', 'Urgente': '#ea580c', 'Urgente Crítico': '#dc2626' };
  const total = r.abiertos || 1;
  const urg = (r.por_urgencia['Urgente'] || 0) + (r.por_urgencia['Urgente Crítico'] || 0);
  $('#main').innerHTML = `
  <div class="page-head"><div><h1>Hola${state.operador ? ', ' + esc(state.operador) : ''} 👋</h1><p>Resumen de la operación de hoy.</p></div>
    <a class="btn primary" href="#/reclamos">📞 Registrar llamado</a></div>
  <div class="grid cols-4">
    <div class="card kpi"><div class="ico" style="background:var(--info-soft)">📂</div><div><b>${r.abiertos}</b><span>Reclamos abiertos</span></div></div>
    <div class="card kpi"><div class="ico" style="background:var(--crit-soft)">🚨</div><div><b>${urg}</b><span>Urgentes / críticos</span></div></div>
    <div class="card kpi"><div class="ico" style="background:var(--warn-soft)">🔁</div><div><b>${r.reiteraciones_7d}</b><span>Reiteraciones (7 días)</span></div></div>
    <div class="card kpi"><div class="ico" style="background:var(--ok-soft)">✅</div><div><b>${r.resueltos_30d}</b><span>Resueltos (30 días)</span></div></div>
  </div>
  <h3 class="section-title">Abiertos por etapa</h3>
  <div class="card"><div class="stages">${r.por_etapa.map((s, i) => `<div class="stage"><b>${s.cantidad}</b><span class="badge etapa e${i}">${esc(s.etapa)}</span></div>`).join('')}</div></div>
  <h3 class="section-title">Abiertos por urgencia</h3>
  <div class="card">
    <div class="bar">${state.meta.urgencias.map(u => r.por_urgencia[u] ? `<div style="width:${r.por_urgencia[u] / total * 100}%;background:${colors[u]}" title="${u}: ${r.por_urgencia[u]}"></div>` : '').join('')}</div>
    <div class="legend">${state.meta.urgencias.map(u => `<span><i class="dot" style="background:${colors[u]}"></i>${u}: <b>${r.por_urgencia[u] || 0}</b></span>`).join('')}</div>
  </div>
  <h3 class="section-title">Reclamos prioritarios</h3>
  <div id="prio">${r.prioritarios.length ? '' : '<div class="empty"><div class="big">🎉</div>No hay reclamos abiertos.</div>'}</div>
  <p class="muted small" style="margin-top:26px">${r.consorcios} consorcios · ${r.unidades} unidades funcionales · ${r.propietarios} propietarios registrados</p>`;
  r.prioritarios.forEach(c => $('#prio').appendChild(claimCard(c, { showConsorcio: true })));
});

/* ====================== RECLAMOS ====================== */
const rc = { consorcio: ls.get('consorcio', ''), tab: 'Abierto', q: '', res: '' };

route(/^\/reclamos(?:\/c(\d+))?$/, async (cid) => {
  if (cid) { rc.consorcio = cid; ls.set('consorcio', cid); }
  const consorcios = await GET('consorcios');
  if (rc.consorcio && rc.consorcio !== 'all' && !consorcios.find(c => c.id === rc.consorcio)) rc.consorcio = '';
  $('#main').innerHTML = `
  <div class="page-head"><div><h1>Reclamos</h1><p>Selecciona el consorcio desde el que están llamando y gestiona sus reclamos.</p></div>
    <button class="btn primary" id="nuevo">＋ Nuevo reclamo</button></div>
  <div class="picker"><div><label for="cons">📍 ¿Desde qué consorcio llaman?</label>
    <select id="cons"><option value="">— Selecciona un consorcio —</option>
    ${consorcios.map(c => `<option value="${c.id}" ${c.id === rc.consorcio ? 'selected' : ''}>${esc(c.nombre)} — ${esc(c.direccion)}</option>`).join('')}
    <option value="all" ${rc.consorcio === 'all' ? 'selected' : ''}>▸ Todos los consorcios</option></select></div>
    <div id="pinfo" class="muted"></div></div>
  <div id="rbody"></div>`;
  $('#cons').onchange = e => { rc.consorcio = e.target.value; ls.set('consorcio', rc.consorcio); loadReclamos(); };
  $('#nuevo').onclick = () => nuevoReclamo({ consorcio_id: rc.consorcio && rc.consorcio !== 'all' ? rc.consorcio : '' });
  if (!consorcios.length) { $('#rbody').innerHTML = `<div class="empty"><div class="big">🏢</div>Aún no hay consorcios. <a href="#/consorcios">Crea el primero</a> para empezar a cargar reclamos.</div>`; return; }
  loadReclamos();
});

async function loadReclamos() {
  const body = $('#rbody'); if (!body) return;
  if (!rc.consorcio) { body.innerHTML = `<div class="empty"><div class="big">📞</div><b>Selecciona el consorcio</b><br>Elige de dónde llama la persona para ver sus reclamos abiertos y cerrados.</div>`; $('#pinfo').innerHTML = ''; return; }
  const q = rc.consorcio === 'all' ? '' : `?consorcio_id=${rc.consorcio}`;
  const [list, cons] = await Promise.all([GET('reclamos' + q), rc.consorcio === 'all' ? null : GET('consorcios/' + rc.consorcio)]);
  $('#pinfo').innerHTML = cons ? `<b>${esc(cons.nombre)}</b><br>${esc(cons.direccion)}${cons.localidad ? ', ' + esc(cons.localidad) : ''}` : '';
  const abiertos = list.filter(r => r.estado === 'Abierto').sort((a, b) => b.urgencia_nivel - a.urgencia_nivel || a.fecha_reclamo.localeCompare(b.fecha_reclamo));
  const cerrados = list.filter(r => r.estado === 'Cerrado').sort((a, b) => b.fecha_cierre.localeCompare(a.fecha_cierre));
  const match = r => !rc.q || JSON.stringify([rid(r.id), r.titulo, r.detalle, r.tipo_nombre, r.unidad_label, r.solicitante_nombre, r.ubicacion_detalle]).toLowerCase().includes(rc.q.toLowerCase());
  body.innerHTML = `
  <div class="row" style="margin-bottom:6px"><div class="tabs" style="flex:1;margin:0">
    <button class="tab ${rc.tab === 'Abierto' ? 'on' : ''}" data-t="Abierto">📂 Abiertos<span class="cnt">${abiertos.length}</span></button>
    <button class="tab ${rc.tab === 'Cerrado' ? 'on' : ''}" data-t="Cerrado">✅ Cerrados<span class="cnt">${cerrados.length}</span></button></div>
    ${rc.tab === 'Cerrado' ? `<select id="fres" style="width:auto"><option value="">Todas las resoluciones</option>${state.meta.resoluciones.map(x => `<option ${x === rc.res ? 'selected' : ''}>${x}</option>`).join('')}</select>` : ''}
    <input class="search" id="q" placeholder="Buscar…" value="${esc(rc.q)}"></div>
  <div id="clist" style="margin-top:14px"></div>`;
  $$('.tab', body).forEach(b => b.onclick = () => { rc.tab = b.dataset.t; loadReclamos(); });
  $('#q', body).oninput = e => { rc.q = e.target.value; drawList(); };
  if ($('#fres', body)) $('#fres', body).onchange = e => { rc.res = e.target.value; drawList(); };
  const drawList = () => {
    const arr = (rc.tab === 'Abierto' ? abiertos : cerrados.filter(r => !rc.res || r.resolucion === rc.res)).filter(match);
    const box = $('#clist', body); box.innerHTML = '';
    if (!arr.length) { box.innerHTML = `<div class="empty"><div class="big">${rc.tab === 'Abierto' ? '🎉' : '🗂️'}</div>${rc.q ? 'Sin resultados.' : rc.tab === 'Abierto' ? 'No hay reclamos abiertos.' : 'Todavía no hay reclamos cerrados.'}</div>`; return; }
    arr.forEach(c => box.appendChild(claimCard(c, { showConsorcio: rc.consorcio === 'all' })));
  };
  drawList();
}

function claimCard(c, { showConsorcio } = {}) {
  const el = document.createElement('div');
  const open = c.estado === 'Abierto';
  el.className = `claim ${sClass(c.urgencia)}`;
  el.innerHTML = `
    <div class="tico">${esc(c.tipo_icono || '📌')}</div>
    <div class="body">
      <div class="top"><span class="id">${rid(c.id)}</span><span class="title">${esc(c.titulo || c.tipo_nombre)}</span>
        <span class="badge ${uClass(c.urgencia)}">${esc(c.urgencia)}</span>
        <span class="badge ${c.naturaleza === 'Técnico' ? 'b-tec' : 'b-adm'}">${esc(c.naturaleza)}</span>
        ${c.reiteraciones ? `<span class="badge chip-reit">🔁 ${c.reiteraciones} reiteración${c.reiteraciones > 1 ? 'es' : ''}</span>` : ''}
        ${open ? etapaBadge(c.etapa) : resBadge(c.resolucion)}</div>
      <div class="snippet">${esc(c.detalle)}</div>
      <div class="meta">${showConsorcio ? `<span>🏢 ${esc(c.consorcio_nombre)}</span>` : ''}<span>📍 ${esc(c.unidad_label)}${c.ubicacion_detalle ? ' · ' + esc(c.ubicacion_detalle) : ''}</span>
        <span>👤 ${esc(c.solicitante_nombre)}</span><span>🗓️ ${fmtDate(c.fecha_reclamo)}</span>
        ${c.proveedores.length ? `<span>🛠️ ${c.proveedores.map(p => esc(p.nombre)).join(', ')}</span>` : open ? '<span title="Sin proveedor asignado">🛠️ <i>sin proveedor</i></span>' : ''}
        ${c.ultima_reiteracion ? `<span>Última reiteración: ${fmtDate(c.ultima_reiteracion)}</span>` : ''}
        ${!open ? `<span>Cerrado: ${fmtDate(c.fecha_cierre)}</span>` : ''}</div>
    </div>
    <div class="acts">
      ${open ? `<button class="btn sm" data-a="reit">🔁 Reiterar</button><button class="btn sm ok" data-a="close">✔ Cerrar</button>`
      : `<button class="btn sm" data-a="reopen">↩ Reabrir</button>`}</div>`;
  el.onclick = () => verReclamo(c.id);
  const act = (a, fn) => { const b = $(`[data-a=${a}]`, el); if (b) b.onclick = e => { e.stopPropagation(); fn(); }; };
  act('reit', () => reiterarModal(c));
  act('close', () => cerrarModal(c));
  act('reopen', () => reabrirModal(c));
  return el;
}
const refresh = () => { if (location.hash.startsWith('#/reclamos')) loadReclamos(); else render(); };

/* ---- Nuevo reclamo ---- */
async function nuevoReclamo(pre = {}) {
  const [consorcios, provs] = await Promise.all([GET('consorcios'), GET('proveedores')]);
  let provsAct = provs.filter(p => p.activo === 'SI');
  const tipos = state.meta.tipos_reclamo.filter(t => t.activo === 'SI');
  let unidades = [], contactos = [], abiertos = [];
  const m = openModal('＋ Nuevo reclamo', `
    <div id="ferr"></div>
    <div id="dup"></div>
    <form id="f" class="form-grid">
      ${fieldHtml({ name: 'consorcio_id', label: 'Consorcio', type: 'select', required: true, options: consorcios.map(c => ({ value: c.id, label: c.nombre + ' — ' + c.direccion })), blank: '— Selecciona —', full: true }, pre.consorcio_id)}
      ${fieldHtml({ name: 'unidad_id', label: 'Unidad funcional', type: 'select', options: [], blank: 'Áreas comunes / todo el edificio' }, '')}
      ${fieldHtml({ name: 'ubicacion_detalle', label: 'Detalle de ubicación (opcional)', placeholder: 'Ej: Ascensor 2, Hall, Terraza, Baño' })}
      ${fieldHtml({ name: 'tipo_id', label: 'Tipo de reclamo', type: 'select', required: true, options: tipos.map(t => ({ value: t.id, label: (t.icono || '') + ' ' + t.nombre })), blank: '— Selecciona —' })}
      ${fieldHtml({ name: 'naturaleza', label: 'Técnico o administrativo', type: 'select', required: true, options: state.meta.naturalezas })}
      ${fieldHtml({ name: 'urgencia', label: 'Urgencia', type: 'select', required: true, options: state.meta.urgencias }, 'Media')}
      ${fieldHtml({ name: 'fecha_reclamo', label: 'Fecha y hora del reclamo', type: 'datetime-local' }, nowLocal())}
      ${fieldHtml({ name: 'contacto_sel', label: '¿Quién llama?', type: 'select', options: [], blank: 'Otra persona / no registrada', full: true }, '')}
      ${fieldHtml({ name: 'solicitante_nombre', label: 'Nombre de quien llama', required: true })}
      ${fieldHtml({ name: 'solicitante_tipo', label: 'Es…', type: 'select', options: state.meta.solicitante_tipos })}
      ${fieldHtml({ name: 'solicitante_contacto', label: 'Teléfono / email de contacto' })}
      ${fieldHtml({ name: 'canal', label: 'Canal', type: 'select', options: state.meta.canales })}
      ${fieldHtml({ name: 'titulo', label: 'Título corto (opcional)', placeholder: 'Se completa con el tipo si lo dejas vacío', full: true })}
      ${fieldHtml({ name: 'detalle', label: 'Detalle del incidente', type: 'textarea', required: true, full: true, placeholder: 'Describe qué está pasando, desde cuándo, dónde…' })}
      <div class="field full"><div class="row"><label style="flex:1">🛠️ Proveedores a asignar (opcional)</label><button type="button" class="btn sm" id="newprov">＋ Nuevo proveedor</button></div><div id="provbox"></div></div>
    </form>`, { wide: true, footer: `<button class="btn" data-x>Cancelar</button><button class="btn primary" data-ok>Registrar reclamo</button>` });
  const f = $('#f', m.el), F = n => f.elements[n];
  $('[data-x]', m.el).onclick = m.close;
  const okBtn = $('[data-ok]', m.el);
  const drawProvs = (extra = []) => {
    const sel = [...chipsValue(m.el, 'prov'), ...extra];
    $('#provbox', m.el).innerHTML = provsAct.length ? chipsHtml('prov', provsAct.map(p => ({ value: p.id, label: `${p.nombre} · ${p.tipo.join(', ')}` })), sel)
      : '<span class="muted small">Todavía no hay proveedores cargados. Usá “Nuevo proveedor” para cargar uno sin salir de acá.</span>';
  };
  $('#newprov', m.el).onclick = () => proveedorForm(null, async p => { provsAct = (await GET('proveedores')).filter(x => x.activo === 'SI'); drawProvs([p.id]); });
  drawProvs();

  const checkDup = () => {
    const c = F('consorcio_id').value, t = F('tipo_id').value, u = F('unidad_id').value, d = F('ubicacion_detalle').value.trim().toLowerCase();
    const dups = c && t ? abiertos.filter(r => r.consorcio_id === c && r.tipo_id === t && r.unidad_id === u && r.ubicacion_detalle.trim().toLowerCase() === d) : [];
    showDups(dups);
  };
  const showDups = dups => {
    okBtn.disabled = dups.length > 0;
    $('#dup', m.el).innerHTML = dups.length ? `<div class="alert dup"><b>⚠️ Ya existe un reclamo abierto para este incidente.</b> No se puede duplicar; registra una reiteración.
      ${dups.map(d => `<div class="dupitem"><div><b>${rid(d.id)}</b> · ${esc(d.tipo_nombre)} · ${esc(d.unidad_label)} <span class="badge ${uClass(d.urgencia)}">${esc(d.urgencia)}</span><br><span class="small">${fmtDate(d.fecha_reclamo)} — ${esc(d.detalle.slice(0, 110))}</span></div>
      <button class="btn sm primary" type="button" data-reit="${d.id}">🔁 Reiterar</button></div>`).join('')}</div>` : '';
    $$('[data-reit]', m.el).forEach(b => b.onclick = () => { const d = dups.find(x => x.id === b.dataset.reit); m.close(); reiterarModal(d); });
  };
  const loadCons = async () => {
    const c = F('consorcio_id').value;
    if (!c) { unidades = []; abiertos = []; }
    else [unidades, abiertos] = await Promise.all([GET('unidades?consorcio_id=' + c), GET(`reclamos?estado=Abierto&consorcio_id=${c}`)]);
    F('unidad_id').innerHTML = `<option value="">Áreas comunes / todo el edificio</option>` + unidades.map(u => `<option value="${u.id}">${esc(u.label)}</option>`).join('');
    if (pre.unidad_id && unidades.find(u => u.id === pre.unidad_id)) { F('unidad_id').value = pre.unidad_id; pre.unidad_id = ''; }
    await loadContactos(); checkDup();
  };
  const loadContactos = async () => {
    const u = F('unidad_id').value;
    contactos = [];
    if (u) {
      const d = await GET('unidades/' + u);
      contactos = [...d.propietarios.map(p => ({ ...p, tipo: 'Propietario' })), ...d.inquilinos.filter(i => i.activo).map(i => ({ ...i, tipo: 'Inquilino' }))];
    }
    F('contacto_sel').innerHTML = `<option value="">Otra persona / no registrada</option>` + contactos.map((p, i) => `<option value="${i}">${esc(p.nombre)} (${p.tipo})</option>`).join('');
  };
  F('contacto_sel').onchange = () => {
    const p = contactos[F('contacto_sel').value]; if (!p) return;
    F('solicitante_nombre').value = p.nombre; F('solicitante_tipo').value = p.tipo;
    F('solicitante_contacto').value = p.telefono || p.email || '';
  };
  F('consorcio_id').onchange = loadCons;
  F('unidad_id').onchange = async () => { await loadContactos(); checkDup(); };
  F('tipo_id').onchange = () => { const t = tipos.find(x => x.id === F('tipo_id').value); if (t) F('naturaleza').value = t.naturaleza; checkDup(); };
  F('ubicacion_detalle').oninput = checkDup;
  await loadCons();

  okBtn.onclick = async () => {
    if (!f.reportValidity()) return;
    okBtn.disabled = true;
    const v = formData(f); delete v.contacto_sel; v.proveedor_ids = chipsValue(m.el, 'prov');
    try { const r = await POST('reclamos', v); m.close(); toast(`Reclamo ${rid(r.id)} registrado`); rc.consorcio = v.consorcio_id; ls.set('consorcio', rc.consorcio); rc.tab = 'Abierto'; if (location.hash.startsWith('#/reclamos')) { const sel = $('#cons'); if (sel) sel.value = rc.consorcio; loadReclamos(); } else go('#/reclamos'); }
    catch (e) {
      if (e.status === 409 && e.data.duplicados) showDups(e.data.duplicados);
      else { $('#ferr', m.el).innerHTML = `<div class="alert err">${esc(e.message)}</div>`; okBtn.disabled = false; }
    }
  };
}

/* ---- Reiterar / Cerrar / Reabrir ---- */
async function reiterarModal(c) {
  let contactos = [];
  if (c.unidad_id) { const d = await safe(() => GET('unidades/' + c.unidad_id)); if (d) contactos = [...d.propietarios.map(p => ({ ...p, tipo: 'Propietario' })), ...d.inquilinos.filter(i => i.activo).map(i => ({ ...i, tipo: 'Inquilino' }))]; }
  const m = formModal({
    title: `🔁 Reiterar ${rid(c.id)} — ${c.titulo || c.tipo_nombre}`, submit: 'Registrar reiteración',
    fields: [
      { name: 'contacto_sel', label: '¿Quién vuelve a llamar?', type: 'select', options: contactos.map((p, i) => ({ value: i, label: `${p.nombre} (${p.tipo})` })), blank: 'Otra persona / no registrada', full: true },
      { name: 'solicitante_nombre', label: 'Nombre', required: true },
      { name: 'solicitante_tipo', label: 'Es…', type: 'select', options: state.meta.solicitante_tipos },
      { name: 'solicitante_contacto', label: 'Teléfono / email' },
      { name: 'canal', label: 'Canal', type: 'select', options: state.meta.canales },
      { name: 'fecha', label: 'Fecha y hora', type: 'datetime-local', value: nowLocal() },
      { name: 'urgencia', label: 'Urgencia (subir si corresponde)', type: 'select', options: state.meta.urgencias, value: c.urgencia },
      { name: 'detalle', label: 'Qué informa en esta llamada', type: 'textarea', required: true, full: true, placeholder: 'Ej: Sigue la pérdida y ahora mojó el techo del vecino…' }],
    onSubmit: async (v, mm) => { delete v.contacto_sel; await POST(`reclamos/${c.id}/reiterar`, v); mm.close(); toast('Reiteración registrada'); $$('.overlay').forEach(o => o.remove()); refresh(); }
  });
  const F = n => $('#f', m.el).elements[n];
  F('contacto_sel').onchange = () => { const p = contactos[F('contacto_sel').value]; if (!p) return; F('solicitante_nombre').value = p.nombre; F('solicitante_tipo').value = p.tipo; F('solicitante_contacto').value = p.telefono || p.email || ''; };
  // Precargar con quien hizo el reclamo original si coincide el flujo habitual
}
function cerrarModal(c) {
  formModal({ title: `✔ Cerrar ${rid(c.id)}`, submit: 'Cerrar reclamo', fields: [
    { name: 'resolucion', label: 'Tipo de cierre', type: 'select', required: true, full: true, blank: '— Selecciona —', options: [
      { value: 'Resuelto', label: 'Resuelto — correspondía a la administración y se finalizaron los trabajos' },
      { value: 'Desestimado', label: 'Desestimado — no corresponde a la administración resolverlo (ej: problema interno)' },
      { value: 'Anulado', label: 'Anulado — se cargó por error o se generó incorrectamente' }] },
    { name: 'motivo', label: 'Detalle del cierre', type: 'textarea', required: true, full: true, placeholder: 'Ej: Plomero reparó la pérdida el 28/09. / Es una cañería interna de la unidad. / Cargado dos veces por error.' }],
    onSubmit: async (v, m) => { await POST(`reclamos/${c.id}/cerrar`, v); m.close(); toast(`${rid(c.id)} cerrado`); $$('.overlay').forEach(o => o.remove()); refresh(); } });
}
function reabrirModal(c) {
  formModal({ title: `↩ Reabrir ${rid(c.id)}`, submit: 'Reabrir reclamo', fields: [{ name: 'motivo', label: 'Motivo de la reapertura', type: 'textarea', required: true, full: true, placeholder: 'Ej: El problema volvió a aparecer.' }],
    onSubmit: async (v, m) => { await POST(`reclamos/${c.id}/reabrir`, v); m.close(); toast(`${rid(c.id)} reabierto`); $$('.overlay').forEach(o => o.remove()); refresh(); } });
}

/* ---- Detalle de reclamo ---- */
async function verReclamo(id) {
  const c = await safe(() => GET('reclamos/' + id)); if (!c) return;
  const open = c.estado === 'Abierto';
  const m = openModal(`${esc(c.tipo_icono)} ${rid(c.id)} · ${esc(c.titulo || c.tipo_nombre)}`, `
    <div class="row"><span class="badge ${open ? 'b-open' : 'b-closed'}">${open ? 'Abierto' : 'Cerrado'}</span>${open ? '' : resBadge(c.resolucion)}
      <span class="badge ${uClass(c.urgencia)}">${esc(c.urgencia)}</span><span class="badge ${c.naturaleza === 'Técnico' ? 'b-tec' : 'b-adm'}">${esc(c.naturaleza)}</span>
      <span class="badge b-neutral">${esc(c.tipo_nombre)}</span><span class="spacer"></span>
      ${open ? `<button class="btn sm" data-a="reit">🔁 Reiterar</button><button class="btn sm ok" data-a="close">✔ Cerrar</button><button class="btn sm" data-a="edit">✏️ Editar</button>` : `<button class="btn sm" data-a="reopen">↩ Reabrir</button>`}</div>
    <div class="kv">
      <div><small>Consorcio</small><b>${esc(c.consorcio_nombre)}</b><br><span class="small muted">${esc(c.consorcio_direccion)}</span></div>
      <div><small>Ubicación</small><b>${esc(c.unidad_label)}</b>${c.ubicacion_detalle ? `<br><span class="small muted">${esc(c.ubicacion_detalle)}</span>` : ''}</div>
      <div><small>Fecha del reclamo</small><b>${fmtDate(c.fecha_reclamo)}</b> <span class="small muted">${c.fecha_reclamo.slice(11)}</span></div>
      <div><small>Reportó</small><b>${esc(c.solicitante_nombre)}</b> <span class="small muted">(${esc(c.solicitante_tipo)})</span><br><span class="small muted">${esc(c.solicitante_contacto)} · ${esc(c.canal)}</span></div>
      ${open ? '' : `<div><small>Cerrado</small><b>${fmtDate(c.fecha_cierre)}</b><br><span class="small muted">${esc(c.motivo_cierre)}</span></div>`}
      <div><small>Cargado por</small><b>${esc(c.operador)}</b></div></div>
    <div class="card" style="background:#fafbfe;margin-bottom:18px"><small class="muted">Detalle del incidente</small><div style="white-space:pre-wrap;margin-top:4px">${esc(c.detalle)}</div></div>
    <div class="grid cols-2" style="margin-bottom:18px">
      <div class="card"><h3 style="font-size:15px;margin-bottom:10px">📌 Etapa del reclamo</h3>
        <div class="stepper">${state.meta.etapas.map((e, i) => `<button class="step e${i} ${e === c.etapa ? 'on' : ''}" data-etapa="${esc(e)}" ${c.estado === 'Cerrado' ? 'disabled' : ''}>${esc(e)}</button>`).join('')}</div>
        <p class="muted small" style="margin:8px 0 0">${open ? 'Hacé clic en cualquier etapa para cambiarla en cualquier momento.' : 'Reabrí el reclamo para modificar su etapa.'}</p></div>
      <div class="card"><div class="row"><h3 style="font-size:15px;flex:1">🛠️ Proveedores asignados (${c.proveedores.length})</h3>${open ? '<button class="btn sm" data-a="addprov">＋ Asignar</button>' : ''}</div>
        ${c.proveedores.length ? c.proveedores.map(p => `<div class="person"><div class="avatar" style="background:#fef3c7;color:#92400e">${initials(p.nombre)}</div><div style="flex:1"><b>${esc(p.nombre)}</b> <span class="small muted">${p.tipo.map(esc).join(', ')}</span><br><span class="small">📞 ${esc(p.telefono)}${p.email ? ' · ✉️ ' + esc(p.email) : ''}</span><br><span class="small muted">Asignado el ${fmtDate(p.fecha_asignacion)}</span></div>
          ${open ? `<button class="btn sm danger" data-unprov="${p.id}" title="Quitar del reclamo">✕</button>` : ''}</div>`).join('') : '<p class="muted" style="margin:10px 0 0">Todavía no se asignó ningún proveedor.</p>'}</div>
    </div>
    <div class="grid cols-2">
      <div><h3 class="section-title" style="margin-top:0">🔁 Reiteraciones (${c.reiteraciones_lista.length})</h3>
        ${c.reiteraciones_lista.length ? c.reiteraciones_lista.map(r => `<div class="reit"><b>${esc(r.solicitante_nombre)}</b> <span class="small muted">(${esc(r.solicitante_tipo || '—')}) · ${fmtDate(r.fecha)} ${r.fecha.slice(11)} · ${esc(r.canal || '')}</span>
          <div style="white-space:pre-wrap;margin-top:3px">${esc(r.detalle)}</div><div class="small muted">${esc(r.solicitante_contacto)}</div></div>`).join('') : '<p class="muted">Nadie más llamó por este incidente todavía.</p>'}</div>
      <div><h3 class="section-title" style="margin-top:0">🕓 Historial</h3>
        <form id="nota" class="row" style="margin-bottom:12px;flex-wrap:nowrap"><input name="detalle" placeholder="Agregar una nota de seguimiento…" required><button class="btn sm">Agregar</button></form>
        <div class="timeline">${c.historial.map(h => `<div class="tl-item ${esc(h.accion.split(/[: ]/)[0])}"><b>${esc(h.accion)}</b> <span class="small muted">${fmtDate(h.fecha)} ${h.fecha.slice(11)} · ${esc(h.operador)}</span><div class="small" style="white-space:pre-wrap">${esc(h.detalle)}</div></div>`).join('')}</div></div>
    </div>`, { wide: true });
  const act = (a, fn) => { const b = $(`[data-a=${a}]`, m.el); if (b) b.onclick = fn; };
  act('reit', () => reiterarModal(c)); act('close', () => cerrarModal(c)); act('reopen', () => reabrirModal(c));
  $$('[data-etapa]', m.el).forEach(b => b.onclick = () => { if (b.dataset.etapa !== c.etapa) safe(async () => { await POST(`reclamos/${c.id}/etapa`, { etapa: b.dataset.etapa }); toast('Etapa actualizada'); m.close(); refresh(); verReclamo(c.id); }); });
  $$('[data-unprov]', m.el).forEach(b => b.onclick = () => safe(async () => { await DEL(`reclamos/${c.id}/proveedores/${b.dataset.unprov}`); m.close(); refresh(); verReclamo(c.id); }));
  const abrirAsignar = async (preId) => {
    const all = (await safe(() => GET('proveedores'))) || [];
    const ya = new Set(c.proveedores.map(p => p.id));
    const disp = all.filter(p => p.activo === 'SI' && !ya.has(p.id));
    const sug = disp.filter(p => p.tipo.some(t => (c.tipo_nombre + ' ' + c.titulo).toLowerCase().includes(t.toLowerCase().slice(0, 5))));
    const mm = openModal('🛠️ Asignar proveedores', `<div id="ferr"></div>${disp.length ? `
      <div class="field"><label>Elegí uno o más proveedores</label>${chipsHtml('prov', disp.map(p => ({ value: p.id, label: `${p.nombre} · ${p.tipo.join(', ')}` })), preId ? [preId] : [])}</div>
      ${sug.length ? `<p class="muted small" style="margin-top:12px">💡 Posibles por el tipo de reclamo: ${sug.map(p => esc(p.nombre)).join(', ')}</p>` : ''}` : '<p class="muted">No hay más proveedores activos para asignar.</p>'}
      <div style="margin-top:14px"><button type="button" class="btn sm" data-newprov>＋ Cargar nuevo proveedor</button></div>`,
      { footer: '<button class="btn" data-x>Cancelar</button><button class="btn primary" data-ok>Asignar</button>' });
    $('[data-x]', mm.el).onclick = mm.close;
    $('[data-newprov]', mm.el).onclick = () => proveedorForm(null, p => { mm.close(); abrirAsignar(p.id); });
    $('[data-ok]', mm.el).onclick = async () => {
      const ids = chipsValue(mm.el, 'prov'); if (!ids.length) { $('#ferr', mm.el).innerHTML = '<div class="alert err">Selecciona al menos un proveedor.</div>'; return; }
      await safe(async () => { await POST(`reclamos/${c.id}/proveedores`, { proveedor_ids: ids }); mm.close(); m.close(); toast('Proveedores asignados'); refresh(); verReclamo(c.id); });
    };
  };
  act('addprov', () => abrirAsignar());
  act('edit', () => formModal({ title: `Editar ${rid(c.id)}`, values: c, fields: [
    { name: 'urgencia', label: 'Urgencia', type: 'select', options: state.meta.urgencias }, { name: 'naturaleza', label: 'Técnico o administrativo', type: 'select', options: state.meta.naturalezas },
    { name: 'titulo', label: 'Título', full: true }, { name: 'detalle', label: 'Detalle', type: 'textarea', full: true }],
    onSubmit: async (v, mm) => { await PUT('reclamos/' + c.id, v); mm.close(); m.close(); refresh(); verReclamo(c.id); } }));
  $('#nota', m.el).onsubmit = async e => { e.preventDefault(); const v = formData(e.target); await safe(async () => { await POST(`reclamos/${c.id}/notas`, v); m.close(); verReclamo(c.id); }); };
}

/* ====================== CONSORCIOS ====================== */
const consorcioFields = [
  { name: 'nombre', label: 'Nombre del consorcio', required: true, full: true, placeholder: 'Ej: Edificio Belgrano 1234' },
  { name: 'direccion', label: 'Dirección', required: true, placeholder: 'Calle y número' }, { name: 'localidad', label: 'Localidad / barrio' },
  { name: 'fecha_inicio_administracion', label: 'Trabaja con nosotros desde', type: 'date' }, { name: 'cuit', label: 'CUIT' },
  { name: 'telefono_contacto', label: 'Teléfono de contacto' }, { name: 'email_contacto', label: 'Email de contacto', type: 'email' },
  { name: 'notas', label: 'Notas', type: 'textarea', full: true }];

route(/^\/consorcios$/, async () => {
  const list = await GET('consorcios');
  $('#main').innerHTML = `<div class="page-head"><div><h1>Consorcios</h1><p>Edificios bajo administración.</p></div><button class="btn primary" id="new">＋ Nuevo consorcio</button></div>
   ${list.length ? `<div class="grid cols-3">${list.map(c => `
    <a class="card" href="#/consorcios/${c.id}" style="color:inherit;display:block;transition:.15s">
      <div class="row"><div class="avatar" style="border-radius:12px">🏢</div><div style="flex:1"><b style="font-size:16px">${esc(c.nombre)}</b><br><span class="muted small">${esc(c.direccion)}${c.localidad ? ', ' + esc(c.localidad) : ''}</span></div></div>
      <div class="row" style="margin-top:14px"><span class="pill">🏠 ${c.unidades_count} unidades</span><span class="pill">🧰 ${c.personal_count} personal</span>
        ${c.reclamos_abiertos ? `<span class="badge u-Alta">${c.reclamos_abiertos} abiertos</span>` : '<span class="badge b-open">Sin reclamos abiertos</span>'}</div>
      ${c.fecha_inicio_administracion ? `<div class="small muted" style="margin-top:10px">Con nosotros hace ${antiguedad(c.fecha_inicio_administracion)} (desde ${fmtDate(c.fecha_inicio_administracion)})</div>` : ''}
    </a>`).join('')}</div>` : `<div class="empty"><div class="big">🏢</div>Todavía no cargaste ningún consorcio.</div>`}`;
  $('#new').onclick = () => formModal({ title: 'Nuevo consorcio', fields: consorcioFields, wide: true, onSubmit: async (v, m) => { const c = await POST('consorcios', v); m.close(); toast('Consorcio creado'); go('#/consorcios/' + c.id); } });
});

route(/^\/consorcios\/(\d+)$/, async (id) => {
  const c = await GET('consorcios/' + id);
  const tab = ls.get('ctab', 'unidades');
  const rolIco = { 'Encargado': '🧑‍🔧', 'Empresa de limpieza': '🧽', 'Proveedor de servicios': '🚚', 'Administrativo': '🗂️', 'Seguridad': '🛡️', 'Otro': '👤' };
  $('#main').innerHTML = `
  <div class="crumbs"><a href="#/consorcios">Consorcios</a> › ${esc(c.nombre)}</div>
  <div class="page-head"><div><h1>${esc(c.nombre)}</h1><p>📍 ${esc(c.direccion)}${c.localidad ? ', ' + esc(c.localidad) : ''}</p></div>
    <div class="row"><a class="btn primary" href="#/reclamos/c${c.id}">📞 Ver reclamos (${c.reclamos_abiertos} abiertos)</a><button class="btn" id="edit">✏️ Editar</button><button class="btn danger" id="del">🗑</button></div></div>
  <div class="card"><div class="kv" style="margin:0">
    <div><small>Antigüedad con la administración</small><b>${c.fecha_inicio_administracion ? antiguedad(c.fecha_inicio_administracion) : '—'}</b><br><span class="small muted">${c.fecha_inicio_administracion ? 'Desde ' + fmtDate(c.fecha_inicio_administracion) : ''}</span></div>
    <div><small>CUIT</small><b>${esc(c.cuit) || '—'}</b></div><div><small>Teléfono</small><b>${esc(c.telefono_contacto) || '—'}</b></div><div><small>Email</small><b>${esc(c.email_contacto) || '—'}</b></div>
    <div><small>Unidades</small><b>${c.unidades.length}</b></div></div>${c.notas ? `<p class="muted" style="margin-bottom:0;white-space:pre-wrap">📝 ${esc(c.notas)}</p>` : ''}</div>
  <div class="tabs" style="margin-top:22px"><button class="tab ${tab === 'unidades' ? 'on' : ''}" data-t="unidades">🏠 Unidades funcionales<span class="cnt">${c.unidades.length}</span></button>
    <button class="tab ${tab === 'personal' ? 'on' : ''}" data-t="personal">🧰 Personal y proveedores<span class="cnt">${c.personal.length}</span></button></div>
  <div id="tabbody"></div>`;
  $('#edit').onclick = () => formModal({ title: 'Editar consorcio', fields: consorcioFields, values: c, wide: true, onSubmit: async (v, m) => { await PUT('consorcios/' + id, v); m.close(); render(); } });
  $('#del').onclick = async () => { if (await confirmBox(`¿Eliminar <b>${esc(c.nombre)}</b> con sus unidades y personal? Solo es posible si no tiene reclamos.`, 'Eliminar')) safe(async () => { await DEL('consorcios/' + id); toast('Consorcio eliminado'); go('#/consorcios'); }); };
  $$('.tab').forEach(b => b.onclick = () => { ls.set('ctab', b.dataset.t); render(); });
  const tb = $('#tabbody');
  if (tab === 'unidades') {
    tb.innerHTML = `<div class="row" style="margin-bottom:12px"><button class="btn primary" id="addu">＋ Nueva unidad funcional</button><button class="btn" id="bulk">⚡ Carga masiva</button></div>
    ${c.unidades.length ? `<div class="table-wrap"><table><thead><tr><th>UF</th><th>Dirección completa</th><th>Propietarios</th><th>Inquilinos</th><th>Reclamos</th></tr></thead><tbody>
    ${c.unidades.map(u => `<tr class="click" data-u="${u.id}"><td><b>UF ${esc(u.numero_uf)}</b><br><span class="small muted">${esc(u.tipo)}</span></td><td>${esc(u.direccion_completa)}</td>
      <td>${u.propietarios.map(p => `<span class="pill">${esc(p.nombre)}</span>`).join('') || '<span class="muted">—</span>'}</td>
      <td>${u.inquilinos.map(p => `<span class="pill">${esc(p.nombre)}</span>`).join('') || '<span class="muted">—</span>'}</td>
      <td>${u.reclamos_abiertos ? `<span class="badge u-Alta">${u.reclamos_abiertos} abiertos</span> ` : ''}<span class="small muted">${u.reclamos_total} en total</span></td></tr>`).join('')}</tbody></table></div>`
        : '<div class="empty"><div class="big">🏠</div>Este consorcio aún no tiene unidades funcionales.</div>'}`;
    $$('tr[data-u]', tb).forEach(tr => tr.onclick = () => go('#/unidades/' + tr.dataset.u));
    $('#addu').onclick = () => unidadForm({ consorcio_id: id });
    $('#bulk').onclick = () => formModal({ title: 'Carga masiva de unidades', submit: 'Crear unidades', fields: [
      { name: 'pisos', label: 'Cantidad de pisos', type: 'number', required: true, value: 5 }, { name: 'porpiso', label: 'Departamentos por piso', type: 'number', required: true, value: 4 },
      { name: 'letras', label: 'Letras de los departamentos (se toman en orden)', value: 'A,B,C,D,E,F,G,H', full: true }],
      onSubmit: async (v, m) => {
        const letras = v.letras.split(',').map(x => x.trim()); let n = 0; const errs = [];
        for (let p = 1; p <= +v.pisos; p++) for (let d = 0; d < +v.porpiso; d++) {
          n++; try { await POST('unidades', { consorcio_id: id, numero_uf: String(n), piso: String(p), departamento: letras[d] || String(d + 1), tipo: 'Departamento' }); } catch (e) { errs.push(e.message); }
        }
        m.close(); toast(errs.length ? `Creadas con ${errs.length} errores` : `${n} unidades creadas`, !!errs.length); render();
      } });
  } else {
    tb.innerHTML = `<div class="row" style="margin-bottom:12px"><button class="btn primary" id="addp">＋ Agregar persona / empresa</button></div>
    ${c.personal.length ? `<div class="grid cols-3">${c.personal.map(p => `<div class="card"><div class="row" style="flex-wrap:nowrap"><div class="avatar">${rolIco[p.rol] || '👤'}</div><div style="flex:1"><b>${esc(p.nombre)}</b><br><span class="badge b-neutral">${esc(p.rol)}</span></div>
      <button class="btn sm" data-e="${p.id}">✏️</button><button class="btn sm danger" data-d="${p.id}">🗑</button></div>
      <div class="small" style="margin-top:10px;line-height:1.7">${p.empresa ? `🏭 ${esc(p.empresa)}<br>` : ''}${p.servicio ? `🔧 ${esc(p.servicio)}<br>` : ''}${p.telefono ? `📞 ${esc(p.telefono)}<br>` : ''}${p.email ? `✉️ ${esc(p.email)}<br>` : ''}${p.horario ? `🕐 ${esc(p.horario)}<br>` : ''}${p.observaciones ? `<span class="muted">${esc(p.observaciones)}</span>` : ''}</div></div>`).join('')}</div>`
        : '<div class="empty"><div class="big">🧰</div>Sin personal cargado (encargados, limpieza, proveedores…).</div>'}`;
    const pf = (p) => formModal({ title: p ? 'Editar personal' : 'Agregar personal', values: p || {}, wide: true, fields: [
      { name: 'nombre', label: 'Nombre', required: true }, { name: 'rol', label: 'Rol', type: 'select', options: state.meta.roles, required: true },
      { name: 'empresa', label: 'Empresa' }, { name: 'servicio', label: 'Servicio que presta', placeholder: 'Ej: Mantenimiento de ascensores' },
      { name: 'telefono', label: 'Teléfono' }, { name: 'email', label: 'Email', type: 'email' }, { name: 'horario', label: 'Horario / días' }, { name: 'observaciones', label: 'Observaciones', type: 'textarea', full: true }],
      onSubmit: async (v, m) => { v.consorcio_id = id; p ? await PUT('personal/' + p.id, v) : await POST('personal', v); m.close(); render(); } });
    $('#addp').onclick = () => pf(null);
    $$('[data-e]', tb).forEach(b => b.onclick = () => pf(c.personal.find(x => x.id === b.dataset.e)));
    $$('[data-d]', tb).forEach(b => b.onclick = async () => { if (await confirmBox('¿Quitar esta persona del personal del consorcio?', 'Quitar')) safe(async () => { await DEL('personal/' + b.dataset.d); render(); }); });
  }
});

function unidadForm(u) {
  const edit = !!u.id;
  formModal({ title: edit ? 'Editar unidad funcional' : 'Nueva unidad funcional', values: u, wide: true, fields: [
    { name: 'numero_uf', label: 'N° de UF', required: true }, { name: 'tipo', label: 'Tipo', type: 'select', options: state.meta.tipos_unidad },
    { name: 'piso', label: 'Piso' }, { name: 'departamento', label: 'Departamento / letra' }, { name: 'observaciones', label: 'Observaciones', type: 'textarea', full: true }],
    onSubmit: async (v, m) => { v.consorcio_id = u.consorcio_id; if (edit) await PUT('unidades/' + u.id, v); else await POST('unidades', v); m.close(); render(); } });
}

/* ====================== UNIDAD FUNCIONAL ====================== */
route(/^\/unidades\/(\d+)$/, async (id) => {
  const u = await GET('unidades/' + id);
  $('#main').innerHTML = `
  <div class="crumbs"><a href="#/consorcios">Consorcios</a> › <a href="#/consorcios/${u.consorcio_id}">${esc(u.consorcio_nombre)}</a> › ${esc(u.label)}</div>
  <div class="page-head"><div><h1>${esc(u.label)}</h1><p>📍 ${esc(u.direccion_completa)} · ${esc(u.tipo || 'Departamento')}</p></div>
    <div class="row"><button class="btn primary" id="nr">＋ Nuevo reclamo</button><button class="btn" id="edit">✏️ Editar</button><button class="btn danger" id="del">🗑</button></div></div>
  ${u.observaciones ? `<p class="muted">📝 ${esc(u.observaciones)}</p>` : ''}
  <div class="grid cols-2">
    <div class="card"><div class="row"><h3 style="flex:1">👤 Propietarios</h3><button class="btn sm" id="addprop">＋ Agregar</button></div>
      ${u.propietarios.length ? u.propietarios.map(p => `<div class="person"><div class="avatar">${initials(p.nombre)}</div><div style="flex:1"><b>${esc(p.nombre)}</b><br><span class="small">${contactLine(p) || '<span class="muted">Sin datos de contacto</span>'}</span></div>
        <a class="btn sm" href="#/propietarios">Ver</a><button class="btn sm danger" data-unlink="${p.link_id}" title="Quitar de esta unidad">✕</button></div>`).join('') : '<p class="muted">Sin propietarios asignados.</p>'}</div>
    <div class="card"><div class="row"><h3 style="flex:1">🔑 Inquilinos</h3><button class="btn sm" id="addinq">＋ Agregar</button></div>
      ${u.inquilinos.length ? u.inquilinos.map(p => `<div class="person"><div class="avatar" style="background:#e0f2fe;color:#0369a1">${initials(p.nombre)}</div><div style="flex:1"><b>${esc(p.nombre)}</b> ${p.activo ? '<span class="badge b-open">Actual</span>' : '<span class="badge b-closed">Anterior</span>'}<br>
        <span class="small">${contactLine(p) || '<span class="muted">Sin datos de contacto</span>'}</span><br><span class="small muted">${p.fecha_desde ? 'Desde ' + fmtDate(p.fecha_desde) : ''}${p.fecha_hasta ? ' hasta ' + fmtDate(p.fecha_hasta) : ''}</span></div>
        <button class="btn sm" data-einq="${p.id}">✏️</button><button class="btn sm danger" data-dinq="${p.id}">🗑</button></div>`).join('') : '<p class="muted">Sin inquilinos registrados.</p>'}</div>
  </div>
  <h3 class="section-title">📞 Reclamos de esta unidad (${u.reclamos.length})</h3><div id="ul"></div>`;
  u.reclamos.forEach(c => $('#ul').appendChild(claimCard(c)));
  if (!u.reclamos.length) $('#ul').innerHTML = '<div class="empty">Esta unidad no tiene reclamos.</div>';
  $('#nr').onclick = () => nuevoReclamo({ consorcio_id: u.consorcio_id, unidad_id: id });
  $('#edit').onclick = () => unidadForm(u);
  $('#del').onclick = async () => { if (await confirmBox(`¿Eliminar <b>${esc(u.label)}</b>? Se quitarán sus asignaciones e inquilinos. Solo es posible si no tiene reclamos.`, 'Eliminar')) safe(async () => { await DEL('unidades/' + id); go('#/consorcios/' + u.consorcio_id); }); };
  $$('[data-unlink]').forEach(b => b.onclick = async () => { if (await confirmBox('¿Quitar este propietario de la unidad? (no se elimina su ficha)', 'Quitar')) safe(async () => { await DEL('unidad_propietarios/' + b.dataset.unlink); render(); }); });
  $('#addprop').onclick = async () => {
    const todos = await GET('propietarios'); const ya = new Set(u.propietarios.map(p => p.id));
    const m = openModal('Agregar propietario', `<div id="ferr"></div>
      <div class="field"><label>Elegir propietario ya registrado</label><select id="sel"><option value="">— Selecciona —</option>${todos.filter(p => !ya.has(p.id)).map(p => `<option value="${p.id}">${esc(p.nombre)}${p.telefono ? ' · ' + esc(p.telefono) : ''}</option>`).join('')}</select></div>
      <p class="muted" style="text-align:center;margin:14px 0">— o crear uno nuevo —</p>
      <form id="f" class="form-grid">${propFields.map(f => fieldHtml(f)).join('')}</form>`, { wide: true, footer: '<button class="btn" data-x>Cancelar</button><button class="btn primary" data-ok>Agregar</button>' });
    $('[data-x]', m.el).onclick = m.close;
    $('[data-ok]', m.el).onclick = async () => {
      try {
        let pid = $('#sel', m.el).value; const v = formData($('#f', m.el));
        if (!pid) { if (!v.nombre.trim()) throw new Error('Selecciona un propietario o completa el nombre del nuevo.'); pid = (await POST('propietarios', v)).id; }
        await POST('unidad_propietarios', { unidad_id: id, propietario_id: pid }); m.close(); render();
      } catch (e) { $('#ferr', m.el).innerHTML = `<div class="alert err">${esc(e.message)}</div>`; }
    };
  };
  const inqForm = (p) => formModal({ title: p ? 'Editar inquilino' : 'Nuevo inquilino', values: p || {}, wide: true, fields: [
    { name: 'nombre', label: 'Nombre y apellido', required: true }, { name: 'dni', label: 'DNI' }, { name: 'telefono', label: 'Teléfono' }, { name: 'telefono_alt', label: 'Teléfono alternativo' },
    { name: 'email', label: 'Email', type: 'email', full: true }, { name: 'fecha_desde', label: 'Vive desde', type: 'date' }, { name: 'fecha_hasta', label: 'Hasta (si ya se fue)', type: 'date' },
    { name: 'observaciones', label: 'Observaciones', type: 'textarea', full: true }],
    onSubmit: async (v, m) => { v.unidad_id = id; p ? await PUT('inquilinos/' + p.id, v) : await POST('inquilinos', v); m.close(); render(); } });
  $('#addinq').onclick = () => inqForm(null);
  $$('[data-einq]').forEach(b => b.onclick = () => inqForm(u.inquilinos.find(x => x.id === b.dataset.einq)));
  $$('[data-dinq]').forEach(b => b.onclick = async () => { if (await confirmBox('¿Eliminar este inquilino?', 'Eliminar')) safe(async () => { await DEL('inquilinos/' + b.dataset.dinq); render(); }); });
});

/* ====================== PROPIETARIOS ====================== */
const propFields = [
  { name: 'nombre', label: 'Nombre y apellido', required: true, full: true }, { name: 'dni', label: 'DNI' }, { name: 'telefono', label: 'Teléfono' },
  { name: 'telefono_alt', label: 'Teléfono alternativo' }, { name: 'email', label: 'Email', type: 'email' }, { name: 'observaciones', label: 'Observaciones', type: 'textarea', full: true }];
let propQ = '';
route(/^\/propietarios$/, async () => {
  const list = await GET('propietarios');
  $('#main').innerHTML = `<div class="page-head"><div><h1>Propietarios</h1><p>Datos de contacto y unidades que posee cada uno.</p></div><button class="btn primary" id="new">＋ Nuevo propietario</button></div>
  <div class="row" style="margin-bottom:14px"><input class="search" id="q" placeholder="Buscar por nombre, teléfono, email…" value="${esc(propQ)}"><span class="muted small">${list.length} registrados</span></div><div id="tb"></div>`;
  const draw = () => {
    const arr = list.filter(p => !propQ || JSON.stringify(p).toLowerCase().includes(propQ.toLowerCase()));
    $('#tb').innerHTML = arr.length ? `<div class="table-wrap"><table><thead><tr><th>Propietario</th><th>Contacto</th><th>Unidades</th><th></th></tr></thead><tbody>
      ${arr.map(p => `<tr><td><b>${esc(p.nombre)}</b>${p.dni ? `<br><span class="small muted">DNI ${esc(p.dni)}</span>` : ''}</td><td class="small" style="line-height:1.7">${contactLine(p).replace(/ &nbsp; /g, '<br>') || '<span class="muted">—</span>'}</td>
      <td>${p.unidades.map(x => `<a class="pill" href="#/unidades/${x.unidad_id}">${esc(x.consorcio_nombre)} · ${esc(x.label)}</a>`).join('') || '<span class="muted">Sin unidades</span>'}</td>
      <td style="white-space:nowrap"><button class="btn sm" data-e="${p.id}">✏️</button> <button class="btn sm danger" data-d="${p.id}">🗑</button></td></tr>`).join('')}</tbody></table></div>`
      : '<div class="empty"><div class="big">👥</div>No hay propietarios para mostrar.</div>';
    $$('[data-e]').forEach(b => b.onclick = () => pform(list.find(x => x.id === b.dataset.e)));
    $$('[data-d]').forEach(b => b.onclick = async () => { if (await confirmBox('¿Eliminar este propietario? Se quitará de todas sus unidades.', 'Eliminar')) safe(async () => { await DEL('propietarios/' + b.dataset.d); render(); }); });
  };
  const pform = p => formModal({ title: p ? 'Editar propietario' : 'Nuevo propietario', values: p || {}, wide: true, fields: propFields, onSubmit: async (v, m) => { p ? await PUT('propietarios/' + p.id, v) : await POST('propietarios', v); m.close(); render(); } });
  $('#q').oninput = e => { propQ = e.target.value; draw(); };
  $('#new').onclick = () => pform(null);
  draw();
});

/* ====================== PROVEEDORES ====================== */
let provQ = '', provTipo = '';
function proveedorForm(p, after) {
  const profs = [...new Set([...state.meta.profesiones, ...(p ? p.tipo : [])])].sort((a, b) => a.localeCompare(b, 'es'));
  const m = openModal(p ? 'Editar proveedor' : 'Nuevo proveedor', `<div id="ferr"></div>
    <form id="f" class="form-grid">
      ${fieldHtml({ name: 'nombre', label: 'Nombre', required: true }, p?.nombre)}
      ${fieldHtml({ name: 'telefono', label: 'Teléfono de contacto', required: true }, p?.telefono)}
      ${fieldHtml({ name: 'email', label: 'Email', type: 'email' }, p?.email)}
      ${fieldHtml({ name: 'empresa', label: 'Empresa (si corresponde)' }, p?.empresa)}
      <div class="field full"><label>Profesión / tipo de servicio <span class="req"> *</span> <span class="muted small">(una o más)</span></label>
        <div id="chipbox">${chipsHtml('tipo', profs, p ? p.tipo : [])}</div>
        <div class="row" style="margin-top:6px"><input id="otra" placeholder="¿Otra profesión? Escríbela y presiona Agregar" style="flex:1"><button type="button" class="btn sm" id="addtipo">＋ Agregar</button></div></div>
      ${fieldHtml({ name: 'activo', label: 'Estado', type: 'select', options: [{ value: 'SI', label: 'Activo' }, { value: 'NO', label: 'Inactivo (no se ofrece al asignar)' }] }, p?.activo || 'SI')}
      ${fieldHtml({ name: 'observaciones', label: 'Observaciones', type: 'textarea', full: true }, p?.observaciones)}
    </form>`, { wide: true, footer: '<button class="btn" data-x>Cancelar</button><button class="btn primary" data-ok>Guardar</button>' });
  $('[data-x]', m.el).onclick = m.close;
  const addTipo = () => {
    const inp = $('#otra', m.el), v = inp.value.trim().replace(/\|/g, ' '); if (!v) return;
    const ex = $$('[data-chips="tipo"] input', m.el).find(i => i.value.toLowerCase() === v.toLowerCase());
    if (ex) ex.checked = true;
    else $('[data-chips="tipo"]', m.el).insertAdjacentHTML('beforeend', `<label class="chip"><input type="checkbox" value="${esc(v)}" checked><span>${esc(v)}</span></label>`);
    inp.value = '';
  };
  $('#addtipo', m.el).onclick = addTipo;
  $('#otra', m.el).onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); addTipo(); } };
  $('[data-ok]', m.el).onclick = async () => {
    const f = $('#f', m.el); if (!f.reportValidity()) return;
    if ($('#otra', m.el).value.trim()) addTipo();
    const v = formData(f); v.tipo = chipsValue(m.el, 'tipo');
    if (!v.tipo.length) { $('#ferr', m.el).innerHTML = '<div class="alert err">Selecciona al menos una profesión.</div>'; return; }
    try { const res = p ? await PUT('proveedores/' + p.id, v) : await POST('proveedores', v); state.meta = await GET('meta'); m.close(); toast(p ? 'Proveedor actualizado' : 'Proveedor creado'); after ? after(res) : render(); }
    catch (e) { $('#ferr', m.el).innerHTML = `<div class="alert err">${esc(e.message)}</div>`; }
  };
}
route(/^\/proveedores$/, async () => {
  const list = await GET('proveedores');
  const tipos = [...new Set(list.flatMap(p => p.tipo))].sort((a, b) => a.localeCompare(b, 'es'));
  $('#main').innerHTML = `<div class="page-head"><div><h1>Proveedores</h1><p>Plomeros, gasistas, electricistas y demás profesionales que podés asignar a un reclamo.</p></div><button class="btn primary" id="new">＋ Nuevo proveedor</button></div>
  <div class="row" style="margin-bottom:14px"><input class="search" id="q" placeholder="Buscar por nombre, teléfono, email…" value="${esc(provQ)}">
    <select id="ft" style="width:auto"><option value="">Todas las profesiones</option>${tipos.map(t => `<option ${t === provTipo ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select><span class="muted small">${list.length} registrados</span></div><div id="tb"></div>`;
  const draw = () => {
    const arr = list.filter(p => (!provQ || JSON.stringify(p).toLowerCase().includes(provQ.toLowerCase())) && (!provTipo || p.tipo.includes(provTipo)));
    $('#tb').innerHTML = arr.length ? `<div class="table-wrap"><table><thead><tr><th>Proveedor</th><th>Profesiones</th><th>Contacto</th><th>Reclamos</th><th></th></tr></thead><tbody>
      ${arr.map(p => `<tr style="${p.activo === 'SI' ? '' : 'opacity:.55'}"><td><b>${esc(p.nombre)}</b>${p.activo === 'SI' ? '' : ' <span class="badge b-closed">Inactivo</span>'}${p.empresa ? `<br><span class="small muted">${esc(p.empresa)}</span>` : ''}</td>
        <td>${p.tipo.map(t => `<span class="pill">${esc(t)}</span>`).join('')}</td>
        <td class="small" style="line-height:1.7">📞 ${esc(p.telefono)}${p.email ? `<br>✉️ ${esc(p.email)}` : ''}</td>
        <td>${p.reclamos_activos ? `<span class="badge u-Alta">${p.reclamos_activos} en curso</span> ` : ''}<span class="small muted">${p.reclamos_total} en total</span></td>
        <td style="white-space:nowrap"><button class="btn sm" data-v="${p.id}">Ver</button> <button class="btn sm" data-e="${p.id}">✏️</button> <button class="btn sm danger" data-d="${p.id}">🗑</button></td></tr>`).join('')}</tbody></table></div>`
      : '<div class="empty"><div class="big">🛠️</div>No hay proveedores para mostrar.</div>';
    $$('[data-e]').forEach(b => b.onclick = () => proveedorForm(list.find(x => x.id === b.dataset.e)));
    $$('[data-v]').forEach(b => b.onclick = () => verProveedor(b.dataset.v));
    $$('[data-d]').forEach(b => b.onclick = async () => { if (await confirmBox('¿Eliminar este proveedor? Si está asignado a reclamos no se podrá; en ese caso márcalo como inactivo.', 'Eliminar')) safe(async () => { await DEL('proveedores/' + b.dataset.d); render(); }); });
  };
  $('#q').oninput = e => { provQ = e.target.value; draw(); };
  $('#ft').onchange = e => { provTipo = e.target.value; draw(); };
  $('#new').onclick = () => proveedorForm(null);
  draw();
});
async function verProveedor(id) {
  const p = await safe(() => GET('proveedores/' + id)); if (!p) return;
  const m = openModal(`🛠️ ${esc(p.nombre)}`, `
    <div>${p.tipo.map(t => `<span class="pill">${esc(t)}</span>`).join('')}</div>
    <div class="kv"><div><small>Teléfono</small><b>${esc(p.telefono)}</b></div><div><small>Email</small><b>${esc(p.email) || '—'}</b></div><div><small>Empresa</small><b>${esc(p.empresa) || '—'}</b></div></div>
    ${p.observaciones ? `<p class="muted" style="white-space:pre-wrap">📝 ${esc(p.observaciones)}</p>` : ''}
    <h3 class="section-title">Reclamos asignados (${p.reclamos.length})</h3><div id="pl"></div>`, { wide: true });
  p.reclamos.forEach(c => { const el = claimCard(c, { showConsorcio: true }); const o = el.onclick; el.onclick = () => { m.close(); o(); }; $('#pl', m.el).appendChild(el); });
  if (!p.reclamos.length) $('#pl', m.el).innerHTML = '<div class="empty">Todavía no tiene reclamos asignados.</div>';
}

/* ====================== CONFIGURACIÓN ====================== */
route(/^\/config$/, async () => {
  const [meta, db] = await Promise.all([GET('meta'), GET('db')]); state.meta = meta;
  $('#main').innerHTML = `<div class="page-head"><div><h1>Configuración</h1><p>Tipos de reclamo y estado de la base de datos.</p></div><button class="btn primary" id="new">＋ Nuevo tipo de reclamo</button></div>
  <div class="table-wrap"><table><thead><tr><th>Tipo de reclamo</th><th>Naturaleza por defecto</th><th>Estado</th><th></th></tr></thead><tbody>
  ${meta.tipos_reclamo.map(t => `<tr><td>${esc(t.icono)} <b>${esc(t.nombre)}</b></td><td><span class="badge ${t.naturaleza === 'Técnico' ? 'b-tec' : 'b-adm'}">${esc(t.naturaleza)}</span></td>
   <td>${t.activo === 'SI' ? '<span class="badge b-open">Activo</span>' : '<span class="badge b-closed">Inactivo</span>'}</td>
   <td style="white-space:nowrap"><button class="btn sm" data-e="${t.id}">✏️</button> <button class="btn sm" data-t="${t.id}">${t.activo === 'SI' ? 'Desactivar' : 'Activar'}</button> <button class="btn sm danger" data-d="${t.id}">🗑</button></td></tr>`).join('')}</tbody></table></div>
  <h3 class="section-title">🗄️ Base de datos (archivos CSV)</h3>
  <p class="muted small">Carpeta: <code>${esc(meta.data_dir)}</code> — cada archivo es una tabla con su propio ID; las relaciones se guardan como <code>*_id</code>.</p>
  <div class="table-wrap"><table><thead><tr><th>Archivo</th><th>Filas</th><th>Columnas</th></tr></thead><tbody>
  ${db.map(t => `<tr><td><b>${esc(t.archivo)}</b></td><td>${t.filas}</td><td class="small muted">${t.columnas.map(c => `<span class="pill">${esc(c)}</span>`).join('')}</td></tr>`).join('')}</tbody></table></div>`;
  const tf = t => formModal({ title: t ? 'Editar tipo de reclamo' : 'Nuevo tipo de reclamo', values: t || { icono: '📌' }, fields: [
    { name: 'nombre', label: 'Nombre', required: true }, { name: 'icono', label: 'Ícono (emoji)' }, { name: 'naturaleza', label: 'Naturaleza por defecto', type: 'select', options: meta.naturalezas, required: true }],
    onSubmit: async (v, m) => { t ? await PUT('tipos_reclamo/' + t.id, { ...v, activo: t.activo }) : await POST('tipos_reclamo', { ...v, activo: 'SI' }); m.close(); render(); } });
  $('#new').onclick = () => tf(null);
  $$('[data-e]').forEach(b => b.onclick = () => tf(meta.tipos_reclamo.find(x => x.id === b.dataset.e)));
  $$('[data-t]').forEach(b => b.onclick = () => safe(async () => { const t = meta.tipos_reclamo.find(x => x.id === b.dataset.t); await PUT('tipos_reclamo/' + t.id, { ...t, activo: t.activo === 'SI' ? 'NO' : 'SI' }); render(); }));
  $$('[data-d]').forEach(b => b.onclick = async () => { if (await confirmBox('¿Eliminar este tipo de reclamo?', 'Eliminar')) safe(async () => { await DEL('tipos_reclamo/' + b.dataset.d); render(); }); });
});

/* ====================== arranque ====================== */
const HANDLE_DB = 'consorcios-app', HANDLE_STORE = 'handles';
const idb = {
  open: () => new Promise((ok, ko) => {
    const rq = indexedDB.open(HANDLE_DB, 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore(HANDLE_STORE);
    rq.onsuccess = () => ok(rq.result); rq.onerror = () => ko(rq.error);
  }),
  async get(k) { try { const db = await this.open(); return await new Promise((ok, ko) => { const r = db.transaction(HANDLE_STORE).objectStore(HANDLE_STORE).get(k); r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error); }); } catch { return undefined; } },
  async set(k, v) { try { const db = await this.open(); await new Promise((ok, ko) => { const tx = db.transaction(HANDLE_STORE, 'readwrite'); tx.objectStore(HANDLE_STORE).put(v, k); tx.oncomplete = ok; tx.onerror = () => ko(tx.error); }); } catch { } }
};
const soportaCarpetas = typeof window.showDirectoryPicker === 'function';

function pantallaConexion({ saved, error } = {}) {
  core = null;
  $('#carpeta').innerHTML = '';
  $('#main').innerHTML = `<div class="gate">
    <div class="gate-card">
      <div class="gate-ico">🏢</div>
      <h1>Administración de Consorcios</h1>
      <p class="muted">Elegí la carpeta donde se guardan los datos (archivos CSV). Si es la primera vez, elegí o creá una carpeta vacía: la aplicación crea ahí todas las tablas.</p>
      ${error ? `<div class="alert err">${esc(error)}</div>` : ''}
      ${!soportaCarpetas ? `<div class="alert err">Este navegador no permite trabajar con carpetas del disco. Abrí la aplicación con <b>Google Chrome</b> o <b>Microsoft Edge</b>.</div>` : ''}
      <div class="gate-actions">
        ${saved ? `<button class="btn primary" id="reconectar">📁 Continuar con «${esc(saved.name)}»</button>` : ''}
        <button class="btn ${saved ? '' : 'primary'}" id="elegir" ${soportaCarpetas ? '' : 'disabled'}>📂 ${saved ? 'Elegir otra carpeta' : 'Elegir carpeta de datos'}</button>
      </div>
      <p class="small muted"><a href="#" id="demo">Probar en modo demo</a> (los datos no se guardan al cerrar).</p>
    </div></div>`;
  const abrir = async handle => {
    try {
      if (await handle.requestPermission({ mode: 'readwrite' }) !== 'granted') return pantallaConexion({ saved, error: 'Sin permiso de escritura sobre la carpeta. Aceptá el permiso para poder guardar los datos.' });
      await idb.set('dir', handle);
      await conectar(new Consorcios.FolderStore(handle));
    } catch (e) { pantallaConexion({ saved, error: 'No se pudo abrir la carpeta: ' + e.message }); }
  };
  if (saved) $('#reconectar').onclick = () => abrir(saved);
  $('#elegir').onclick = async () => {
    try { abrir(await window.showDirectoryPicker({ id: 'consorcios-datos', mode: 'readwrite' })); } catch (e) { if (e.name !== 'AbortError') pantallaConexion({ saved, error: e.message }); }
  };
  $('#demo').onclick = ev => { ev.preventDefault(); conectar(new Consorcios.MemoryStore({}, 'modo demo (en memoria)'), true); };
}

async function conectar(store, demo = false) {
  const c = new Consorcios.Core(store);
  try { await c.init(); } catch (e) { pantallaConexion({ error: 'No se pudieron leer los datos: ' + e.message }); return; }
  core = c;
  state.meta = await GET('meta');
  $('#carpeta').innerHTML = `<div class="folder ${demo ? 'demo' : ''}" title="${esc(store.name)}"><span>${demo ? '⚠️ Modo demo — no se guarda' : '📁 ' + esc(store.name)}</span><a href="#" id="cambiar">Cambiar</a></div>`;
  $('#cambiar').onclick = async ev => { ev.preventDefault(); pantallaConexion({ saved: demo ? undefined : await idb.get('dir') }); };
  render();
}

// Si se editaron los CSV fuera de la aplicación (p. ej. con Excel), se vuelven a leer al volver a esta pestaña.
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && core && core.store instanceof Consorcios.FolderStore) {
    try { await core.reload(); render(); } catch (e) { toast('No se pudo releer la carpeta: ' + e.message, true); }
  }
});

(async function init() {
  const op = $('#operador'); op.value = state.operador;
  op.oninput = () => { state.operador = op.value.trim(); ls.set('operador', state.operador); };
  const saved = soportaCarpetas ? await idb.get('dir') : undefined;
  if (saved) {
    let perm = 'prompt';
    try { perm = await saved.queryPermission({ mode: 'readwrite' }); } catch { }
    if (perm === 'granted') { await conectar(new Consorcios.FolderStore(saved)); return; }
  }
  pantallaConexion({ saved });
})();
