import { Router } from 'express'
import { coalesceRowsToArray, toTransaction } from '../lib/helpers'
import { RunQuery } from '../lib/connectionPool'
import { DEFAULT_SYSTEM_SCHEMAS } from '../lib/constants'
import { Tables } from '../lib/interfaces'
import sqlTemplates = require('../lib/sql')

/**
 * @param {string} [include_system_schemas=false] - Return system schemas as well as user schemas
 */
interface QueryParams {
  include_system_schemas?: string
}

const router = Router()

router.get('/', async (req, res) => {
  try {
    const sql = getTablesSql(sqlTemplates)
    const { data } = await RunQuery(req.headers.pg, sql)
    const query: QueryParams = req.query
    const include_system_schemas = query?.include_system_schemas === 'true'
    let payload: Tables.Table[] = data
    if (!include_system_schemas) payload = removeSystemSchemas(data)
    return res.status(200).json(payload)
  } catch (error) {
    console.log('throwing error', error)
    res.status(500).json({ error: 'Database error', status: 500 })
  }
})

router.get('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id)

    const sql = selectSingleSql(sqlTemplates, id)
    const table = (await RunQuery(req.headers.pg, sql)).data[0]
    if (typeof table === 'undefined') {
      return res.status(404).json({ error: `No table exists with ID ${id}.` })
    }

    return res.status(200).json(table)
  } catch (error) {
    console.log('throwing error', error)
    res.status(500).json({ error: 'Database error', status: 500 })
  }
})

router.post('/', async (req, res) => {
  try {
    const pcConnection: string = req.headers.pg.toString()
    const { schema = 'public', name } = req.body

    // Create the table
    const createTableSql = createTableSqlize(req.body)
    const alterSql = alterTableSql(req.body)
    const transaction = toTransaction([createTableSql, alterSql])
    await RunQuery(pcConnection, transaction)

    // Return fresh details
    const getTable = selectSingleByName(sqlTemplates, schema, name)
    const { data: newTableResults } = await RunQuery(pcConnection, getTable)
    let newTable: Tables.Table = newTableResults[0]
    return res.status(200).json(newTable)
  } catch (error) {
    // For this one, we always want to give back the error to the customer
    console.log('Soft error!', error)
    res.status(200).json([{ error: error.toString() }])
  }
})

router.patch('/:id', async (req, res) => {
  try {
    const pcConnection: string = req.headers.pg.toString()
    const id: number = parseInt(req.params.id)
    if (!(id > 0)) throw new Error('id is required')

    const name: string = req.body.name
    const payload: any = { ...req.body }

    // Get table
    const getTableSql = selectSingleSql(sqlTemplates, id)
    const { data: getTableResults } = await RunQuery(pcConnection, getTableSql)
    let previousTable: Tables.Table = getTableResults[0]

    // Update fields and name
    const nameSql =
      typeof name === 'undefined' || name === previousTable.name
        ? ''
        : alterTableName(previousTable.name, name, previousTable.schema)
    if (!name) payload.name = previousTable.name
    const alterSql = alterTableSql(payload)
    const transaction = toTransaction([nameSql, alterSql])
    await RunQuery(pcConnection, transaction)

    // Return fresh details
    const { data: freshTableData } = await RunQuery(pcConnection, getTableSql)
    let updated: Tables.Table = freshTableData[0]
    return res.status(200).json(updated)
  } catch (error) {
    // For this one, we always want to give back the error to the customer
    console.log('Soft error!', error)
    res.status(200).json([{ error: error.toString() }])
  }
})

router.delete('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id)
    const getTableQuery = selectSingleSql(sqlTemplates, id)
    const table = (await RunQuery(req.headers.pg, getTableQuery)).data[0]
    const { name, schema } = table

    const cascade = req.query.cascade === 'true'
    const query = dropTableSql(schema, name, cascade)
    await RunQuery(req.headers.pg, query)

    return res.status(200).json(table)
  } catch (error) {
    console.log('throwing error', error)
    res.status(500).json({ error: 'Database error', status: 500 })
  }
})

