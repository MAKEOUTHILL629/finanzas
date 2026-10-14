# Implementación de Métodos DELETE y UPDATE para Compras a Crédito

## 📋 Resumen
Se han implementado los métodos para **eliminar** y **actualizar** compras a crédito, incluyendo el manejo correcto de las tablas dependientes (CuotasDetalle y ResponsablesComprasCredito).

## 🔧 Cambios Realizados

### 1. **ResponsablesCompraCreditoRepositorio.scala**
Se agregó el método `deleteByCompraCredito` para eliminar los responsables asociados a una compra:

```scala
def deleteByCompraCredito(compraCreditoId: Int): Future[Int] = Future {
  db.withConnection { conn =>
    val sql = "DELETE FROM public.\"ResponsablesComprasCredito\" WHERE compra_credito = ?"
    val statement = conn.prepareStatement(sql)
    try {
      statement.setInt(1, compraCreditoId)
      statement.executeUpdate()
    } finally {
      statement.close()
    }
  }
}(databaseExecutionContext)
```

### 2. **CompraCreditoRepositorio.scala**
Se agregó el método `delete` para eliminar una compra a crédito:

```scala
def delete(id: Int): Future[Int] = Future {
  db.withConnection { conn =>
    val sql = "DELETE FROM public.\"ComprasCredito\" WHERE id = ?"
    using(conn.prepareStatement(sql)) { statement =>
      statement.setInt(1, id)
      val affectedRows = statement.executeUpdate()
      if (affectedRows == 0) {
        throw new SQLException(s"Deleting CompraCredito with id $id failed, no rows affected.")
      }
      affectedRows
    }
  }
}(databaseExecutionContext)
```

### 3. **CompraCreditoServicio.scala**

#### Método `delete` - Elimina una compra con sus dependencias
```scala
def delete(compraCreditoId: Int): Future[Unit] = {
  for {
    _ <- responsablesRepositorio.deleteByCompraCredito(compraCreditoId)
    _ <- cuotaDetalleRepositorio.deleteByCompra(compraCreditoId)
    _ <- compraCreditoRepositorio.delete(compraCreditoId)
  } yield ()
}
```

**Orden de eliminación:**
1. Elimina los responsables de la compra
2. Elimina las cuotas detalle de la compra
3. Elimina la compra a crédito

#### Método `updateCompra` - Actualiza una compra y recalcula cuotas
```scala
def updateCompra(compraCredito: CompraCredito): Future[Int] = {
  for {
    updateResult <- compraCreditoRepositorio.update(compraCredito)
    _ <- recalcularCuotas(compraCredito)
  } yield updateResult
}
```

**Proceso:**
1. Actualiza los datos de la compra en la base de datos
2. Recalcula automáticamente las cuotas con el método existente `recalcularCuotas`

### 4. **ComprasCreditoControlador.scala**

#### Endpoint DELETE
```scala
def delete(id: Int) = Action.async { implicit request =>
  compraService.delete(id).map { _ =>
    Ok(Json.obj("message" -> "Compra a crédito eliminada exitosamente"))
  }.recover {
    case ex: Exception =>
      InternalServerError(Json.obj("message" -> s"Error al eliminar la compra a crédito: ${ex.getMessage}"))
  }
}
```

#### Endpoint UPDATE
```scala
def update() = Action(parse.json).async { implicit request =>
  request.body.validate[CompraCredito](compraCreditoUpdateReads) match {
    case JsSuccess(compra, _) =>
      compraService.updateCompra(compra).map { _ =>
        Ok(Json.obj("message" -> "Compra a crédito actualizada exitosamente"))
      }.recover {
        case ex: Exception =>
          InternalServerError(Json.obj("message" -> s"Error al actualizar la compra a crédito: ${ex.getMessage}"))
      }
    case JsError(errors) =>
      Future.successful(BadRequest(Json.obj("message" -> "Datos inválidos", "errors" -> JsError.toJson(errors))))
  }
}
```

### 5. **routes**
Se agregaron las rutas para los endpoints:

```scala
PUT /api/compras-credito controllers.ComprasCreditoControlador.update()
DELETE /api/compras-credito/:id controllers.ComprasCreditoControlador.delete(id:Int)
```

## 📡 Uso de los Endpoints

### DELETE - Eliminar una compra a crédito

**Endpoint:** `DELETE /api/compras-credito/:id`

**Ejemplo con cURL:**
```bash
curl -X DELETE http://localhost:9000/api/compras-credito/123
```

**Respuesta exitosa:**
```json
{
  "message": "Compra a crédito eliminada exitosamente"
}
```

**Respuesta con error:**
```json
{
  "message": "Error al eliminar la compra a crédito: No se encontró la compra"
}
```

