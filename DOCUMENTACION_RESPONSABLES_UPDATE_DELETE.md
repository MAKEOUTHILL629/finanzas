# 📚 Documentación: Endpoints UPDATE y DELETE de ResponsableCompraCredito

## ✅ Implementación Completa

Se han implementado exitosamente los endpoints para **actualizar** y **eliminar** responsables de compras a crédito.

---

## ✏️ UPDATE - Actualizar Responsable de Compra a Crédito

### **Campos Editables**

Los siguientes campos se pueden actualizar:
- ✅ `persona` (Int) - ID de la persona responsable
- ✅ `porcentajePago` (Float) - Porcentaje de pago que debe asumir
- ✅ `cantidadPago` (Float) - Cantidad en dinero que debe pagar
- ✅ `cantidadCuotas` (Int) - Número de cuotas

**Nota:** El campo `compraCredito` NO se puede modificar, ya que representa la relación con la compra.

### **Endpoint**

**URL:** `PUT /api/compras-credito/responsables`

**Content-Type:** `application/json`

### **Estructura del JSON**

```json
{
  "id": 1,
  "persona": 2,
  "porcentajePago": 50.0,
  "cantidadPago": 1500.00,
  "cantidadCuotas": 12,
  "compraCredito": 5
}
```

### **Ejemplo de Uso**

```bash
curl -X PUT http://localhost:9000/api/compras-credito/responsables \
  -H "Content-Type: application/json" \
  -d '{
    "id": 1,
    "persona": 2,
    "porcentajePago": 60.0,
    "cantidadPago": 1800.00,
    "cantidadCuotas": 12,
    "compraCredito": 5
  }'
```

### **Respuestas**

**Éxito (200 OK):**
```json
{
  "message": "Responsable actualizado exitosamente"
}
```

**Error de Validación (400 Bad Request):**
```json
{
  "message": "Datos inválidos",
  "errors": { ... }
}
```

**Error en el Servidor (500 Internal Server Error):**
```json
{
  "message": "Error al actualizar el responsable: No se encontró el responsable con ID 1"
}
```

---

## 🗑️ DELETE - Eliminar Responsable de Compra a Crédito

### **Endpoint**

**URL:** `DELETE /api/compras-credito/responsables/:id`

**Parámetros:**
- `id` (Int): ID del responsable a eliminar

### **Ejemplo de Uso**

```bash
# Eliminar responsable con ID 1
curl -X DELETE http://localhost:9000/api/compras-credito/responsables/1
```

### **Respuestas**

**Éxito (200 OK):**
```json
{
  "message": "Responsable eliminado exitosamente"
}
```

**Error (500 Internal Server Error):**
```json
{
  "message": "Error al eliminar el responsable: No se encontró el responsable con ID 1"
}
```

---

## 📂 Archivos Modificados

### 1. **ResponsablesCompraCreditoRepositorio.scala**

**Métodos agregados:**

#### `update(responsable: ResponsableCompraCredito): Future[Int]`
```scala
def update(responsable: ResponsableCompraCredito): Future[Int] = Future {
  db.withConnection { conn =>
    val sql = """
      UPDATE public."ResponsablesComprasCredito"
      SET persona = ?, porcentaje_pago = ?, cantidad_pago = ?, cantidad_cuotas = ?
      WHERE id = ?
    """
    val statement = conn.prepareStatement(sql)
    try {
      statement.setInt(1, responsable.persona)
      statement.setFloat(2, responsable.porcentajePago)
      statement.setFloat(3, responsable.cantidadPago)
      statement.setInt(4, responsable.cantidadCuotas)
      statement.setInt(5, responsable.id)
      
      val affectedRows = statement.executeUpdate()
      if (affectedRows == 0) {
        throw new Exception(s"No se encontró el responsable con ID ${responsable.id}")
      }
      affectedRows
    } finally {
      statement.close()
    }
  }
}(databaseExecutionContext)
```

**Características:**
- Actualiza persona, porcentaje_pago, cantidad_pago y cantidad_cuotas
- Valida que el responsable exista antes de actualizar
- Usa PreparedStatement para prevenir SQL injection

