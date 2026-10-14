# Endpoint de Carga Masiva de Compras a Crédito

## 📋 Descripción
Endpoint que permite cargar múltiples compras a crédito mediante un archivo CSV. El sistema procesa cada registro, crea las compras en la base de datos y devuelve un CSV con los resultados.

## 🔗 Endpoint
```
POST /api/compras-credito/upload-csv
```

## 📤 Parámetros
- **file**: Archivo CSV con las compras (multipart/form-data)

## 📊 Formato del CSV

### Columnas Requeridas
| Columna | Tipo | Obligatorio | Descripción |
|---------|------|-------------|-------------|
| Fecha Compra | Fecha | No* | Fecha de la compra. Si está vacía o inválida, usa fecha actual |
| Concepto | String | Sí | Descripción de la compra |
| Valor | Number | Sí | Valor total de la compra |
| Cuotas | Integer | Sí | Número de cuotas |
| Tarjeta | String/Int | Sí | ID de tarjeta o nombre de franquicia |
| Interes | Number | Sí | Tasa de interés |
| descripcion | String | No | Descripción adicional |
| estado | String | No | Estado de la compra (default: "Pendiente") |

### 🌍 Soporte Multiidioma

El endpoint detecta automáticamente:

#### 1. **Delimitadores**
- `,` (coma) - Formato internacional
- `;` (punto y coma) - Formato europeo

#### 2. **Decimales**
- `.` (punto) - Formato internacional: `1500.50`
- `,` (coma) - Formato europeo: `1500,50`

#### 3. **Formatos de Fecha**
El sistema soporta múltiples formatos automáticamente:
- `yyyy-MM-dd` → `2025-04-05`
- `dd/MM/yyyy` → `05/04/2025`
- `dd-MM-yyyy` → `05-04-2025`
- `dd,MM,yyyy` → `05,04,2025`
- `yyyy/MM/dd` → `2025/04/05`
- `dd.MM.yyyy` → `05.04.2025`

#### 4. **Encabezados**
- Insensible a mayúsculas/minúsculas
- Respuesta con encabezados capitalizados
- Soporta variaciones de nombres:
  - Fecha Compra / FechaCompra / Fecha / Date
  - Concepto / Descripcion / Description
  - Valor / Monto / Amount / Value
  - etc.

## 📥 Ejemplos de CSV

### Ejemplo 1: Formato Internacional (separado por comas)
```csv
Fecha Compra,Concepto,Valor,Cuotas,Tarjeta,Interes,descripcion,estado
2024-01-15,Computador portátil,1500000,12,1,2.5,Compra de equipo de trabajo,Pendiente
2024-02-20,Celular Samsung,800000,6,Visa,3.0,Teléfono móvil,
,Televisor LG,2000000,18,2,2.8,TV 55 pulgadas,Pendiente
```

### Ejemplo 2: Formato Europeo (separado por punto y coma, decimales con coma)
```csv
Fecha Compra;Concepto;Valor;Cuotas;Tarjeta;Interes;descripcion;estado
15,01,2025;Computador portátil;1500000,50;12;1;2,5;Compra de equipo de trabajo;Pendiente
20-02-2025;Celular Samsung;800000,00;6;Visa;3,0;Teléfono móvil;
;Televisor LG;2000000,75;18;2;2,8;TV 55 pulgadas;Pendiente
```

### Ejemplo 3: Formato Mixto (encabezados en minúsculas, varios formatos de fecha)
```csv
fecha compra,concepto,valor,cuotas,tarjeta,interes,descripcion,estado
15/01/2025,Laptop Dell,2500.50,12,1,2.5,Computadora para trabajo,pendiente
20,02,2025,iPhone 15,1200.00,6,Visa,3.0,Teléfono móvil,
10-03-2025,Lavadora LG,1800.25,10,MasterCard,3.5,,
```

## 📤 Respuesta

El endpoint devuelve un archivo CSV con las mismas columnas del archivo original más una columna adicional **"Resultado"** que indica:

- `Éxito: Compra creada con ID {id}` - Compra creada exitosamente
- `Error: {mensaje}` - Error al procesar la compra

### Ejemplo de Respuesta
```csv
Fecha Compra,Concepto,Valor,Cuotas,Tarjeta,Interes,Descripcion,Estado,Resultado
2024-01-15,Computador portátil,1500000,12,1,2.5,Compra de equipo de trabajo,Pendiente,Éxito: Compra creada con ID 123
2024-02-20,Celular Samsung,800000,6,Visa,3.0,Teléfono móvil,,Éxito: Compra creada con ID 124
,Televisor LG,2000000,18,999,2.8,TV 55 pulgadas,Pendiente,Error: Tarjeta '999' no encontrada
```

## 🔍 Validaciones

El sistema valida automáticamente:
- ✅ Concepto no puede estar vacío
- ✅ Valor debe ser numérico y mayor a 0
- ✅ Cuotas debe ser numérico y mayor a 0
- ✅ Tarjeta debe existir (busca por ID o nombre de franquicia)
- ✅ Interés debe ser numérico
- ✅ Fecha debe tener formato válido (o se usa fecha actual)

## 🚀 Uso con cURL

```bash
# Subir archivo CSV
curl -X POST http://localhost:9000/api/compras-credito/upload-csv \
  -F "file=@compras.csv" \
  -o resultado_compras.csv

# El archivo resultado_compras.csv contendrá el resultado de cada operación
```

## 🔧 Uso con Postman

1. Método: `POST`
2. URL: `http://localhost:9000/api/compras-credito/upload-csv`
3. Body:
   - Seleccionar `form-data`
   - Key: `file` (tipo: File)
   - Value: Seleccionar el archivo CSV
4. Enviar
5. Guardar la respuesta como archivo CSV

## ⚡ Características Principales

- ✅ **Detección automática de delimitador** (coma o punto y coma)
- ✅ **Soporte para decimales con punto o coma**
- ✅ **Múltiples formatos de fecha soportados**
- ✅ **Encabezados insensibles a mayúsculas/minúsculas**
- ✅ **Respuesta con encabezados capitalizados**
- ✅ **Búsqueda de tarjetas por ID o franquicia**
- ✅ **Validaciones detalladas con mensajes de error específicos**
- ✅ **Procesamiento asíncrono para mejor rendimiento**
- ✅ **Reutiliza la lógica existente de creación de compras**

## 📝 Notas Importantes

1. **Tarjetas**: Se pueden especificar por ID numérico o por nombre de franquicia (ej: "Visa", "MasterCard")
2. **Fecha vacía**: Si el campo Fecha Compra está vacío, se usa la fecha actual
3. **Formato de respuesta**: La respuesta mantiene el mismo delimitador del archivo original
4. **Encoding**: El sistema usa UTF-8 para soportar caracteres especiales
5. **Estados**: Si no se especifica, el estado por defecto es "Pendiente"

## 🐛 Manejo de Errores

Si hay errores en algunas filas, el sistema:
- Continúa procesando las demás filas
- Marca cada fila con "Éxito" o "Error"
- Devuelve el CSV completo con los resultados
- Las filas exitosas sí se crean en la base de datos

## 📂 Archivos de Ejemplo

El proyecto incluye varios archivos CSV de ejemplo:
- `ejemplo_compras.csv` - Formato internacional estándar
- `ejemplo_compras_europeo.csv` - Formato europeo con punto y coma y decimales con coma
- `ejemplo_compras_minusculas.csv` - Encabezados en minúsculas y varios formatos de fecha
- `ejemplo_compras_mayusculas.csv` - Encabezados en mayúsculas y formato europeo

