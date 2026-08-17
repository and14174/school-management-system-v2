import { Body, Controller, Delete, Get, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';
import { unwrap, type CampusId, type DateOnly, type UserId } from '@sms/kernel';
import { ACCESS_CONTRACT, type AccessContract } from '../contract.js';
import { AssignRoleDto, RevokeRoleDto } from './dto/role-assignment.dto.js';
import { RequirePermission } from './require-permission.decorator.js';

@ApiTags('access')
@Controller('access')
export class RolesController {
  // Explicit @Inject(): see apps/api's HealthController for why implicit
  // type-based DI is not trusted in this codebase.
  constructor(@Inject(ACCESS_CONTRACT) private readonly access: AccessContract) {}

  @Get('roles')
  listRoles() {
    return this.access.listRoles();
  }

  @Get('permissions')
  listPermissions() {
    return this.access.listPermissions();
  }

  // No @RequirePermission - gated the same as GET /access/roles above
  // (ungated beyond AuthGuard's ordinary authentication: any tenant member
  // may view a role's permission matrix). Returns the FULL catalogue joined
  // to this role's grants, `scope: null` for anything it does not hold -
  // see RolePermissionMatrixEntry's doc comment - so a permission-matrix UI
  // can render one row per catalogue permission without a second request.
  @Get('roles/:id/permissions')
  async listRolePermissions(@Param('id', ParseUUIDPipe) id: string) {
    return unwrap(await this.access.listRolePermissionMatrix(id));
  }

  @RequirePermission('access.role:manage')
  @Post('roles/:id/assignments')
  async assign(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(AssignRoleDto)) body: AssignRoleDto) {
    return unwrap(
      await this.access.assignRole({
        roleId: id,
        userId: body.userId as UserId,
        ...(body.campusId !== undefined ? { campusId: body.campusId as CampusId } : {}),
        ...(body.validFrom !== undefined ? { validFrom: body.validFrom as DateOnly } : {}),
        ...(body.validTo !== undefined ? { validTo: body.validTo as DateOnly | null } : {}),
      }),
    );
  }

  @RequirePermission('access.role:manage')
  @Delete('roles/:id/assignments')
  async revoke(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(RevokeRoleDto)) body: RevokeRoleDto) {
    unwrap(
      await this.access.revokeRole({
        roleId: id,
        userId: body.userId as UserId,
        ...(body.campusId !== undefined ? { campusId: body.campusId as CampusId } : {}),
        ...(body.asOf !== undefined ? { asOf: body.asOf as DateOnly } : {}),
      }),
    );
    return { revoked: true };
  }
}
