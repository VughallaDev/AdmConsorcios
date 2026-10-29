<#
  Carga datos de ejemplo (opcional) usando la API del servidor. El servidor debe estar en ejecución.
  Uso:  powershell -ExecutionPolicy Bypass -File cargar-datos-demo.ps1 [-Port 8080]
#>
param([int]$Port = 8080)
$b = "http://localhost:$Port/api"
function Call($m, $u, $d) {
    $json = $d | ConvertTo-Json -Depth 6 -Compress
    Invoke-RestMethod -Method $m -Uri "$b/$u" -Body ([Text.Encoding]::UTF8.GetBytes($json)) -ContentType 'application/json; charset=utf-8'
}
$c1 = Call POST consorcios @{ nombre = 'Edificio Belgrano 1234'; direccion = 'Av. Belgrano 1234'; localidad = 'CABA'; fecha_inicio_administracion = '2019-03-01'; telefono_contacto = '11-4000-1111' }
$c2 = Call POST consorcios @{ nombre = 'Torres del Parque'; direccion = 'Libertador 4500'; localidad = 'Vicente López'; fecha_inicio_administracion = '2022-08-15' }
Call POST personal @{ consorcio_id = $c1.id; nombre = 'Ramón Gutiérrez'; rol = 'Encargado'; telefono = '11-5555-0101'; horario = 'Lu a Vi 7 a 15' } | Out-Null
Call POST personal @{ consorcio_id = $c1.id; nombre = 'CleanPro SRL'; rol = 'Empresa de limpieza'; empresa = 'CleanPro'; telefono = '11-4444-0000' } | Out-Null
Call POST personal @{ consorcio_id = $c1.id; nombre = 'Ascensores Norte'; rol = 'Proveedor de servicios'; servicio = 'Mantenimiento de ascensores'; email = 'soporte@ascensoresnorte.com' } | Out-Null
$ufs = @()
foreach ($i in 1..4) {
    $u = Call POST unidades @{ consorcio_id = $c1.id; numero_uf = "$i"; piso = "$i"; departamento = 'A'; tipo = 'Departamento' }
    $ufs += $u
}
$u5 = Call POST unidades @{ consorcio_id = $c2.id; numero_uf = '1'; piso = 'PB'; departamento = '1'; tipo = 'Departamento' }
$p1 = Call POST propietarios @{ nombre = 'María Pérez'; telefono = '11-5555-1234'; email = 'maria.perez@mail.com' }
$p2 = Call POST propietarios @{ nombre = 'Carlos Rodríguez'; telefono = '11-5555-9876'; dni = '20123456' }
$p3 = Call POST propietarios @{ nombre = 'Lucía Fernández'; telefono = '11-5555-4321'; email = 'lucia@mail.com' }
Call POST unidad_propietarios @{ unidad_id = $ufs[0].id; propietario_id = $p1.id } | Out-Null
Call POST unidad_propietarios @{ unidad_id = $ufs[1].id; propietario_id = $p2.id } | Out-Null
Call POST unidad_propietarios @{ unidad_id = $ufs[2].id; propietario_id = $p3.id } | Out-Null
Call POST unidad_propietarios @{ unidad_id = $u5.id; propietario_id = $p3.id } | Out-Null
Call POST inquilinos @{ unidad_id = $ufs[1].id; nombre = 'Julián Soto'; telefono = '11-6666-2222'; fecha_desde = '2025-01-01' } | Out-Null
$pv1 = Call POST proveedores @{ nombre = 'Juan Gómez'; telefono = '11-7000-1111'; tipo = @('Plomero','Gasista') }
$pv2 = Call POST proveedores @{ nombre = 'Electro Sur'; telefono = '11-7000-2222'; email = 'contacto@electrosur.com'; tipo = @('Electricista') }
$r1 = Call POST reclamos @{ consorcio_id = $c1.id; unidad_id = $ufs[0].id; tipo_id = '1'; urgencia = 'Alta'; detalle = 'Pérdida de agua en el baño que moja el techo del vecino de abajo.'; solicitante_nombre = 'María Pérez'; solicitante_tipo = 'Propietario'; solicitante_contacto = '11-5555-1234'; proveedor_ids = @($pv1.id) }
Call POST "reclamos/$($r1.id)/etapa" @{ etapa = 'En espera de visita del proveedor' } | Out-Null
Call POST "reclamos/$($r1.id)/reiterar" @{ solicitante_nombre = 'Carlos Rodríguez'; solicitante_tipo = 'Propietario'; detalle = 'Confirma que le cae agua del techo.' } | Out-Null
$r2 = Call POST reclamos @{ consorcio_id = $c1.id; tipo_id = '3'; ubicacion_detalle = 'Ascensor 2'; urgencia = 'Urgente Crítico'; detalle = 'Hay una persona atrapada en el ascensor 2.'; solicitante_nombre = 'Ramón Gutiérrez'; solicitante_tipo = 'Personal del consorcio' }
$r3 = Call POST reclamos @{ consorcio_id = $c1.id; unidad_id = $ufs[1].id; tipo_id = '14'; urgencia = 'Baja'; detalle = 'Consulta por el detalle de la factura de expensas de agosto.'; solicitante_nombre = 'Julián Soto'; solicitante_tipo = 'Inquilino' }
Call POST "reclamos/$($r3.id)/cerrar" @{ resolucion = 'Resuelto'; motivo = 'Se envió el detalle por mail.' } | Out-Null
Call POST reclamos @{ consorcio_id = $c2.id; tipo_id = '8'; urgencia = 'Media'; detalle = 'La pileta tiene el agua verde.'; solicitante_nombre = 'Lucía Fernández'; solicitante_tipo = 'Propietario' } | Out-Null
Write-Host 'Datos de ejemplo cargados.'
