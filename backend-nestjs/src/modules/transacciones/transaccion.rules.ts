import { TipoTransaccion } from '../../common/enums/finance.enums';

export interface ReferenciasTransaccion {
  tipoTransaccion: TipoTransaccion;
  cuentaOrigenId?: number | bigint | null;
  cuentaDestinoId?: number | bigint | null;
  tarjetaPagadaId?: number | bigint | null;
}

const REQUIEREN_ORIGEN: TipoTransaccion[] = [
  TipoTransaccion.EGRESO,
  TipoTransaccion.PAGO_TARJETA,
  TipoTransaccion.PAGO_PRESTAMO,
];
const REQUIEREN_DESTINO: TipoTransaccion[] = [TipoTransaccion.INGRESO, TipoTransaccion.REEMBOLSO_TERCERO];

const presente = (v: number | bigint | null | undefined) => v !== null && v !== undefined;

/**
 * Reglas de negocio del libro diario (Dominio 3). Devuelve la lista de errores (vacía = válida).
 *
 *  • EGRESO / PAGO_TARJETA / PAGO_PRESTAMO → `cuenta_origen_id` obligatoria y sin cuenta destino.
 *  • INGRESO / REEMBOLSO_TERCERO           → `cuenta_destino_id` obligatoria y sin cuenta origen.
 *  • TRANSFERENCIA                          → ambas obligatorias y distintas (una sola fila afecta ambos saldos: Trigger 2).
 *  • PAGO_TARJETA                           → `tarjeta_pagada_id` obligatoria.
 *
 * Se rechazan las cuentas "sobrantes" porque el Trigger 2 las afectaría: p. ej. un INGRESO con cuenta origen
 * descontaría ese saldo.
 */
export function validarReglasTransaccion(refs: ReferenciasTransaccion): string[] {
  const errores: string[] = [];
  const { tipoTransaccion: tipo } = refs;
  const origen = presente(refs.cuentaOrigenId);
  const destino = presente(refs.cuentaDestinoId);

  if (REQUIEREN_ORIGEN.includes(tipo)) {
    if (!origen) errores.push(`cuentaOrigenId es obligatoria para ${tipo}`);
    if (destino) errores.push(`cuentaDestinoId no aplica para ${tipo}`);
  } else if (REQUIEREN_DESTINO.includes(tipo)) {
    if (!destino) errores.push(`cuentaDestinoId es obligatoria para ${tipo}`);
    if (origen) errores.push(`cuentaOrigenId no aplica para ${tipo}`);
  } else if (tipo === TipoTransaccion.TRANSFERENCIA) {
    if (!origen) errores.push('cuentaOrigenId es obligatoria para TRANSFERENCIA');
    if (!destino) errores.push('cuentaDestinoId es obligatoria para TRANSFERENCIA');
    if (origen && destino && BigInt(refs.cuentaOrigenId as number | bigint) === BigInt(refs.cuentaDestinoId as number | bigint)) {
      errores.push('cuentaOrigenId y cuentaDestinoId deben ser distintas en una TRANSFERENCIA');
    }
  }

  if (tipo === TipoTransaccion.PAGO_TARJETA && !presente(refs.tarjetaPagadaId)) {
    errores.push('tarjetaPagadaId es obligatoria para PAGO_TARJETA');
  }
  return errores;
}
