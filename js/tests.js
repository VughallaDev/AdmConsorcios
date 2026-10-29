'use strict';
/* Tests de la aplicación. Se ejecutan abriendo tests.html (no requieren servidor ni instalación). */
const { Core, MemoryStore, FolderStore, SCHEMA, TABLES, csvParse, csvSerialize, tableFromCsv } = Consorcios;

/* ---------- mini framework ---------- */
const suites = []; let curSuite = null;
const suite = (name, fn) => { curSuite = { name, tests: [] }; suites.push(curSuite); fn(); };
const test = (name, fn) => curSuite.tests.push({ name, fn });
class AssertionError extends Error { }
class SkipError extends Error { }
const skip = m => { throw new SkipError(m); };
const fail = m => { throw new AssertionError(m); };
const show = v => { try { return JSON.stringify(v); } catch { return String(v); } };
const eq = (a, b, msg = '') => { if (JSON.stringify(a) !== JSON.stringify(b)) fail(`${msg} esperado ${show(b)} pero fue ${show(a)}`); };
const ok = (c, msg = 'condición falsa') => { if (!c) fail(msg); };
const status = (r, code, msg = '') => { if (r.status !== code) fail(`${msg} esperado HTTP ${code} pero fue ${r.status} (${show(r.data && r.data.error)})`); return r.data; };

/* ---------- helpers ---------- */
let clock = null;
async function mk(files, opts = {}) {
  const store = new MemoryStore(files);
  const c = new Core(store, opts);
  await c.init();
  c.s = store;
  c.call = (m, u, b) => c.handle(m, u, b);
  c.get = async u => status(await c.handle('GET', u), 200, 'GET ' + u);
  c.post = async (u, b, code = 200) => status(await c.handle('POST', u, b || {}), code, 'POST ' + u);
  c.put = async (u, b, code = 200) => status(await c.handle('PUT', u, b || {}), code, 'PUT ' + u);
  c.del = async (u, code = 200) => status(await c.handle('DELETE', u), code, 'DELETE ' + u);
  return c;
}
// Escenario base: 1 consorcio, 2 unidades, 1 propietario, 2 proveedores
async function escenario(opts) {
  const c = await mk(undefined, opts);
  const cons = await c.post('consorcios', { nombre: 'Torre Norte', direccion: 'Av. Siempreviva 742' });
  const u1 = await c.post('unidades', { consorcio_id: cons.id, numero_uf: '1', piso: '1', departamento: 'A', tipo: 'Departamento' });
  const u2 = await c.post('unidades', { consorcio_id: cons.id, numero_uf: '2', piso: '1', departamento: 'B', tipo: 'Departamento' });
  const pr = await c.post('propietarios', { nombre: 'Ana Gómez', telefono: '11-1111' });
  await c.post('unidad_propietarios', { unidad_id: u1.id, propietario_id: pr.id, porcentaje: '100' });
  const p1 = await c.post('proveedores', { nombre: 'Juan Plomero', telefono: '11-2222', tipo: ['Plomero', 'Gasista'] });
  const p2 = await c.post('proveedores', { nombre: 'Elec SRL', telefono: '11-3333', email: 'e@x.com', tipo: ['Electricista'] });
  return { c, cons, u1, u2, pr, p1, p2 };
}
const nuevoReclamo = (c, e, extra = {}) => c.post('reclamos', Object.assign({ consorcio_id: e.cons.id, tipo_id: '1', urgencia: 'Alta', detalle: 'Pierde agua', solicitante_nombre: 'Ana', unidad_id: e.u1.id }, extra));
const cerrar = (c, id, res = 'Resuelto', motivo = 'ok') => c.post(`reclamos/${id}/cerrar`, { resolucion: res, motivo });

/* ============================================================ CSV */
suite('CSV · lectura y escritura', () => {
  test('serializa con BOM, CRLF y todos los campos entre comillas', () => {
    const s = csvSerialize(['id', 'nombre'], [{ id: '1', nombre: 'Ana' }]);
    eq(s, '﻿id,nombre\r\n"1","Ana"\r\n');
  });
  test('ida y vuelta con comas, comillas, saltos de línea y acentos', () => {
    const rows = [{ id: '1', nombre: 'Pérez, "Juan"\nSegunda línea', obs: 'ñandú 🏢' }];
    const back = csvParse(csvSerialize(['id', 'nombre', 'obs'], rows));
    eq(back[1], ['1', 'Pérez, "Juan"\nSegunda línea', 'ñandú 🏢']);
  });
  test('acepta CSV sin comillas, con LF y sin BOM (p. ej. guardado desde Excel)', () => {
    eq(csvParse('a,b\n1,2\n3,4'), [['a', 'b'], ['1', '2'], ['3', '4']]);
  });
  test('celdas vacías y filas en blanco finales', () => {
    eq(csvParse('a,b,c\r\n"","x",\r\n\r\n'), [['a', 'b', 'c'], ['', 'x', ''], ]);
  });
  test('tableFromCsv completa columnas faltantes y descarta las desconocidas', () => {
    const { rows, header } = tableFromCsv('propietarios', 'id,nombre,columna_rara\n1,Ana,zzz\n');
    eq(rows[0].nombre, 'Ana'); eq(rows[0].telefono, ''); ok(!('columna_rara' in rows[0]));
    eq(header, ['id', 'nombre', 'columna_rara']);
  });
  test('ignora filas totalmente vacías', () => {
    eq(tableFromCsv('propietarios', 'id,nombre\n,\n2,Beto\n').rows.length, 1);
  });
});

/* ============================================================ INICIO / MIGRACIÓN */
suite('Inicio de datos y migración', () => {
  test('en una carpeta vacía crea los 12 archivos CSV con su encabezado', async () => {
    const c = await mk();
    eq(Object.keys(c.s.files).sort(), TABLES.slice().sort());
    for (const t of TABLES) ok(c.s.files[t].startsWith('﻿' + SCHEMA[t].join(',') + '\r\n'), 'encabezado de ' + t);
  });
  test('carga los 15 tipos de reclamo iniciales una sola vez', async () => {
    const c = await mk();
    eq((await c.get('tipos_reclamo')).length, 15);
    const c2 = await mk(c.s.files);
    eq((await c2.get('tipos_reclamo')).length, 15, 'no se vuelven a sembrar');
  });
  test('una segunda carga no reescribe archivos que no cambiaron', async () => {
    const c = await mk();
    const c2 = await mk(c.s.files);
    eq(c2.s.writes, []);
  });
  test('migra un reclamos.csv viejo (sin etapa/resolución) conservando los datos', async () => {
    const viejo = '"id","consorcio_id","unidad_id","ubicacion_detalle","tipo_id","naturaleza","urgencia","titulo","detalle","fecha_reclamo","estado","fecha_cierre","motivo_cierre","solicitante_tipo","solicitante_nombre","solicitante_contacto","canal","operador","actualizado"\r\n' +
      '"1","1","","Hall","1","Técnico","Alta","Agua","Pierde, mucho","2026-01-01 10:00","Abierto","","","Otro","Ana","","Teléfono","Op","2026-01-01 10:00"\r\n' +
      '"2","1","","Garage","2","Técnico","Baja","Luz","Sin luz","2026-01-02 10:00","Cerrado","2026-01-03 09:00","listo","Otro","Beto","","Email","Op","2026-01-03 09:00"\r\n';
    const c = await mk({ reclamos: viejo });
    const r = await c.get('reclamos');
    eq(r.length, 2);
    eq(r[0].etapa, 'Nuevo'); eq(r[0].detalle, 'Pierde, mucho'); eq(r[0].resolucion, '');
    eq(r[1].resolucion, 'Resuelto', 'cerrado viejo => Resuelto'); eq(r[1].motivo_cierre, 'listo');
    ok(c.s.files.reclamos.split('\r\n')[0].includes('"etapa"') === false && c.s.files.reclamos.split('\r\n')[0].includes('etapa'), 'archivo reescrito con columnas nuevas');
    ok(c.migrated.includes('reclamos'));
  });
  test('migra un proveedores.csv sin la columna empresa', async () => {
    const c = await mk({ proveedores: 'id,nombre,telefono,email,tipo,observaciones,activo\n1,Pepe,123,,Plomero|Gasista,nota,SI\n' });
    const p = await c.get('proveedores/1');
    eq(p.tipo, ['Plomero', 'Gasista']); eq(p.empresa, ''); eq(p.observaciones, 'nota');
  });
  test('los IDs continúan desde el máximo existente', async () => {
    const c = await mk({ propietarios: 'id,nombre\n5,Ana\n9,Beto\n' });
    eq((await c.post('propietarios', { nombre: 'Caro' })).id, '10');
  });
});

