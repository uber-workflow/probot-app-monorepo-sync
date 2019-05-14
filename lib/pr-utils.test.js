/** Copyright (c) 2019 Uber Technologies, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

const esmRequire = require('esm')(module);
const {genQueueKey} = esmRequire('./pr-utils.js');

test(`genQueueKey`, () => {
  expect(
    genQueueKey({
      base: {
        repo: {
          full_name: 'foo/bar',
        },
      },
      number: '0',
    }),
  ).toBe('foo/bar-0');

  expect(
    genQueueKey(
      {
        base: {
          repo: {
            full_name: 'foo/bar',
          },
        },
        number: '0',
      },
      'prefix',
    ),
  ).toBe('prefix-foo/bar-0');
});