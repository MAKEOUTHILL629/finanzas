#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Auditoría y vínculo de los refinanciamientos HISTÓRICOS (plan V2, fase 5).
 *
 * Antes de la fase 5, cuando el banco unificaba la deuda de una tarjeta el usuario lo registraba a mano: las compras pendientes
 * quedaban en estado «Ajuste Interes» y se creaba una compra «Ajuste de Interes …» (12 cuotas) por el saldo, sin ningún vínculo entre
 * ellas. Este script propone ese vínculo:
 *
 *   • «maestra»: compra cuyo concepto contiene «Ajuste de Interes» y tiene 2+ cuotas;
 *   • «absorbida»: compra de la MISMA tarjeta en estado «Ajuste Interes» (y que no es una maestra) con fecha de compra anterior o igual
 *     a la de la maestra, asignada a la PRIMERA maestra de esa tarjeta que llegó después de comprarla (la primera unificación se la
 *     llevó: una compra absorbida ya no está pendiente para la siguiente).
 *
 * Con `--aplicar` escribe SOLO las columnas nuevas de sql/009 (`es_refinanciamiento` en la maestra; `refinanciamiento_id` y
 * `saldo_refinanciado` en cada absorbida). NO cambia estados ni cuotas ni sistema de amortización: la deuda y lo que debe cada
 * persona siguen calculándose exactamente como hasta hoy (por eso estos refinanciamientos no se pueden «deshacer» desde la app).
 *
 *   node scripts/vincular-refinanciamientos-historicos.js                 # informe (transacción con ROLLBACK)
 *   node scripts/vincular-refinanciamientos-historicos.js --aplicar       # escribe el vínculo (COMMIT)
 *   node scripts/vincular-refinanciamientos-historicos.js --database-url=postgresql://…   # base explícita
 *
 * Idempotente: lo que ya está vinculado no se vuelve a tocar. Reversa: `UPDATE "ComprasCredito" SET refinanciamiento_id = NULL,
 * saldo_refinanciado = NULL, es_refinanciamiento = false WHERE sistema_amortizacion = 'CAPITAL_FIJO' AND (es_refinanciamiento OR refinanciamiento_id IS NOT NULL)`.
 */
const { Client } = require('pg');
const { configCliente, resolverConexion } = require('./conexion-bd');

const SQL_MAESTRAS = `
  SELECT cc.id, cc.tarjeta, cc.concepto, cc.fecha_compra::date AS fecha, cc.valor_compra, cc.numero_cuotas
  FROM "ComprasCredito" cc
  WHERE cc.concepto ILIKE '%ajuste de interes%' AND COALESCE(cc.numero_cuotas, 0) >= 2
    AND cc.tarjeta IS NOT NULL AND cc.sistema_amortizacion = 'CAPITAL_FIJO'
  ORDER BY cc.tarjeta, cc.fecha_compra, cc.id`;

const SQL_ABSORBIDAS = `
  SELECT cc.id, cc.tarjeta, cc.concepto, cc.fecha_compra::date AS fecha, cc.valor_compra, cc.refinanciamiento_id,
         COALESCE((SELECT SUM(cd.aporte_capital) FROM "CuotasDetalle" cd WHERE cd.compra = cc.id AND cd.estado = 'Ajuste Interes'), 0) AS saldo
  FROM "ComprasCredito" cc
  WHERE cc.estado = 'Ajuste Interes' AND cc.concepto NOT ILIKE '%ajuste de interes%' AND cc.tarjeta IS NOT NULL
  ORDER BY cc.tarjeta, cc.fecha_compra, cc.id`;

const moneda = (n) => `$${Math.round(Number(n)).toLocaleString('es-CO')}`;
const dia = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