/* ============================================================ CRUD */
suite('Consorcios, unidades, propietarios, inquilinos, personal', () => {
  test('consorcio: campos obligatorios y fecha de creación', async () => {
    const c = await mk();
    status(await c.call('POST', 'consorcios', { nombre: 'X' }), 400);
    const r = await c.post('consorcios', { nombre: ' X ', direccion: 'Y' });
    eq(r.nombre, 'X'); ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(r.creado));
  });
  test('consorcio: editar y leer; id inexistente => 404', async () => {
    const e = await escenario();
    const r = await e.c.put('consorcios/' + e.cons.id, { nombre: 'Torre Sur' });
    eq(r.nombre, 'Torre Sur'); eq(r.direccion, 'Av. Siempreviva 742', 'conserva lo no enviado');
    status(await e.c.call('GET', 'consorcios/999'), 404);
  });
  test('unidad: consorcio inexistente => 400; duplicada => 409', async () => {
    const e = await escenario();
    status(await e.c.call('POST', 'unidades', { consorcio_id: '99', numero_uf: '7' }), 400);
    status(await e.c.call('POST', 'unidades', { consorcio_id: e.cons.id, numero_uf: '1', piso: '1', departamento: 'A', tipo: 'Departamento' }), 409);
    await e.c.post('unidades', { consorcio_id: e.cons.id, numero_uf: '1', piso: '2', departamento: 'A', tipo: 'Departamento' });
  });
  test('unidad: tipo inválido => 400', async () => {
    const e = await escenario();
    status(await e.c.call('POST', 'unidades', { consorcio_id: e.cons.id, numero_uf: '8', tipo: 'Castillo' }), 400);
  });
  test('personal: rol inválido => 400, válido => ok', async () => {
    const e = await escenario();
    status(await e.c.call('POST', 'personal', { consorcio_id: e.cons.id, nombre: 'Pepe', rol: 'Rey' }), 400);
    await e.c.post('personal', { consorcio_id: e.cons.id, nombre: 'Pepe', rol: 'Encargado' });
  });
  test('propietario asignado dos veces a la misma unidad => 409; porcentajes', async () => {
    const e = await escenario();
    status(await e.c.call('POST', 'unidad_propietarios', { unidad_id: e.u1.id, propietario_id: e.pr.id }), 409);
    const p2 = await e.c.post('propietarios', { nombre: 'Beto' });
    await e.c.post('unidad_propietarios', { unidad_id: e.u1.id, propietario_id: p2.id, porcentaje: '50' });
    const u = await e.c.get('unidades/' + e.u1.id);
    eq(u.propietarios.length, 2);
  });
  test('inquilino: activo si no tiene fecha_hasta o es futura; vencido no figura en el consorcio', async () => {
    const e = await escenario({ now: () => new Date(2026, 5, 15, 10, 0) });
    await e.c.post('inquilinos', { unidad_id: e.u1.id, nombre: 'Activo', fecha_desde: '2026-01-01' });
    await e.c.post('inquilinos', { unidad_id: e.u1.id, nombre: 'Futuro', fecha_hasta: '2026-12-31' });
    await e.c.post('inquilinos', { unidad_id: e.u1.id, nombre: 'Vencido', fecha_hasta: '2026-01-31' });
    const det = await e.c.get('consorcios/' + e.cons.id);
    eq(det.unidades.find(u => u.id === e.u1.id).inquilinos.map(i => i.nombre).sort(), ['Activo', 'Futuro']);
    const u = await e.c.get('unidades/' + e.u1.id);
    eq(u.inquilinos.length, 3);
    eq(u.inquilinos.find(i => i.nombre === 'Vencido').activo, false);
  });
  test('detalle de consorcio: etiqueta de unidad, orden y contadores', async () => {
    const e = await escenario();
    await nuevoReclamo(e.c, e);
    const det = await e.c.get('consorcios/' + e.cons.id);
    eq(det.unidades.map(u => u.label), ['UF 1 · Piso 1 Dto A', 'UF 2 · Piso 1 Dto B']);
    eq(det.unidades[0].reclamos_abiertos, 1); eq(det.reclamos_abiertos, 1);
    eq(det.unidades[0].propietarios[0].nombre, 'Ana Gómez');
    eq(det.unidades[0].direccion_completa, 'Av. Siempreviva 742, Piso 1 Dto A');
  });
  test('listado de consorcios con contadores y ordenado por nombre', async () => {
    const e = await escenario();
    await e.c.post('consorcios', { nombre: 'Alamos', direccion: 'Z' });
    const l = await e.c.get('consorcios');
    eq(l.map(x => x.nombre), ['Alamos', 'Torre Norte']);
    eq(l[1].unidades_count, 2);
  });
  test('propietarios: lista con sus unidades y consorcio', async () => {
    const e = await escenario();
    const l = await e.c.get('propietarios');
    eq(l[0].unidades[0].label, 'UF 1 · Piso 1 Dto A'); eq(l[0].unidades[0].consorcio_nombre, 'Torre Norte');
  });
  test('filtro de unidades por consorcio', async () => {
    const e = await escenario();
    const c2 = await e.c.post('consorcios', { nombre: 'Otro', direccion: 'Q' });
    await e.c.post('unidades', { consorcio_id: c2.id, numero_uf: '1' });
    eq((await e.c.get('unidades?consorcio_id=' + e.cons.id)).length, 2);
    eq((await e.c.get('unidades?consorcio_id=' + c2.id)).length, 1);
  });
  test('borrar consorcio sin reclamos elimina en cascada unidades, personal, inquilinos y vínculos', async () => {
    const e = await escenario();
    await e.c.post('personal', { consorcio_id: e.cons.id, nombre: 'Pepe', rol: 'Encargado' });
    await e.c.post('inquilinos', { unidad_id: e.u1.id, nombre: 'Inq' });
    await e.c.del('consorcios/' + e.cons.id);
    for (const t of ['unidades', 'personal', 'inquilinos', 'unidad_propietarios']) eq((await e.c.get(t)).length, 0, t);
    eq((await e.c.get('propietarios')).length, 1, 'el propietario se conserva');
  });
  test('borrar consorcio o unidad con reclamos => 409 y no borra nada', async () => {
    const e = await escenario();
    await nuevoReclamo(e.c, e);
    status(await e.c.call('DELETE', 'consorcios/' + e.cons.id), 409);
    status(await e.c.call('DELETE', 'unidades/' + e.u1.id), 409);
    eq((await e.c.get('unidades')).length, 2);
    await e.c.del('unidades/' + e.u2.id);
  });
  test('borrar propietario quita sus vínculos con unidades', async () => {
    const e = await escenario();
    await e.c.del('propietarios/' + e.pr.id);
    eq((await e.c.get('unidad_propietarios')).length, 0);
  });
  test('tipos de reclamo: nombre único (sin distinguir mayúsculas), naturaleza válida, bloqueo al borrar', async () => {
    const e = await escenario();
    status(await e.c.call('POST', 'tipos_reclamo', { nombre: 'gas', naturaleza: 'Técnico' }), 409);
    status(await e.c.call('POST', 'tipos_reclamo', { nombre: 'Nuevo', naturaleza: 'Mágico' }), 400);
    const t = await e.c.post('tipos_reclamo', { nombre: 'Ascensor nuevo', naturaleza: 'Técnico' });
    eq(t.activo, 'SI');
    await nuevoReclamo(e.c, e);
    status(await e.c.call('DELETE', 'tipos_reclamo/1'), 409);
    await e.c.del('tipos_reclamo/' + t.id);
  });
  test('recurso inexistente => 404; método no soportado en reclamos => 405', async () => {
    const c = await mk();
    status(await c.call('GET', 'cosas'), 404);
    status(await c.call('PATCH', 'reclamos'), 405);
  });
});

suite('Proveedores', () => {
  test('nombre y teléfono obligatorios; al menos una profesión', async () => {
    const c = await mk();
    status(await c.call('POST', 'proveedores', { telefono: '1', tipo: ['Plomero'] }), 400);
    status(await c.call('POST', 'proveedores', { nombre: 'X', tipo: ['Plomero'] }), 400);
    status(await c.call('POST', 'proveedores', { nombre: 'X', telefono: '1' }), 400);
    status(await c.call('POST', 'proveedores', { nombre: 'X', telefono: '1', tipo: [] }), 400);
    status(await c.call('POST', 'proveedores', { nombre: 'X', telefono: '1', tipo: ['  ', ''] }), 400);
  });
  test('tipo es un arreglo en JSON; se depura y se guarda separado por | en el CSV', async () => {
    const c = await mk();
    const p = await c.post('proveedores', { nombre: 'X', telefono: '1', tipo: ['Plomero', 'plomero', ' Gasista ', 'A|B'] });
    eq(p.tipo, 'Plomero|Gasista|A B');
    const g = await c.get('proveedores/' + p.id);
    eq(g.tipo, ['Plomero', 'Gasista', 'A B']);
    ok(c.s.files.proveedores.includes('"Plomero|Gasista|A B"'));
  });
  test('editar sin enviar tipo conserva las profesiones; email opcional; activo por defecto', async () => {
    const c = await mk();
    const p = await c.post('proveedores', { nombre: 'X', telefono: '1', tipo: ['Plomero'] });
    eq(p.activo, 'SI'); eq(p.email, '');
    await c.put('proveedores/' + p.id, { telefono: '2' });
    eq((await c.get('proveedores/' + p.id)).tipo, ['Plomero']);
    await c.put('proveedores/' + p.id, { activo: 'NO' });
    eq((await c.get('proveedores/' + p.id)).activo, 'NO');
  });
  test('editar dejando tipo vacío => 400', async () => {
    const c = await mk();
    const p = await c.post('proveedores', { nombre: 'X', telefono: '1', tipo: ['Plomero'] });
    status(await c.call('PUT', 'proveedores/' + p.id, { tipo: [] }), 400);
  });
  test('listado con reclamos activos y totales', async () => {
    const e = await escenario();
    const r1 = await nuevoReclamo(e.c, e, { proveedor_ids: [e.p1.id] });
    const r2 = await nuevoReclamo(e.c, e, { tipo_id: '2', proveedor_ids: [e.p1.id] });
    await cerrar(e.c, r2.id);
    const l = await e.c.get('proveedores');
    const j = l.find(x => x.id === e.p1.id);
    eq([j.reclamos_activos, j.reclamos_total], [1, 2]);
    const det = await e.c.get('proveedores/' + e.p1.id);
    eq(det.reclamos.length, 2);
  });
  test('profesiones del meta incluyen las personalizadas, sin duplicar', async () => {
    const c = await mk();
    await c.post('proveedores', { nombre: 'X', telefono: '1', tipo: ['Domótica', 'plomero'] });
    const m = await c.get('meta');
    ok(m.profesiones.includes('Domótica')); eq(m.profesiones.filter(x => x.toLowerCase() === 'plomero').length, 1);
  });
  test('no se puede borrar un proveedor asignado; sí uno sin uso', async () => {
    const e = await escenario();
    const r = await nuevoReclamo(e.c, e, { proveedor_ids: [e.p1.id] });
    status(await e.c.call('DELETE', 'proveedores/' + e.p1.id), 409);
    await e.c.del('proveedores/' + e.p2.id);
    await e.c.del(`reclamos/${r.id}/proveedores/${e.p1.id}`);
    await e.c.del('proveedores/' + e.p1.id);
  });
});

