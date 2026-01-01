package servicios

import org.scalatest.flatspec.AsyncFlatSpec
import org.scalatest.matchers.should.Matchers
import org.mockito.Mockito._
import org.mockito.ArgumentMatchers._

import scala.concurrent.Future
import modelo.CompraCredito
import percistencia.{CompraCreditoRepositorio, CuotaDetalleRepositorio, DatabaseExecutionContext}

import java.util.Date

class CompraCreditoServicioTest extends AsyncFlatSpec with Matchers  {

  "recalcularCuotas" should "recalculate the installments correctly" in {
    // Mock dependencies
    val compraCreditoRepositorio = mock(classOf[CompraCreditoRepositorio])
    val cuotaDetalleRepositorio = mock(classOf[CuotaDetalleRepositorio])
    val databaseExecutionContext = mock(classOf[DatabaseExecutionContext])

    // Define behavior for mocked methods
    when(cuotaDetalleRepositorio.deleteByCompra(anyInt())).thenReturn(Future.successful(10))
    when(cuotaDetalleRepositorio.saveBatch(any())).thenReturn(Future.successful(1))
    when(compraCreditoRepositorio.update(any())).thenReturn(Future.successful(1))

    // Create the service with mocked dependencies
    val servicio = new CompraCreditoServicio(compraCreditoRepositorio, cuotaDetalleRepositorio, databaseExecutionContext)

    // Create a sample CompraCredito
    val compraCredito = CompraCredito(
      id = 1,
      fechaCreacion = new Date(),
      concepto = "Compra Test",
      valorCompra = 1000.0f,
      fechaCompra = new Date(),
      numeroCuotas = 10,
      fechaUltimaCuota = new Date(),
      pagoMensual = 100.0f,
      interes = 5.0f,
      descripcion = "Test",
      estado = "Pendiente",
      tarjeta = 1234,
      responsables = ""
    )



    // Call the method under test
    servicio.recalcularCuotas(compraCredito).map { result =>

      verify(cuotaDetalleRepositorio).deleteByCompra(anyInt())
      verify(cuotaDetalleRepositorio).saveBatch(any())
      verify(compraCreditoRepositorio).update(any())
      result shouldBe 1
    }


  }

}
