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
  // Métodos canónicos de la especificación de aportes del carro
  EFECTIVO = 'EFECTIVO',
  TRANSFERENCIA = 'TRANSFERENCIA',
  CRUCE_CUENTAS = 'CRUCE_CUENTAS',
  SALDO_A_FAVOR = 'SALDO_A_FAVOR',
  // Valores heredados de AppSheet (560 aportes migrados); se siguen aceptando y mostrando
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
  /** Cargo mensual recurrente a una persona (`CargosRecurrentesPersona`, naturaleza CARGO_A_COBRAR). */
  CARGO_RECURRENTE_PERSONA = 'CARGO_RECURRENTE_PERSONA',
  /** Valor a favor / descuento mensual recurrente (naturaleza ABONO_A_FAVOR). */
  ABONO_RECURRENTE_PERSONA = 'ABONO_RECURRENTE_PERSONA',
  /** Saldo a favor de la cuota del carro aplicado al estado de cuenta de fin de mes. */
  ABONO_SALDO_FAVOR_CARRO = 'ABONO_SALDO_FAVOR_CARRO',
}

export enum EstadoMovimientoDeuda {
  PROYECTADO = 'PROYECTADO',
  CONFIRMADO = 'CONFIRMADO',
  ANULADO = 'ANULADO',
}

export enum EstadoPeriodoAporte {
  PENDIENTE = 'PENDIENTE',
  PARCIAL = 'PARCIAL',
  COMPLETADO = 'COMPLETADO',
  CON_SALDO_A_FAVOR = 'CON_SALDO_A_FAVOR',
}

export enum DestinoExcedente {
  SIGUIENTE_MES = 'SIGUIENTE_MES',
  ESTADO_CUENTA = 'ESTADO_CUENTA',
}

export enum NaturalezaRecurrentePersona {
  CARGO_A_COBRAR = 'CARGO_A_COBRAR',
  ABONO_A_FAVOR = 'ABONO_A_FAVOR',
}

export enum ModalidadDuracion {
  INDEFINIDO = 'INDEFINIDO',
  PLAZO_FIJO = 'PLAZO_FIJO',
}

export enum EstadoCargoRecurrentePersona {
  ACTIVO = 'ACTIVO',
  FINALIZADO = 'FINALIZADO',
}
