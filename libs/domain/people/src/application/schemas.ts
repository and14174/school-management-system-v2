import { z } from 'zod';
import { ALERT_CATEGORIES, ALERT_SEVERITIES, PERSON_ROLE_TYPES, RELATIONSHIP_TYPES } from '../domain/types.js';

/**
 * Zod schemas for this module's REST bodies - parsed by the `nestjs-zod`
 * DTOs in `src/api/dto` (`createZodDto`), same convention as `@sms/access`'s
 * `application/schemas.ts`.
 */

const dateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/;
const dateOnlySchema = z.string().regex(dateOnlyPattern, 'must be a YYYY-MM-DD date');

export const createPersonSchema = z.object({
  givenName: z.string().min(1).max(200),
  familyName: z.string().min(1).max(200),
  preferredName: z.string().max(200).nullish(),
  dateOfBirth: dateOnlySchema.nullish(),
  gender: z.string().max(50).nullish(),
  photoFileId: z.string().uuid().nullish(),
  customFields: z.record(z.string(), z.unknown()).optional(),
});
export type CreatePersonBody = z.infer<typeof createPersonSchema>;

export const updatePersonSchema = createPersonSchema.partial();
export type UpdatePersonBody = z.infer<typeof updatePersonSchema>;

export const mergePersonsSchema = z.object({
  survivingId: z.string().uuid(),
  mergedId: z.string().uuid(),
  reason: z.string().min(1).max(500),
});
export type MergePersonsBody = z.infer<typeof mergePersonsSchema>;

export const assignRoleSchema = z.object({
  personId: z.string().uuid(),
  role: z.enum(PERSON_ROLE_TYPES as [string, ...string[]]),
  campusId: z.string().uuid().nullish(),
  validFrom: dateOnlySchema.optional(),
  validTo: dateOnlySchema.nullish(),
});
export type AssignRoleBody = z.infer<typeof assignRoleSchema>;

export const endRoleSchema = z.object({
  personId: z.string().uuid(),
  role: z.enum(PERSON_ROLE_TYPES as [string, ...string[]]),
  campusId: z.string().uuid().nullish(),
  asOf: dateOnlySchema.optional(),
});
export type EndRoleBody = z.infer<typeof endRoleSchema>;

export const createHouseholdSchema = z.object({
  name: z.string().min(1).max(200),
  primaryAddress: z.record(z.string(), z.unknown()).optional(),
});
export type CreateHouseholdBody = z.infer<typeof createHouseholdSchema>;

export const addHouseholdMemberSchema = z.object({
  personId: z.string().uuid(),
  isPrimaryContact: z.boolean().optional(),
  validFrom: dateOnlySchema.optional(),
  validTo: dateOnlySchema.nullish(),
});
export type AddHouseholdMemberBody = z.infer<typeof addHouseholdMemberSchema>;

export const createRelationshipSchema = z.object({
  fromPersonId: z.string().uuid(),
  toPersonId: z.string().uuid(),
  type: z.enum(RELATIONSHIP_TYPES as [string, ...string[]]),
  hasCustody: z.boolean().optional(),
  mayPickup: z.boolean().optional(),
  mayReceiveComms: z.boolean().optional(),
  priority: z.number().int().optional(),
});
export type CreateRelationshipBody = z.infer<typeof createRelationshipSchema>;

export const createAlertSchema = z.object({
  personId: z.string().uuid(),
  category: z.enum(ALERT_CATEGORIES as [string, ...string[]]),
  severity: z.enum(ALERT_SEVERITIES as [string, ...string[]]),
  summary: z.string().min(1).max(500),
  detail: z.string().max(5000).nullish(),
  validFrom: dateOnlySchema.optional(),
  validTo: dateOnlySchema.nullish(),
});
export type CreateAlertBody = z.infer<typeof createAlertSchema>;
