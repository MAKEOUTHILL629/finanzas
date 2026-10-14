import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** Marca una ruta/controlador como pública (equivale a `excludedPaths` de `JwtFilter.scala`). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
