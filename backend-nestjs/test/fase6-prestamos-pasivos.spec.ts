import { Decimal } from '../src/config/decimal.config';
import { resumenTrasAbono } from '../src/modules/prestamos/prestamos-pasivos.service';
import { validarComprobante } from '../src/modules/cobros/comprobante.util';

const d = (v: string) => new Decimal(v);

describe('Fase 6 — préstamo POR_PAGAR (cuñada)', () => {
  it('abonos parciales descuentan el saldo; al cubrir el total queda pagado', () => {
    const parcial = resumenTrasAbono(d('1000000'), d('400000'));
    expect(parcial.saldoPendiente.toString()).toBe('600000');
    expect(parcial.pagadoTotalmente).toBe(false);
    const total = resumenTrasAbono(d('1000000'), d('1000000'));
    expect(total.saldoPendiente.toString()).toBe('0');
    expect(total.pagadoTotalmente).toBe(true);
  });

  it('el comprobante se valida por firma real (PNG válido, texto disfrazado no)', () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('contenido')]);
    const ok = validarComprobante({ nombre: 'pago.png', tipo: 'image/png', datos: png.toString('base64') });
    expect(ok.tipo).toBe('image/png');
    expect(() => validarComprobante({ nombre: 'pago.png', tipo: 'image/png', datos: Buffer.from('no es un png').toString('base64') })).toThrow();
  });
});