#### `delete(id: Int): Future[Int]`
```scala
def delete(id: Int): Future[Int] = Future {
  db.withConnection { conn =>
    val sql = "DELETE FROM public.\"ResponsablesComprasCredito\" WHERE id = ?"
    val statement = conn.prepareStatement(sql)
    try {
      statement.setInt(1, id)
      val affectedRows = statement.executeUpdate()
      if (affectedRows == 0) {
        throw new Exception(s"No se encontró el responsable con ID $id")
      }
      affectedRows
    } finally {
      statement.close()
    }
  }
}(databaseExecutionContext)
```

**Características:**
- Elimina el responsable por ID
- Valida que el responsable exista antes de eliminar
- Usa PreparedStatement para prevenir SQL injection

### 2. **ResponsableCompraCreditoControlador.scala**

**Métodos agregados:**

#### `update(): Action[JsValue]`
```scala
def update() = Action(parse.json).async { implicit request =>
  request.body.validate[ResponsableCompraCredito](responsableCreditoUpdateReads) match {
    case JsSuccess(responsable, _) =>
      responsablesCompraCreditoRepositorio.update(responsable).map { _ =>
        Ok(Json.obj("message" -> "Responsable actualizado exitosamente"))
      }.recover {
        case ex: Exception =>
          InternalServerError(Json.obj("message" -> s"Error al actualizar el responsable: ${ex.getMessage}"))
      }
    case JsError(errors) =>
      Future.successful(BadRequest(Json.obj("message" -> "Datos inválidos", "errors" -> JsError.toJson(errors))))
  }
}
```

#### `delete(id: Int): Action[AnyContent]`
```scala
def delete(id: Int) = Action.async { implicit request =>
  responsablesCompraCreditoRepositorio.delete(id).map { _ =>
    Ok(Json.obj("message" -> "Responsable eliminado exitosamente"))
  }.recover {
    case ex: Exception =>
      InternalServerError(Json.obj("message" -> s"Error al eliminar el responsable: ${ex.getMessage}"))
  }
}
```

### 3. **routes**

**Rutas agregadas:**
```
PUT /api/compras-credito/responsables controllers.ResponsableCompraCreditoControlador.update()
DELETE /api/compras-credito/responsables/:id controllers.ResponsableCompraCreditoControlador.delete(id:Int)
```

---

## 🎯 Características Implementadas

### UPDATE
✅ **Validación de datos** - Verifica que el JSON sea válido  
✅ **Campos editables** - Persona, porcentaje de pago, cantidad de pago, cantidad de cuotas  
✅ **Manejo de errores** - Mensajes claros cuando algo falla  
✅ **Operaciones asíncronas** - Usa Futures para mejor rendimiento  
✅ **Seguridad** - Usa PreparedStatement para prevenir SQL injection  

### DELETE
✅ **Eliminación por ID** - Elimina un responsable específico  
✅ **Validación de existencia** - Verifica que el responsable exista antes de eliminar  
✅ **Manejo de errores** - Mensajes claros en caso de fallo  
✅ **Operaciones asíncronas** - Usa Futures para mejor rendimiento  
✅ **Seguridad** - Usa PreparedStatement para prevenir SQL injection  

---

## 🧪 Casos de Prueba

### Probar UPDATE

1. **Actualizar todos los campos:**
```bash
curl -X PUT http://localhost:9000/api/compras-credito/responsables \
  -H "Content-Type: application/json" \
  -d '{
    "id": 1,
    "persona": 3,
    "porcentajePago": 75.0,
    "cantidadPago": 2000.00,
    "cantidadCuotas": 18,
    "compraCredito": 5
  }'
```

2. **Intentar actualizar con ID inexistente:**
```bash
curl -X PUT http://localhost:9000/api/compras-credito/responsables \
  -H "Content-Type: application/json" \
  -d '{
    "id": 99999,
    "persona": 3,
    "porcentajePago": 75.0,
    "cantidadPago": 2000.00,
    "cantidadCuotas": 18,
    "compraCredito": 5
  }'
```