/* ============================================================ RECLAMOS */
suite('Reclamos · alta y duplicados', () => {
  test('nace Abierto, etapa Nuevo, con historial "Creado" y datos enriquecidos', async () => {
    const e = await escenario();
    const r = await nuevoReclamo(e.c, e);
    eq([r.estado, r.etapa, r.resolucion], ['Abierto', 'Nuevo', '']);
    eq(r.tipo_nombre, 'Problemas de agua'); eq(r.unidad_label, 'UF 1 · Piso 1 Dto A'); eq(r.consorcio_nombre, 'Torre Norte');
    eq(r.historial[0].accion, 'Creado'); eq(r.naturaleza, 'Técnico', 'toma la del tipo'); eq(r.titulo, 'Problemas de agua'); eq(r.canal, 'Teléfono');
    eq(r.urgencia_nivel, 3);
  });
  test('campos obligatorios y valores inválidos', async () => {
    const e = await escenario();
    for (const k of ['consorcio_id', 'tipo_id', 'urgencia', 'detalle', 'solicitante_nombre']) {
      const b = { consorcio_id: e.cons.id, tipo_id: '1', urgencia: 'Alta', detalle: 'x', solicitante_nombre: 'A' }; delete b[k];
      status(await e.c.call('POST', 'reclamos', b), 400, k);
    }
    status(await nuevoReclamoRaw(e, { urgencia: 'Altísima' }), 400);
    status(await nuevoReclamoRaw(e, { consorcio_id: '99' }), 400);
    status(await nuevoReclamoRaw(e, { tipo_id: '99' }), 404);
    status(await nuevoReclamoRaw(e, { naturaleza: 'Raro' }), 400);
  });
  test('la unidad debe pertenecer al consorcio', async () => {
    const e = await escenario();
    const c2 = await e.c.post('consorcios', { nombre: 'Otro', direccion: 'Q' });
    status(await nuevoReclamoRaw(e, { consorcio_id: c2.id }), 400);
  });
  test('área común (sin unidad) es válida', async () => {
    const e = await escenario();
    const r = await nuevoReclamo(e.c, e, { unidad_id: '' });
    eq(r.unidad_label, 'Áreas comunes');
  });
  test('no permite duplicar un incidente abierto: 409 con el reclamo existente', async () => {
    const e = await escenario();
    const r = await nuevoReclamo(e.c, e);
    const res = await nuevoReclamoRaw(e, {});
    const d = status(res, 409);
    eq(d.duplicados.map(x => x.id), [r.id]); ok(/reiteraci/i.test(d.error));
    eq((await e.c.get('reclamos')).length, 1);
  });
  test('la ubicación se compara sin distinguir mayúsculas ni espacios', async () => {
    const e = await escenario();
    await nuevoReclamo(e.c, e, { ubicacion_detalle: 'Baño principal' });
    status(await nuevoReclamoRaw(e, { ubicacion_detalle: '  baño PRINCIPAL ' }), 409);
    await nuevoReclamo(e.c, e, { ubicacion_detalle: 'Cocina' });
  });
  test('distinto tipo, unidad o consorcio NO es duplicado', async () => {
    const e = await escenario();
    await nuevoReclamo(e.c, e);
    await nuevoReclamo(e.c, e, { tipo_id: '2' });
    await nuevoReclamo(e.c, e, { unidad_id: e.u2.id });
    await nuevoReclamo(e.c, e, { unidad_id: '' });
    const c2 = await e.c.post('consorcios', { nombre: 'Otro', direccion: 'Q' });
    await e.c.post('reclamos', { consorcio_id: c2.id, tipo_id: '1', urgencia: 'Alta', detalle: 'x', solicitante_nombre: 'A' });
    eq((await e.c.get('reclamos')).length, 5);
  });
  test('tras cerrar un reclamo, el mismo incidente puede cargarse de nuevo', async () => {
    const e = await escenario();
    const r = await nuevoReclamo(e.c, e);
    await cerrar(e.c, r.id);
    const r2 = await nuevoReclamo(e.c, e);
    ok(r2.id !== r.id);
  });
  test('los IDs son correlativos', async () => {
    const e = await escenario();
    const a = await nuevoReclamo(e.c, e); const b = await nuevoReclamo(e.c, e, { tipo_id: '2' });
    eq([a.id, b.id], ['1', '2']);
  });
});
const nuevoReclamoRaw = (e, extra) => e.c.call('POST', 'reclamos', Object.assign({ consorcio_id: e.cons.id, tipo_id: '1', urgencia: 'Alta', detalle: 'Pierde agua', solicitante_nombre: 'Ana', unidad_id: e.u1.id }, extra));

suite('Reclamos · reiteraciones', () => {
  test('registra la reiteración, cuenta y deja historial', async () => {
    const e = await escenario();
    const r = await nuevoReclamo(e.c, e);
    const d = await e.c.post(`reclamos/${r.id}/reiterar`, { solicitante_nombre: 'Beto', solicitante_tipo: 'Inquilino', detalle: 'Sigue igual' });
    eq(d.reiteraciones, 1); eq(d.reiteraciones_lista[0].solicitante_nombre, 'Beto'); eq(d.historial[0].accion, 'Reiteración');
    ok(d.historial[0].detalle.includes('N° 1'));
    const d2 = await e.c.post(`reclamos/${r.id}/reiterar`, { solicitante_nombre: 'Caro', detalle: 'Otra vez' });
    eq(d2.reiteraciones, 2); ok(d2.ultima_reiteracion !== '');
  });
  test('exige quién llama y el detalle', async () => {
    const e = await escenario();
    const r = await nuevoReclamo(e.c, e);
    status(await e.c.call('POST', `reclamos/${r.id}/reiterar`, { detalle: 'x' }), 400);
    status(await e.c.call('POST', `reclamos/${r.id}/reiterar`, { solicitante_nombre: 'x' }), 400);
  });
  test('puede subir la urgencia al reiterar (queda en el historial)', async () => {
    const e = await escenario();
    const r = await nuevoReclamo(e.c, e);
    const d = await e.c.post(`reclamos/${r.id}/reiterar`, { solicitante_nombre: 'B', detalle: 'peor', urgencia: 'Urgente' });
    eq(d.urgencia, 'Urgente'); ok(d.historial.some(h => h.accion === 'Urgencia modificada'));
  });
  test('no se puede reiterar un reclamo cerrado (hay que reabrir)', async () => {
    const e = await escenario();
    const r = await nuevoReclamo(e.c, e); await cerrar(e.c, r.id);
    status(await e.c.call('POST', `reclamos/${r.id}/reiterar`, { solicitante_nombre: 'B', detalle: 'x' }), 409);
  });
});

