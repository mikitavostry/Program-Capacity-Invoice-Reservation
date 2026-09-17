import { describe, expect, it } from 'vitest';
import { AggregateRoot } from './aggregate-root.js';
import type { DomainEvent } from './domain-event.js';
import { Entity } from './entity.js';
import { Identifier, InvalidIdentifierError } from './identifier.js';

class ThingId extends Identifier {
  static of(value: string): ThingId {
    return new ThingId(value);
  }
}

class OtherId extends Identifier {
  static of(value: string): OtherId {
    return new OtherId(value);
  }
}

class Thing extends AggregateRoot<ThingId> {
  label: string;

  constructor(id: ThingId, label = '') {
    super(id);
    this.label = label;
  }

  rename(label: string): void {
    this.label = label;
    this.raise({
      eventName: 'ThingRenamed',
      aggregateId: this.id.value,
      occurredAt: new Date(),
    });
  }
}

class OtherThing extends Entity<ThingId> {
  constructor(id: ThingId) {
    super(id);
  }
}

describe('Identifier', () => {
  it('rejects a value that is empty or only whitespace', () => {
    expect(() => ThingId.of('')).toThrow(InvalidIdentifierError);
    expect(() => ThingId.of('   ')).toThrow(/ThingId is invalid/);
    expect(() => ThingId.of(undefined as unknown as string)).toThrow(InvalidIdentifierError);
  });

  it('trims the value it keeps', () => {
    expect(ThingId.of('  abc  ').value).toBe('abc');
  });

  it('is equal to another identifier of the same type and value', () => {
    expect(ThingId.of('abc').equals(ThingId.of('abc'))).toBe(true);
  });

  it('is not equal to a different identifier type holding the same value', () => {
    expect(ThingId.of('abc').equals(OtherId.of('abc'))).toBe(false);
  });

  it('is not equal to the bare string it wraps', () => {
    expect(ThingId.of('abc').equals('abc')).toBe(false);
  });

  it('serialises to its value', () => {
    expect(JSON.stringify({ id: ThingId.of('abc') })).toBe('{"id":"abc"}');
    expect(String(ThingId.of('abc'))).toBe('abc');
  });
});

describe('Entity', () => {
  it('is equal by identity, whatever else differs', () => {
    const left = new Thing(ThingId.of('abc'), 'one');
    const right = new Thing(ThingId.of('abc'), 'two');

    expect(left.equals(right)).toBe(true);
  });

  it('is not equal when the ids differ', () => {
    expect(new Thing(ThingId.of('abc')).equals(new Thing(ThingId.of('xyz')))).toBe(false);
  });

  it('is not equal to a different entity type sharing an id', () => {
    expect(new Thing(ThingId.of('abc')).equals(new OtherThing(ThingId.of('abc')))).toBe(false);
  });

  it('is not equal to an unrelated value', () => {
    expect(new Thing(ThingId.of('abc')).equals({ id: 'abc' })).toBe(false);
  });
});

describe('AggregateRoot', () => {
  it('starts with no recorded events', () => {
    expect(new Thing(ThingId.of('abc')).domainEvents).toHaveLength(0);
  });

  it('records the events a behaviour raises', () => {
    const thing = new Thing(ThingId.of('abc'));
    thing.rename('renamed');

    expect(thing.domainEvents.map((event: DomainEvent) => event.eventName)).toEqual([
      'ThingRenamed',
    ]);
    expect(thing.domainEvents[0].aggregateId).toBe('abc');
  });

  it('hands the events over once and then forgets them', () => {
    const thing = new Thing(ThingId.of('abc'));
    thing.rename('renamed');

    expect(thing.pullDomainEvents()).toHaveLength(1);
    expect(thing.pullDomainEvents()).toHaveLength(0);
    expect(thing.domainEvents).toHaveLength(0);
  });

  it('does not expose the list it records into', () => {
    const thing = new Thing(ThingId.of('abc'));
    thing.rename('renamed');

    (thing.domainEvents as DomainEvent[]).length = 0;

    expect(thing.domainEvents).toHaveLength(1);
  });
});
