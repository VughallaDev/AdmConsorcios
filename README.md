# Administración de Consorcios

App web local para cargar y dar seguimiento a reclamos. Sin instalaciones: usa PowerShell (incluido en Windows). La base de datos son archivos CSV en `data/`.

## Uso
1. Doble clic en `iniciar.bat` (abre http://localhost:8080). Dejá la ventana abierta mientras uses la app.
2. Opcional, con el servidor andando: `powershell -ExecutionPolicy Bypass -File cargar-datos-demo.ps1` carga datos de ejemplo.

## Tablas CSV (`data/`)
consorcios, personal, unidades, propietarios, unidad_propietarios (relación UF↔propietario), inquilinos, proveedores (columna `tipo` = profesiones separadas por `|`), reclamo_proveedores (relación reclamo↔proveedor), tipos_reclamo, reclamos, reiteraciones, historial.
Cada una tiene su `id` propio; las relaciones son columnas `*_id`.

## Reglas de reclamos
- Un reclamo abierto con el mismo consorcio + tipo + unidad (o áreas comunes) + detalle de ubicación no se puede duplicar: se registra una reiteración.
- Los abiertos se pueden cerrar (con motivo) y los cerrados reabrir (con motivo). Todo queda en `historial`.

- Etapas (cambiables en cualquier momento): Nuevo → En espera de visita del proveedor → Visitado por el proveedor → Esperando presupuesto → Presupuesto aprobado → Trabajo en ejecución → Finalizado.
- Cierre con resolución: Resuelto, Desestimado o Anulado. Los cerrados no se borran: salen de "Abiertos" y quedan en "Cerrados" (se pueden reabrir).
- Al iniciar, el servidor migra solos los CSV existentes a las columnas nuevas (los reclamos viejos quedan en etapa "Nuevo"; los cerrados, como "Resuelto").