import { normalize } from 'normalizr';

import * as mw from '../src/middleware';

jest.mock('normalizr');

const FROZEN_TIME = 123;

const err = new Error('Bad request');
err.status = 400;

const request = success => async d => {
  if (success) {
    return d;
  }

  throw err;
};
const mockRequest = success => jest.fn(request(success));
const getEntity = (success, staleTimeout) => ({
  provider: {
    upsert: mockRequest(success),
    remove: mockRequest(success),
    fetch: mockRequest(success),
  },
  staleTimeout,
  key: 'e',
  idAttribute: 'id',
});
const actionCreator = (type, success, staleTimeout, refresh) => ({
  type: `snowbox/${type}`,
  entity: type == 'FETCH' ?
    [getEntity(success, staleTimeout)] :
    getEntity(success, staleTimeout),
  data: { id: 3 },
  options: { refresh },
  success: (data, entities, result, date) => ({ data, entities, result, date }),
  failure: (data, error, statusCode) => ({ data, error, statusCode }),
});

describe('middleware', () => {
  let next;

  beforeAll(() => {
    next = jest.fn(a => a);
    normalize.mockImplementation(
      (data, entity) => ({ entities: 1, result: 2 })
    );
    jest
      .spyOn(global.Date, 'now')
      .mockImplementation(() => FROZEN_TIME);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    next.mockClear();
    normalize.mockClear();
  });

  it('ignores non snowbox actions', async () => {
    const action = { type: 'IRRELEVANT', some: 'field' };

    const result = await mw.snowboxMiddleware({})(next)(action);

    expect(result).toStrictEqual(action);
    expect(next.mock.calls.length).toBe(1);
    expect(next.mock.calls[0][0]).toStrictEqual(action);
  });

  describe.each(
    ['upsert', 'remove', 'find', 'fetch']
  )('handles %s action', type => {
    const store = { getState: () => {} };

    test('when succeeds', async () => {
      const action = actionCreator(type.toUpperCase(), true);
      const provider = type == 'fetch' ?
        action.entity[0].provider :
        action.entity.provider;
      const method = type == 'find' ? 'fetch' : type;
      const result = await mw.snowboxMiddleware(store)(next)(action);

      expect(provider[method].mock.calls.length).toBe(1);
      expect(provider[method].mock.calls[0][0]).toBe(action.data);
      expect(next.mock.calls.length).toBe(2);
      expect(next.mock.calls[0][0]).toStrictEqual(action);
      expect(next.mock.calls[1][0]).toStrictEqual(result);
      expect(result).toStrictEqual({
        data: { id: 3 },
        entities: type == 'remove' ? undefined : 1,
        result: type == 'remove' ? undefined : 2,
        date: type == 'remove' ? undefined : FROZEN_TIME,
      });
      expect(normalize.mock.calls.length).toBe(type == 'remove' ? 0 : 1);

      if (type != 'remove') {
        expect(normalize.mock.calls[0][0]).toBe(action.data);
        expect(normalize.mock.calls[0][1]).toStrictEqual(action.entity);
      }
    });

    test('when fails', async () => {
      const action = actionCreator(type.toUpperCase(), false);
      const provider = type == 'fetch' ?
        action.entity[0].provider :
        action.entity.provider;
      const method = type == 'find' ? 'fetch' : type;
      const result = await mw.snowboxMiddleware(store)(next)(action);

      expect(provider[method].mock.calls.length).toBe(1);
      expect(provider[method].mock.calls[0][0]).toBe(action.data);
      expect(next.mock.calls.length).toBe(2);
      expect(next.mock.calls[0][0]).toStrictEqual(action);
      expect(next.mock.calls[1][0]).toStrictEqual(result);
      expect(result).toStrictEqual({
        data: { id: 3 },
        error: err,
        statusCode: 400,
      });
      expect(normalize.mock.calls.length).toBe(0);
    });
  });

  describe('singletons', () => {
    const store = { getState: () => {} };

    it('handles singletons correctly', async () => {
      const entity = {
        key: 's',
        singleton: true,
        provider: { fetch: jest.fn(async () => 'r') },
      };
      const action = {
        type: 'snowbox/FETCH',
        entity,
        data: { d: 'd' },
        success: (data, entities, result, date) => (
          { data, entities, result, date }
        ),
        failure: (data, error, statusCode) => ({ data, error, statusCode }),
      };
      const provider = action.entity.provider;
      const result = await mw.snowboxMiddleware(store)(next)(action);

      expect(provider.fetch.mock.calls.length).toBe(1);
      expect(provider.fetch.mock.calls[0][0]).toBe(action.data);
      expect(next.mock.calls.length).toBe(2);
      expect(next.mock.calls[0][0]).toStrictEqual(action);
      expect(next.mock.calls[1][0]).toStrictEqual(result);
      expect(result).toStrictEqual({
        data: { d: 'd' },
        entities: undefined,
        result: 'r',
        date: FROZEN_TIME,
      });
      expect(normalize.mock.calls.length).toBe(0);
    });
  });

  describe('sateTimeout option', () => {
    const store = {
      getState: () => ({ snowbox: {
        meta: { e: { '#id[3]': { __updatedAt: 100 } } },
        entities: { e: { 3: { id: 3, __updatedAt: 100 } } },
      }}),
    };

    describe.each(
      ['upsert', 'remove']
    )('for %s actions', type => {
      test('doesn nothing', async () => {
        const action = actionCreator(type.toUpperCase(), true);
        const provider = type == 'fetch' ?
          action.entity[0].provider :
          action.entity.provider;
        const method = type == 'find' ? 'fetch' : type;
        await mw.snowboxMiddleware(store)(next)(action);

        expect(provider[method].mock.calls.length).toBe(1);
        expect(next.mock.calls.length).toBe(2);
      });
    });

    it('does nothing when the entity does not have staleTimeout', async () => {
      const type = 'fetch';
      const action = actionCreator(type.toUpperCase(), true);
      const provider = type == 'fetch' ?
        action.entity[0].provider :
        action.entity.provider;
      const method = type == 'find' ? 'fetch' : type;
      await mw.snowboxMiddleware(store)(next)(action);

      expect(provider[method].mock.calls.length).toBe(1);
      expect(next.mock.calls.length).toBe(2);
    });

    it('does nothing when the action explicitly ask fresh data', async () => {
      const type = 'find';
      const action = actionCreator(type.toUpperCase(), true, 11, true);
      const provider = type == 'fetch' ?
        action.entity[0].provider :
        action.entity.provider;
      const method = type == 'find' ? 'fetch' : type;
      await mw.snowboxMiddleware(store)(next)(action);

      expect(provider[method].mock.calls.length).toBe(1);
      expect(next.mock.calls.length).toBe(2);
    });

    it('does not fetch new data when the entity is fresh', async () => {
      const type = 'find';
      const action = actionCreator(type.toUpperCase(), true, 100);
      const provider = type == 'fetch' ?
        action.entity[0].provider :
        action.entity.provider;
      const method = type == 'find' ? 'fetch' : type;
      await mw.snowboxMiddleware(store)(next)(action);

      expect(provider[method].mock.calls.length).toBe(0);
      expect(next.mock.calls.length).toBe(1);
    });

    it('does not fetch new data when the page is fresh', async () => {
      const type = 'fetch';
      const action = actionCreator(type.toUpperCase(), true, 100);
      const provider = type == 'fetch' ?
        action.entity[0].provider :
        action.entity.provider;
      const method = type == 'find' ? 'fetch' : type;
      await mw.snowboxMiddleware(store)(next)(action);

      expect(provider[method].mock.calls.length).toBe(0);
      expect(next.mock.calls.length).toBe(1);
    });

    it('fetches new data when the entity is stale', async () => {
      const type = 'find';
      const action = actionCreator(type.toUpperCase(), true, 10);
      const provider = type == 'fetch' ?
        action.entity[0].provider :
        action.entity.provider;
      const method = type == 'find' ? 'fetch' : type;
      await mw.snowboxMiddleware(store)(next)(action);

      expect(provider[method].mock.calls.length).toBe(1);
      expect(next.mock.calls.length).toBe(2);

    });

    it('fetches new data when the page is stale', async () => {
      const type = 'fetch';
      const action = actionCreator(type.toUpperCase(), true, 10);
      const provider = type == 'fetch' ?
        action.entity[0].provider :
        action.entity.provider;
      const method = type == 'find' ? 'fetch' : type;
      await mw.snowboxMiddleware(store)(next)(action);

      expect(provider[method].mock.calls.length).toBe(1);
      expect(next.mock.calls.length).toBe(2);
    });
  });

  describe('shouldFetchData', () => {
    const entity = {
      key: 'baz',
      singleton: true,
      staleTimeout: 10,
    };

    it('returns true when the singleton is stale', () => {
      const result = mw.shouldFetchData(
        {
          snowbox: { singletons: { baz: { a: 'b', __updatedAt: 100 } } },
        },
        entity,
        { data: {} }
      );

      expect(result).toBe(true);
    });

    it('returns false when the singleton is fresh', () => {
      const result = mw.shouldFetchData(
        {
          snowbox: { singletons: { baz: { a: 'b', __updatedAt: 120 } } },
        },
        entity,
        { data: {} }
      );

      expect(result).toBe(false);
    });

    it('returns true when the state data does not have update date', () => {
      const result = mw.shouldFetchData(
        {
          snowbox: { singletons: { baz: { a: 'b' } } },
        },
        entity,
        { data: {} }
      );

      expect(result).toBe(true);
    });
  });
});
