/**
 * Business logic for sending: build the message (rendering the email
 * template if one is given), save it, deliver it through the channel's
 * provider, then record the result.
 */

// Nest DI helpers, logger and HTTP exceptions.
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
// Injects the TypeORM repository for an entity.
import { InjectRepository } from '@nestjs/typeorm';
// Repository: TypeORM's data-access API for one table.
import { Repository } from 'typeorm';
// Email template renderer.
import { TemplatesService } from '../templates/templates.service.js';
// Provider token and contract.
import {
  CHANNEL_PROVIDERS,
  ChannelProvider,
  OutgoingMessage,
} from './channels/channel-provider.interface.js';
// Input DTO.
import { SendNotificationDto } from './dto/send-notification.dto.js';
// Table mapping and enums.
import { Notification } from './entities/notification.entity.js';
import { NotificationChannel } from './enums/notification-channel.enum.js';
import { NotificationStatus } from './enums/notification-status.enum.js';

@Injectable()
export class NotificationsService {
  // Logger labelled "NotificationsService".
  private readonly logger = new Logger(NotificationsService.name);
  // Lookup table: channel -> provider that handles it.
  private readonly providers: Map<NotificationChannel, ChannelProvider>;

  constructor(
    private readonly templates: TemplatesService,
    // Data access for the notifications table.
    @InjectRepository(Notification)
    private readonly notifications: Repository<Notification>,
    // Injected list of all channel providers registered in the module.
    @Inject(CHANNEL_PROVIDERS) providers: ChannelProvider[],
  ) {
    // Index providers by their channel for O(1) lookup.
    this.providers = new Map(providers.map((p) => [p.channel, p]));
  }

  /** Saves the notification, delivers it and stores the result. */
  async send(
    tenantId: string,
    dto: SendNotificationDto,
  ): Promise<Notification> {
    // Find the provider for the requested channel.
    const provider = this.providers.get(dto.channel);
    if (!provider) {
      throw new UnprocessableEntityException(
        `No provider configured for channel "${dto.channel}"`,
      );
    }

    // Render first: template errors are client errors (400), not delivery failures.
    const message = this.buildMessage(tenantId, dto);

    // Persist as "pending" so there's a record even if delivery crashes.
    const notification = await this.notifications.save(
      this.notifications.create({
        tenantId,
        channel: dto.channel,
        recipient: dto.recipient,
        subject: message.subject ?? null,
        body: dto.body ?? null,
        template: dto.template ?? null,
        data: dto.data ?? null,
        status: NotificationStatus.Pending,
      }),
    );

    try {
      const { providerMessageId } = await provider.send(message);
      notification.status = NotificationStatus.Sent;
      notification.providerMessageId = providerMessageId;
    } catch (err) {
      this.logger.error(`Delivery failed for ${notification.id}`, err);
      notification.status = NotificationStatus.Failed;
      notification.error = err instanceof Error ? err.message : String(err);
    }
    // Store the final state and return it to the caller.
    return this.notifications.save(notification);
  }

  /** Turns the request into a provider-ready message. */
  private buildMessage(
    tenantId: string,
    dto: SendNotificationDto,
  ): OutgoingMessage {
    const data = dto.data ?? {};
    const message: OutgoingMessage = {
      tenantId,
      channel: dto.channel,
      recipient: dto.recipient,
      // Subjects may contain placeholders too, e.g. "Hi {{name}}".
      subject: dto.subject && this.templates.renderText(dto.subject, data),
      text: dto.body,
    };

    if (dto.template) {
      if (dto.channel !== NotificationChannel.Email) {
        throw new BadRequestException(
          'Templates are only supported for the email channel',
        );
      }
      message.html = this.templates.renderEmail(dto.template, {
        ...data,
        subject: message.subject,
      });
    }
    return message;
  }
}
