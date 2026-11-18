import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { z } from 'zod';
import { EVENT_CATALOG, EVENT_TYPES, type EventType } from '../src';

// Keeps the event catalog table in docs/01-nghiep-vu.md §5 and EVENT_CATALOG
// identical, so neither the doc nor the code can drift on its own.

interface DocRow {
  routingKey: string;
  producer: string;
  consumers: string[];
  fields: { name: string; optional: boolean }[];
}

const stripParens = (s: string) => s.replace(/\([^)]*\)/g, '');
const unquote = (s: string) => s.replace(/`/g, '').trim();
const list = (cell: string) =>
  stripParens(cell)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

function readDocCatalog(): Map<string, DocRow> {
  const doc = readFileSync(resolve(__dirname, '../../../docs/01-nghiep-vu.md'), 'utf8');
  const lines = doc.split(/\r?\n/);
  const header = lines.findIndex((l) => l.startsWith('| Event | Routing key |'));
  if (header < 0) throw new Error('event catalog table not found in docs/01-nghiep-vu.md');

  const rows = new Map<string, DocRow>();
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith('|')) break;
    const [events, keys, producer, payload, consumers] = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    const names = events.split('/').map(unquote);
    const routingKeys = keys.split('/').map(unquote);
    names.forEach((name, i) =>
      rows.set(name, {
        routingKey: routingKeys[i],
        producer: producer.toLowerCase(),
        consumers: list(consumers).map((c) => c.split(/\s+/)[0].toLowerCase()),
        fields: list(payload).map((f) => ({
          name: f.replace('?', ''),
          optional: f.endsWith('?'),
        })),
      }),
    );
  }
  return rows;
}

const doc = readDocCatalog();

describe('event catalog matches docs/01-nghiep-vu.md §5', () => {
  it('lists the same events', () => {
    expect([...doc.keys()].sort()).toEqual([...EVENT_TYPES].sort());
  });

  describe.each(EVENT_TYPES)('%s', (eventType: EventType) => {
    const def = EVENT_CATALOG[eventType];
    const row = doc.get(eventType);
    const shape = (def.data as unknown as z.ZodObject).shape;

    it('has the documented routing key, producer and consumers', () => {
      expect(row).toBeDefined();
      expect(row!.routingKey).toBe(def.routingKey);
      expect(row!.producer).toBe(def.producer);
      expect([...row!.consumers].sort()).toEqual([...def.consumers].sort());
    });

    it('has the documented payload fields', () => {
      expect(row!.fields.map((f) => f.name).sort()).toEqual(Object.keys(shape).sort());
      for (const field of row!.fields) {
        const optional = shape[field.name].safeParse(undefined).success;
        expect({ field: field.name, optional }).toEqual({
          field: field.name,
          optional: field.optional,
        });
      }
    });
  });
});
