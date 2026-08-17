import { Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { NotFoundError, newId, type DomainError, type Result, type TenantId, err, ok } from '@sms/kernel';
import { withTenantTx } from '@sms/db';
import type { CreateRoomInput, UpdateRoomInput } from '../contract.js';
import type { Room } from '../domain/types.js';
import { toRoom } from '../infrastructure/mappers.js';
import { roomTable } from '../infrastructure/schema.js';
import { scopedContext } from './scoped-context.js';
import { toDomainError } from './sql-errors.js';

@Injectable()
export class RoomService {
  async create(tenantId: TenantId, input: CreateRoomInput): Promise<Result<Room, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .insert(roomTable)
          .values({
            id: newId(),
            tenantId,
            campusId: input.campusId,
            code: input.code,
            name: input.name,
            capacity: input.capacity ?? null,
          })
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new NotFoundError('Insert returned no row.'));
      }
      return ok(toRoom(row));
    } catch (error) {
      return err(toDomainError(error, `Could not create room "${input.code}".`) as DomainError);
    }
  }

  async list(tenantId: TenantId): Promise<Room[]> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db.select().from(roomTable).where(eq(roomTable.tenantId, tenantId)).orderBy(asc(roomTable.code)),
    );
    return rows.map(toRoom);
  }

  async update(tenantId: TenantId, id: string, input: UpdateRoomInput): Promise<Result<Room, DomainError>> {
    const ctx = scopedContext(tenantId);
    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .update(roomTable)
          .set({
            ...(input.campusId !== undefined ? { campusId: input.campusId } : {}),
            ...(input.code !== undefined ? { code: input.code } : {}),
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.capacity !== undefined ? { capacity: input.capacity } : {}),
          })
          .where(and(eq(roomTable.tenantId, tenantId), eq(roomTable.id, id)))
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new NotFoundError(`Room ${id} not found.`));
      }
      return ok(toRoom(row));
    } catch (error) {
      return err(toDomainError(error, `Could not update room ${id}.`) as DomainError);
    }
  }
}
