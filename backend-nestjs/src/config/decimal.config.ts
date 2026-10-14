import Decimal from 'decimal.js';

/**
 * Configuración global de decimal.js (Regla 1).
 *  - precision 20 dígitos significativos
 *  - redondeo financiero estándar ROUND_HALF_UP (equivale a BigDecimal.RoundingMode.HALF_UP de Scala)
 *
 * Este módulo tiene efecto secundario al importarse; toda utilidad financiera lo importa.
 */
Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

export { Decimal };
