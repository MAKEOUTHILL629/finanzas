package controllers.filters


import javax.inject.Inject
import play.api.http.HttpFilters
import play.api.mvc.EssentialFilter
// Importa tu filtro:

// Puedes añadir otros filtros aquí si los tienes (ej. CORS, Gzip, SecurityHeaders)
// import play.filters.cors.CORSFilter
// import play.filters.gzip.GzipFilter

class Filters @Inject() (
                          // Inyecta tu filtro JWT:
                          jwtFilter: JwtFilter
                          // Inyecta otros filtros si los usas:
                          // corsFilter: CORSFilter,
                          // gzipFilter: GzipFilter
                        ) extends HttpFilters {

  // Define el orden en que se aplicarán los filtros
  override val filters: Seq[EssentialFilter] = Seq(
    // corsFilter, // CORS suele ir primero
    // gzipFilter,
    jwtFilter    // Tu filtro JWT
    // ... otros filtros
  )
}