suite('Reclamos · cierre y reapertura', () => {
  test('cada tipo de cierre: Resuelto, Desestimado, Anulado', async () => {
    const e = await escenario();
    for (const [i, res] of ['Resuelto', 'Desestimado', 'Anulado'].entries()) {
      const r = await nuevoReclamo(e.c, e, { tipo_id: String(i + 1) });
      const d = await cerrar(e.c, r.id, res, 'motivo ' + res);
      eq([d.estado, d.resolucion, d.motivo_cierre], ['Cerrado', res, 'motivo ' + res]);
      ok(d.fecha_cierre); eq(d.historial[0].accion, 'Cerrado: ' + res);
    }
  });
  test('exige tipo de cierre válido y motivo', async () => {
    const e = await escenario();
    const r = await nuevoReclamo(e.c, e);
    status(await e.c.call('POST', `reclamos/${r.id}/cerrar`, { motivo: 'x' }), 400);
    status(await e.c.call('POST', `reclamos/${r.id}/cerrar`, { resolucion: 'Borrado', motivo: 'x' }), 400);
    status(await e.c.call('POST', `reclamos/${r.id}/cerrar`, { resolucion: 'Resuelto' }), 400);
    eq((await e.c.get('reclamos/' + r.id)).estado, 'Abierto');
  });
  test('cerrar dos veces => 409', async () => {
    const e = await escenario();
    const r = await nuevoReclamo(e.c, e); await cerrar(e.c, r.id);
    status(await e.c.call('POST', `reclamos/${r.id}/cerrar`, { resolucion: 'Anulado', motivo: 'x' }), 409);
  });
  test('NADA se borra: los cerrados siguen en la base y se filtran por estado', async () => {
    const e = await escenario();
    const a = await nuevoReclamo(e.c, e); const b = await nuevoReclamo(e.c, e, { tipo_id: '2' });
    await cerrar(e.c, a.id, 'Anulado');
    eq((await e.c.get('reclamos?estado=Abierto')).map(x => x.id), [b.id]);
    eq((await e.c.get('reclamos?estado=Cerrado')).map(x => x.id), [a.id]);
    eq((await e.c.get('reclamos')).length, 2);
    ok(e.c.s.files.reclamos.includes('"Anulado"'), 'persistido en el CSV');
  });
  test('reabrir: limpia el cierre, exige motivo y deja historial', async () => {
    const e = await escenario();
    const r = await nuevoReclamo(e.c, e); await cerrar(e.c, r.id, 'Desestimado');
    status(await e.c.call('POST', `reclamos/${r.id}/reabrir`, {}), 400);
    const d = await e.c.post(`reclamos/${r.id}/reabrir`, { motivo: 'Volvió a fallar' });
    eq([d.estado, d.resolucion, d.fecha_cierre, d.motivo_cierre], ['Abierto', '', '', '']); eq(d.historial[0].accion, 'Reabierto');
  });
  test('reabrir un reclamo abierto => 409', async () => {
    const e = await escenario(); const r = await nuevoReclamo(e.c, e);
    status(await e.c.call('POST', `reclamos/${r.id}/reabrir`, { motivo: 'x' }), 409);
  });
  test('no se puede reabrir si ya hay otro abierto del mismo incidente', async () => {
    const e = await escenario();
    const r = await nuevoReclamo(e.c, e); await cerrar(e.c, r.id);
    const r2 = await nuevoReclamo(e.c, e);
    const d = status(await e.c.call('POST', `reclamos/${r.id}/reabrir`, { motivo: 'x' }), 409);
    eq(d.duplicados.map(x => x.id), [r2.id]);
  });
});

suite('Reclamos · etapas', () => {
  test('las 7 etapas existen y la primera es Nuevo', async () => {
    const c = await mk(); const m = await c.get('meta');
    eq(m.etapas, ['Nuevo', 'En espera de visita del proveedor', 'Visitado por el proveedor', 'Esperando presupuesto', 'Presupuesto aprobado', 'Trabajo en ejecución', 'Finalizado']);
    eq(m.resoluciones, ['Resuelto', 'Desestimado', 'Anulado']);
  });
  test('se puede pasar de cualquier etapa a cualquier otra, en cualquier momento (incluso hacia atrás)', async () => {
    const e = await escenario(); const r = await nuevoReclamo(e.c, e);
    const m = await e.c.get('meta');
    for (const et of [m.etapas[3], m.etapas[6], m.etapas[0], m.etapas[5], m.etapas[1]]) {
      eq((await e.c.post(`reclamos/${r.id}/etapa`, { etapa: et })).etapa, et);
    }
  });
  test('etapa inválida => 400; misma etapa no agrega historial', async () => {
    const e = await escenario(); const r = await nuevoReclamo(e.c, e);
    status(await e.c.call('POST', `reclamos/${r.id}/etapa`, { etapa: 'Inventada' }), 400);
    const antes = (await e.c.get('reclamos/' + r.id)).historial.length;
    await e.c.post(`reclamos/${r.id}/etapa`, { etapa: 'Nuevo' });
    eq((await e.c.get('reclamos/' + r.id)).historial.length, antes);
  });
  test('el cambio de etapa queda en el historial con la nota', async () => {
    const e = await escenario(); const r = await nuevoReclamo(e.c, e);
    const d = await e.c.post(`reclamos/${r.id}/etapa`, { etapa: 'Esperando presupuesto', detalle: 'pidió 3' });
    eq(d.historial[0].accion, 'Etapa'); ok(d.historial[0].detalle.includes('«Nuevo»') && d.historial[0].detalle.includes('pidió 3'));
  });
  test('un reclamo cerrado conserva su etapa', async () => {
    const e = await escenario(); const r = await nuevoReclamo(e.c, e);
    await e.c.post(`reclamos/${r.id}/etapa`, { etapa: 'Finalizado' });
    eq((await cerrar(e.c, r.id)).etapa, 'Finalizado');
  });
});

suite('Reclamos · proveedores asignados', () => {
  test('asignar al crear, uno o varios', async () => {
    const e = await escenario();
    const r = await nuevoReclamo(e.c, e, { proveedor_ids: [e.p1.id, e.p2.id] });
    eq(r.proveedores.map(p => p.nombre).sort(), ['Elec SRL', 'Juan Plomero']);
    ok(r.historial.some(h => h.accion === 'Proveedor asignado'));
  });
  test('asignar después; no repite el mismo proveedor', async () => {
    const e = await escenario(); const r = await nuevoReclamo(e.c, e);
    await e.c.post(`reclamos/${r.id}/proveedores`, { proveedor_ids: [e.p1.id] });
    const d = await e.c.post(`reclamos/${r.id}/proveedores`, { proveedor_ids: [e.p1.id, e.p2.id, e.p2.id] });
    eq(d.proveedores.length, 2); eq((await e.c.get('reclamo_proveedores')).length, 2);
  });
  test('proveedor inexistente => 400 y no asigna ninguno; sin selección => 400', async () => {
    const e = await escenario(); const r = await nuevoReclamo(e.c, e);
    status(await e.c.call('POST', `reclamos/${r.id}/proveedores`, { proveedor_ids: [e.p1.id, '999'] }), 400);
    eq((await e.c.get('reclamo_proveedores')).length, 0);
    status(await e.c.call('POST', `reclamos/${r.id}/proveedores`, { proveedor_ids: [] }), 400);
    status(await e.c.call('POST', `reclamos/${r.id}/proveedores`, {}), 400);
  });
  test('desasignar; desasignar uno que no está => 404', async () => {
    const e = await escenario(); const r = await nuevoReclamo(e.c, e, { proveedor_ids: [e.p1.id, e.p2.id] });
    const d = await e.c.del(`reclamos/${r.id}/proveedores/${e.p2.id}`);
    eq(d.proveedores.map(p => p.id), [e.p1.id]); ok(d.historial.some(h => h.accion === 'Proveedor desasignado'));
    status(await e.c.call('DELETE', `reclamos/${r.id}/proveedores/${e.p2.id}`), 404);
  });
  test('el proveedor asignado se ve también en el listado de reclamos', async () => {
    const e = await escenario(); await nuevoReclamo(e.c, e, { proveedor_ids: [e.p1.id] });
    eq((await e.c.get('reclamos'))[0].proveedores[0].nombre, 'Juan Plomero');
  });
  test('un proveedor puede asignarse a reclamos cerrados y queda el historial', async () => {
    const e = await escenario(); const r = await nuevoReclamo(e.c, e, { proveedor_ids: [e.p1.id] });
    await cerrar(e.c, r.id);
    eq((await e.c.get('reclamos/' + r.id)).proveedores.length, 1);
  });
});