const getTablesSql = (sqlTemplates) => {
  const { columns, grants, policies, primary_keys, relationships, tables } = sqlTemplates
  return `
  WITH tables AS MATERIALIZED ( ${tables} ),
    columns AS MATERIALIZED ( ${columns} ),
    grants AS MATERIALIZED ( ${grants} ),
    policies AS MATERIALIZED ( ${policies} ),
    primary_keys AS MATERIALIZED ( ${primary_keys} ),
    relationships AS MATERIALIZED ( ${relationships} )
  SELECT
    *,
    ${coalesceRowsToArray('columns', 'SELECT * FROM columns WHERE columns.table_id = tables.id')},
    ${coalesceRowsToArray('grants', 'SELECT * FROM grants WHERE grants.table_id = tables.id')},
    ${coalesceRowsToArray(
      'policies',
      'SELECT * FROM policies WHERE policies.table_id = tables.id'
    )},
    ${coalesceRowsToArray(
      'primary_keys',
      'SELECT * FROM primary_keys WHERE primary_keys.table_id = tables.id'
    )},
    ${coalesceRowsToArray(
      'relationships',
      `SELECT
        *
      FROM
        relationships
      WHERE
        (relationships.source_schema = tables.schema AND relationships.source_table_name = tables.name)
        OR (relationships.target_table_schema = tables.schema AND relationships.target_table_name = tables.name)`
    )}
  FROM tables;`.trim()
}
const selectSingleSql = (sqlTemplates, id: number) => {
  const { tables } = sqlTemplates
  return `${tables} and c.oid = ${id};`.trim()
}
const selectSingleByName = (sqlTemplates, schema: string, name: string) => {
  const { tables } = sqlTemplates
  return `${tables} and table_schema = '${schema}' and table_name = '${name}';`.trim()
}
const createTableSqlize = ({
  name,
  schema = 'public',
  comment,
}: {
  name: string
  schema?: string
  comment?: string
}) => {
  const tableSql = `CREATE TABLE IF NOT EXISTS "${schema}"."${name}" ();`
  const commentSql =
    comment === undefined ? '' : `COMMENT ON TABLE "${schema}"."${name}" IS '${comment}';`
  return `${tableSql} ${commentSql}`
}
const alterTableName = (previousName: string, newName: string, schema: string) => {
  return `ALTER TABLE "${schema}"."${previousName}" RENAME TO "${newName}";`.trim()
}
const alterTableSql = ({
  schema = 'public',
  name,
  rls_enabled,
  rls_forced,
  comment,
}: {
  schema?: string
  name: string
  rls_enabled?: boolean
  rls_forced?: boolean
  comment?: string
}) => {
  let alter = `ALTER table "${schema}"."${name}"`
  let enableRls = ''
  if (rls_enabled !== undefined) {
    let enable = `${alter} ENABLE ROW LEVEL SECURITY;`
    let disable = `${alter} DISABLE ROW LEVEL SECURITY;`
    enableRls = rls_enabled ? enable : disable
  }
  let forceRls = ''
  if (rls_forced !== undefined) {
    let enable = `${alter} FORCE ROW LEVEL SECURITY;`
    let disable = `${alter} NO FORCE ROW LEVEL SECURITY;`
    forceRls = rls_forced ? enable : disable
  }
  const commentSql =
    comment === undefined ? '' : `COMMENT ON TABLE "${schema}"."${name}" IS '${comment}';`
  return `
    ${enableRls}
    ${forceRls}
    ${commentSql}
  `.trim()
}
const dropTableSql = (schema: string, name: string, cascade: boolean) => {
  return `DROP TABLE "${schema}"."${name}" ${cascade ? 'CASCADE' : 'RESTRICT'};`.trim()
}
const removeSystemSchemas = (data: Tables.Table[]) => {
  return data.filter((x) => !DEFAULT_SYSTEM_SCHEMAS.includes(x.schema))
}

export = router
