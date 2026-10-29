<#
  Administración de Consorcios - servidor local (sin dependencias).
  Sirve la app web (carpeta /public) y una API REST que guarda todo en archivos CSV (carpeta /data).
  Uso:  powershell -ExecutionPolicy Bypass -File server.ps1 [-Port 8080] [-DataDir .\data] [-NoBrowser]
#>
param(
    [int]$Port = 8080,
    [string]$DataDir = (Join-Path $PSScriptRoot 'data'),
    [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
$PublicDir = Join-Path $PSScriptRoot 'public'
$Utf8Bom = New-Object System.Text.UTF8Encoding($true)
$Utf8 = New-Object System.Text.UTF8Encoding($false)
if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir | Out-Null }

# ---------------------------------------------------------------- Esquema de tablas (1 CSV = 1 tabla)
$Schema = [ordered]@{
    consorcios          = @('id','nombre','direccion','localidad','cuit','fecha_inicio_administracion','email_contacto','telefono_contacto','notas','creado')
    personal            = @('id','consorcio_id','nombre','rol','empresa','servicio','telefono','email','horario','observaciones')
    unidades            = @('id','consorcio_id','numero_uf','piso','departamento','tipo','observaciones')
    propietarios        = @('id','nombre','dni','telefono','telefono_alt','email','observaciones')
    unidad_propietarios = @('id','unidad_id','propietario_id','porcentaje')
    inquilinos          = @('id','unidad_id','nombre','dni','telefono','telefono_alt','email','fecha_desde','fecha_hasta','observaciones')
    tipos_reclamo       = @('id','nombre','naturaleza','icono','activo')
    proveedores         = @('id','nombre','telefono','email','tipo','empresa','observaciones','activo')
    reclamo_proveedores = @('id','reclamo_id','proveedor_id','fecha_asignacion','operador')
    reclamos            = @('id','consorcio_id','unidad_id','ubicacion_detalle','tipo_id','naturaleza','urgencia','titulo','detalle','fecha_reclamo','estado','etapa','resolucion','fecha_cierre','motivo_cierre','solicitante_tipo','solicitante_nombre','solicitante_contacto','canal','operador','actualizado')
    reiteraciones       = @('id','reclamo_id','fecha','solicitante_tipo','solicitante_nombre','solicitante_contacto','unidad_id','canal','detalle','operador')
    historial           = @('id','reclamo_id','fecha','accion','detalle','operador')
}
$Required = @{
    consorcios          = @('nombre','direccion')
    personal            = @('consorcio_id','nombre','rol')
    unidades            = @('consorcio_id','numero_uf')
    propietarios        = @('nombre')
    unidad_propietarios = @('unidad_id','propietario_id')
    inquilinos          = @('unidad_id','nombre')
    tipos_reclamo       = @('nombre','naturaleza')
    proveedores         = @('nombre','telefono')
}
$FKs = @{
    personal            = @(,@('consorcio_id','consorcios'))
    unidades            = @(,@('consorcio_id','consorcios'))
    unidad_propietarios = @(@('unidad_id','unidades'),@('propietario_id','propietarios'))
    inquilinos          = @(,@('unidad_id','unidades'))
}
# Al borrar: elimina en cascada los hijos.
$Cascade = @{
    consorcios          = @(@('personal','consorcio_id'),@('unidades','consorcio_id'))
    unidades            = @(@('unidad_propietarios','unidad_id'),@('inquilinos','unidad_id'))
    propietarios        = @(,@('unidad_propietarios','propietario_id'))
    reclamos            = @(@('reiteraciones','reclamo_id'),@('historial','reclamo_id'),@('reclamo_proveedores','reclamo_id'))
}
# Al borrar: bloquea si existen dependientes.
$Blocks = @{
    consorcios    = @(,@('reclamos','consorcio_id','No se puede eliminar: el consorcio tiene reclamos registrados.'))
    unidades      = @(,@('reclamos','unidad_id','No se puede eliminar: la unidad funcional tiene reclamos registrados.'))
    tipos_reclamo = @(,@('reclamos','tipo_id','No se puede eliminar: hay reclamos de este tipo. Desactívalo en su lugar.'))
    proveedores   = @(,@('reclamo_proveedores','proveedor_id','No se puede eliminar: el proveedor está asignado a reclamos (queda el historial). Márcalo como inactivo en su lugar.'))
}
$Labels = @{ telefono='Teléfono de contacto'; tipo='Tipo (al menos una profesión)'; nombre='Nombre'; direccion='Dirección'; consorcio_id='Consorcio'; rol='Rol'; numero_uf='N° de UF'; unidad_id='Unidad funcional'; propietario_id='Propietario'; naturaleza='Naturaleza' }
$Urgencias = @('Baja','Media','Alta','Urgente','Urgente Crítico')
$Naturalezas = @('Técnico','Administrativo')
$Roles = @('Encargado','Empresa de limpieza','Proveedor de servicios','Administrativo','Seguridad','Otro')
$TiposUnidad = @('Departamento','Cochera','Local','Baulera','Oficina','Otro')
$Canales = @('Teléfono','WhatsApp','Email','Presencial','Otro')
$SolicitanteTipos = @('Propietario','Inquilino','Personal del consorcio','Otro')
$Etapas = @('Nuevo','En espera de visita del proveedor','Visitado por el proveedor','Esperando presupuesto','Presupuesto aprobado','Trabajo en ejecución','Finalizado')
$Resoluciones = @('Resuelto','Desestimado','Anulado')
$ProfesionesSugeridas = @('Plomero','Gasista','Electricista','Fumigador','Mantenimiento de ascensores','Albañil','Pintor','Techista','Durlockero','Cerrajero','Jardinero','Piletero','Limpieza','Herrero','Vidriero','Aire acondicionado')

# ---------------------------------------------------------------- Utilidades
function Fail($code, $msg, $extra = $null) { $script:ErrExtra = $extra; throw "API|$code|$msg" }
function Now { (Get-Date).ToString('yyyy-MM-dd HH:mm') }
function TablePath($t) { Join-Path $DataDir "$t.csv" }
function Read-Table($t) {
    $p = TablePath $t
    if (-not (Test-Path $p)) { Write-Table $t @() }
    @(Import-Csv -Path $p -Encoding UTF8)
}
function Write-Table($t, $rows) {
    $cols = $Schema[$t]
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append(($cols -join ',') + "`r`n")
    foreach ($r in $rows) {
        $cells = foreach ($c in $cols) { '"' + ([string]$r.$c -replace '"', '""') + '"' }
        [void]$sb.Append(($cells -join ',') + "`r`n")
    }
    $p = TablePath $t
    $tmp = "$p.tmp"
    [System.IO.File]::WriteAllText($tmp, $sb.ToString(), $Utf8Bom)
    Move-Item -Path $tmp -Destination $p -Force
}
function Next-Id($rows) {
    $m = 0
    foreach ($r in $rows) { $n = 0; if ([int]::TryParse($r.id, [ref]$n) -and $n -gt $m) { $m = $n } }
    [string]($m + 1)
}
function Index($t) { $h = @{}; foreach ($r in (Read-Table $t)) { $h[[string]$r.id] = $r }; $h }
function Exists($t, $id) { foreach ($r in (Read-Table $t)) { if ($r.id -eq [string]$id) { return $true } }; $false }
function Get-Row($t, $id) { foreach ($r in (Read-Table $t)) { if ($r.id -eq [string]$id) { return $r } }; Fail 404 'Registro no encontrado.' }
function Val($body, $c) {
    if ($null -eq $body) { return $null }
    $p = $body.PSObject.Properties[$c]
    if ($null -eq $p) { return $null }
    if ($null -eq $p.Value) { return '' }
    ([string]$p.Value).Trim()
}
function Has($body, $c) { $null -ne $body -and $null -ne $body.PSObject.Properties[$c] }
function Op($body) { $o = Val $body 'operador'; if ([string]::IsNullOrWhiteSpace($o)) { 'Operador' } else { $o } }
function Unit-Label($u) {
    if ($null -eq $u) { return 'Áreas comunes' }
    $s = "UF $($u.numero_uf)"
    if ($u.piso) { $s += " · Piso $($u.piso)" }
    if ($u.departamento) { $s += " Dto $($u.departamento)" }
    $s
}
function Add-Hist($reclamoId, $accion, $detalle, $op) {
    $h = @(Read-Table 'historial')
    $row = [pscustomobject][ordered]@{ id = (Next-Id $h); reclamo_id = $reclamoId; fecha = (Now); accion = $accion; detalle = $detalle; operador = $op }
    Write-Table 'historial' (@($h) + $row)
}

function Seed-Data {
    if ((Test-Path (TablePath 'tipos_reclamo')) -and (@(Read-Table 'tipos_reclamo').Count -gt 0)) { return }
    $tipos = @(
        @('Problemas de agua','Técnico','💧'), @('Electricidad','Técnico','⚡'), @('Ascensores','Técnico','🛗'),
        @('Plagas','Técnico','🐜'), @('Gas','Técnico','🔥'), @('Limpieza','Técnico','🧹'),
        @('Jardinería','Técnico','🌿'), @('Pileta','Técnico','🏊'), @('SUM','Técnico','🎉'),
        @('Estructural','Técnico','🏗️'), @('Seguridad / Portería','Técnico','🔒'), @('Ruidos / Convivencia','Administrativo','🔊'),
        @('Pagos / Expensas','Administrativo','💳'), @('Consulta de facturas','Administrativo','🧾'), @('Otros','Administrativo','📌')
    )
    $rows = @(); $i = 1
    foreach ($t in $tipos) { $rows += [pscustomobject][ordered]@{ id = [string]$i; nombre = $t[0]; naturaleza = $t[1]; icono = $t[2]; activo = 'SI' }; $i++ }
    Write-Table 'tipos_reclamo' $rows
}
function Init-Data {
    foreach ($t in $Schema.Keys) {
        $p = TablePath $t
        if (-not (Test-Path $p)) { Write-Table $t @(); continue }
        # Migración: si el CSV tiene columnas distintas al esquema actual, se reescribe conservando los datos.
        $hdr = ([string](Get-Content -Path $p -TotalCount 1 -Encoding UTF8)).Trim([char]0xFEFF).Trim()
        if ($hdr -ne ($Schema[$t] -join ',')) { Write-Host "  Migrando tabla $t..." -ForegroundColor DarkGray; Write-Table $t (Read-Table $t) }
    }
    Seed-Data
    # Reclamos previos a la incorporación de etapas/resoluciones.
    $rows = @(Read-Table 'reclamos'); $dirty = $false
    foreach ($r in $rows) {
        if (-not $r.etapa) { $r.etapa = 'Nuevo'; $dirty = $true }
        if ($r.estado -eq 'Cerrado' -and -not $r.resolucion) { $r.resolucion = 'Resuelto'; $dirty = $true }
    }
    if ($dirty) { Write-Table 'reclamos' $rows }
}

# ---------------------------------------------------------------- CRUD genérico
function Build-Row($t, $body, $existing) {
    $h = [ordered]@{}
    foreach ($c in $Schema[$t]) {
        if ($c -eq 'id') { continue }
        if (Has $body $c) { $h[$c] = Val $body $c }
        elseif ($existing) { $h[$c] = [string]$existing.$c }
        else { $h[$c] = '' }
    }
    if ($t -eq 'proveedores') {
        if (Has $body 'tipo') {
            $items = @($body.tipo | ForEach-Object { ([string]$_).Replace('|', ' ').Trim() } | Where-Object { $_ })
            $seen = @{}; $uniq = @(); foreach ($i in $items) { if (-not $seen.ContainsKey($i.ToLower())) { $seen[$i.ToLower()] = 1; $uniq += $i } }
            $h['tipo'] = $uniq -join '|'
        }
        if (-not $h['tipo']) { Fail 400 'Falta completar: tipo (al menos una profesión).' }
        if (-not $h['activo']) { $h['activo'] = 'SI' }
    }
    foreach ($c in $Required[$t]) {
        if ([string]::IsNullOrWhiteSpace($h[$c])) { $l = $Labels[$c]; if (-not $l) { $l = $c }; Fail 400 "Falta completar: $l." }
    }
    foreach ($fk in $FKs[$t]) {
        $v = $h[$fk[0]]
        if ($v -and -not (Exists $fk[1] $v)) { Fail 400 "Referencia inválida en $($fk[0])." }
    }
    if ($t -eq 'personal' -and $h['rol'] -and $Roles -notcontains $h['rol']) { Fail 400 'Rol inválido.' }
    if ($t -eq 'unidades' -and $h['tipo'] -and $TiposUnidad -notcontains $h['tipo']) { Fail 400 'Tipo de unidad inválido.' }
    if ($t -eq 'tipos_reclamo') {
        if ($Naturalezas -notcontains $h['naturaleza']) { Fail 400 'Naturaleza inválida.' }
        if (-not $h['activo']) { $h['activo'] = 'SI' }
    }
    $h
}
function Check-Unique($t, $h, $selfId) {
    if ($t -eq 'unidades') {
        foreach ($r in (Read-Table 'unidades')) {
            if ($r.id -ne $selfId -and $r.consorcio_id -eq $h['consorcio_id'] -and $r.numero_uf -eq $h['numero_uf'] -and $r.piso -eq $h['piso'] -and $r.departamento -eq $h['departamento'] -and $r.tipo -eq $h['tipo']) {
                Fail 409 "Ya existe la unidad UF $($h['numero_uf']) en este consorcio."
            }
        }
    }
    if ($t -eq 'tipos_reclamo') {
        foreach ($r in (Read-Table 'tipos_reclamo')) { if ($r.id -ne $selfId -and $r.nombre.ToLower() -eq $h['nombre'].ToLower()) { Fail 409 'Ya existe un tipo de reclamo con ese nombre.' } }
    }
    if ($t -eq 'unidad_propietarios') {
        foreach ($r in (Read-Table $t)) { if ($r.id -ne $selfId -and $r.unidad_id -eq $h['unidad_id'] -and $r.propietario_id -eq $h['propietario_id']) { Fail 409 'El propietario ya está asignado a esta unidad.' } }
    }
}
function Create-Row($t, $body) {
    $h = Build-Row $t $body $null
    Check-Unique $t $h ''
    $rows = @(Read-Table $t)
    $o = [ordered]@{ id = (Next-Id $rows) }
    foreach ($k in $h.Keys) { $o[$k] = $h[$k] }
    if ($t -eq 'consorcios') { $o['creado'] = Now }
    $row = [pscustomobject]$o
    Write-Table $t (@($rows) + $row)
    $row
}
function Update-Row($t, $id, $body) {
    $rows = @(Read-Table $t)
    $cur = $null
    foreach ($r in $rows) { if ($r.id -eq $id) { $cur = $r } }
    if (-not $cur) { Fail 404 'Registro no encontrado.' }
    $h = Build-Row $t $body $cur
    Check-Unique $t $h $id
    foreach ($k in $h.Keys) { $cur.$k = $h[$k] }
    Write-Table $t $rows
    $cur
}
function Delete-Row($t, $id) {
    if (-not (Exists $t $id)) { Fail 404 'Registro no encontrado.' }
    foreach ($b in $Blocks[$t]) {
        foreach ($r in (Read-Table $b[0])) { if ($r.($b[1]) -eq $id) { Fail 409 $b[2] } }
    }
    # Para consorcios: sus unidades también podrían tener bloqueos (cubiertos por reclamos.consorcio_id).
    foreach ($c in $Cascade[$t]) {
        foreach ($r in @(Read-Table $c[0] | Where-Object { $_.($c[1]) -eq $id })) { Delete-Row $c[0] $r.id }
    }
    $keep = @(Read-Table $t | Where-Object { $_.id -ne $id })
    Write-Table $t $keep
}

# ---------------------------------------------------------------- Enriquecimientos
function Propietarios-De-Unidad($unidadId, $links, $props) {
    $out = @()
    foreach ($l in $links) { if ($l.unidad_id -eq $unidadId -and $props.ContainsKey($l.propietario_id)) {
        $p = $props[$l.propietario_id]
        $out += [ordered]@{ link_id = $l.id; porcentaje = $l.porcentaje; id = $p.id; nombre = $p.nombre; telefono = $p.telefono; telefono_alt = $p.telefono_alt; email = $p.email; dni = $p.dni }
    } }
    ,$out
}
function Inquilino-Activo($i) {
    if (-not $i.fecha_hasta) { return $true }
    $i.fecha_hasta -ge (Get-Date).ToString('yyyy-MM-dd')
}
function Shape-Proveedor($p) {
    $o = [ordered]@{}
    foreach ($k in $Schema.proveedores) { $o[$k] = [string]$p.$k }
    $o['tipo'] = @(([string]$p.tipo).Split('|') | Where-Object { $_ })
    $o
}
function Proveedores-De-Reclamo($reclamoId) {
    $provs = Index 'proveedores'
    $out = @()
    foreach ($l in (Read-Table 'reclamo_proveedores')) { if ($l.reclamo_id -eq $reclamoId -and $provs.ContainsKey($l.proveedor_id)) {
        $o = Shape-Proveedor $provs[$l.proveedor_id]; $o['link_id'] = $l.id; $o['fecha_asignacion'] = $l.fecha_asignacion; $out += $o } }
    ,$out
}
function Enrich-Reclamos($rows) {
    $cons = Index 'consorcios'; $uni = Index 'unidades'; $tip = Index 'tipos_reclamo'
    $provs = Index 'proveedores'; $provBy = @{}
    foreach ($l in (Read-Table 'reclamo_proveedores')) { if ($provs.ContainsKey($l.proveedor_id)) {
        if (-not $provBy.ContainsKey($l.reclamo_id)) { $provBy[$l.reclamo_id] = @() }
        $provBy[$l.reclamo_id] += [ordered]@{ id = $l.proveedor_id; nombre = $provs[$l.proveedor_id].nombre; telefono = $provs[$l.proveedor_id].telefono } } }
    $reit = @{}; $last = @{}
    foreach ($r in (Read-Table 'reiteraciones')) {
        if ($reit.ContainsKey($r.reclamo_id)) { $reit[$r.reclamo_id]++ } else { $reit[$r.reclamo_id] = 1 }
        if (-not $last.ContainsKey($r.reclamo_id) -or $r.fecha -gt $last[$r.reclamo_id]) { $last[$r.reclamo_id] = $r.fecha }
    }
    $out = @()
    foreach ($r in $rows) {
        $o = [ordered]@{}
        foreach ($c in $Schema.reclamos) { $o[$c] = [string]$r.$c }
        if (-not $o['etapa']) { $o['etapa'] = 'Nuevo' }
        if ($o['estado'] -eq 'Cerrado' -and -not $o['resolucion']) { $o['resolucion'] = 'Resuelto' }
        $o['proveedores'] = if ($provBy.ContainsKey($r.id)) { @($provBy[$r.id]) } else { @() }
        $o['consorcio_nombre'] = if ($cons.ContainsKey($r.consorcio_id)) { $cons[$r.consorcio_id].nombre } else { '' }
        $o['consorcio_direccion'] = if ($cons.ContainsKey($r.consorcio_id)) { $cons[$r.consorcio_id].direccion } else { '' }
        $u = if ($uni.ContainsKey($r.unidad_id)) { $uni[$r.unidad_id] } else { $null }
        $o['unidad_label'] = Unit-Label $u
        $o['tipo_nombre'] = if ($tip.ContainsKey($r.tipo_id)) { $tip[$r.tipo_id].nombre } else { '' }
        $o['tipo_icono'] = if ($tip.ContainsKey($r.tipo_id)) { $tip[$r.tipo_id].icono } else { '' }
        $o['urgencia_nivel'] = [array]::IndexOf($Urgencias, $r.urgencia) + 1
        $o['reiteraciones'] = if ($reit.ContainsKey($r.id)) { $reit[$r.id] } else { 0 }
        $o['ultima_reiteracion'] = if ($last.ContainsKey($r.id)) { $last[$r.id] } else { '' }
        $out += $o
    }
    ,$out
}

# ---------------------------------------------------------------- Reclamos (lógica de negocio)
function Norm($s) { ([string]$s).Trim().ToLower() }
function Find-Duplicados($consorcioId, $tipoId, $unidadId, $detalleUbic, $exceptId) {
    $dups = @(Read-Table 'reclamos' | Where-Object {
        $_.estado -eq 'Abierto' -and $_.id -ne $exceptId -and $_.consorcio_id -eq $consorcioId -and $_.tipo_id -eq $tipoId -and
        $_.unidad_id -eq $unidadId -and (Norm $_.ubicacion_detalle) -eq (Norm $detalleUbic) })
    ,$dups
}
function Create-Reclamo($body) {
    $h = [ordered]@{}
    foreach ($c in @('consorcio_id','unidad_id','ubicacion_detalle','tipo_id','naturaleza','urgencia','titulo','detalle','fecha_reclamo','solicitante_tipo','solicitante_nombre','solicitante_contacto','canal')) {
        $h[$c] = Val $body $c; if ($null -eq $h[$c]) { $h[$c] = '' }
    }
    foreach ($c in @('consorcio_id','tipo_id','urgencia','detalle','solicitante_nombre')) {
        if (-not $h[$c]) { Fail 400 "Falta completar: $c." }
    }
    if (-not (Exists 'consorcios' $h['consorcio_id'])) { Fail 400 'Consorcio inválido.' }
    $tipo = Get-Row 'tipos_reclamo' $h['tipo_id']
    if ($Urgencias -notcontains $h['urgencia']) { Fail 400 'Urgencia inválida.' }
    if (-not $h['naturaleza']) { $h['naturaleza'] = $tipo.naturaleza }
    if ($Naturalezas -notcontains $h['naturaleza']) { Fail 400 'Naturaleza inválida.' }
    if ($h['unidad_id']) {
        $u = Get-Row 'unidades' $h['unidad_id']
        if ($u.consorcio_id -ne $h['consorcio_id']) { Fail 400 'La unidad no pertenece al consorcio.' }
    }
    $dups = Find-Duplicados $h['consorcio_id'] $h['tipo_id'] $h['unidad_id'] $h['ubicacion_detalle'] ''
    if ($dups.Count -gt 0) {
        Fail 409 'Ya existe un reclamo abierto para este mismo incidente. No se puede duplicar: corresponde registrar una reiteración.' @{ duplicados = (Enrich-Reclamos $dups) }
    }
    $op = Op $body
    if (-not $h['fecha_reclamo']) { $h['fecha_reclamo'] = Now } else { $h['fecha_reclamo'] = $h['fecha_reclamo'].Replace('T', ' ') }
    if (-not $h['titulo']) { $h['titulo'] = $tipo.nombre }
    if (-not $h['canal']) { $h['canal'] = 'Teléfono' }
    if (-not $h['solicitante_tipo']) { $h['solicitante_tipo'] = 'Otro' }
    $rows = @(Read-Table 'reclamos')
    $o = [ordered]@{ id = (Next-Id $rows) }
    foreach ($k in $h.Keys) { $o[$k] = $h[$k] }
    $o['estado'] = 'Abierto'; $o['etapa'] = 'Nuevo'; $o['resolucion'] = ''; $o['fecha_cierre'] = ''; $o['motivo_cierre'] = ''; $o['operador'] = $op; $o['actualizado'] = Now
    $row = [pscustomobject]$o
    Write-Table 'reclamos' (@($rows) + $row)
    Add-Hist $row.id 'Creado' "Reclamo registrado por $($h['solicitante_nombre']) ($($h['solicitante_tipo'])) vía $($h['canal']). Urgencia: $($h['urgencia'])." $op
    if (Has $body 'proveedor_ids') { [void](Asignar-Proveedores $row.id @($body.proveedor_ids) $op) }
    $row
}
function Asignar-Proveedores($reclamoId, $ids, $op) {
    $links = @(Read-Table 'reclamo_proveedores'); $provs = Index 'proveedores'; $added = @()
    foreach ($provId in $ids) {
        $provId = [string]$provId
        if (-not $provId) { continue }
        if (-not $provs.ContainsKey($provId)) { Fail 400 'Proveedor inválido.' }
        if (@($links | Where-Object { $_.reclamo_id -eq $reclamoId -and $_.proveedor_id -eq $provId }).Count -gt 0) { continue }
        $row = [pscustomobject][ordered]@{ id = (Next-Id $links); reclamo_id = $reclamoId; proveedor_id = $provId; fecha_asignacion = (Now); operador = $op }
        $links = @($links) + $row; $added += $provs[$provId].nombre
    }
    if ($added.Count -gt 0) {
        Write-Table 'reclamo_proveedores' $links
        Add-Hist $reclamoId 'Proveedor asignado' ($added -join ', ') $op
        [void](Touch-Reclamo $reclamoId { param($r) })
    }
    $added
}
function Touch-Reclamo($id, [scriptblock]$change) {
    $rows = @(Read-Table 'reclamos')
    $cur = $null
    foreach ($r in $rows) { if ($r.id -eq $id) { $cur = $r } }
    if (-not $cur) { Fail 404 'Reclamo no encontrado.' }
    & $change $cur
    $cur.actualizado = Now
    Write-Table 'reclamos' $rows
    $cur
}
function Reiterar($id, $body) {
    $rec = Get-Row 'reclamos' $id
    if ($rec.estado -ne 'Abierto') { Fail 409 'El reclamo está cerrado. Reábrelo para poder registrar una reiteración.' }
    $nombre = Val $body 'solicitante_nombre'
    if (-not $nombre) { Fail 400 'Falta completar: quién llama.' }
    $detalle = Val $body 'detalle'
    if (-not $detalle) { Fail 400 'Falta completar: detalle de lo que informa.' }
    $fecha = Val $body 'fecha'; if (-not $fecha) { $fecha = Now } else { $fecha = $fecha.Replace('T', ' ') }
    $rows = @(Read-Table 'reiteraciones')
    $row = [pscustomobject][ordered]@{
        id = (Next-Id $rows); reclamo_id = $id; fecha = $fecha
        solicitante_tipo = (Val $body 'solicitante_tipo'); solicitante_nombre = $nombre; solicitante_contacto = (Val $body 'solicitante_contacto')
        unidad_id = (Val $body 'unidad_id'); canal = (Val $body 'canal'); detalle = $detalle; operador = (Op $body) }
    Write-Table 'reiteraciones' (@($rows) + $row)
    $n = @(Read-Table 'reiteraciones' | Where-Object { $_.reclamo_id -eq $id }).Count
    Add-Hist $id 'Reiteración' "Reiteración N° $n de $nombre ($($row.solicitante_tipo)): $detalle" (Op $body)
    $niv = Val $body 'urgencia'
    if ($niv -and $niv -ne $rec.urgencia -and $Urgencias -contains $niv) {
        $old = $rec.urgencia
        [void](Touch-Reclamo $id { param($r) $r.urgencia = $niv })
        Add-Hist $id 'Urgencia modificada' "De $old a $niv (al reiterar)." (Op $body)
    } else { [void](Touch-Reclamo $id { param($r) }) }
    $row
}
function Reclamo-Detalle($id) {
    $rec = Get-Row 'reclamos' $id
    $e = (Enrich-Reclamos @($rec))[0]
    $e['proveedores'] = Proveedores-De-Reclamo $id
    $e['reiteraciones_lista'] = @(Read-Table 'reiteraciones' | Where-Object { $_.reclamo_id -eq $id } | Sort-Object fecha -Descending)
    $e['historial'] = @(Read-Table 'historial' | Where-Object { $_.reclamo_id -eq $id } | Sort-Object { [int]$_.id } -Descending)
    $e
}

function Resumen {
    $all = Enrich-Reclamos (Read-Table 'reclamos')
    $abiertos = @($all | Where-Object { $_['estado'] -eq 'Abierto' })
    $porUrg = [ordered]@{}; foreach ($u in $Urgencias) { $porUrg[$u] = @($abiertos | Where-Object { $_['urgencia'] -eq $u }).Count }
    $hace7 = (Get-Date).AddDays(-7).ToString('yyyy-MM-dd HH:mm')
    $hace30 = (Get-Date).AddDays(-30).ToString('yyyy-MM-dd HH:mm')
    [ordered]@{
        abiertos = $abiertos.Count
        cerrados = @($all | Where-Object { $_['estado'] -eq 'Cerrado' }).Count
        resueltos_30d = @($all | Where-Object { $_['estado'] -eq 'Cerrado' -and $_['resolucion'] -eq 'Resuelto' -and $_['fecha_cierre'] -ge $hace30 }).Count
        por_etapa = $(foreach ($e in $Etapas) { [ordered]@{ etapa = $e; cantidad = @($abiertos | Where-Object { $_['etapa'] -eq $e }).Count } })
        reiteraciones_7d = @(Read-Table 'reiteraciones' | Where-Object { $_.fecha -ge $hace7 }).Count
        consorcios = @(Read-Table 'consorcios').Count
        unidades = @(Read-Table 'unidades').Count
        propietarios = @(Read-Table 'propietarios').Count
        por_urgencia = $porUrg
        prioritarios = @($abiertos | Sort-Object @{e={$_['urgencia_nivel']};Descending=$true}, @{e={$_['fecha_reclamo']}} | Select-Object -First 8)
    }
}

# ---------------------------------------------------------------- Router de la API
function Route-Api($method, $segs, $q, $body) {
    $t = $segs[1]; $id = $segs[2]; $sub = $segs[3]
    if ($t -eq 'meta') {
        $tipos = @(Read-Table 'tipos_reclamo' | Sort-Object { [int]$_.id })
        $profs = @($ProfesionesSugeridas)
        foreach ($p in (Read-Table 'proveedores')) { foreach ($x in ([string]$p.tipo).Split('|')) { if ($x -and @($profs | Where-Object { $_.ToLower() -eq $x.ToLower() }).Count -eq 0) { $profs += $x } } }
        $profs = @($profs | Sort-Object)
        return [ordered]@{ urgencias = $Urgencias; naturalezas = $Naturalezas; roles = $Roles; tipos_unidad = $TiposUnidad; canales = $Canales; solicitante_tipos = $SolicitanteTipos; etapas = $Etapas; resoluciones = $Resoluciones; profesiones = $profs; tipos_reclamo = $tipos; data_dir = (Resolve-Path $DataDir).Path }
    }
    if ($t -eq 'resumen') { return Resumen }
    if ($t -eq 'db') {
        return @(foreach ($k in $Schema.Keys) { [ordered]@{ tabla = $k; archivo = "$k.csv"; filas = @(Read-Table $k).Count; columnas = $Schema[$k] } })
    }
    if (-not $Schema.Contains($t)) { Fail 404 'Recurso inexistente.' }

    # ---- reclamos
    if ($t -eq 'reclamos') {
        if ($method -eq 'GET' -and -not $id) {
            $rows = @(Read-Table 'reclamos')
            if ($q['consorcio_id']) { $rows = @($rows | Where-Object { $_.consorcio_id -eq $q['consorcio_id'] }) }
            if ($q['unidad_id']) { $rows = @($rows | Where-Object { $_.unidad_id -eq $q['unidad_id'] }) }
            if ($q['estado']) { $rows = @($rows | Where-Object { $_.estado -eq $q['estado'] }) }
            return ,(Enrich-Reclamos $rows)
        }
        if ($method -eq 'GET' -and $id -and -not $sub) { return Reclamo-Detalle $id }
        if ($method -eq 'POST' -and -not $id) { $r = Create-Reclamo $body; return Reclamo-Detalle $r.id }
        if ($id -and $method -eq 'POST' -and $sub -eq 'reiterar') { [void](Reiterar $id $body); return Reclamo-Detalle $id }
        if ($id -and $method -eq 'POST' -and $sub -eq 'cerrar') {
            $rec = Get-Row 'reclamos' $id
            if ($rec.estado -ne 'Abierto') { Fail 409 'El reclamo ya está cerrado.' }
            $res = Val $body 'resolucion'
            if ($Resoluciones -notcontains $res) { Fail 400 'Indica cómo se cierra el reclamo: Resuelto, Desestimado o Anulado.' }
            $m = Val $body 'motivo'; if (-not $m) { Fail 400 'Indica el motivo del cierre (qué se hizo o por qué se cierra).' }
            [void](Touch-Reclamo $id { param($r) $r.estado = 'Cerrado'; $r.resolucion = $res; $r.fecha_cierre = (Now); $r.motivo_cierre = $m })
            Add-Hist $id "Cerrado: $res" $m (Op $body)
            return Reclamo-Detalle $id
        }
        if ($id -and $method -eq 'POST' -and $sub -eq 'etapa') {
            $rec = Get-Row 'reclamos' $id
            $et = Val $body 'etapa'
            if ($Etapas -notcontains $et) { Fail 400 'Etapa inválida.' }
            $old = if ($rec.etapa) { $rec.etapa } else { 'Nuevo' }
            if ($old -ne $et) {
                [void](Touch-Reclamo $id { param($r) $r.etapa = $et })
                $nota = Val $body 'detalle'
                Add-Hist $id 'Etapa' ("De «$old» a «$et»." + $(if ($nota) { " $nota" } else { '' })) (Op $body)
            }
            return Reclamo-Detalle $id
        }
        if ($id -and $method -eq 'POST' -and $sub -eq 'proveedores') {
            [void](Get-Row 'reclamos' $id)
            $ids = @($body.proveedor_ids)
            if ($ids.Count -eq 0 -or -not $ids[0]) { Fail 400 'Selecciona al menos un proveedor.' }
            [void](Asignar-Proveedores $id $ids (Op $body))
            return Reclamo-Detalle $id
        }
        if ($id -and $method -eq 'DELETE' -and $sub -eq 'proveedores' -and $segs[4]) {
            [void](Get-Row 'reclamos' $id)
            $links = @(Read-Table 'reclamo_proveedores')
            $link = @($links | Where-Object { $_.reclamo_id -eq $id -and $_.proveedor_id -eq $segs[4] })
            if ($link.Count -eq 0) { Fail 404 'El proveedor no está asignado a este reclamo.' }
            $prov = Get-Row 'proveedores' $segs[4]
            Write-Table 'reclamo_proveedores' @($links | Where-Object { -not ($_.reclamo_id -eq $id -and $_.proveedor_id -eq $segs[4]) })
            Add-Hist $id 'Proveedor desasignado' $prov.nombre (Op $body)
            return Reclamo-Detalle $id
        }
        if ($id -and $method -eq 'POST' -and $sub -eq 'reabrir') {
            $rec = Get-Row 'reclamos' $id
            if ($rec.estado -ne 'Cerrado') { Fail 409 'El reclamo ya está abierto.' }
            $m = Val $body 'motivo'; if (-not $m) { Fail 400 'Indica el motivo de la reapertura.' }
            $dups = Find-Duplicados $rec.consorcio_id $rec.tipo_id $rec.unidad_id $rec.ubicacion_detalle $id
            if ($dups.Count -gt 0) { Fail 409 'No se puede reabrir: ya hay otro reclamo abierto para el mismo incidente.' @{ duplicados = (Enrich-Reclamos $dups) } }
            [void](Touch-Reclamo $id { param($r) $r.estado = 'Abierto'; $r.resolucion = ''; $r.fecha_cierre = ''; $r.motivo_cierre = '' })
            Add-Hist $id 'Reabierto' $m (Op $body)
            return Reclamo-Detalle $id
        }
        if ($id -and $method -eq 'POST' -and $sub -eq 'notas') {
            $n = Val $body 'detalle'; if (-not $n) { Fail 400 'Escribe la nota.' }
            [void](Get-Row 'reclamos' $id)
            Add-Hist $id 'Nota' $n (Op $body)
            return Reclamo-Detalle $id
        }
        if ($id -and $method -eq 'PUT') {
            $rec = Get-Row 'reclamos' $id
            $cambios = @()
            $nu = Val $body 'urgencia'; $nn = Val $body 'naturaleza'; $nt = Val $body 'titulo'; $nd = Val $body 'detalle'
            if ($nu -and $Urgencias -notcontains $nu) { Fail 400 'Urgencia inválida.' }
            if ($nn -and $Naturalezas -notcontains $nn) { Fail 400 'Naturaleza inválida.' }
            if ($nu -and $nu -ne $rec.urgencia) { $cambios += "Urgencia: $($rec.urgencia) → $nu" }
            if ($nn -and $nn -ne $rec.naturaleza) { $cambios += "Naturaleza: $($rec.naturaleza) → $nn" }
            if ($nt -and $nt -ne $rec.titulo) { $cambios += 'Título editado' }
            if ($nd -and $nd -ne $rec.detalle) { $cambios += 'Detalle editado' }
            [void](Touch-Reclamo $id { param($r)
                if ($nu) { $r.urgencia = $nu }; if ($nn) { $r.naturaleza = $nn }; if ($nt) { $r.titulo = $nt }; if ($nd) { $r.detalle = $nd } })
            if ($cambios.Count -gt 0) { Add-Hist $id 'Modificado' ($cambios -join '; ') (Op $body) }
            return Reclamo-Detalle $id
        }
        if ($id -and $method -eq 'DELETE') { Delete-Row 'reclamos' $id; return @{ ok = $true } }
        Fail 405 'Operación no soportada.'
    }

    # ---- lecturas enriquecidas
    if ($method -eq 'GET' -and $t -eq 'consorcios') {
        if (-not $id) {
            $uni = @(Read-Table 'unidades'); $per = @(Read-Table 'personal'); $rec = @(Read-Table 'reclamos')
            return ,@(foreach ($c in (Read-Table 'consorcios' | Sort-Object nombre)) {
                $o = [ordered]@{}; foreach ($k in $Schema.consorcios) { $o[$k] = [string]$c.$k }
                $o['unidades_count'] = @($uni | Where-Object { $_.consorcio_id -eq $c.id }).Count
                $o['personal_count'] = @($per | Where-Object { $_.consorcio_id -eq $c.id }).Count
                $o['reclamos_abiertos'] = @($rec | Where-Object { $_.consorcio_id -eq $c.id -and $_.estado -eq 'Abierto' }).Count
                $o['reclamos_total'] = @($rec | Where-Object { $_.consorcio_id -eq $c.id }).Count
                $o
            })
        }
        $c = Get-Row 'consorcios' $id
        $props = Index 'propietarios'; $links = @(Read-Table 'unidad_propietarios'); $inq = @(Read-Table 'inquilinos'); $rec = @(Read-Table 'reclamos')
        $unidades = @(foreach ($u in (Read-Table 'unidades' | Where-Object { $_.consorcio_id -eq $id } | Sort-Object { $_.piso }, { $_.departamento }, { [int]("0" + ($_.numero_uf -replace '\D','')) })) {
            $o = [ordered]@{}; foreach ($k in $Schema.unidades) { $o[$k] = [string]$u.$k }
            $o['label'] = Unit-Label $u
            $o['direccion_completa'] = "$($c.direccion)" + $(if ($u.piso) { ", Piso $($u.piso)" } else { '' }) + $(if ($u.departamento) { " Dto $($u.departamento)" } else { '' })
            $o['propietarios'] = Propietarios-De-Unidad $u.id $links $props
            $o['inquilinos'] = @($inq | Where-Object { $_.unidad_id -eq $u.id -and (Inquilino-Activo $_) })
            $o['reclamos_abiertos'] = @($rec | Where-Object { $_.unidad_id -eq $u.id -and $_.estado -eq 'Abierto' }).Count
            $o['reclamos_total'] = @($rec | Where-Object { $_.unidad_id -eq $u.id }).Count
            $o
        })
        $o = [ordered]@{}; foreach ($k in $Schema.consorcios) { $o[$k] = [string]$c.$k }
        $o['personal'] = @(Read-Table 'personal' | Where-Object { $_.consorcio_id -eq $id } | Sort-Object rol, nombre)
        $o['unidades'] = $unidades
        $o['reclamos_abiertos'] = @($rec | Where-Object { $_.consorcio_id -eq $id -and $_.estado -eq 'Abierto' }).Count
        return $o
    }
    if ($method -eq 'GET' -and $t -eq 'unidades' -and $id) {
        $u = Get-Row 'unidades' $id
        $c = Get-Row 'consorcios' $u.consorcio_id
        $props = Index 'propietarios'; $links = @(Read-Table 'unidad_propietarios')
        $o = [ordered]@{}; foreach ($k in $Schema.unidades) { $o[$k] = [string]$u.$k }
        $o['label'] = Unit-Label $u
        $o['consorcio_nombre'] = $c.nombre
        $o['direccion_completa'] = "$($c.direccion)" + $(if ($u.piso) { ", Piso $($u.piso)" } else { '' }) + $(if ($u.departamento) { " Dto $($u.departamento)" } else { '' })
        $o['propietarios'] = Propietarios-De-Unidad $u.id $links $props
        $o['inquilinos'] = @(Read-Table 'inquilinos' | Where-Object { $_.unidad_id -eq $id } | Sort-Object fecha_desde -Descending | ForEach-Object {
            $x = [ordered]@{}; foreach ($k in $Schema.inquilinos) { $x[$k] = [string]$_.$k }; $x['activo'] = [bool](Inquilino-Activo $_); $x })
        $o['reclamos'] = Enrich-Reclamos @(Read-Table 'reclamos' | Where-Object { $_.unidad_id -eq $id } | Sort-Object fecha_reclamo -Descending)
        return $o
    }
    if ($method -eq 'GET' -and $t -eq 'proveedores') {
        $links = @(Read-Table 'reclamo_proveedores'); $recs = Index 'reclamos'
        $shape = {
            param($p)
            $o = Shape-Proveedor $p
            $mine = @($links | Where-Object { $_.proveedor_id -eq $p.id -and $recs.ContainsKey($_.reclamo_id) })
            $o['reclamos_activos'] = @($mine | Where-Object { $recs[$_.reclamo_id].estado -eq 'Abierto' }).Count
            $o['reclamos_total'] = $mine.Count
            $o
        }
        if ($id) {
            $o = & $shape (Get-Row 'proveedores' $id)
            $ids = @($links | Where-Object { $_.proveedor_id -eq $id } | ForEach-Object { $_.reclamo_id })
            $o['reclamos'] = Enrich-Reclamos @(Read-Table 'reclamos' | Where-Object { $ids -contains $_.id } | Sort-Object fecha_reclamo -Descending)
            return $o
        }
        return ,@(foreach ($p in (Read-Table 'proveedores' | Sort-Object nombre)) { & $shape $p })
    }
    if ($method -eq 'GET' -and $t -eq 'propietarios') {
        $uni = Index 'unidades'; $cons = Index 'consorcios'; $links = @(Read-Table 'unidad_propietarios')
        $shape = {
            param($p)
            $o = [ordered]@{}; foreach ($k in $Schema.propietarios) { $o[$k] = [string]$p.$k }
            $o['unidades'] = @(foreach ($l in ($links | Where-Object { $_.propietario_id -eq $p.id })) { if ($uni.ContainsKey($l.unidad_id)) {
                $u = $uni[$l.unidad_id]
                [ordered]@{ link_id = $l.id; unidad_id = $u.id; consorcio_id = $u.consorcio_id; consorcio_nombre = $cons[$u.consorcio_id].nombre; label = (Unit-Label $u) } } })
            $o
        }
        if ($id) { return (& $shape (Get-Row 'propietarios' $id)) }
        return ,@(foreach ($p in (Read-Table 'propietarios' | Sort-Object nombre)) { & $shape $p })
    }
    if ($method -eq 'GET' -and $t -eq 'unidades') {
        $rows = @(Read-Table 'unidades')
        if ($q['consorcio_id']) { $rows = @($rows | Where-Object { $_.consorcio_id -eq $q['consorcio_id'] }) }
        return ,@(foreach ($u in $rows) { $o = [ordered]@{}; foreach ($k in $Schema.unidades) { $o[$k] = [string]$u.$k }; $o['label'] = Unit-Label $u; $o })
    }

    # ---- CRUD genérico
    switch ($method) {
        'GET' {
            if ($id) { return Get-Row $t $id }
            $rows = @(Read-Table $t)
            foreach ($c in $Schema[$t]) { if ($q[$c]) { $rows = @($rows | Where-Object { $_.$c -eq $q[$c] }) } }
            return ,@($rows)
        }
        'POST' { return Create-Row $t $body }
        'PUT' { if (-not $id) { Fail 400 'Falta el id.' }; return Update-Row $t $id $body }
        'DELETE' { if (-not $id) { Fail 400 'Falta el id.' }; Delete-Row $t $id; return @{ ok = $true } }
    }
    Fail 405 'Operación no soportada.'
}

# ---------------------------------------------------------------- Servidor HTTP
$Mime = @{ '.html'='text/html; charset=utf-8'; '.css'='text/css; charset=utf-8'; '.js'='application/javascript; charset=utf-8'; '.json'='application/json; charset=utf-8'; '.svg'='image/svg+xml'; '.png'='image/png'; '.ico'='image/x-icon'; '.csv'='text/csv; charset=utf-8' }
function Send($ctx, $code, [byte[]]$bytes, $type) {
    $ctx.Response.StatusCode = $code
    $ctx.Response.ContentType = $type
    $ctx.Response.ContentLength64 = $bytes.Length
    $ctx.Response.Headers.Add('Cache-Control', 'no-store')
    $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $ctx.Response.OutputStream.Close()
}
function Send-Json($ctx, $code, $obj) {
    $json = ConvertTo-Json -InputObject $obj -Depth 10 -Compress
    Send $ctx $code ($Utf8.GetBytes($json)) 'application/json; charset=utf-8'
}

Init-Data
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
try { $listener.Start() } catch { Write-Host "No se pudo iniciar en el puerto $Port. ¿Ya está en uso? Detalle: $($_.Exception.Message)" -ForegroundColor Red; exit 1 }
$url = "http://localhost:$Port/"
Write-Host ''
Write-Host '  Administración de Consorcios' -ForegroundColor Cyan
Write-Host "  App:    $url"
Write-Host "  Datos:  $((Resolve-Path $DataDir).Path)  (archivos CSV)"
Write-Host '  Cierra esta ventana o presiona Ctrl+C para detener el servidor.' -ForegroundColor DarkGray
Write-Host ''
if (-not $NoBrowser) { Start-Process $url }

try {
    while ($listener.IsListening) {
        $ctx = $listener.GetContext()
        try {
            $req = $ctx.Request
            $path = [Uri]::UnescapeDataString($req.Url.AbsolutePath)
            if ($path.StartsWith('/api/')) {
                $segs = @($path.Trim('/').Split('/'))
                $body = $null
                if ($req.HasEntityBody) {
                    $sr = New-Object System.IO.StreamReader($req.InputStream, $Utf8)
                    $raw = $sr.ReadToEnd(); $sr.Close()
                    if ($raw) { try { $body = $raw | ConvertFrom-Json } catch { Fail 400 'JSON inválido.' } }
                }
                $script:ErrExtra = $null
                try {
                    $res = Route-Api $req.HttpMethod $segs $req.QueryString $body
                    Send-Json $ctx 200 $res
                } catch {
                    $m = $_.Exception.Message
                    if ($m.StartsWith('API|')) {
                        $p = $m.Split('|', 3)
                        $err = [ordered]@{ error = $p[2] }
                        if ($script:ErrExtra) { foreach ($k in $script:ErrExtra.Keys) { $err[$k] = $script:ErrExtra[$k] } }
                        Send-Json $ctx ([int]$p[1]) $err
                    } else {
                        Write-Host "ERROR: $m" -ForegroundColor Red
                        Write-Host $_.ScriptStackTrace -ForegroundColor DarkRed
                        Send-Json $ctx 500 @{ error = "Error interno: $m" }
                    }
                }
            } else {
                if ($path -eq '/') { $path = '/index.html' }
                $full = [System.IO.Path]::GetFullPath((Join-Path $PublicDir $path.TrimStart('/')))
                if ($full.StartsWith($PublicDir, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path $full -PathType Leaf)) {
                    $ext = [System.IO.Path]::GetExtension($full).ToLower()
                    $type = $Mime[$ext]; if (-not $type) { $type = 'application/octet-stream' }
                    Send $ctx 200 ([System.IO.File]::ReadAllBytes($full)) $type
                } else {
                    Send $ctx 404 ($Utf8.GetBytes('No encontrado')) 'text/plain; charset=utf-8'
                }
            }
        } catch {
            Write-Host "ERROR de conexión: $($_.Exception.Message)" -ForegroundColor Red
            try { $ctx.Response.Abort() } catch {}
        }
    }
} finally { $listener.Stop() }