async function main() {
  const aplicar = process.argv.includes('--aplicar');
  const client = new Client(configCliente(resolverConexion()));
  await client.connect();
  try {
    const ok = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'ComprasCredito' AND column_name = 'refinanciamiento_id'`);
    if (ok.rowCount === 0) throw new Error('Falta aplicar sql/009 (node scripts/aplicar-sql.js)');

    await client.query('BEGIN');
    const maestras = (await client.query(SQL_MAESTRAS)).rows;
    const absorbidas = (await client.query(SQL_ABSORBIDAS)).rows;

    const porTarjeta = new Map();
    for (const m of maestras) porTarjeta.set(String(m.tarjeta), [...(porTarjeta.get(String(m.tarjeta)) ?? []), m]);

    const grupos = new Map(maestras.map((m) => [String(m.id), { maestra: m, absorbidas: [] }]));
    const sinMaestra = [];
    for (const a of absorbidas) {
      const candidatas = (porTarjeta.get(String(a.tarjeta)) ?? []).filter((m) => m.fecha >= a.fecha);
      const elegida = candidatas.sort((x, y) => x.fecha - y.fecha || Number(x.id) - Number(y.id))[0];
      if (elegida) grupos.get(String(elegida.id)).absorbidas.push(a);
      else sinMaestra.push(a);
    }

    console.log(`\nMaestras («Ajuste de Interes», 2+ cuotas): ${maestras.length} · compras en estado «Ajuste Interes»: ${absorbidas.length}\n`);
    let aVincular = 0;
    let yaVinculadas = 0;
    for (const { maestra, absorbidas: lista } of grupos.values()) {
      const saldo = lista.reduce((acc, a) => acc + Number(a.saldo), 0);
      const nuevas = lista.filter((a) => a.refinanciamiento_id === null);
      yaVinculadas += lista.length - nuevas.length;
      aVincular += nuevas.length;
      console.log(`#${maestra.id} «${String(maestra.concepto).trim()}» · tarjeta ${maestra.tarjeta} · ${dia(maestra.fecha)} · ${maestra.numero_cuotas} cuotas · ${moneda(maestra.valor_compra)}`);
      console.log(`   unifica ${lista.length} compra${lista.length === 1 ? '' : 's'} (${nuevas.length} por vincular) · capital marcado «Ajuste Interes»: ${moneda(saldo)}`);
      for (const a of lista.slice(0, 4)) console.log(`     - #${a.id} ${String(a.concepto).trim()} (${dia(a.fecha)}, ${moneda(a.valor_compra)})`);
      if (lista.length > 4) console.log(`     … y ${lista.length - 4} más`);
      if (aplicar) {
        await client.query(`UPDATE "ComprasCredito" SET es_refinanciamiento = true WHERE id = $1 AND NOT es_refinanciamiento`, [maestra.id]);
        for (const a of nuevas) {
          await client.query(`UPDATE "ComprasCredito" SET refinanciamiento_id = $1, saldo_refinanciado = $2 WHERE id = $3 AND refinanciamiento_id IS NULL`, [maestra.id, a.saldo, a.id]);
        }
      }
    }
    if (sinMaestra.length > 0) {
      console.log(`\nEn «Ajuste Interes» pero sin una maestra posterior en su tarjeta (no se vinculan): ${sinMaestra.length}`);
      for (const a of sinMaestra.slice(0, 6)) console.log(`   - #${a.id} ${String(a.concepto).trim()} · tarjeta ${a.tarjeta} · ${dia(a.fecha)}`);
    }
    console.log(`\nPor vincular: ${aVincular} · ya vinculadas: ${yaVinculadas} · sin maestra: ${sinMaestra.length}`);

    if (aplicar) {
      await client.query('COMMIT');
      console.log('COMMIT ejecutado: vínculo guardado (estados, cuotas y deudas NO cambian).');
    } else {
      await client.query('ROLLBACK');
      console.log('INFORME: ROLLBACK ejecutado, no se guardó nada. Usa --aplicar para vincular.');
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error('FALLÓ:', e.message);
  process.exit(1);
});
