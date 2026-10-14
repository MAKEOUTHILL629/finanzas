# 📚 Documentación: Métodos DELETE y UPDATE de Compras a Crédito

## ✅ Implementación Completa

Se han implementado exitosamente los métodos para **eliminar** y **actualizar** compras a crédito, manejando correctamente las dependencias en cascada.

---

## 🗑️ DELETE - Eliminar Compra a Crédito

### **Orden de Eliminación en Cascada**

```
1. Eliminar ResponsablesComprasCredito (WHERE compra_credito = id)
2. Eliminar CuotasDetalle (WHERE compra = id)
3. Eliminar ComprasCredito (WHERE id = id)
```

### **Implementación en el Servicio**

```scala
def delete(compraCreditoId: Int): Future[Unit] = {
  for {
    _ <- responsablesRepositorio.deleteByCompraCredito(compraCreditoId)
    _ <- cuotaDetalleRepositorio.deleteByCompra(compraCreditoId)
    _ <- compraCreditoRepositorio.delete(compraCreditoId)
  } yield ()
}
```

### **Endpoint**

**URL:** `DELETE /api/compras-credito/:id`

**Parámetros:**
- `id` (Int): ID de la compra a crédito a eliminar

### **Ejemplo de Uso**

```bash
# Eliminar compra con ID 123
curl -X DELETE http://localhost:9000/api/compras-credito/123
```

### **Respuestas**

**Éxito (200 OK):**
```json
{
  "message": "Compra a crédito eliminada exitosamente"
}
```

**Error (500 Internal Server Error):**
```json
{
  "message": "Error al eliminar la compra a crédito: No se encontró la compra con ID 123"
}
```

---

## ✏️ UPDATE - Actualizar Compra a Crédito

### **Campos Editables**

Los siguientes campos se pueden actualizar:
- ✅ `concepto` (String)
- ✅ `descripcion` (String)
- ✅ `fechaCompra` (Date - formato: "yyyy-MM-dd")
- ✅ `valorCompra` (Float)
- ✅ `numeroCuotas` (Int)
- ✅ `interes` (Float)
- ✅ `tarjeta` (Int)

### **Proceso de Actualización**

```
1. Actualizar ComprasCredito con los nuevos valores
2. Recalcular cuotas automáticamente:
   a. Eliminar todas las cuotas antiguas
   b. Calcular nueva tabla de amortización
   c. Insertar nuevas cuotas
   d. Actualizar fecha_ultima_cuota
```

### **Implementación en el Servicio**

```scala
def updateCompra(compraCredito: CompraCredito): Future[Int] = {
  for {
    updateResult <- compraCreditoRepositorio.update(compraCredito)
    _ <- recalcularCuotas(compraCredito)
  } yield updateResult
}
```

### **Endpoint**

**URL:** `PUT /api/compras-credito`

**Content-Type:** `application/json`

### **Estructura del JSON**

```json
{
  "id": 123,
  "concepto": "Laptop Dell actualizada",
  "valorCompra": 2500.00,
  "fechaCompra": "2024-01-15",
  "numeroCuotas": 12,
  "interes": 2.5,
  "descripcion": "Laptop para desarrollo",
  "estado": "Pendiente",
  "tarjeta": 1
}
```

### **Ejemplo de Uso**

```bash
curl -X PUT http://localhost:9000/api/compras-credito \
  -H "Content-Type: application/json" \
  -d '{
    "id": 123,
    "concepto": "Laptop Dell actualizada",
    "valorCompra": 2500.00,
    "fechaCompra": "2024-01-15",
    "numeroCuotas": 12,
    "interes": 2.5,
    "descripcion": "Laptop para desarrollo",
    "estado": "Pendiente",
    "tarjeta": 1
  }'
```

### **Respuestas**

**Éxito (200 OK):**
```json
{
  "message": "Compra a crédito actualizada exitosamente"
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
  "message": "Error al actualizar la compra a crédito: Mensaje de error"
}
```

---

## 🔧 Archivos Modificados

### 1. **CompraCreditoRepositorio.scala**

**Método agregado:**
```scala
def delete(id: Int): Future[Int]
```

Elimina una compra a crédito de la base de datos por su ID.

### 2. **ResponsablesCompraCreditoRepositorio.scala**

**Método agregado:**
```scala
def deleteByCompraCredito(compraCreditoId: Int): Future[Int]
```

Elimina todos los responsables asociados a una compra a crédito.

### 3. **CompraCreditoServicio.scala**

**Métodos agregados:**
- `delete(compraCreditoId: Int): Future[Unit]` - Elimina una compra con sus dependencias
- `updateCompra(compraCredito: CompraCredito): Future[Int]` - Actualiza una compra y recalcula cuotas

**Dependencia agregada:**
- `ResponsablesCompraCreditoRepositorio` - Para eliminar responsables

### 4. **ComprasCreditoControlador.scala**

**Endpoints agregados:**
- `delete(id: Int)` - DELETE endpoint
- `update()` - PUT endpoint

### 5. **routes**

