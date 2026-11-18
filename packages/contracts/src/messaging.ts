import type { EventType, ServiceName } from './events';

// RabbitMQ naming from docs/02-cac-service.md §10, in one place so every
// service declares the same exchanges and queues.

/** Topic exchange every event is published to. */
export const EVENTS_EXCHANGE = 'tms.events';

/** Dead-letter exchange for messages that failed all retries. */
export const DEAD_LETTER_EXCHANGE = 'tms.dlx';

const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

/** `<service>.<event>`, for example `billing.attendance-recorded`. */
export const queueName = (service: ServiceName, eventType: EventType): string =>
  `${service}.${kebab(eventType)}`;

/** `<service>.dlq`, bound to the dead-letter exchange. */
export const deadLetterQueueName = (service: ServiceName): string => `${service}.dlq`;
