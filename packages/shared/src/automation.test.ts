import { describe, expect, it } from 'vitest';

import {
  automationDefinitionFromRecord,
  conditionsMatch,
  describeSchedule,
  nextScheduleRun,
  normalizeAutomationDefinition,
  renderAutomationTemplate,
  resolveAutomationValue,
  type AutomationValueContext,
} from './automation';

const context: AutomationValueContext = {
  now: Date.UTC(2026, 10, 25, 16, 30),
  timezone: 'Asia/Shanghai',
  triggerUserId: 'user-1',
  triggerRowId: 'row-1',
  triggerValues: { status: '进行中', owner: ['user-2'] },
};

describe('automation definitions', () => {
  it('reads legacy single-action records with steps, condition and UTC cron', () => {
    const definition = automationDefinitionFromRecord({
      trigger_type: 'property_changed',
      trigger_config_json: JSON.stringify({
        propertyId: 'status',
        condition: { propertyId: 'status', op: 'eq', value: '完成' },
        cron: '30 1 * * *',
      }),
      action_type: 'set_property',
      action_config_json: JSON.stringify({
        targetPropertyId: 'done',
        value: true,
        steps: [{ type: 'webhook', config: { url: 'https://example.com' } }],
      }),
    });
    expect(definition.trigger).toEqual({
      type: 'schedule',
      propertyIds: ['status'],
      schedule: { frequency: 'daily', time: '01:30', weekdays: [], dayOfMonth: 1 },
    });
    expect(definition.conditions.rules).toEqual([
      { propertyId: 'status', op: 'eq', value: '完成' },
    ]);
    expect(definition.actions.map((action) => action.type)).toEqual(['webhook', 'set_property']);
    expect(definition.actions[1]?.config).toEqual({ targetPropertyId: 'done', value: true });
  });

  it('prefers a stored definition and drops unknown actions', () => {
    const definition = automationDefinitionFromRecord({
      trigger_type: 'manual',
      trigger_config_json: JSON.stringify({
        definition: {
          trigger: { type: 'row_created' },
          conditions: { match: 'any', rules: [{ propertyId: 'a', op: 'not_empty' }] },
          actions: [{ type: 'notify', config: { message: 'hi' } }, { type: 'format_disk' }],
          timezone: 'Asia/Shanghai',
        },
      }),
      action_type: 'notify',
      action_config_json: '{}',
    });
    expect(definition.trigger.type).toBe('row_created');
    expect(definition.conditions.match).toBe('any');
    expect(definition.actions).toEqual([{ type: 'notify', config: { message: 'hi' } }]);
    expect(definition.timezone).toBe('Asia/Shanghai');
  });

  it('rejects an unknown trigger and falls back to UTC for a bad time zone', () => {
    expect(normalizeAutomationDefinition({ trigger: { type: 'reboot' } })).toBeNull();
    expect(
      normalizeAutomationDefinition({ trigger: { type: 'manual' }, timezone: 'Mars/Base' })
        ?.timezone,
    ).toBe('UTC');
  });
});

describe('automation conditions', () => {
  const values = {
    status: '进行中',
    tags: ['前端', '设计'],
    hours: 8,
    due: { start: '2026-11-20T00:00:00.000Z', includeTime: false },
    done: false,
    note: '',
  };

  it('supports all/any matching across operators', () => {
    expect(
      conditionsMatch(
        {
          match: 'all',
          rules: [
            { propertyId: 'status', op: 'eq', value: '进行中' },
            { propertyId: 'tags', op: 'contains', value: '设计' },
            { propertyId: 'hours', op: 'gte', value: 8 },
            { propertyId: 'done', op: 'not_checked' },
            { propertyId: 'note', op: 'is_empty' },
          ],
        },
        values,
        context,
      ),
    ).toBe(true);
    expect(
      conditionsMatch(
        {
          match: 'any',
          rules: [
            { propertyId: 'status', op: 'eq', value: '已完成' },
            { propertyId: 'hours', op: 'lt', value: 4 },
          ],
        },
        values,
        context,
      ),
    ).toBe(false);
  });

  it('compares dates against tokens such as today', () => {
    expect(
      conditionsMatch(
        { match: 'all', rules: [{ propertyId: 'due', op: 'lt', value: { $token: 'today' } }] },
        values,
        context,
      ),
    ).toBe(true);
  });

  it('passes when there are no rules', () => {
    expect(conditionsMatch({ match: 'all', rules: [] }, {}, context)).toBe(true);
  });
});