suite('Reclamos · edición, notas, borrado y listados', () => {
  test('modificar urgencia/naturaleza/título/detalle registra los cambios', async () => {
    const e = await escenario(); const r = await nuevoReclamo(e.c, e);
    const d = await e.c.put('reclamos/' + r.id, { urgencia: 'Urgente Crítico', naturaleza: 'Administrativo', titulo: 'Nuevo título', detalle: 'Detalle nuevo' });
    eq([d.urgencia, d.naturaleza, d.titulo, d.detalle], ['Urgente Crítico', 'Administrativo', 'Nuevo título', 'Detalle nuevo']);
    ok(d.historial[0].detalle.includes('Urgencia: Alta → Urgente Crítico'));
    status(await e.c.call('PUT', 'reclamos/' + r.id, { urgencia: 'Nada' }), 400);
  });
  test('notas: exige texto y queda en el historial', async () => {
    const e = await escenario(); const r = await nuevoReclamo(e.c, e);
    status(await e.c.call('POST', `reclamos/${r.id}/notas`, { detalle: ' ' }), 400);
    eq((await e.c.post(`reclamos/${r.id}/notas`, { detalle: 'Llamé al proveedor' })).historial[0].accion, 'Nota');
  });
  test('el operador queda registrado (y "Operador" por defecto)', async () => {
    const e = await escenario();
    const r = await nuevoReclamo(e.c, e, { operador: 'Marta' });
    eq(r.operador, 'Marta'); eq(r.historial[0].operador, 'Marta');
    const r2 = await nuevoReclamo(e.c, e, { tipo_id: '3' }); eq(r2.operador, 'Operador');
  });
  test('filtros del listado por consorcio y por unidad', async () => {
    const e = await escenario();
    const c2 = await e.c.post('consorcios', { nombre: 'Otro', direccion: 'Q' });
    await nuevoReclamo(e.c, e); await nuevoReclamo(e.c, e, { unidad_id: e.u2.id });
    await e.c.post('reclamos', { consorcio_id: c2.id, tipo_id: '1', urgencia: 'Baja', detalle: 'x', solicitante_nombre: 'A' });
    eq((await e.c.get('reclamos?consorcio_id=' + e.cons.id)).length, 2);
    eq((await e.c.get('reclamos?consorcio_id=' + e.cons.id + '&unidad_id=' + e.u2.id)).length, 1);
    eq((await e.c.get('reclamos?consorcio_id=' + c2.id)).length, 1);
  });
  test('eliminar un reclamo borra en cascada reiteraciones, historial y asignaciones', async () => {
    const e = await escenario(); const r = await nuevoReclamo(e.c, e, { proveedor_ids: [e.p1.id] });
    await e.c.post(`reclamos/${r.id}/reiterar`, { solicitante_nombre: 'B', detalle: 'x' });
    await e.c.del('reclamos/' + r.id);
    for (const t of ['reclamos', 'reiteraciones', 'historial', 'reclamo_proveedores']) eq((await e.c.get(t)).length, 0, t);
  });
  test('reclamo inexistente => 404', async () => {
    const c = await mk();
    status(await c.call('GET', 'reclamos/77'), 404);
    status(await c.call('POST', 'reclamos/77/cerrar', { resolucion: 'Resuelto', motivo: 'x' }), 404);
  });
  test('el historial viene del más nuevo al más viejo', async () => {
    const e = await escenario(); const r = await nuevoReclamo(e.c, e);
    await e.c.post(`reclamos/${r.id}/notas`, { detalle: 'uno' }); await e.c.post(`reclamos/${r.id}/notas`, { detalle: 'dos' });
    const h = (await e.c.get('reclamos/' + r.id)).historial;
    eq(h.map(x => x.detalle).slice(0, 2), ['dos', 'uno']);
  });
});

suite('Resumen del inicio', () => {
  test('cuenta abiertos, cerrados, urgencias y etapas', async () => {
    const e = await escenario();
    const a = await nuevoReclamo(e.c, e, { tipo_id: '1', urgencia: 'Urgente' });
    const b = await nuevoReclamo(e.c, e, { tipo_id: '2', urgencia: 'Baja' });
    const d = await nuevoReclamo(e.c, e, { tipo_id: '3', urgencia: 'Urgente Crítico' });
    await e.c.post(`reclamos/${b.id}/etapa`, { etapa: 'Esperando presupuesto' });
    await cerrar(e.c, d.id, 'Resuelto');
    const s = await e.c.get('resumen');
    eq([s.abiertos, s.cerrados, s.resueltos_30d], [2, 1, 1]);
    eq(s.por_urgencia, { 'Baja': 1, 'Media': 0, 'Alta': 0, 'Urgente': 1, 'Urgente Crítico': 0 });
    eq(s.por_etapa.find(x => x.etapa === 'Nuevo').cantidad, 1); eq(s.por_etapa.find(x => x.etapa === 'Esperando presupuesto').cantidad, 1);
    eq(s.por_etapa.length, 7); eq([s.consorcios, s.unidades, s.propietarios], [1, 2, 1]);
    eq(s.prioritarios.map(x => x.id), [a.id, b.id], 'más urgente primero');
  });
  test('"Resueltos 30 días" no cuenta anulados/desestimados ni cierres viejos', async () => {
    let ahora = new Date(2026, 0, 1, 10, 0);
    const e = await escenario({ now: () => ahora });
    const a = await nuevoReclamo(e.c, e, { tipo_id: '1' }); const b = await nuevoReclamo(e.c, e, { tipo_id: '2' }); const d = await nuevoReclamo(e.c, e, { tipo_id: '3' });
    await cerrar(e.c, a.id, 'Resuelto');            // 1 de enero
    ahora = new Date(2026, 1, 20, 10, 0);            // 50 días después
    await cerrar(e.c, b.id, 'Resuelto'); await cerrar(e.c, d.id, 'Anulado');
    eq((await e.c.get('resumen')).resueltos_30d, 1);
  });
  test('reiteraciones de los últimos 7 días', async () => {
    let ahora = new Date(2026, 0, 1, 10, 0);
    const e = await escenario({ now: () => ahora });
    const r = await nuevoReclamo(e.c, e);
    await e.c.post(`reclamos/${r.id}/reiterar`, { solicitante_nombre: 'B', detalle: 'x' });
    ahora = new Date(2026, 0, 20, 10, 0);
    await e.c.post(`reclamos/${r.id}/reiterar`, { solicitante_nombre: 'B', detalle: 'y' });
    eq((await e.c.get('resumen')).reiteraciones_7d, 1);
  });
  test('prioritarios: máximo 8', async () => {
    const e = await escenario();
    for (let i = 1; i <= 10; i++) await nuevoReclamo(e.c, e, { ubicacion_detalle: 'lugar ' + i });
    eq((await e.c.get('resumen')).prioritarios.length, 8);
  });
  test('/db informa filas y columnas por archivo', async () => {
    const e = await escenario(); const db = await e.c.get('db');
    eq(db.length, 12); eq(db.find(x => x.tabla === 'proveedores').filas, 2); eq(db.find(x => x.tabla === 'proveedores').archivo, 'proveedores.csv');
  });
});

/* ============================================================ PERSISTENCIA */
suite('Persistencia en archivos', () => {
  test('lo guardado se recupera al abrir de nuevo la misma carpeta', async () => {
    const e = await escenario();
    const r = await nuevoReclamo(e.c, e, { proveedor_ids: [e.p1.id], detalle: 'Con "comillas", comas\ny salto' });
    await e.c.post(`reclamos/${r.id}/etapa`, { etapa: 'Presupuesto aprobado' });
    const c2 = await mk(e.c.s.files);
    const d = await c2.get('reclamos/' + r.id);
    eq(d.detalle, 'Con "comillas", comas\ny salto'); eq(d.etapa, 'Presupuesto aprobado'); eq(d.proveedores.length, 1); eq(d.historial.length, 3);
  });
  test('sólo se reescriben los archivos que cambiaron', async () => {
    const e = await escenario(); e.c.s.writes.length = 0;
    await e.c.post('propietarios', { nombre: 'Nuevo' });
    eq(e.c.s.writes, ['propietarios']);
  });
  test('una operación inválida no escribe nada', async () => {
    const e = await escenario(); e.c.s.writes.length = 0;
    status(await e.c.call('POST', 'proveedores', { nombre: 'X' }), 400);
    eq(e.c.s.writes, []);
  });
  test('los CSV usan BOM y todos los campos entre comillas', async () => {
    const e = await escenario();
    ok(e.c.s.files.consorcios.startsWith('﻿"id"'.replace('"id"', 'id')));
    ok(e.c.s.files.consorcios.includes('"Torre Norte","Av. Siempreviva 742"'));
  });
  test('peticiones simultáneas se serializan: IDs únicos y nada se pierde', async () => {
    const c = await mk();
    const rs = await Promise.all(Array.from({ length: 25 }, (_, i) => c.call('POST', 'propietarios', { nombre: 'P' + i })));
    const ids = rs.map(r => r.data.id);
    eq(new Set(ids).size, 25); eq((await c.get('propietarios')).length, 25);
    eq(tableFromCsv('propietarios', c.s.files.propietarios).rows.length, 25);
  });
  test('si falla la escritura en disco, la operación informa el error y los datos en memoria se restauran', async () => {
    const e = await escenario();
    const original = e.c.s.write.bind(e.c.s);
    e.c.s.write = async () => { throw new Error('disco lleno'); };
    const r = await e.c.call('POST', 'propietarios', { nombre: 'Fallido' });
    eq(r.status, 500); ok(r.data.error.includes('disco lleno'));
    e.c.s.write = original;
    eq((await e.c.get('propietarios')).map(p => p.nombre), ['Ana Gómez']);
  });
  test('recargar toma cambios hechos a mano en el CSV (p. ej. con Excel)', async () => {
    const e = await escenario();
    e.c.s.files.propietarios = 'id,nombre,dni,telefono,telefono_alt,email,observaciones\r\n1,Editado afuera,,,,,\r\n';
    await e.c.reload();
    eq((await e.c.get('propietarios/1')).nombre, 'Editado afuera');
  });
  test('los datos devueltos son copias: modificarlos no altera la base', async () => {
    const e = await escenario();
    const p = await e.c.get('propietarios/' + e.pr.id); p.nombre = 'HACK';
    eq((await e.c.get('propietarios/' + e.pr.id)).nombre, 'Ana Gómez');
  });
  test('caracteres especiales (ñ, acentos, emoji) sobreviven al guardado', async () => {
    const e = await escenario();
    const c = await e.c.post('consorcios', { nombre: 'Edificio Ñandú 🌿', direccion: 'Güemes 123 — Pta. Baja' });
    const c2 = await mk(e.c.s.files);
    eq((await c2.get('consorcios/' + c.id)).nombre, 'Edificio Ñandú 🌿');
  });
});

