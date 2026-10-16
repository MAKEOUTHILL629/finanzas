import { HttpException, Injectable } from '@nestjs/common';
import { Tarjetas } from '@prisma/client';
import { errorMessage } from '../../common/utils/legacy-http.util';
import { PrismaService } from '../../prisma/prisma.service';
import { ComprasCreditoService } from './compras-credito.service';
import {
  getColumnValue,
  parseCsv,
  parseDecimalCsv,
  parseFechaCsv,
  parseIntCsv,
  serializeResultCsv,
} from './csv.util';

/** Mensaje legible de una excepción (incluye las HttpException con cuerpo `{message}`/`{errors}`). */
function describe(error: unknown): string {
  if (error instanceof HttpException) {
    const body = error.getResponse();
    if (typeof body === 'string') return body;
    const { message, errors } = body as { message?: string; errors?: Record<string, string[]> };
    const detail = errors ? Object.values(errors).flat().join('; ') : '';
    return [message, detail].filter(Boolean).join(': ');
  }
  return errorMessage(error);
}

@Injectable()
export class ComprasCreditoCsvService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly compras: ComprasCreditoService,
  ) {}

  /**
   * Procesa el CSV fila por fila (las filas válidas se crean aunque otras fallen) y devuelve el mismo CSV con la
   * columna `Resultado` ("Éxito: Compra creada con ID n" / "Error: ...").
   */
  async procesar(contenido: string, ownerUserId: bigint): Promise<{ csv: string; exitosos: number; errores: number }> {
    const { delimiter, headers, records } = parseCsv(contenido);

    const rows: Array<{ values: string[]; resultado: string }> = [];
    for (const record of records) {
      rows.push({ values: record, resultado: await this.procesarFila(headers, record, ownerUserId) });
    }

    return {
      csv: serializeResultCsv(headers, rows, delimiter),
      exitosos: rows.filter((r) => r.resultado.startsWith('Éxito')).length,
      errores: rows.filter((r) => r.resultado.startsWith('Error')).length,
    };
  }

  private async procesarFila(headers: string[], record: string[], ownerUserId: bigint): Promise<string> {
    const col = (...names: string[]) => getColumnValue(headers, record, names);

    const fechaCompraStr = col('Fecha Compra', 'FechaCompra', 'Fecha', 'Date');
    const concepto = col('Concepto', 'Descripcion', 'Description');
    const valorStr = col('Valor', 'Monto', 'Amount', 'Value');
    const cuotasStr = col('Cuotas', 'Installments', 'Numero Cuotas');
    const tarjetaStr = col('Tarjeta', 'Card', 'Tarjeta ID');
    const interesStr = col('Interes', 'Interés', 'Interest', 'Tasa');
    const descripcionStr = col('descripcion', 'Descripción', 'Detalle', 'Detail');
    const estadoStr = col('estado', 'Estado', 'Status');

    // Mismas validaciones y mensajes, en el mismo orden, que el controlador Scala.
    if (!concepto) return 'Error: Concepto es obligatorio';

    const valor = parseDecimalCsv(valorStr);
    if (!valor) return `Error: Valor inválido '${valorStr}'`;
    if (!valor.greaterThan(0)) return 'Error: Valor debe ser mayor a 0';

    const cuotas = parseIntCsv(cuotasStr);
    if (cuotas === null) return `Error: Cuotas inválido '${cuotasStr}'`;
    if (cuotas <= 0) return 'Error: Cuotas debe ser mayor a 0';

    if (!tarjetaStr) return 'Error: Tarjeta es obligatoria';

    const interes = parseDecimalCsv(interesStr);
    if (!interes) return `Error: Interés inválido '${interesStr}'`;

    const fechaCompra = parseFechaCsv(fechaCompraStr);

    const tarjeta = await this.buscarTarjeta(tarjetaStr, ownerUserId);
    if (!tarjeta) return `Error: Tarjeta '${tarjetaStr}' no encontrada`;

    try {
      const id = await this.compras.save(
        {
          concepto,
          valorCompra: valor.toString(),
          fechaCompra,
          numeroCuotas: cuotas,
          interes: interes.toString(),
          descripcion: descripcionStr,
          estado: estadoStr || 'Pendiente',
          tarjeta: tarjeta.id,
        },
        ownerUserId,
      );
      return `Éxito: Compra creada con ID ${id}`;
    } catch (error) {
      return `Error: ${describe(error)}`;
    }
  }

  /** `findByIdOrFranquicia`: por id numérico o por franquicia (case-insensitive), limitado a las tarjetas del usuario. */
  private buscarTarjeta(identificador: string, ownerUserId: bigint): Promise<Tarjetas | null> {
    const esId = /^\d+$/.test(identificador);
    return this.prisma.tarjetas.findFirst({
      where: {
        owner_user_id: ownerUserId,
        tipo_tarjeta: 'CREDITO',
        OR: [
          ...(esId ? [{ id: BigInt(identificador) }] : []),
          { franquicia: { equals: identificador, mode: 'insensitive' as const } },
        ],
      },
      orderBy: { id: 'asc' },
    });
  }
}
