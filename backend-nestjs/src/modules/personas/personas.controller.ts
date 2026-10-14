import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PersonasService } from './personas.service';

@ApiTags('Personas')
@ApiBearerAuth()
@Controller('api/personas')
export class PersonasController {
  constructor(private readonly personas: PersonasService) {}

  @Get()
  list(@CurrentUser('userId') userId: bigint) {
    return this.personas.listLegacy(userId);
  }
}