describe('automation values and templates', () => {
  it('resolves tokens from the trigger context', () => {
    expect(resolveAutomationValue({ $token: 'trigger_user' }, context)).toEqual(['user-1']);
    expect(resolveAutomationValue({ $token: 'trigger_row' }, context)).toEqual(['row-1']);
    expect(resolveAutomationValue({ $token: 'copy', propertyId: 'status' }, context)).toBe(
      '进行中',
    );
    // 16:30 UTC is already the next day in Shanghai.
    expect(resolveAutomationValue({ $token: 'today' }, context)).toEqual({
      start: '2026-11-26T00:00:00.000Z',
      end: null,
      includeTime: false,
    });
    expect(resolveAutomationValue(['a', { $token: 'trigger_user' }], context)).toEqual([
      'a',
      'user-1',
    ]);
  });

  it('fills {{field}} placeholders and keeps unknown ones', () => {
    const lookup = (name: string) => (name === '标题' ? '发布 v2' : null);
    expect(renderAutomationTemplate('{{ 标题 }} 已完成 {{未知}}', lookup)).toBe(
      '发布 v2 已完成 {{未知}}',
    );
  });
});

describe('automation schedules', () => {
  const from = Date.UTC(2026, 10, 25, 2, 0); // Wed 10:00 in Shanghai

  it('runs daily at a local time', () => {
    const next = nextScheduleRun(
      { frequency: 'daily', time: '09:00', weekdays: [], dayOfMonth: 1 },
      'Asia/Shanghai',
      from,
    );
    expect(new Date(next!).toISOString()).toBe('2026-11-26T01:00:00.000Z');
  });

  it('runs on chosen weekdays', () => {
    const next = nextScheduleRun(
      { frequency: 'weekly', time: '09:00', weekdays: [1], dayOfMonth: 1 },
      'Asia/Shanghai',
      from,
    );
    expect(new Date(next!).toISOString()).toBe('2026-11-30T01:00:00.000Z'); // Monday
  });

  it('uses the last day of short months', () => {
    const next = nextScheduleRun(
      { frequency: 'monthly', time: '08:00', weekdays: [], dayOfMonth: 31 },
      'UTC',
      Date.UTC(2027, 1, 1),
    );
    expect(new Date(next!).toISOString()).toBe('2027-02-28T08:00:00.000Z');
  });

  it('runs hourly at a minute', () => {
    const next = nextScheduleRun(
      { frequency: 'hourly', time: '00:15', weekdays: [], dayOfMonth: 1 },
      'UTC',
      Date.UTC(2026, 0, 1, 10, 20),
    );
    expect(new Date(next!).toISOString()).toBe('2026-01-01T11:15:00.000Z');
  });

  it('keeps local time across a DST change', () => {
    const next = nextScheduleRun(
      { frequency: 'daily', time: '09:00', weekdays: [], dayOfMonth: 1 },
      'America/New_York',
      Date.UTC(2026, 2, 7, 15, 0),
    );
    // 2026-03-08 is the first day of EDT (UTC-4).
    expect(new Date(next!).toISOString()).toBe('2026-03-08T13:00:00.000Z');
  });

  it('describes a schedule in words', () => {
    expect(
      describeSchedule({ frequency: 'weekly', time: '09:00', weekdays: [1, 3], dayOfMonth: 1 }),
    ).toBe('每周一、周三 09:00');
  });
});
