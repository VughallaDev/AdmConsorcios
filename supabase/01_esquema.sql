-- =====================================================================
--  Administración de Consorcios — esquema para Supabase (PostgreSQL)
--  Pegar completo en  SQL Editor > New query  y apretar  Run.
--  Se puede ejecutar más de una vez sin romper nada.
--
--  Equivale a los 12 CSV de la versión local (mismos nombres de tablas y columnas).
--  Las fechas se guardan como texto 'AAAA-MM-DD HH:MM' igual que en los CSV,
--  para que la app funcione igual con ambos orígenes de datos.
-- =====================================================================

-- ---------------------------------------------------------------- Tablas

create table if not exists public.consorcios (
  id bigint generated always as identity primary key,
  nombre text not null check (btrim(nombre) <> ''),
  direccion text not null check (btrim(direccion) <> ''),
  localidad text not null default '',
  cuit text not null default '',
  fecha_inicio_administracion text not null default '',
  email_contacto text not null default '',
  telefono_contacto text not null default '',
  notas text not null default '',
  creado text not null default to_char(now() at time zone 'America/Argentina/Buenos_Aires', 'YYYY-MM-DD HH24:MI')
);

create table if not exists public.personal (
  id bigint generated always as identity primary key,
  consorcio_id bigint not null references public.consorcios(id) on delete cascade,
  nombre text not null check (btrim(nombre) <> ''),
  rol text not null check (rol in ('Encargado','Empresa de limpieza','Proveedor de servicios','Administrativo','Seguridad','Otro')),
  empresa text not null default '',
  servicio text not null default '',
  telefono text not null default '',
  email text not null default '',
  horario text not null default '',
  observaciones text not null default ''
);

create table if not exists public.unidades (
  id bigint generated always as identity primary key,
  consorcio_id bigint not null references public.consorcios(id) on delete cascade,
  numero_uf text not null check (btrim(numero_uf) <> ''),
  piso text not null default '',
  departamento text not null default '',
  tipo text not null default '' check (tipo in ('','Departamento','Cochera','Local','Baulera','Oficina','Otro')),
  observaciones text not null default '',
  -- no puede repetirse la misma unidad dentro del consorcio
  unique (consorcio_id, numero_uf, piso, departamento, tipo)
);

create table if not exists public.propietarios (
  id bigint generated always as identity primary key,
  nombre text not null check (btrim(nombre) <> ''),
  dni text not null default '',
  telefono text not null default '',
  telefono_alt text not null default '',
  email text not null default '',
  observaciones text not null default ''
);

create table if not exists public.unidad_propietarios (
  id bigint generated always as identity primary key,
  unidad_id bigint not null references public.unidades(id) on delete cascade,
  propietario_id bigint not null references public.propietarios(id) on delete cascade,
  porcentaje text not null default '',
  unique (unidad_id, propietario_id)
);

create table if not exists public.inquilinos (
  id bigint generated always as identity primary key,
  unidad_id bigint not null references public.unidades(id) on delete cascade,
  nombre text not null check (btrim(nombre) <> ''),
  dni text not null default '',
  telefono text not null default '',
  telefono_alt text not null default '',
  email text not null default '',
  fecha_desde text not null default '',
  fecha_hasta text not null default '',
  observaciones text not null default ''
);

create table if not exists public.tipos_reclamo (
  id bigint generated always as identity primary key,
  nombre text not null check (btrim(nombre) <> ''),
  naturaleza text not null check (naturaleza in ('Técnico','Administrativo')),
  icono text not null default '',
  activo text not null default 'SI' check (activo in ('SI','NO'))
);
create unique index if not exists tipos_reclamo_nombre_uq on public.tipos_reclamo (lower(btrim(nombre)));

create table if not exists public.proveedores (
  id bigint generated always as identity primary key,
  nombre text not null check (btrim(nombre) <> ''),
  telefono text not null check (btrim(telefono) <> ''),
  email text not null default '',
  tipo text[] not null check (cardinality(tipo) >= 1),   -- profesiones (ARRAY<string>), al menos una
  empresa text not null default '',
  observaciones text not null default '',
  activo text not null default 'SI' check (activo in ('SI','NO'))
);