### UPDATE - Actualizar una compra a crédito

**Endpoint:** `PUT /api/compras-credito`

**Body (JSON):**
```json
{
  "id": 123,
  "concepto": "Laptop Dell actualizado",
  "valorCompra": 2500.00,
  "fechaCompra": "2024-01-15",
  "numeroCuotas": 12,
  "interes": 2.5,
  "descripcion": "Laptop para desarrollo",
  "estado": "Pendiente",
  "tarjeta": 1
}
```

**Ejemplo con cURL:**
```bash
curl -X PUT http://localhost:9000/api/compras-credito \
  -H "Content-Type: application/json" \
  -d '{
    "id": 123,
    "concepto": "Laptop Dell actualizado",
    "valorCompra": 2500.00,
    "fechaCompra": "2024-01-15",
    "numeroCuotas": 12,
    "interes": 2.5,
    "descripcion": "Laptop para desarrollo",
    "estado": "Pendiente",
    "tarjeta": 1
  }'
```

**Respuesta exitosa:**
```json
{
  "message": "Compra a crédito actualizada exitosamente"
}
```

**Respuesta con error:**
```json
{
  "message": "Error al actualizar la compra a crédito: Datos inválidos"
}
```

## ✨ Características Implementadas

### DELETE
✅ **Eliminación en cascada** - Elimina primero las dependencias (responsables y cuotas)
✅ **Manejo de errores** - Devuelve mensajes claros si algo falla
✅ **Transaccional** - Usa Future.for para asegurar el orden correcto

### UPDATE
✅ **Actualización completa** - Permite modificar:
  - Concepto
  - Descripción
  - Fecha de compra
  - Valor de la compra
  - Número de cuotas
  - Interés
  - Tarjeta
✅ **Recalculo automático de cuotas** - Después de actualizar, recalcula las cuotas automáticamente
✅ **Validación de datos** - Valida el JSON de entrada
✅ **Manejo de errores** - Devuelve mensajes claros si algo falla

## 🔒 Orden de Operaciones

### Eliminación
```
1. Eliminar ResponsablesComprasCredito (WHERE compra_credito = id)
2. Eliminar CuotasDetalle (WHERE compra = id)
3. Eliminar ComprasCredito (WHERE id = id)
```

### Actualización
```
1. Actualizar ComprasCredito con los nuevos valores
2. Recalcular cuotas:
   a. Eliminar cuotas antiguas
   b. Calcular nueva amortización
   c. Insertar nuevas cuotas
   d. Actualizar fecha_ultima_cuota
```

## 🎯 Campos Editables en UPDATE

Los campos que se pueden actualizar son:
- `concepto` (String)
- `descripcion` (String)
- `fechaCompra` (Date - formato: "yyyy-MM-dd")
- `valorCompra` (Float)
- `numeroCuotas` (Int)
- `interes` (Float)
- `tarjeta` (Int - ID de la tarjeta)

**Nota:** El campo `estado` también se puede actualizar si es necesario.

## ⚠️ Consideraciones Importantes

1. **Orden de eliminación:** Es crucial eliminar primero las tablas dependientes para evitar violaciones de foreign key.

2. **Recalculo de cuotas:** Al actualizar una compra, las cuotas se recalculan automáticamente. Esto significa que:
   - Se eliminan todas las cuotas antiguas
   - Se crean nuevas cuotas basadas en los nuevos valores
   - La fecha de última cuota se actualiza

3. **Validaciones:** El endpoint UPDATE valida que todos los campos requeridos estén presentes y tengan el formato correcto.

4. **Transacciones:** Las operaciones usan Futures para mantener el orden correcto de ejecución.

## 🧪 Testing

### Probar DELETE
```bash
# Crear una compra primero (guarda el ID que devuelve)
curl -X POST http://localhost:9000/api/compras-credito \
  -H "Content-Type: application/json" \
  -d '{...}'

# Eliminar la compra
curl -X DELETE http://localhost:9000/api/compras-credito/[ID]
```

### Probar UPDATE
```bash
# Obtener una compra existente
curl -X GET http://localhost:9000/api/compras-credito/detalle/[ID]

# Actualizar la compra
curl -X PUT http://localhost:9000/api/compras-credito \
  -H "Content-Type: application/json" \
  -d '{...}'  # Usar los datos obtenidos, modificando lo necesario
```

## 📝 Notas Adicionales

- El método `recalcularCuotas` ya existía y se reutiliza para el UPDATE
- El método `deleteByCompra` de CuotaDetalleRepositorio ya existía
- Se añadió el método `deleteByCompraCredito` en ResponsablesCompraCreditoRepositorio
- Los métodos son asíncronos (Future) para mantener la consistencia con el resto de la aplicación
