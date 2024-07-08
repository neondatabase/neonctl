import { Writable } from 'node:stream';
import { describe, it, expect } from 'vitest';
import { writer } from './writer.js';

class MockWritable extends Writable {
  _data: Buffer[] = [];

  get data() {
    return this._data.map((chunk) => chunk.toString()).join('');
  }

  _write(chunk: Buffer) {
    this._data.push(chunk);
  }
}

describe('writer', () => {
  describe('outputs yaml', () => {
    it('outputs single data', () => {
      const stream = new MockWritable();
      const out = writer({ output: 'yaml', out: stream });
      out.end({ foo: 'bar' }, { fields: ['foo'] });
      expect(stream.data).toMatchSnapshot();
    });

    it('outputs single data with title', () => {
      const stream = new MockWritable();
      const out = writer({ output: 'yaml', out: stream });
      out.end({ foo: 'bar' }, { fields: ['foo'], title: 'baz' });
      expect(stream.data).toMatchSnapshot();
    });

    it('outputs multiple data', () => {
      const stream = new MockWritable();
      const out = writer({ output: 'yaml', out: stream });
      out
        .write({ foo: 'bar' }, { fields: ['foo'], title: 'T1' })
        .write({ baz: 'xyz' }, { fields: ['baz'], title: 'T2' })
        .end();
      expect(stream.data).toMatchSnapshot();
    });
  });

  describe('outputs json', () => {
    it('outputs single data', () => {
      const stream = new MockWritable();
      const out = writer({ output: 'json', out: stream });
      out.end({ foo: 'bar' }, { fields: ['foo'] });
      expect(stream.data).toMatchSnapshot();
    });

    it('outputs single data with title', () => {
      const stream = new MockWritable();
      const out = writer({ output: 'json', out: stream });
      out.end({ foo: 'bar' }, { fields: ['foo'], title: 'baz' });
      expect(stream.data).toMatchSnapshot();
    });

    it('outputs multiple data', () => {
      const stream = new MockWritable();
      const out = writer({ output: 'json', out: stream });
      out
        .write({ foo: 'bar' }, { fields: ['foo'], title: 'T1' })
        .write({ baz: 'xyz' }, { fields: ['baz'], title: 'T2' })
        .end();
      expect(stream.data).toMatchSnapshot();
    });
  });

  describe('outputs table', () => {
    it('outputs single data', () => {
      const stream = new MockWritable();
      const out = writer({ output: 'table', out: stream });
      out.end({ foo: 'bar', extra: 'extra' }, { fields: ['foo'] });
      expect(stream.data).toMatchSnapshot();
    });

    it('outputs single data with title', () => {
      const stream = new MockWritable();
      const out = writer({ output: 'table', out: stream });
      out.end(
        { foo: 'bar', extra: 'extra' },
        { fields: ['foo'], title: 'baz' },
      );
      expect(stream.data).toMatchSnapshot();
    });

    it('outputs multiple data', () => {
      const stream = new MockWritable();
      const out = writer({ output: 'table', out: stream });
      out
        .write({ foo: 'bar', extra: 'extra' }, { fields: ['foo'], title: 'T1' })
        .write({ baz: 'xyz', extra: 'extra' }, { fields: ['baz'], title: 'T2' })
        .end();
      expect(stream.data).toMatchSnapshot();
    });
  });
});