/* ============================================================ CARPETA REAL (OPFS) */
suite('FolderStore (File System Access API sobre una carpeta real)', () => {
  // Chrome/Edge no permiten la carpeta temporal (OPFS) desde file://; ahí se omiten (en la app real se usa la carpeta elegida por el usuario).
  const dir = async () => {
    let root;
    try { root = await navigator.storage.getDirectory(); } catch (e) { skip('carpeta temporal no disponible en este contexto (' + e.name + '). Abrí tests.html por http:// para ejecutarlos.'); }
    const name = 'test-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    return { root, name, handle: await root.getDirectoryHandle(name, { create: true }) };
  };
  test('leer un archivo inexistente devuelve null; escribir y leer', async () => {
    const d = await dir(); const s = new FolderStore(d.handle);
    eq(await s.read('x'), null);
    await s.write('x', '﻿a,b\r\n"ñ","é"\r\n');
    eq((await s.read('x')).replace(/^﻿/, ''), 'a,b\r\n"ñ","é"\r\n');   // el navegador quita el BOM al leer; el parser también lo tolera
    await d.root.removeEntry(d.name, { recursive: true });
  });
  test('el núcleo crea los 12 CSV en la carpeta y los recupera en otra sesión', async () => {
    const d = await dir(); const c = new Core(new FolderStore(d.handle)); await c.init();
    const nombres = []; for await (const [n] of d.handle.entries()) nombres.push(n);
    eq(nombres.sort(), TABLES.map(t => t + '.csv').sort());
    const r = await c.handle('POST', 'consorcios', { nombre: 'Disco', direccion: 'Real 1' });
    eq(r.status, 200);
    const c2 = new Core(new FolderStore(d.handle)); await c2.init();
    eq((await c2.handle('GET', 'consorcios')).data.map(x => x.nombre), ['Disco']);
    const bytes = new Uint8Array(await (await (await d.handle.getFileHandle('consorcios.csv')).getFile()).arrayBuffer());
    eq([...bytes.slice(0, 3)], [0xEF, 0xBB, 0xBF], 'el archivo en disco empieza con BOM UTF-8');
    await d.root.removeEntry(d.name, { recursive: true });
  });
  test('flujo completo de un reclamo contra archivos reales', async () => {
    const d = await dir(); const c = new Core(new FolderStore(d.handle)); await c.init();
    const H = (m, u, b) => c.handle(m, u, b);
    const cons = (await H('POST', 'consorcios', { nombre: 'A', direccion: 'B' })).data;
    const pv = (await H('POST', 'proveedores', { nombre: 'P', telefono: '1', tipo: ['Plomero'] })).data;
    const rec = (await H('POST', 'reclamos', { consorcio_id: cons.id, tipo_id: '1', urgencia: 'Alta', detalle: 'x', solicitante_nombre: 'Z', proveedor_ids: [pv.id] })).data;
    eq((await H('POST', 'reclamos', { consorcio_id: cons.id, tipo_id: '1', urgencia: 'Alta', detalle: 'x', solicitante_nombre: 'Z' })).status, 409);
    await H('POST', `reclamos/${rec.id}/etapa`, { etapa: 'Visitado por el proveedor' });
    await H('POST', `reclamos/${rec.id}/cerrar`, { resolucion: 'Resuelto', motivo: 'listo' });
    const c2 = new Core(new FolderStore(d.handle)); await c2.init();
    const x = (await c2.handle('GET', 'reclamos/' + rec.id)).data;
    eq([x.estado, x.resolucion, x.etapa, x.proveedores.length], ['Cerrado', 'Resuelto', 'Visitado por el proveedor', 1]);
    await d.root.removeEntry(d.name, { recursive: true });
  });
});

/* ============================================================ INTERFAZ (humo) */
suite('Interfaz (index.html cargado en un iframe, modo demo)', () => {
  // Desde file:// el navegador aísla los iframes (origen distinto): no se puede inspeccionar su contenido.
  const abrir = () => new Promise((res, rej) => {
    if (location.protocol === 'file:') return rej(new SkipError('un iframe no es inspeccionable desde file://; se prueba la interfaz por http://'));
    const f = document.createElement('iframe'); f.style.cssText = 'width:1200px;height:800px;border:0;position:absolute;left:-9999px';
    f.src = 'index.html'; const errs = [];
    f.onload = () => { f.contentWindow.addEventListener('error', e => errs.push(e.message)); res({ f, w: f.contentWindow, d: f.contentDocument, errs }); };
    f.onerror = rej; document.body.appendChild(f);
  });
  const esperar = async (fn, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 40)); } throw new AssertionError('timeout esperando la interfaz'); };
  test('sin carpeta guardada muestra la pantalla de conexión y permite modo demo', async () => {
    const u = await abrir();
    try {
      await esperar(() => u.d.querySelector('.gate'));
      ok(u.d.querySelector('#elegir'), 'botón elegir carpeta'); ok(u.d.querySelector('#demo'), 'enlace demo');
      u.d.querySelector('#demo').click();
      await esperar(() => u.d.querySelector('.page-head'));
      ok(u.d.querySelector('#carpeta .demo'), 'aviso de modo demo');
      eq(u.errs, []);
    } finally { u.f.remove(); }
  });
  test('recorre todas las secciones sin errores', async () => {
    const u = await abrir();
    try {
      await esperar(() => u.d.querySelector('#demo')); u.d.querySelector('#demo').click();
      await esperar(() => u.d.querySelector('.page-head'));
      for (const h of ['#/inicio', '#/reclamos', '#/consorcios', '#/propietarios', '#/proveedores', '#/config']) {
        u.w.location.hash = h; await new Promise(r => setTimeout(r, 250));
        await esperar(() => u.d.querySelector('#main .page-head'));
        ok(!u.d.querySelector('#main .alert.err'), 'error visible en ' + h);
      }
      ok(u.d.querySelectorAll('#main tbody tr').length >= 12, 'config lista las 12 tablas');
      eq(u.errs, []);
    } finally { u.f.remove(); }
  });
  test('cargar proveedor + consorcio + reclamo desde la interfaz y verlo en Reclamos', async () => {
    const u = await abrir();
    try {
      await esperar(() => u.d.querySelector('#demo')); u.d.querySelector('#demo').click();
      await esperar(() => u.d.querySelector('.page-head'));
      const w = u.w;   // app.js usa const globales: se accede con eval dentro del iframe
      const cons = await w.eval("POST('consorcios', { nombre: 'UI Test', direccion: 'Calle 1' })");
      const prov = await w.eval("POST('proveedores', { nombre: 'Prov UI', telefono: '1', tipo: ['Plomero'] })");
      const rec = await w.eval(`POST('reclamos', { consorcio_id: '${cons.id}', tipo_id: '1', urgencia: 'Alta', detalle: 'desde UI', solicitante_nombre: 'Z', proveedor_ids: ['${prov.id}'] })`);
      w.location.hash = '#/reclamos';
      await esperar(() => [...u.d.querySelectorAll('#main select option')].some(o => o.textContent.includes('UI Test')));
      await w.eval("go('#/proveedores')");
      await esperar(() => u.d.querySelector('#main').textContent.includes('Prov UI'));
      eq(u.errs, []); eq(rec.proveedores[0].nombre, 'Prov UI');
    } finally { u.f.remove(); }
  });
});

/* ============================================================ SUPABASE (base simulada) */
const { SupabaseStore, StoreError } = Consorcios;
const TESTKEY = 'test-supabase-session';

