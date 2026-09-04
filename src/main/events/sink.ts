/**
 * miniClaudio — persistencia de los eventos de hook en `hook_events`.
 *
 * Implementa el puerto `HookEventSink` que declara `router.ts`. La sentencia se prepara
 * una vez, no por evento: `PreToolUse`/`PostToolUse` llegan en ráfagas.
 *
 * Se escribe SIEMPRE fuera del ciclo de la respuesta HTTP (el router se invoca desde un
 * `queueMicrotask`), así que un `INSERT` lento no puede retrasar a Claude Code.
 */

import type Database from 'better-sqlite3'

import type { Db } from '../db/connection'
import type { HookEventRow, HookEventSink } from './router'

const INSERT_SQL = `
  INSERT INTO hook_events
    (ts, ts_epoch, event, project_key, project_path, session_id,
     message, reason, tool_name, is_error, pet_state, raw_json)
  VALUES
    (@ts, @ts_epoch, @event, @project_key, @project_path, @session_id,
     @message, @reason, @tool_name, @is_error, @pet_state, @raw_json)`

export class SqliteHookEventSink implements HookEventSink {
  private readonly stmt: Database.Statement<unknown[]>

  constructor(db: Db) {
    this.stmt = db.prepare(INSERT_SQL)
  }

  insertHookEvent(row: HookEventRow): void {
    this.stmt.run({
      ts: row.ts,
      ts_epoch: row.tsEpoch,
      event: row.event,
      project_key: row.projectKey,
      project_path: row.projectPath,
      session_id: row.sessionId,
      message: row.message,
      reason: row.reason,
      tool_name: row.toolName,
      is_error: row.isError ? 1 : 0,
      pet_state: row.petState,
      raw_json: row.rawJson
    })
  }
}
