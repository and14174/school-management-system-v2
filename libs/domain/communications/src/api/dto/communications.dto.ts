import { createZodDto } from 'nestjs-zod';
import {
  createAnnouncementSchema,
  listAnnouncementsQuerySchema,
  listThreadsQuerySchema,
  postMessageSchema,
  startThreadSchema,
  supersedeAnnouncementSchema,
} from '../../application/schemas.js';

export class CreateAnnouncementDto extends createZodDto(createAnnouncementSchema) {}
export class SupersedeAnnouncementDto extends createZodDto(supersedeAnnouncementSchema) {}
export class ListAnnouncementsQueryDto extends createZodDto(listAnnouncementsQuerySchema) {}
export class StartThreadDto extends createZodDto(startThreadSchema) {}
export class PostMessageDto extends createZodDto(postMessageSchema) {}
export class ListThreadsQueryDto extends createZodDto(listThreadsQuerySchema) {}