3. **Intentar actualizar con datos inválidos:**
```bash
curl -X PUT http://localhost:9000/api/compras-credito/responsables \
  -H "Content-Type: application/json" \
  -d '{
    "id": 1,
    "persona": "abc",
    "porcentajePago": "invalid"
  }'
```

### Probar DELETE

1. **Eliminar responsable existente:**
```bash
curl -X DELETE http://localhost:9000/api/compras-credito/responsables/1
```

2. **Intentar eliminar responsable inexistente:**
```bash
curl -X DELETE http://localhost:9000/api/compras-credito/responsables/99999
```

---

## ⚠️ Consideraciones Importantes

### Actualización
1. **Campo compraCredito** - Aunque se debe enviar en el JSON, NO se actualiza en la base de datos. Solo se usa para mantener la estructura del objeto.
2. **Validación de existencia** - Se valida que el responsable exista antes de actualizar.
3. **Todos los campos obligatorios** - Se deben enviar todos los campos en el JSON, incluso si no cambian.

### Eliminación
1. **Foreign Keys** - Si hay otras tablas que dependen de ResponsablesComprasCredito, la eliminación podría fallar por restricciones de integridad referencial.
2. **No reversible** - Una vez eliminado, no se puede recuperar (considerar soft delete si es necesario).
3. **Validación de existencia** - Se valida que el responsable exista antes de intentar eliminar.

---

## 📊 Flujo de Datos

### UPDATE
```
Cliente
  ↓
PUT /api/compras-credito/responsables + JSON
  ↓
ResponsableCompraCreditoControlador.update()
  ↓
Validar JSON
  ↓
ResponsablesCompraCreditoRepositorio.update(responsable)
  ↓
UPDATE public."ResponsablesComprasCredito"
SET persona = ?, porcentaje_pago = ?, cantidad_pago = ?, cantidad_cuotas = ?
WHERE id = ?
  ↓
Response: {"message": "Responsable actualizado exitosamente"}
```

### DELETE
```
Cliente
  ↓
DELETE /api/compras-credito/responsables/1
  ↓
ResponsableCompraCreditoControlador.delete(1)
  ↓
ResponsablesCompraCreditoRepositorio.delete(1)
  ↓
DELETE FROM public."ResponsablesComprasCredito" WHERE id = ?
  ↓
Response: {"message": "Responsable eliminado exitosamente"}
```

---

## 🔐 Seguridad

- [x] **PreparedStatement** - Se usa para prevenir SQL injection
- [ ] **Autenticación/Autorización** - Implementar antes de usar en producción
- [ ] **Validación de permisos** - Verificar que el usuario tenga permisos
- [ ] **Logs de auditoría** - Registrar quién hace cambios

---

## 📝 Notas Técnicas

1. **Prepared Statements**: Se utilizan para prevenir SQL injection en todas las operaciones
2. **Error Handling**: Los errores se capturan con `.recover` y se devuelven mensajes descriptivos
3. **Validación**: El JSON se valida automáticamente con el `Reads` implícito
4. **Future Composition**: Se usa programación asíncrona para mejor rendimiento

---

## ✨ Resumen

Has implementado exitosamente:
- ✅ Endpoint PUT para actualizar ResponsableCompraCredito
- ✅ Endpoint DELETE para eliminar ResponsableCompraCredito
- ✅ Validación de datos en UPDATE
- ✅ Validación de existencia en ambos endpoints
- ✅ Manejo de errores robusto
- ✅ Seguridad con PreparedStatement

Los endpoints están listos para ser probados y usados en tu aplicación! 🚀

---

## 📌 Endpoints Completos de ResponsableCompraCredito

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/compras-credito/:id/responsables` | Listar responsables de una compra |
| POST | `/api/compras-credito/responsables` | Crear nuevo responsable |
| **PUT** | `/api/compras-credito/responsables` | **Actualizar responsable** |
| **DELETE** | `/api/compras-credito/responsables/:id` | **Eliminar responsable** |

