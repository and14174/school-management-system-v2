import { Catch, HttpException, HttpStatus, Logger, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { DomainError } from '@sms/kernel';

const HTTP_STATUS_BY_DOMAIN_ERROR_CODE: Record<string, number> = {
  NOT_FOUND: HttpStatus.NOT_FOUND,
  CONFLICT: HttpStatus.CONFLICT,
  FORBIDDEN: HttpStatus.FORBIDDEN,
  VALIDATION_ERROR: HttpStatus.UNPROCESSABLE_ENTITY,
  PRECONDITION_FAILED: HttpStatus.PRECONDITION_FAILED,
};

interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId: string;
  };
}

/**
 * Maps every error thrown anywhere in the request pipeline to the
 * consistent `{ error: { code, message, details?, requestId } }` envelope.
 * `@sms/kernel` `DomainError` subclasses map to their documented status
 * codes; anything else (a bug, an unhandled exception) becomes a 500 with
 * no internal detail leaked to the client - the real error is logged
 * server-side, keyed by the same `requestId` the client sees, so it's
 * still traceable from a bug report without exposing stack traces.
 */
@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const httpContext = host.switchToHttp();
    const response = httpContext.getResponse<FastifyReply>();
    const request = httpContext.getRequest<FastifyRequest>();
    const requestId = request?.id ?? firstHeaderValue(request?.headers?.['x-request-id']) ?? 'unknown';

    if (exception instanceof DomainError) {
      const status = HTTP_STATUS_BY_DOMAIN_ERROR_CODE[exception.code] ?? HttpStatus.BAD_REQUEST;
      this.send(response, status, {
        error: {
          code: exception.code,
          message: exception.message,
          ...(exception.details !== undefined ? { details: exception.details } : {}),
          requestId,
        },
      });
      return;
    }

    // `instanceof HttpException` first (the common, fast case), but falls
    // back to duck-typing (`getStatus`/`getResponse`) for anything shaped
    // like one. This matters in this workspace specifically: a platform
    // library (e.g. `@sms/tenancy`) can end up resolving its own copy of
    // `@nestjs/common` - and therefore its own `HttpException` class object
    // - distinct from this app's, whenever pnpm's peer-dependency hashing
    // gives the library and the app different physical package instances
    // (visible via e.g. `nestjs-zod`'s `ZodValidationException extends
    // BadRequestException`, thrown from a library-owned `ZodValidationPipe`).
    // `instanceof` fails across that boundary even though it is, in every
    // way that matters, the same class - so anything with `getStatus()` and
    // `getResponse()` is treated as one rather than silently becoming a 500.
    if (exception instanceof HttpException || isHttpExceptionLike(exception)) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const { message, code, details } = normaliseHttpExceptionBody(body, exception.message);
      this.send(response, status, {
        error: { code, message, ...(details !== undefined ? { details } : {}), requestId },
      });
      return;
    }

    // Truly unexpected: log the real error (with requestId to correlate),
    // but never leak internals (message, stack) to the client.
    this.logger.error(
      `Unhandled exception [requestId=${requestId}]: ${exception instanceof Error ? exception.stack : String(exception)}`,
    );
    this.send(response, HttpStatus.INTERNAL_SERVER_ERROR, {
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.', requestId },
    });
  }

  private send(response: FastifyReply, status: number, body: ErrorEnvelope): void {
    response.status(status).send(body);
  }
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Structural shape of `HttpException` - see the comment where this is used. */
interface HttpExceptionLike extends Error {
  getStatus(): number;
  getResponse(): unknown;
}

function isHttpExceptionLike(exception: unknown): exception is HttpExceptionLike {
  return (
    exception instanceof Error &&
    typeof (exception as Partial<HttpExceptionLike>).getStatus === 'function' &&
    typeof (exception as Partial<HttpExceptionLike>).getResponse === 'function'
  );
}

function normaliseHttpExceptionBody(
  body: unknown,
  fallbackMessage: string,
): { message: string; code: string; details?: unknown } {
  if (typeof body === 'object' && body !== null) {
    const record = body as Record<string, unknown>;
    const message = Array.isArray(record.message)
      ? record.message.join('; ')
      : ((record.message as string | undefined) ?? fallbackMessage);
    const code = typeof record.error === 'string' ? record.error.toUpperCase().replace(/\s+/g, '_') : 'HTTP_ERROR';
    return { message, code, details: Array.isArray(record.message) ? record.message : undefined };
  }
  return { message: fallbackMessage, code: 'HTTP_ERROR' };
}