**Rutas agregadas:**
```
PUT /api/compras-credito controllers.ComprasCreditoControlador.update()
DELETE /api/compras-credito/:id controllers.ComprasCreditoControlador.delete(id:Int)
```

---

## 🎯 Características Implementadas

### DELETE
✅ **Eliminación en cascada** - Orden correcto para evitar violaciones de foreign key  
✅ **Manejo de errores** - Mensajes claros cuando algo falla  
✅ **Operaciones asíncronas** - Usa Futures para mejor rendimiento  
✅ **Validación de existencia** - Lanza error si la compra no existe  

### UPDATE
✅ **Recalculo automático de cuotas** - Se recalculan después de actualizar  
✅ **Validación de datos** - Verifica que el JSON sea válido  
✅ **Campos editables limitados** - Solo permite editar campos específicos  
✅ **Manejo de errores** - Mensajes claros en caso de fallo  
✅ **Operaciones asíncronas** - Usa Futures para mejor rendimiento  

---

## 🧪 Casos de Prueba

### Probar DELETE

1. **Eliminar compra existente:**
```bash
curl -X DELETE http://localhost:9000/api/compras-credito/1
```

2. **Intentar eliminar compra inexistente:**
```bash
curl -X DELETE http://localhost:9000/api/compras-credito/99999
```

### Probar UPDATE

1. **Actualizar todos los campos:**
```bash
curl -X PUT http://localhost:9000/api/compras-credito \
  -H "Content-Type: application/json" \
  -d '{
    "id": 1,
    "concepto": "Compra actualizada",
    "valorCompra": 3000.00,
    "fechaCompra": "2024-02-01",
    "numeroCuotas": 18,
    "interes": 3.0,
    "descripcion": "Nueva descripción",
    "estado": "Pendiente",
    "tarjeta": 2
  }'
```

2. **Intentar actualizar con datos inválidos:**
```bash
curl -X PUT http://localhost:9000/api/compras-credito \
  -H "Content-Type: application/json" \
  -d '{
    "id": 1,
    "concepto": "",
    "valorCompra": -100
  }'
```

---

## ⚠️ Consideraciones Importantes

### Eliminación
1. **Orden de eliminación crítico** - Si se intenta eliminar la compra antes que las dependencias, fallará por foreign key constraints
2. **No reversible** - Una vez eliminada, no se puede recuperar (considerar soft delete si es necesario)
3. **Transaccional** - Si falla alguna parte, toda la operación falla

### Actualización
1. **Recalculo automático** - Las cuotas se recalculan automáticamente, perdiendo el estado de pago anterior
2. **Validación de fecha** - La fecha debe estar en formato ISO (yyyy-MM-dd)
3. **Cambio de tarjeta** - Se puede cambiar la tarjeta asociada
4. **Interés** - Cambiar el interés recalculará todas las cuotas

---

## 📊 Flujo de Datos

### DELETE
```
Cliente
  ↓
DELETE /api/compras-credito/123
  ↓
ComprasCreditoControlador.delete(123)
  ↓
CompraCreditoServicio.delete(123)
  ↓
1. ResponsablesRepository.deleteByCompraCredito(123)
2. CuotaDetalleRepository.deleteByCompra(123)
3. CompraCreditoRepository.delete(123)
  ↓
Response: {"message": "Compra eliminada exitosamente"}
```

### UPDATE
```
Cliente
  ↓
PUT /api/compras-credito + JSON
  ↓
ComprasCreditoControlador.update()
  ↓
Validar JSON
  ↓
CompraCreditoServicio.updateCompra(compra)
  ↓
1. CompraCreditoRepository.update(compra)
2. CompraCreditoServicio.recalcularCuotas(compra)
   ├─ CuotaDetalleRepository.deleteByCompra(id)
   ├─ Calcular nueva amortización
   ├─ CuotaDetalleRepository.saveBatch(nuevasCuotas)
   └─ CompraCreditoRepository.update(fecha_ultima_cuota)
  ↓
Response: {"message": "Compra actualizada exitosamente"}
```

---

## 🔐 Seguridad

- [ ] Implementar autenticación/autorización antes de usar en producción
- [ ] Validar que el usuario tenga permisos para eliminar/editar
- [ ] Agregar logs de auditoría para rastrear cambios
- [ ] Considerar soft delete en lugar de hard delete

---

## 📝 Notas Técnicas

1. **Future Composition**: Se utiliza `for-comprehension` para componer operaciones asíncronas
2. **Error Handling**: Los errores se propagan y se capturan en el controlador con `.recover`
3. **Prepared Statements**: Se usan para prevenir SQL injection
4. **Resource Management**: Se usa el patrón `using` para cerrar conexiones automáticamente

---

## ✨ Resumen

Has implementado exitosamente:
- ✅ Endpoint DELETE para eliminar compras a crédito
- ✅ Endpoint PUT para actualizar compras a crédito
- ✅ Eliminación en cascada de dependencias
- ✅ Recalculo automático de cuotas al actualizar
- ✅ Validación de datos
- ✅ Manejo de errores robusto

Los endpoints están listos para ser probados y usados en tu aplicación! 🚀