// Simula lo que hacen Auth y PostgREST de Supabase (login, token, paginado de 1000, upsert, delete, restricciones y errores).
function fakeSupabase(opts = {}) {
  const db = {}; for (const t of TABLES) db[t] = [];
  const st = { db, calls: [], users: { 'op@x.com': 'secreta' }, tokens: new Map(), refresh: new Map(), n: 0, offline: false, failNextRest: null, expireNext: false };
  const res = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => (body == null ? '' : JSON.stringify(body)) });
  const issue = email => {
    const id = ++st.n, at = 'AT' + id, rt = 'RT' + id;
    st.tokens.set(at, email); st.refresh.set(rt, email);
    return { access_token: at, refresh_token: rt, expires_in: opts.expiresIn ?? 3600, user: { email } };
  };
  st.fetch = async (url, init = {}) => {
    if (st.offline) throw new TypeError('Failed to fetch');
    const u = new URL(url), h = init.headers || {}, method = init.method || 'GET';
    if (!h.apikey) return res(401, { message: 'No API key found in request' });
    if (u.pathname === '/auth/v1/token') {
      const b = JSON.parse(init.body), g = u.searchParams.get('grant_type');
      st.calls.push({ op: 'auth', grant: g });
      if (g === 'password') return st.users[b.email] === b.password ? res(200, issue(b.email)) : res(400, { error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
      if (g === 'refresh_token') return st.refresh.has(b.refresh_token) ? res(200, issue(st.refresh.get(b.refresh_token))) : res(400, { error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' });
    }
    if (u.pathname === '/auth/v1/logout') { st.calls.push({ op: 'logout' }); return res(204, null); }
    if (u.pathname.startsWith('/rest/v1/')) {
      const t = u.pathname.split('/').pop();
      const bearer = (h.Authorization || '').replace('Bearer ', '');
      if (st.expireNext) { st.expireNext = false; return res(401, { message: 'JWT expired', code: 'PGRST301' }); }
      if (!st.tokens.has(bearer)) return res(401, { message: 'permission denied', code: '42501' });
      if (st.failNextRest) { const f = st.failNextRest; st.failNextRest = null; return res(f.status, f.body); }
      if (method === 'GET') {
        const off = +u.searchParams.get('offset') || 0, lim = +u.searchParams.get('limit') || 1000;
        st.calls.push({ op: 'select', t, off });
        return res(200, db[t].slice().sort((a, b) => a.id - b.id).slice(off, off + lim));
      }
      if (method === 'POST') {
        const rows = JSON.parse(init.body); st.calls.push({ op: 'upsert', t, rows });
        for (const r of rows) {
          if (t === 'reclamos' && r.estado === 'Abierto' && db.reclamos.some(x => x.id !== r.id && x.estado === 'Abierto' && x.consorcio_id === r.consorcio_id && x.tipo_id === r.tipo_id && (x.unidad_id ?? 0) === (r.unidad_id ?? 0) && x.ubicacion_detalle.trim().toLowerCase() === r.ubicacion_detalle.trim().toLowerCase()))
            return res(409, { code: '23505', message: 'duplicate key value violates unique constraint "reclamos_incidente_abierto_uq"' });
          const i = db[t].findIndex(x => x.id === r.id);
          if (i >= 0) db[t][i] = r; else db[t].push(r);
        }
        return res(201, null);
      }
      if (method === 'DELETE') {
        const ids = u.searchParams.get('id').replace(/^in\.\(|\)$/g, '').split(',').map(Number); st.calls.push({ op: 'delete', t, ids });
        db[t] = db[t].filter(r => !ids.includes(r.id)); return res(204, null);
      }
    }
    return res(404, { message: 'ruta no simulada: ' + u.pathname });
  };
  return st;
}
const supaStore = fake => new SupabaseStore({ url: 'https://demo.supabase.co', key: 'sb_publishable_test', fetchFn: (...a) => fake.fetch(...a), sessionKey: TESTKEY });
async function supaCore(fake, opts) {
  const s = supaStore(fake); await s.signIn('op@x.com', 'secreta');
  const c = new Core(s, opts); await c.init();
  c.call = (m, u, b) => c.handle(m, u, b);
  c.get = async u => status(await c.handle('GET', u), 200, 'GET ' + u);
  c.post = async (u, b, code = 200) => status(await c.handle('POST', u, b || {}), code, 'POST ' + u);
  c.put = async (u, b, code = 200) => status(await c.handle('PUT', u, b || {}), code, 'PUT ' + u);
  c.del = async (u, code = 200) => status(await c.handle('DELETE', u), code, 'DELETE ' + u);
  return c;
}

suite('Supabase · inicio de sesión', () => {
  test('contraseña incorrecta => error claro y sin sesión', async () => {
    const f = fakeSupabase(), s = supaStore(f);
    let err; try { await s.signIn('op@x.com', 'mala'); } catch (e) { err = e; }
    ok(err instanceof StoreError, 'es StoreError'); eq(err.httpStatus, 400); ok(/incorrectos/.test(err.userMessage)); eq(s.session, null);
  });
  test('inicio correcto guarda la sesión; se puede retomar sin pedir contraseña', async () => {
    const f = fakeSupabase(), s = supaStore(f); await s.signIn('op@x.com', 'secreta');
    eq(s.email, 'op@x.com');
    const saved = SupabaseStore.saved(TESTKEY); eq(saved.email, 'op@x.com'); ok(saved.refresh_token);
    const s2 = supaStore(f); await s2.resume(saved);
    eq(s2.email, 'op@x.com'); ok(s2.session.access_token !== saved.access_token, 'token renovado');
    await s.signOut(); eq(SupabaseStore.saved(TESTKEY), null);
    ok(f.calls.some(c => c.op === 'logout'));
  });
  test('una sesión vencida/inválida no se puede retomar y se descarta', async () => {
    const f = fakeSupabase(), s = supaStore(f);
    let err; try { await s.resume({ access_token: 'x', refresh_token: 'RT-viejo', expires_at: 0, email: 'op@x.com' }); } catch (e) { err = e; }
    ok(err, 'falla'); eq(SupabaseStore.saved(TESTKEY), null);
  });
  test('sin sesión no se leen datos', async () => {
    const f = fakeSupabase(), s = supaStore(f);
    let err; try { await s.loadAll(); } catch (e) { err = e; }
    eq(err.httpStatus, 401);
  });
  test('el token se renueva solo cuando está por vencer', async () => {
    const f = fakeSupabase({ expiresIn: 30 }), s = supaStore(f); await s.signIn('op@x.com', 'secreta');
    const antes = f.calls.filter(c => c.grant === 'refresh_token').length;
    await s.loadAll();
    ok(f.calls.filter(c => c.grant === 'refresh_token').length > antes, 'refrescó antes de consultar');
  });
  test('si el servidor responde 401 por token vencido, renueva y reintenta una vez', async () => {
    const f = fakeSupabase(), s = supaStore(f); await s.signIn('op@x.com', 'secreta');
    f.expireNext = true;
    const d = await s.loadAll(); eq(Object.keys(d).length, 12);
  });
  test('sin internet => error claro (status 0)', async () => {
    const f = fakeSupabase(), s = supaStore(f); f.offline = true;
    let err; try { await s.signIn('op@x.com', 'secreta'); } catch (e) { err = e; }
    eq(err.httpStatus, 0); ok(/conexión/.test(err.userMessage));
  });
});

suite('Supabase · lectura y escritura de datos', () => {
  test('al conectar a una base vacía carga los 15 tipos de reclamo con id numérico', async () => {
    const f = fakeSupabase(); const c = await supaCore(f);
    eq(f.db.tipos_reclamo.length, 15); eq(typeof f.db.tipos_reclamo[0].id, 'number');
    eq((await c.get('tipos_reclamo')).length, 15);
  });
  test('tipos de datos enviados: ids y claves foráneas numéricos, unidad vacía = null, profesiones como arreglo', async () => {
    const f = fakeSupabase(); const c = await supaCore(f);
    const cons = await c.post('consorcios', { nombre: 'A', direccion: 'B' });
    const pv = await c.post('proveedores', { nombre: 'P', telefono: '1', tipo: ['Plomero', 'Gasista'] });
    const r = await c.post('reclamos', { consorcio_id: cons.id, tipo_id: '1', urgencia: 'Alta', detalle: 'x', solicitante_nombre: 'Z', proveedor_ids: [pv.id] });
    const row = f.db.reclamos[0];
    eq([typeof row.id, typeof row.consorcio_id, typeof row.tipo_id, row.unidad_id], ['number', 'number', 'number', null]);
    eq(f.db.proveedores[0].tipo, ['Plomero', 'Gasista']);
    eq(f.db.reclamo_proveedores.length, 1); eq(f.db.historial.length >= 2, true);
    const det = await c.get('reclamos/' + r.id);
    eq([det.unidad_id, det.proveedores[0].tipo, typeof det.id], ['', ['Plomero', 'Gasista'], 'string'], 'la app ve texto y arreglos');
  });
  test('sólo se envían las filas que cambiaron', async () => {
    const f = fakeSupabase(); const c = await supaCore(f);
    const a = await c.post('propietarios', { nombre: 'A' }); await c.post('propietarios', { nombre: 'B' });
    f.calls.length = 0;
    await c.put('propietarios/' + a.id, { telefono: '99' });
    const ups = f.calls.filter(x => x.op === 'upsert');
    eq(ups.length, 1); eq(ups[0].rows.length, 1); eq(ups[0].rows[0].telefono, '99');
  });
  test('una consulta que no escribe no genera escrituras', async () => {
    const f = fakeSupabase(); const c = await supaCore(f); f.calls.length = 0;
    await c.get('resumen'); await c.get('consorcios');
    eq(f.calls.filter(x => x.op === 'upsert' || x.op === 'delete').length, 0);
  });
  test('borrados en orden: primero los hijos y después el padre', async () => {
    const f = fakeSupabase(); const c = await supaCore(f);
    const cons = await c.post('consorcios', { nombre: 'A', direccion: 'B' });
    const u = await c.post('unidades', { consorcio_id: cons.id, numero_uf: '1' });
    await c.post('inquilinos', { unidad_id: u.id, nombre: 'I' }); await c.post('personal', { consorcio_id: cons.id, nombre: 'E', rol: 'Encargado' });
    f.calls.length = 0;
    await c.del('consorcios/' + cons.id);
    const orden = f.calls.filter(x => x.op === 'delete').map(x => x.t);
    ok(orden.indexOf('inquilinos') < orden.indexOf('unidades') && orden.indexOf('unidades') < orden.indexOf('consorcios') && orden.indexOf('personal') < orden.indexOf('consorcios'), 'orden: ' + orden.join(' > '));
    eq(f.db.consorcios.length + f.db.unidades.length + f.db.inquilinos.length + f.db.personal.length, 0);
  });
  test('altas en orden: el padre se guarda antes que el hijo', async () => {
    const f = fakeSupabase(); const c = await supaCore(f);
    f.calls.length = 0;
    const cons = await c.post('consorcios', { nombre: 'A', direccion: 'B' });
    await c.post('reclamos', { consorcio_id: cons.id, tipo_id: '1', urgencia: 'Baja', detalle: 'x', solicitante_nombre: 'Z' });
    const orden = f.calls.filter(x => x.op === 'upsert').map(x => x.t);
    ok(orden.indexOf('consorcios') < orden.indexOf('reclamos') && orden.indexOf('reclamos') < orden.indexOf('historial'), orden.join(' > '));
  });
  test('lee más de 1000 filas paginando', async () => {
    const f = fakeSupabase(); const s = supaStore(f); await s.signIn('op@x.com', 'secreta');
    for (let i = 1; i <= 2500; i++) f.db.propietarios.push({ id: i, nombre: 'P' + i, dni: '', telefono: '', telefono_alt: '', email: '', observaciones: '' });
    const d = await s.loadAll();
    eq(d.propietarios.length, 2500); eq(d.propietarios[2499].id, '2500');
    eq(f.calls.filter(x => x.op === 'select' && x.t === 'propietarios').length, 3);
  });
  test('flujo completo de reclamo contra la base: alta, duplicado, etapa, cierre, reapertura', async () => {
    const f = fakeSupabase(); const c = await supaCore(f);
    const cons = await c.post('consorcios', { nombre: 'A', direccion: 'B' });
    const nuevo = () => c.call('POST', 'reclamos', { consorcio_id: cons.id, tipo_id: '1', urgencia: 'Alta', detalle: 'x', solicitante_nombre: 'Z' });
    const r = status(await nuevo(), 200);
    status(await nuevo(), 409);
    eq((await c.post(`reclamos/${r.id}/etapa`, { etapa: 'Esperando presupuesto' })).etapa, 'Esperando presupuesto');
    await c.post(`reclamos/${r.id}/cerrar`, { resolucion: 'Desestimado', motivo: 'no corresponde' });
    eq(f.db.reclamos[0].estado, 'Cerrado'); eq(f.db.reclamos[0].resolucion, 'Desestimado');
    const r2 = status(await nuevo(), 200);
    status(await c.call('POST', `reclamos/${r.id}/reabrir`, { motivo: 'x' }), 409);
    await c.post(`reclamos/${r2.id}/cerrar`, { resolucion: 'Anulado', motivo: 'error' });
    eq((await c.post(`reclamos/${r.id}/reabrir`, { motivo: 'volvió' })).estado, 'Abierto');
    eq(f.db.reclamos.length, 2, 'nada se borró');
  });
});

suite('Supabase · errores y varios operadores', () => {
  test('la restricción de la base contra duplicados se traduce a un mensaje claro (409) y la app se resincroniza', async () => {
    const f = fakeSupabase(); const c = await supaCore(f);
    const cons = await c.post('consorcios', { nombre: 'A', direccion: 'B' });
    // otro operador cargó el mismo incidente justo antes: la app aún no lo sabe
    f.db.reclamos.push({ id: 50, consorcio_id: +cons.id, unidad_id: null, ubicacion_detalle: '', tipo_id: 1, naturaleza: 'Técnico', urgencia: 'Alta', titulo: 't', detalle: 'x', fecha_reclamo: '', estado: 'Abierto', etapa: 'Nuevo', resolucion: '', fecha_cierre: '', motivo_cierre: '', solicitante_tipo: 'Otro', solicitante_nombre: 'Z', solicitante_contacto: '', canal: '', operador: '', actualizado: '' });
    // al operar, la app relee la base primero, así que detecta el duplicado sola
    const r = await c.call('POST', 'reclamos', { consorcio_id: cons.id, tipo_id: '1', urgencia: 'Alta', detalle: 'x', solicitante_nombre: 'Z' });
    eq(r.status, 409); ok(/reiteraci/i.test(r.data.error)); eq(r.data.duplicados[0].id, '50');
  });
  test('si la base rechaza igualmente la escritura, se informa con mensaje claro y no queda estado a medias en pantalla', async () => {
    const f = fakeSupabase(); const c = await supaCore(f);
    f.failNextRest = null;
    const original = f.fetch; let escrituras = 0;
    f.fetch = async (url, init = {}) => {
      if ((init.method || 'GET') === 'POST' && /\/rest\/v1\/reclamos/.test(url)) { escrituras++; return { ok: false, status: 409, json: async () => ({ code: '23505', message: 'duplicate key ... "reclamos_incidente_abierto_uq"' }), text: async () => '' }; }
      return original(url, init);
    };
    const cons = await c.post('consorcios', { nombre: 'A', direccion: 'B' });
    const r = await c.call('POST', 'reclamos', { consorcio_id: cons.id, tipo_id: '1', urgencia: 'Alta', detalle: 'x', solicitante_nombre: 'Z' });
    eq(r.status, 409); ok(/mismo incidente/.test(r.data.error)); eq(escrituras, 1);
    eq((await c.get('reclamos')).length, 0, 'el reclamo fallido no aparece');
  });
  test('violación de clave foránea => 409 con explicación', async () => {
    const f = fakeSupabase(); const c = await supaCore(f);
    f.failNextRest = null;
    const original = f.fetch;
    f.fetch = async (url, init = {}) => ((init.method || 'GET') === 'DELETE' ? { ok: false, status: 409, json: async () => ({ code: '23503', message: 'violates foreign key constraint' }), text: async () => '' } : original(url, init));
    const cons = await c.post('consorcios', { nombre: 'A', direccion: 'B' });
    const r = await c.call('DELETE', 'consorcios/' + cons.id);
    eq(r.status, 409); ok(/dependen/.test(r.data.error));
  });
  test('dos operadores: cada operación parte de lo último guardado, IDs distintos y nada se pisa', async () => {
    const f = fakeSupabase(); const a = await supaCore(f), b = await supaCore(f);
    const p1 = await a.post('propietarios', { nombre: 'De A' });
    const p2 = await b.post('propietarios', { nombre: 'De B' });
    ok(p1.id !== p2.id, 'ids distintos');
    a.loadedAt = 0;   // pasaron más de 1,5 s: la lectura vuelve a consultar la base
    eq((await a.get('propietarios')).map(p => p.nombre).sort(), ['De A', 'De B']);
    eq(f.db.propietarios.length, 2);
  });
  test('una lectura falla con mensaje claro si no hay conexión', async () => {
    const f = fakeSupabase(); const c = await supaCore(f);
    f.offline = true; c.loadedAt = 0;
    const r = await c.call('GET', 'consorcios');
    ok(/conexión/.test(r.data.error), r.data.error);
  });
  test('toDb/fromDb son inversos', () => {
    const { fromDb, toDb } = Consorcios._supa;
    const row = { id: '7', nombre: 'P', telefono: '1', email: '', tipo: 'A|B', empresa: '', observaciones: 'ñ', activo: 'SI' };
    eq(fromDb('proveedores', JSON.parse(JSON.stringify(toDb('proveedores', row)))), row);
    const rec = { id: '1', consorcio_id: '2', unidad_id: '', tipo_id: '3' };
    eq(toDb('reclamos', rec).unidad_id, null);
  });
});

/* ============================================================ EJECUCIÓN */
async function runAll() {
  const out = document.getElementById('out'); const sum = document.getElementById('sum');
  let pass = 0, failN = 0, skipped = 0; const failures = [];
  window.__results = { pass: 0, fail: 0, failures };
  for (const s of suites) {
    const sec = document.createElement('section'); sec.innerHTML = `<h2>${s.name}</h2>`; out.appendChild(sec);
    for (const t of s.tests) {
      const row = document.createElement('div'); row.className = 'row';
      try { await t.fn(); pass++; row.innerHTML = `<span class="ok">✔</span> ${t.name}`; }
      catch (e) {
        if (e instanceof SkipError) { skipped++; row.innerHTML = `<span>⏭</span> <i>${t.name} — omitido: ${e.message}</i>`; sec.appendChild(row); continue; }
        failN++; failures.push(`${s.name} › ${t.name}: ${e.message}`); row.classList.add('bad'); row.innerHTML = `<span class="no">✖</span> ${t.name}<pre></pre>`; row.querySelector('pre').textContent = (e instanceof AssertionError ? '' : e.name + ': ') + e.message; if (!(e instanceof AssertionError)) console.error(e); }
      sec.appendChild(row);
      sum.textContent = `${pass} correctos · ${failN} fallidos · ${skipped} omitidos`;
      sum.className = failN ? 'bad' : 'good';
    }
  }
  window.__results.pass = pass; window.__results.fail = failN; window.__results.skipped = skipped; window.__results.done = true;
  sum.textContent = (failN ? '❌ ' : '✅ ') + `${pass} correctos · ${failN} fallidos · ${skipped} omitidos · ${pass + failN + skipped} en total`;
}
window.addEventListener('load', runAll);
