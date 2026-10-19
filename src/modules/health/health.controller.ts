/**
 * Health check endpoint (GET /api/health). Used by load balancers,
 * Kubernetes probes and uptime monitors to confirm the service is alive.
 */

// Controller/Get: route decorators; VERSION_NEUTRAL: route has no /v1 segment.
// ServiceUnavailableException: 503, tells probes the service isn't healthy.
import {
  Controller,
  Get,
  ServiceUnavailableException,
  VERSION_NEUTRAL,
} from '@nestjs/common';
// Swagger decorators for documenting the response and grouping the route.
import {
  ApiOkResponse,
  ApiProperty,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
// The open database connection.
import { DataSource } from 'typeorm';

/** Response body for the health check (documented in Swagger). */
class HealthResponseDto {
  // Always "ok" when the service can respond.
  @ApiProperty({ example: 'ok' })
  status: string;

  // Database reachability.
  @ApiProperty({ example: 'up' })
  database: string;

  // How long the Node.js process has been running.
  @ApiProperty({ example: 12.34, description: 'Process uptime in seconds' })
  uptime: number;

  // Current server time in ISO-8601 format.
  @ApiProperty({ example: '2026-01-01T00:00:00.000Z' })
  timestamp: string;
}

// Group under "Health" in Swagger UI.
@ApiTags('Health')
// Route: /api/health (version neutral = not prefixed with /v1).
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(private readonly dataSource: DataSource) {}

  // Handles GET /api/health.
  @Get()
  @ApiOkResponse({ type: HealthResponseDto })
  @ApiServiceUnavailableResponse({ description: 'Database is unreachable' })
  async check(): Promise<HealthResponseDto> {
    // Cheapest possible round trip to Postgres.
    try {
      await this.dataSource.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException('Database is unreachable');
    }
    return {
      status: 'ok',
      database: 'up',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }
}
