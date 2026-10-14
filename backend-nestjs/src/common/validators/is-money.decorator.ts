import { registerDecorator, ValidationArguments, ValidationOptions } from 'class-validator';
import { Decimal } from '../../config/decimal.config';

export interface IsMoneyOptions {
  /** Máximo de decimales permitidos (default 2). */
  maxDecimals?: number;
  /** true = debe ser > 0. */
  positive?: boolean;
  /** true = admite 0 (con `positive` falso). */
  allowNegative?: boolean;
}

/** ¿Es un valor monetario válido? Acepta `number` finito o string decimal ("1500.50", "-3"). */
export function isMoneyValue(value: unknown, options: IsMoneyOptions = {}): boolean {
  const { maxDecimals = 2, positive = false, allowNegative = false } = options;
  let texto: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return false;
    texto = String(value);
  } else if (typeof value === 'string') {
    texto = value.trim();
    if (!/^-?\d+(\.\d+)?$/.test(texto)) return false;
  } else {
    return false;
  }
  let d: Decimal;
  try {
    d = new Decimal(texto);
  } catch {
    return false;
  }
  if (d.decimalPlaces() > maxDecimals) return false;
  if (positive && !d.greaterThan(0)) return false;
  if (!allowNegative && d.isNegative()) return false;
  return true;
}

/**
 * Valida montos que pueden llegar como `number` o como `string` decimal (preferible: sin pérdida de precisión).
 * El valor se convierte después a `Decimal` con `toDecimal`; nunca se opera como `number`.
 */
export function IsMoney(options: IsMoneyOptions = {}, validationOptions?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: 'isMoney',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [options],
      validator: {
        validate: (value: unknown) => isMoneyValue(value, options),
        defaultMessage: (args: ValidationArguments) => {
          const { maxDecimals = 2, positive } = options;
          return `${args.property} debe ser un monto numérico${positive ? ' mayor a 0' : ''} con máximo ${maxDecimals} decimales (número o texto)`;
        },
      },
    });
  };
}