create table if not exists public.reclamos (
  id bigint generated always as identity primary key,
  consorcio_id bigint not null references public.consorcios(id) on delete restrict,   -- no se borra un consorcio con reclamos
  unidad_id bigint references public.unidades(id) on delete restrict,                  -- null = áreas comunes
  ubicacion_detalle text not null default '',
  tipo_id bigint not null references public.tipos_reclamo(id) on delete restrict,
  naturaleza text not null check (naturaleza in ('Técnico','Administrativo')),
  urgencia text not null check (urgencia in ('Baja','Media','Alta','Urgente','Urgente Crítico')),
  titulo text not null default '',
  detalle text not null check (btrim(detalle) <> ''),
  fecha_reclamo text not null default '',
  estado text not null default 'Abierto' check (estado in ('Abierto','Cerrado')),
  etapa text not null default 'Nuevo' check (etapa in ('Nuevo','En espera de visita del proveedor','Visitado por el proveedor','Esperando presupuesto','Presupuesto aprobado','Trabajo en ejecución','Finalizado')),
  resolucion text not null default '' check (resolucion in ('','Resuelto','Desestimado','Anulado')),
  fecha_cierre text not null default '',
  motivo_cierre text not null default '',
  solicitante_tipo text not null default 'Otro',
  solicitante_nombre text not null check (btrim(solicitante_nombre) <> ''),
  solicitante_contacto text not null default '',
  canal text not null default 'Teléfono',
  operador text not null default 'Operador',
  actualizado text not null default '',
  -- un reclamo cerrado siempre indica cómo se cerró
  check (estado = 'Abierto' or resolucion <> '')
);
-- REGLA CLAVE: no puede haber dos reclamos ABIERTOS del mismo incidente
-- (mismo consorcio + tipo + unidad/área común + ubicación). Se debe reiterar el existente.
-- También impide reabrir un reclamo cerrado si ya hay otro abierto igual.
create unique index if not exists reclamos_incidente_abierto_uq
  on public.reclamos (consorcio_id, tipo_id, coalesce(unidad_id, 0), lower(btrim(ubicacion_detalle)))
  where estado = 'Abierto';
create index if not exists reclamos_consorcio_estado_ix on public.reclamos (consorcio_id, estado);

create table if not exists public.reclamo_proveedores (
  id bigint generated always as identity primary key,
  reclamo_id bigint not null references public.reclamos(id) on delete cascade,
  proveedor_id bigint not null references public.proveedores(id) on delete restrict,  -- proveedor con historial: se marca inactivo, no se borra
  fecha_asignacion text not null default '',
  operador text not null default '',
  unique (reclamo_id, proveedor_id)
);

create table if not exists public.reiteraciones (
  id bigint generated always as identity primary key,
  reclamo_id bigint not null references public.reclamos(id) on delete cascade,
  fecha text not null default '',
  solicitante_tipo text not null default '',
  solicitante_nombre text not null check (btrim(solicitante_nombre) <> ''),
  solicitante_contacto text not null default '',
  unidad_id bigint references public.unidades(id) on delete set null,
  canal text not null default '',
  detalle text not null check (btrim(detalle) <> ''),
  operador text not null default ''
);
create index if not exists reiteraciones_reclamo_ix on public.reiteraciones (reclamo_id);

create table if not exists public.historial (
  id bigint generated always as identity primary key,
  reclamo_id bigint not null references public.reclamos(id) on delete cascade,
  fecha text not null default '',
  accion text not null default '',
  detalle text not null default '',
  operador text not null default ''
);
create index if not exists historial_reclamo_ix on public.historial (reclamo_id);

-- ---------------------------------------------------------------- Datos iniciales (tipos de reclamo)

insert into public.tipos_reclamo (nombre, naturaleza, icono)
select v.nombre, v.naturaleza, v.icono
from (values
  ('Problemas de agua','Técnico','💧'), ('Electricidad','Técnico','⚡'), ('Ascensores','Técnico','🛗'),
  ('Plagas','Técnico','🐜'), ('Gas','Técnico','🔥'), ('Limpieza','Técnico','🧹'),
  ('Jardinería','Técnico','🌿'), ('Pileta','Técnico','🏊'), ('SUM','Técnico','🎉'),
  ('Estructural','Técnico','🏗️'), ('Seguridad / Portería','Técnico','🔒'), ('Ruidos / Convivencia','Administrativo','🔊'),
  ('Pagos / Expensas','Administrativo','💳'), ('Consulta de facturas','Administrativo','🧾'), ('Otros','Administrativo','📌')
) as v(nombre, naturaleza, icono)
where not exists (select 1 from public.tipos_reclamo);

-- ---------------------------------------------------------------- Seguridad (RLS)
-- Solo usuarios con sesión iniciada (los operadores que vos crees) pueden leer o escribir.
-- Sin sesión, la publishable key NO da acceso a ningún dato.

do $$
declare t text;
begin
  foreach t in array array['consorcios','personal','unidades','propietarios','unidad_propietarios','inquilinos',
                           'tipos_reclamo','proveedores','reclamo_proveedores','reclamos','reiteraciones','historial']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists operadores_todo on public.%I', t);
    execute format('create policy operadores_todo on public.%I for all to authenticated using (true) with check (true)', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

grant usage on all sequences in schema public to authenticated;
revoke all on all sequences in schema public from anon;

-- ---------------------------------------------------------------- Verificación (debe mostrar 12 tablas y 15 tipos)
select
  (select count(*) from information_schema.tables where table_schema = 'public'
     and table_name in ('consorcios','personal','unidades','propietarios','unidad_propietarios','inquilinos',
                        'tipos_reclamo','proveedores','reclamo_proveedores','reclamos','reiteraciones','historial')) as tablas,
  (select count(*) from public.tipos_reclamo) as tipos_de_reclamo,
  (select count(*) from pg_tables where schemaname = 'public' and rowsecurity) as tablas_con_rls;
