'use strict';
/*
  Conexión a Supabase (sin librerías externas: sólo fetch).
    - Inicio de sesión con email y contraseña (GoTrue)  → /auth/v1
    - Lectura y escritura de las 12 tablas (PostgREST)   → /rest/v1
  Implementa la interfaz "rowLevel" que usa Core (loadAll / sync).
*/
(function (root) {
  const { SCHEMA, TABLES } = root.Consorcios;
  const SESSION_KEY = 'consorcios-supabase-session';
  const PAGE = 1000;   // Supabase devuelve como máximo 1000 filas por consulta

  const isBig = c => c === 'id' || c.endsWith('_id');
  // Columnas de clave foránea que admiten NULL (vacío en la app = null en la base)
  const NULLABLE = { reclamos: ['unidad_id'], reiteraciones: ['unidad_id'] };

  function fromDb(t, r) {
    const o = {};
    for (const c of SCHEMA[t]) {
      const v = r[c];
      if (v == null) o[c] = '';
      else if (Array.isArray(v)) o[c] = v.join('|');     // proveedores.tipo: text[] → "A|B"
      else o[c] = String(v);
    }
    return o;
  }
  function toDb(t, r) {
    const o = {};
    for (const c of SCHEMA[t]) {
      const v = r[c] == null ? '' : String(r[c]);
      if (isBig(c)) o[c] = v === '' ? null : Number(v);
      else if (t === 'proveedores' && c === 'tipo') o[c] = v.split('|').filter(Boolean);
      else o[c] = v;
    }
    return o;
  }

  class StoreError extends Error {
    constructor(httpStatus, userMessage, detail) { super(detail || userMessage); this.httpStatus = httpStatus; this.userMessage = userMessage; }
  }
  // Traduce los errores de la base a mensajes para el operador.
  function mapError(status, body) {
    const code = body && body.code, msg = (body && (body.message || body.msg || body.error_description || body.error)) || '';
    if (code === '23505') {
      if (/reclamos_incidente_abierto_uq/.test(msg + (body.details || ''))) return new StoreError(409, 'Ya existe un reclamo abierto para este mismo incidente. No se puede duplicar: corresponde registrar una reiteración.', msg);
      return new StoreError(409, 'Ya existe un registro igual (puede haberlo cargado otro operador recién). Actualizá la pantalla e intentá de nuevo.', msg);
    }
    if (code === '23503') return new StoreError(409, 'No se puede completar la operación: hay otros registros que dependen de este.', msg);
    if (code === '23514' || code === '23502') return new StoreError(400, 'Algún dato no es válido para la base de datos: ' + msg, msg);
    if (code === '42501' || status === 403) return new StoreError(403, 'Tu usuario no tiene permiso para esta operación.', msg);
    if (status === 401) return new StoreError(401, 'La sesión expiró. Volvé a iniciar sesión.', msg);
    if (code === '42P01' || code === 'PGRST205') return new StoreError(500, 'Falta una tabla en la base de datos. Ejecutá el script supabase/01_esquema.sql.', msg);
    return new StoreError(status || 500, 'Error de la base de datos: ' + (msg || ('HTTP ' + status)), msg);
  }

  class SupabaseStore {
    constructor({ url, key, fetchFn, sessionKey }) {
      this.sessionKey = sessionKey || SESSION_KEY;
      this.url = String(url).replace(/\/+$/, ''); this.key = key; this.rowLevel = true;
      this.fetch = fetchFn || ((...a) => root.fetch(...a));
      this.session = null; this.name = 'Supabase';
    }
    /* ---- sesión ---- */
    static saved(k) { try { return JSON.parse(localStorage.getItem(k || SESSION_KEY) || 'null'); } catch { return null; } }
    persist() { try { this.session ? localStorage.setItem(this.sessionKey, JSON.stringify(this.session)) : localStorage.removeItem(this.sessionKey); } catch { } }
    get email() { return this.session ? this.session.email : ''; }
    setSession(d, emailFallback) {
      this.session = { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: Date.now() + (d.expires_in || 3600) * 1000, email: (d.user && d.user.email) || emailFallback || '' };
      this.name = 'Supabase · ' + this.session.email; this.persist();
    }
    async auth(path, body) {
      let r;
      try { r = await this.fetch(`${this.url}/auth/v1/${path}`, { method: 'POST', headers: { apikey: this.key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
      catch (e) { throw new StoreError(0, 'No hay conexión con Supabase. Revisá tu internet.', e.message); }
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        const m = d.error_code || d.error || '';
        if (r.status === 401 || r.status === 403 || /api key/i.test(d.message || d.msg || ''))
          throw new StoreError(r.status, 'Supabase rechazó la clave de la aplicación (Invalid API key). Revisá SUPABASE_KEY en js/config.js: debe ser la "Publishable key" de ESTE proyecto, copiada completa.', d.message || d.msg);
        if (m === 'invalid_credentials' || r.status === 400) throw new StoreError(400, 'Email o contraseña incorrectos.', d.msg);
        throw new StoreError(r.status, 'No se pudo iniciar sesión: ' + (d.msg || d.error_description || r.status), d.msg);
      }
      return d;
    }
    async signIn(email, password) { this.setSession(await this.auth('token?grant_type=password', { email, password }), email); }
    async resume(saved) {
      this.session = saved; this.name = 'Supabase · ' + (saved.email || '');
      await this.refresh();
    }
    async refresh() {
      try { this.setSession(await this.auth('token?grant_type=refresh_token', { refresh_token: this.session.refresh_token }), this.session.email); }
      catch (e) { this.session = null; this.persist(); throw e; }
    }
    async signOut() {
      try { if (this.session) await this.fetch(`${this.url}/auth/v1/logout`, { method: 'POST', headers: { apikey: this.key, Authorization: 'Bearer ' + this.session.access_token } }); } catch { }
      this.session = null; this.persist();
    }
    async token() {
      if (!this.session) throw new StoreError(401, 'No hay sesión iniciada.');
      if (this.session.expires_at - Date.now() < 60000) await this.refresh();
      return this.session.access_token;
    }

    /* ---- REST ---- */
    async rest(path, { method = 'GET', body, headers = {} } = {}, retry = true) {
      const tk = await this.token();
      let r;
      try {
        r = await this.fetch(`${this.url}/rest/v1/${path}`, { method, headers: Object.assign({ apikey: this.key, Authorization: 'Bearer ' + tk, 'Content-Type': 'application/json' }, headers), body: body === undefined ? undefined : JSON.stringify(body) });
      } catch (e) { throw new StoreError(0, 'No hay conexión con Supabase. Revisá tu internet.', e.message); }
      if (r.status === 401 && retry) { await this.refresh(); return this.rest(path, { method, body, headers }, false); }
      if (!r.ok) throw mapError(r.status, await r.json().catch(() => ({})));
      return r.status === 204 ? null : await r.text().then(t => (t ? JSON.parse(t) : null));
    }
    async fetchAll(t) {
      const out = [];
      for (let off = 0; ; off += PAGE) {
        const rows = await this.rest(`${t}?select=*&order=id.asc&limit=${PAGE}&offset=${off}`);
        out.push(...rows);
        if (rows.length < PAGE) break;
      }
      return out.map(r => fromDb(t, r));
    }

    /* ---- interfaz rowLevel ---- */
    async loadAll() {
      const res = await Promise.all(TABLES.map(t => this.fetchAll(t)));
      const o = {}; TABLES.forEach((t, i) => { o[t] = res[i]; });
      return o;
    }
    async sync({ upserts, deletes }) {
      for (const { table, rows } of upserts) {
        const body = rows.map(r => toDb(table, r));
        for (let i = 0; i < body.length; i += 500)
          await this.rest(`${table}?on_conflict=id`, { method: 'POST', body: body.slice(i, i + 500), headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
      }
      for (const { table, ids } of deletes)
        for (let i = 0; i < ids.length; i += 200)
          await this.rest(`${table}?id=in.(${ids.slice(i, i + 200).join(',')})`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    }
  }

  root.Consorcios.SupabaseStore = SupabaseStore;
  root.Consorcios.StoreError = StoreError;
  root.Consorcios._supa = { fromDb, toDb, mapError, NULLABLE };
})(typeof window !== 'undefined' ? window : globalThis);
