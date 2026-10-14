import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNumber } from 'class-validator';

/** `POST /api/compras-credito/responsables` */
export class CreateResponsableDto {
  @ApiProperty({ example: 2, description: 'ID de la persona responsable' })
  @IsInt()
  persona: number;

  @ApiProperty({ example: 50, description: 'Porcentaje que asume (0-100)' })
  @IsNumber()
  porcentajePago: number | string;

  @ApiProperty({ example: 42500 })
  @IsNumber()
  cantidadPago: number | string;

  @ApiProperty({ example: 36 })
  @IsInt()
  cantidadCuotas: number;

  @ApiProperty({ example: 1 })
  @IsInt()
  compraCredito: number;
}

/** `PUT /api/compras-credito/responsables` (compraCredito se exige pero NO se modifica, como en el legacy). */
export class UpdateResponsableDto extends CreateResponsableDto {
  @ApiProperty({ example: 3 })
  @IsInt()
  id: number;
}
