import { Decimal } from '../src/config/decimal.config';
import { liquidarEvento } from '../src/modules/eventos-grupales/eventos-grupales.calc';
import { construirBilateral } from '../src/modules/liquidacion-mensual/bilateral.util';

const d = (v: string) => new Decimal(v);

describe('Fase 4 — cámara bilateral', () => {
  it('el saldo anterior es la fila #1 y el neto es cargos + saldo − abonos', () => {
    const camara = construirBilateral({
      saldoAnterior: d('120000'),
      items: [
        { id: 1, fecha: null, concepto: 'Codensa Luz', origen: 'RECURRENTE_PERSONA', signo: 1, monto: d('80000'), detalle: { porcentaje: d('50'), valorCompra: d('160000') } },
        { id: 2, fecha: null, concepto: 'Abono intra-mes', origen: 'PAGO_RECIBIDO', signo: -1, monto: d('50000') },
      ],
    });
    expect(camara.columnaContraparte[0]).toMatchObject({ concepto: 'Saldo Anterior', montoImputado: d('120000') });
    expect(camara.columnaContraparte[1]).toMatchObject({ reglaDivision: '50_50' });
    expect(camara.netoAEnviar.toString()).toBe('150000');
    expect(camara.direccionNeto).toBe('CONTRAPARTE_ENVIA_A_USUARIO');
  });

  it('saldo anterior a favor va a la columna del usuario', () => {
    const camara = construirBilateral({ saldoAnterior: d('-30000'), items: [] });
    expect(camara.columnaUsuario[0].concepto).toBe('Saldo Anterior');
    expect(camara.netoAEnviar.toString()).toBe('-30000');
  });
});

describe('Fase 4 — evento grupal multilateral (caso Viajes)', () => {
  it('3 participantes y $567.000 a partes iguales → $189.000 por persona y cruce neto', () => {
    const participantes = [
      { participanteId: 1, personaId: 11, alias: 'Julian/Felipe', peso: d('1') },
      { participanteId: 2, personaId: 12, alias: 'Maleja', peso: d('1') },
      { participanteId: 3, personaId: 13, alias: 'Pacho', peso: d('1') },
    ];
    const resultado = liquidarEvento(participantes, [
      { descripcion: 'Viaje Ida', montoTotal: d('300000'), pagadoPorParticipanteId: 1, tipoDivision: 'PARTES_IGUALES' },
      { descripcion: 'Cover + Ron', montoTotal: d('267000'), pagadoPorParticipanteId: 2, tipoDivision: 'PARTES_IGUALES' },
    ]);
    expect(resultado.totalEvento.toString()).toBe('567000');
    for (const b of resultado.balances) expect(b.leToca.toString()).toBe('189000');
    // Julian/Felipe puso 300k (le sobran 111k), Maleja puso 267k (le sobran 78k), Pacho no puso nada (debe 189k).
    expect(resultado.balances.find((b) => b.personaId === 13)?.balance.toString()).toBe('-189000');
    const totalTransferido = resultado.transferencias.reduce((a, t) => a.plus(t.monto), new Decimal(0));
    expect(totalTransferido.toString()).toBe('189000');
    expect(resultado.transferencias.every((t) => t.desdePersonaId === 13)).toBe(true);
  });

  it('pesos/cupos: una pareja que cuenta como 2 paga el doble', () => {
    const participantes = [
      { participanteId: 1, personaId: 11, alias: 'Pareja', peso: d('2') },
      { participanteId: 2, personaId: 12, alias: 'Solo', peso: d('1') },
    ];
    const resultado = liquidarEvento(participantes, [{ descripcion: 'Casa', montoTotal: d('300000'), pagadoPorParticipanteId: 2, tipoDivision: 'PESOS_CUPOS' }]);
    expect(resultado.balances.find((b) => b.personaId === 11)?.leToca.toString()).toBe('200000');
    expect(resultado.balances.find((b) => b.personaId === 12)?.leToca.toString()).toBe('100000');
  });
});
