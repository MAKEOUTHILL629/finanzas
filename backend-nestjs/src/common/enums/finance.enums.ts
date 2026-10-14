/** Catálogo de enums de la BD (sección 9 de "base de datos-documentacion.md"). */

export enum TipoCuentaFinanciera {
  AHORROS = 'AHORROS',
  CORRIENTE = 'CORRIENTE',
  BILLETERA_DIGITAL = 'BILLETERA_DIGITAL',
  EFECTIVO = 'EFECTIVO',
}

export enum TipoCategoria {
  INGRESO = 'INGRESO',
  EGRESO = 'EGRESO',
  AMBOS = 'AMBOS',
}

export enum TipoTransaccion {
  INGRESO = 'INGRESO',
  EGRESO = 'EGRESO',
  TRANSFERENCIA = 'TRANSFERENCIA',
  PAGO_TARJETA = 'PAGO_TARJETA',
  PAGO_PRESTAMO = 'PAGO_PRESTAMO',
  REEMBOLSO_TERCERO = 'REEMBOLSO_TERCERO',
}

export enum OrigenRegistro {
  MANUAL = 'MANUAL',
  EMAIL_AUTO = 'EMAIL_AUTO',
  MIGRACION = 'MIGRACION',
}

export enum EstadoTransaccion {
  PENDIENTE_REVISION = 'PENDIENTE_REVISION',
  CONFIRMADO = 'CONFIRMADO',
  ANULADO = 'ANULADO',
}

export enum EstadoNotificacionCorreo {
  PENDIENTE = 'PENDIENTE',
  CONCILIADO = 'CONCILIADO',
  IGNORADO = 'IGNORADO',
  ERROR = 'ERROR',
}

export enum FrecuenciaRecurrente {
  SEMANAL = 'SEMANAL',
  QUINCENAL = 'QUINCENAL',
  MENSUAL = 'MENSUAL',
  ANUAL = 'ANUAL',
}

export enum EstadoPeriodoRecurrente {
  PROYECTADO = 'PROYECTADO',
  FACTURADO = 'FACTURADO',
  PAGADO = 'PAGADO',
  OMITIDO = 'OMITIDO',
}

export enum DireccionPrestamo {
  POR_COBRAR = 'POR_COBRAR',
  POR_PAGAR = 'POR_PAGAR',
}

export enum EstadoPrestamo {
  PENDIENTE = 'Pendiente',
  PAGADO = 'Pagado',
  ANULADO = 'Anulado',
}

export enum MetodoPrestamo {
  NEQUI = 'Nequi',
  FISICO = 'Fisico',
  PAGO_FERNANDO = 'Pago Fernando',
  PRESTAMO_FERNANDO = 'Prestamo Fernando',
  DOMICILIO = 'Domicilio',
  OTROS = 'Otros',
}

export enum EstadoAprobacion {
  PENDIENTE = 'Pendiente',
  APROBADO = 'Aprobado',
  RECHAZADO = 'Rechazado',
}

export enum EstadoCorte {
  PASADO = 'PASADO',
  ACTIVO = 'ACTIVO',
  FUTURO = 'FUTURO',
}

export enum TipoObligacionMes {
  CUOTA_CARRO = 'CUOTA_CARRO',
  CUOTA_CASA = 'CUOTA_CASA',
  OTRO = 'OTRO',
}

export enum EstadoObligacionMes {
  ABIERTO = 'ABIERTO',
  COMPLETADO = 'COMPLETADO',
}

export enum MetodoAporte {
  FISICO = 'Fisico',
  BANCOLOMBIA = 'Bancolombia',
  NEQUI = 'Nequi',
  CARRERA = 'Carrera',
  USO_CARRO = 'Uso Carro',
  PRESTAMO = 'Prestamo',
  PAGO_MENSUAL = 'Pago Mensual',
  OTRO = 'Otro',
}

export enum TipoMovimientoDeuda {
  CARGO_CUOTA_TC = 'CARGO_CUOTA_TC',
  CARGO_GASTO_COMPARTIDO = 'CARGO_GASTO_COMPARTIDO',
  CARGO_PRESTAMO_DIRECTO = 'CARGO_PRESTAMO_DIRECTO',
  CARGO_CRUCE_DEUDA = 'CARGO_CRUCE_DEUDA',
  ABONO_PAGO_RECIBIDO = 'ABONO_PAGO_RECIBIDO',
  ABONO_APORTE_DIARIO = 'ABONO_APORTE_DIARIO',
  ABONO_CRUCE_DEUDA = 'ABONO_CRUCE_DEUDA',
}

export enum EstadoMovimientoDeuda {
  PROYECTADO = 'PROYECTADO',
  CONFIRMADO = 'CONFIRMADO',
  ANULADO = 'ANULADO',
}
